import {
    characters,
    eventSource,
    event_types,
    extension_prompt_roles,
    extension_prompt_types,
    generateRaw,
    getCharacterCardFields,
    saveSettingsDebounced,
    setExtensionPrompt,
    syncMesToSwipe,
    this_chid,
    updateMessageBlock,
} from '../../../script.js';
import { extension_settings, getContext, renderExtensionTemplateAsync } from '../../extensions.js';
import { getTokenCountAsync } from '../../tokenizers.js';
import { removeReasoningFromString } from '../../reasoning.js';
import { selected_group } from '../../group-chats.js';
import { Popup } from '../../popup.js';
import {
    PROMPT_KEY,
    REASONING_RECOVERY_KEY,
    SIGNAL_DEFINITIONS,
    SNAPSHOT_KEY,
    assertDeltaSubject,
    collectMessages,
    createEmptyState,
    findLatestSnapshot,
    formatStateForPrompt,
    invalidateSnapshots,
    mergeDelta,
    normalizeGuidance,
    normalizeState,
    recoverStoryContentFromReasoning,
    saveStateSnapshot,
} from './state.js';

const MODULE_NAME = 'livingStateHarness';
const LEGACY_RESPONSE_PROMPT_KEY = 'living_state_harness_response_contract';
const DEFAULT_SETTINGS = Object.freeze({
    enabled: false,
    frozen: false,
    depth: 2,
    updaterModel: 'deepseek-v4-flash',
    responseTokens: 8192,
    messageWindow: 20,
    recoverStoryFromReasoning: true,
    stateInfluence: 'balanced',
    initiative: 'natural',
    pacing: 'responsive',
    userMicroAgency: 'natural',
    authorLocks: [
        '不得替用户决定私人思想、新承诺、关键台词或关键行动；仅可补充上下文已明确暗示的低风险即时反应',
        '角色不能使用尚未在剧情中获知的秘密',
        '世界客观规律和已发生的聊天事实优先于 Living State',
    ].join('\n'),
});

let lastRuntime = {
    status: 'idle',
    error: '',
    durationMs: 0,
    updaterInputTokens: null,
    updaterOutputTokens: null,
    injectionTokens: null,
    delta: null,
    updatedAt: null,
};
let backgroundUpdateRunning = false;
let backgroundStartedAt = 0;
let historyRevision = 0;
let pendingStateUpdate = null;
let ecotRenderQueued = false;

function enhanceEcotBlocks(root = document) {
    const blocks = root.querySelectorAll?.('.mes_text thinking:not([data-lsh-ecot-enhanced])') ?? [];
    for (const thinking of blocks) {
        thinking.dataset.lshEcotEnhanced = 'true';
        const details = document.createElement('details');
        details.className = 'lsh-ecot-details';

        const summary = document.createElement('summary');
        summary.className = 'lsh-ecot-summary';
        summary.innerHTML = '<span class="lsh-ecot-icon fa-solid fa-wand-magic-sparkles"></span><span class="lsh-ecot-title">创作推演</span><span class="lsh-ecot-hint">预设的写作规划，不是正文</span><span class="lsh-ecot-arrow fa-solid fa-chevron-down"></span>';

        const content = document.createElement('div');
        content.className = 'lsh-ecot-content';
        while (thinking.firstChild) content.append(thinking.firstChild);

        details.append(summary, content);
        thinking.replaceWith(details);
    }
}

function queueEcotEnhancement() {
    if (ecotRenderQueued) return;
    ecotRenderQueued = true;
    requestAnimationFrame(() => {
        ecotRenderQueued = false;
        enhanceEcotBlocks(document);
    });
}

function observeEcotRendering() {
    const chatElement = document.getElementById('chat');
    if (!chatElement) return;
    new MutationObserver(queueEcotEnhancement).observe(chatElement, { childList: true, subtree: true });
    queueEcotEnhancement();
}

function getSettings() {
    extension_settings[MODULE_NAME] ??= {};
    for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
        extension_settings[MODULE_NAME][key] ??= value;
    }
    Object.assign(extension_settings[MODULE_NAME], normalizeGuidance(extension_settings[MODULE_NAME]));
    return extension_settings[MODULE_NAME];
}

function getSubjectIdentity(context = getContext()) {
    return {
        role: 'character',
        name: String(characters[this_chid]?.name ?? context.name2 ?? '').trim(),
        counterpartName: String(context.name1 ?? 'user').trim() || 'user',
    };
}

async function interceptor() {
    const settings = getSettings();
    if (!settings.enabled || selected_group) {
        clearInjection();
        updateUi();
        return;
    }

    const context = getContext();
    const chat = context.chat;
    if (!Array.isArray(chat) || !characters[this_chid]) {
        clearInjection();
        return;
    }

    const subject = getSubjectIdentity(context);
    await injectPrompts(findLatestSnapshot(chat, Number.POSITIVE_INFINITY, subject)?.state);
    updateUi();
}

async function updateStateInBackground(messageId, type) {
    const settings = getSettings();
    if (!settings.enabled || settings.frozen || selected_group || type === 'first_message') return;
    if (backgroundUpdateRunning) {
        pendingStateUpdate = { messageId, type };
        return;
    }

    const context = getContext();
    const chat = context.chat;
    const subject = getSubjectIdentity(context);
    const targetMessageId = Number(messageId);
    const targetMessage = chat?.[targetMessageId];
    if (!Array.isArray(chat) || !targetMessage || targetMessage.is_user || !characters[this_chid]) return;

    const latest = findLatestSnapshot(chat, Number.POSITIVE_INFINITY, subject);
    if (latest?.state?.processedThroughMessageId >= targetMessageId) return;

    const previousState = latest?.state ?? createEmptyState(subject);
    const afterMessageId = latest?.state?.processedThroughMessageId ?? -1;
    const messages = collectMessages(chat, afterMessageId, targetMessageId, settings.messageWindow);
    if (messages.length === 0) return;

    backgroundUpdateRunning = true;
    backgroundStartedAt = performance.now();
    const updateRevision = historyRevision;
    lastRuntime = { ...lastRuntime, status: 'updating', error: '' };
    updateUi();
    const startedAt = performance.now();

    try {
        const prompt = buildUpdaterPrompt(previousState, messages, settings.authorLocks, subject);
        const updaterInputTokens = await safeTokenCount(prompt);
        const delta = await runUpdaterWithRetry(prompt, settings.responseTokens, settings.updaterModel, subject);
        const updaterOutputTokens = await safeTokenCount(JSON.stringify(delta));
        if (updateRevision !== historyRevision || getContext().chat !== chat || chat[targetMessageId] !== targetMessage) {
            lastRuntime = { ...lastRuntime, status: 'stale', error: '', updatedAt: new Date().toISOString() };
            await restoreInjection();
            return;
        }
        const { state, changed } = mergeDelta(previousState, delta, messages.map(message => message.id), targetMessageId, subject);
        saveSnapshot(targetMessage, targetMessageId, state, delta, changed, 'post-response');
        syncMesToSwipe(targetMessageId);
        carryStateForwardToPendingUser(chat, targetMessageId, state);
        await context.saveChat();
        await injectPrompts(state);
        lastRuntime = {
            status: changed ? 'updated' : 'unchanged',
            error: '',
            durationMs: Math.round(performance.now() - startedAt),
            updaterInputTokens,
            updaterOutputTokens,
            injectionTokens: await safeTokenCount(formatStateForPrompt(state, null, settings)),
            delta,
            updatedAt: new Date().toISOString(),
        };
    } catch (error) {
        console.error('Living State Harness update failed', error);
        await injectPrompts(previousState);
        lastRuntime = {
            ...lastRuntime,
            status: 'error',
            error: error instanceof Error ? error.message : String(error),
            durationMs: Math.round(performance.now() - startedAt),
            updatedAt: new Date().toISOString(),
        };
        toastr.warning('State update failed; the previous Living State is still being used.', 'Living State Harness');
    } finally {
        backgroundUpdateRunning = false;
        backgroundStartedAt = 0;
        const pending = pendingStateUpdate;
        pendingStateUpdate = null;
        if (pending) setTimeout(() => void updateStateInBackground(pending.messageId, pending.type), 0);
    }

    updateUi();
}

/**
 * Runs the updater after the story response has rendered. It deliberately does not
 * install a global prompt hook: other extensions can issue concurrent auxiliary
 * requests (for example emotion classification), and a global hook would corrupt them.
 */
async function runUpdater(prompt, responseLength, model, subject) {
    const systemPrompt = buildUpdaterSystemPrompt();
    const jsonPrompt = `${prompt}\n\nReturn one JSON object only. Use this exact shape and use null/[] for unchanged fields:\n${JSON.stringify(createEmptyDelta(subject))}\n\nEvery item in an *Add array must be an object shaped as {"text":"...","reason":"...","evidenceMessageIds":[0]}; never return a bare string. evidenceMessageIds must cite message ids from newMessages.`;
    return generateRaw({
        prompt: [{ role: 'user', content: jsonPrompt }],
        systemPrompt: `${systemPrompt}\n立即输出 JSON；不要展示分析过程，不要使用 Markdown 代码块，不要在 JSON 外添加文字。`,
        responseLength: Math.max(8192, responseLength),
        trimNames: false,
        model: String(model || '').trim() || null,
        thinking: 'disabled',
        skipChatCompletionSettings: true,
        ignoreGenerationStop: true,
    });
}

async function runUpdaterWithRetry(prompt, responseLength, model, subject) {
    let lastError;
    for (let attempt = 1; attempt <= 2; attempt++) {
        try {
            return parseDelta(await runUpdater(prompt, responseLength, model, subject), subject);
        } catch (error) {
            lastError = error;
            console.warn(`Living State Harness updater attempt ${attempt} failed`, error);
            if (attempt < 2) await new Promise(resolve => setTimeout(resolve, 750));
        }
    }
    throw lastError;
}

async function injectPrompts(state) {
    const settings = getSettings();
    const statePrompt = state ? formatStateForPrompt(state, null, settings) : '';
    setExtensionPrompt(PROMPT_KEY, statePrompt, extension_prompt_types.IN_CHAT, settings.depth, false, extension_prompt_roles.SYSTEM);
    setExtensionPrompt(LEGACY_RESPONSE_PROMPT_KEY, '', extension_prompt_types.IN_CHAT, 0, false, extension_prompt_roles.SYSTEM);
    lastRuntime.injectionTokens = await safeTokenCount(statePrompt);
}

function clearInjection() {
    setExtensionPrompt(PROMPT_KEY, '', extension_prompt_types.IN_CHAT, getSettings().depth, false, extension_prompt_roles.SYSTEM);
    setExtensionPrompt(LEGACY_RESPONSE_PROMPT_KEY, '', extension_prompt_types.IN_CHAT, 0, false, extension_prompt_roles.SYSTEM);
}

async function recoverReceivedResponse(messageId, type) {
    const settings = getSettings();
    if (!settings.enabled || type === 'first_message' || selected_group) return;
    const context = getContext();
    const message = context.chat?.[Number(messageId)];
    if (!message || message.is_user) return;

    if (settings.recoverStoryFromReasoning) {
        const recovery = recoverStoryContentFromReasoning(message.mes, message.extra?.reasoning);
        if (recovery.recovered) {
            message.mes = recovery.content;
            message.extra ??= {};
            message.extra.reasoning = recovery.remainingReasoning;
            message.extra[REASONING_RECOVERY_KEY] = { recoveredAt: new Date().toISOString() };
            updateMessageBlock(Number(messageId), message);
            await context.saveChat();
            toastr.info('已将误入思考通道的结构化正文恢复到正文区。', 'Living State Harness');
        }
    }
    updateUi();
}

function saveSnapshot(message, messageId, state, delta, changed, kind) {
    return saveStateSnapshot(message, messageId, state, { delta, changed, kind });
}

function carryStateForwardToPendingUser(chat, assistantMessageId, state) {
    const nextMessageId = Number(assistantMessageId) + 1;
    const nextMessage = chat[nextMessageId];
    if (!nextMessage?.is_user) return false;
    saveSnapshot(nextMessage, nextMessageId, state, { source: 'carried-forward' }, false, 'pre-generation');
    return true;
}

function buildUpdaterPrompt(previousState, messages, authorLocks, subject) {
    const fields = getCharacterCardFields();
    const character = characters[this_chid];
    const characterCore = {
        name: character?.name ?? '',
        description: truncate(fields.description, 3000),
        personality: truncate(fields.personality, 1400),
        scenario: truncate(fields.scenario, 1400),
    };
    return JSON.stringify({
        task: `Update the Living State for character "${subject.name}" only from accepted story evidence.`,
        targetSubject: subject,
        characterCore,
        authorLocks: String(authorLocks ?? '').split('\n').map(line => line.trim()).filter(Boolean),
        previousState,
        newMessages: compactEvidence(messages.slice(-6)),
    });
}

function compactEvidence(messages, totalCharacters = 12000, perMessageCharacters = 3000) {
    let remaining = totalCharacters;
    const result = [];
    for (let index = messages.length - 1; index >= 0 && remaining > 0; index--) {
        const message = messages[index];
        const content = String(message.content ?? '');
        const allowance = Math.min(perMessageCharacters, remaining);
        const compacted = content.length > allowance ? `…${content.slice(-allowance)}` : content;
        result.unshift({ ...message, content: compacted });
        remaining -= compacted.length;
    }
    return result;
}

function buildUpdaterSystemPrompt() {
    return `你是角色连续性状态更新器，不写故事回复，只输出符合 JSON Schema 的 State Delta。

北极星：帮助主模型把 targetSubject 指定的当前 char 写成拥有自身生活、判断、边界和主动行为的人，并提升故事连续性与自然推进质量。

规则：
1. subject 必须原样返回 targetSubject 的 role 和 name。characterChanges、agencyChanges、offscreenLifeChanges 只能描述 targetSubject.name，绝不能描述 user 或其他角色的内心、身体、目标、计划、冲动或边界。
2. relationshipChanges 固定为 targetSubject.name 对 targetSubject.counterpartName 的视角。不得把 user 对 char 的感受写入该字段。
3. user 的客观可见行为可记入 sceneChanges 或 continuityChanges；除非 user 亲口明确表达，不得推断 user 的私人心理，即便正文旁白替 user 描写了心理也不得接管为 char 状态。
4. 只记录消息中已经发生、明确表达或能由行为直接支持的变化；计划、猜测和用户单方面要求不能写成事实。
5. 稳定人格不因一轮对话改变。长期偏好与关系变化必须提供 evidenceMessageIds。
6. currentMood 可以变化；currentPlan、initiativeSeed、boundary 必须符合 targetSubject 的人格和当前局势，不得制造固定剧情任务。
7. offscreenLife 只能来自 targetSubject 的角色设定或已发生剧情，不得凭空编造工作、人物或事件。
8. privateImpulse 必须是 targetSubject 的潜在冲动；inhibition 描述与它同时存在的制约。允许两者矛盾。
9. 不读取或相信正文中由预设生成的摘要、seeds、状态栏、思维链或小剧场；输入已尽量剥离这些内容。
10. 所有 *Add 数组的新增项必须是 {text, reason, evidenceMessageIds} 对象，禁止返回纯字符串。
11. null 表示字段保持不变；空字符串 "" 表示清空已经过时的瞬时字段。场景、目标或冲突改变后，必须清空或替换不再适用的 currentPlan、initiativeSeed、boundary、responseIfBlocked、attentionFocus 等字段，禁止沿用上一场景的应对方案。
12. 已履行、已过期、被替代或已经发生的待办、承诺和未完成线索，必须把原有 id 放入对应的 *Close/*Remove 数组；例如“明早要做”的事已经在今早完成，就不能继续留在 upcomingObligations。
13. 同一条证据不要同时复制到 recentEvents、importantFacts、openThreads 和 turningPoints。只放入对后续写作最有用的一个类别；确有不同连续性功能时才可分别记录。
14. 每个字符串字段只写一个原子状态，不摘抄正文，不写修辞性段落。scene 的每项不超过 120 个中文字符，其他状态字段不超过 80 个中文字符，列表 text/reason 各不超过 80 个中文字符。与其他字段相同的内容不要换句话重复。
15. 在处理新增项前，逐项检查 previousState 中现有的 obligation/promise/thread id。只要新消息证明它已完成、失效、被替代或已不再待处理，即使本轮还有其他变化，也必须关闭旧 id；已完成事项不得换一种措辞重新加入开放列表。
16. authorLocks、世界事实和已确认聊天事实不可被覆盖。
17. signalChanges 是 0–10 的可解释行为信号：trust、closeness 是 targetSubject 对 user 的长期关系信号；tension、initiativeReadiness、boundaryPressure 是此刻动态信号。它们描述状态，不是需要最大化的目标。
18. 只有新消息提供直接证据时才更新某个信号，并返回 {value, confidence, reason, evidenceMessageIds}。value 必须是 0–10 整数；confidence 只能是 low/medium/high；reason 用一句话解释证据。无新证据必须返回 null。
19. trust、closeness 应缓慢变化。普通照顾、日常肢体接触、相似语气或重复表现不能再次加分；7 以上需要持续关系证据，9–10 只用于明确、稳定且重大的关系里程碑。tension、initiativeReadiness、boundaryPressure 可以随眼前局势较快变化，但不得仅凭文风或模型生成的 user 私人心理评分。
20. 无变化时返回字段为空的 Delta。不要复述上一状态。`;
}

function parseDelta(rawResult, subject) {
    const value = typeof rawResult === 'string' ? JSON.parse(extractJsonObject(removeReasoningFromString(rawResult))) : rawResult;
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error('Updater returned an invalid Delta object.');
    }
    assertDeltaSubject(value, subject);
    assertEvidenceBackedAdditions(value);
    assertEvidenceBackedSignals(value);
    return value;
}

function extractJsonObject(value) {
    const text = String(value ?? '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start === -1 || end < start) throw new Error('Updater did not return a JSON object.');
    return text.slice(start, end + 1);
}

function createEmptyDelta(subject) {
    return {
        subject: { role: 'character', name: subject.name },
        sceneChanges: { location: null, presentCharacters: null, immediateSituation: null },
        characterChanges: Object.fromEntries(['currentMood', 'physicalState', 'attentionFocus', 'currentGoal', 'currentConcern', 'privateImpulse', 'inhibition'].map(key => [key, null])),
        agencyChanges: Object.fromEntries(['currentPlan', 'initiativeSeed', 'boundary', 'responseIfBlocked'].map(key => [key, null])),
        relationshipChanges: { trust: null, emotionalCloseness: null, authorityDynamic: null, currentTension: null, evolvedPreferencesAdd: [], evolvedPreferenceIdsRemove: [] },
        signalChanges: Object.fromEntries(Object.keys(SIGNAL_DEFINITIONS).map(key => [key, null])),
        offscreenLifeChanges: { recentEventsAdd: [], recentEventIdsRemove: [], upcomingObligationsAdd: [], upcomingObligationIdsClose: [], peopleOnMindAdd: [], peopleOnMindIdsRemove: [] },
        continuityChanges: { importantFactsAdd: [], importantFactIdsRemove: [], openPromisesAdd: [], openPromiseIdsClose: [], openThreadsAdd: [], openThreadIdsClose: [] },
        turningPointsAdd: [],
        turningPointIdsRemove: [],
    };
}

function assertEvidenceBackedSignals(delta) {
    for (const key of Object.keys(SIGNAL_DEFINITIONS)) {
        const signal = delta?.signalChanges?.[key];
        if (signal === null || signal === undefined) continue;
        const value = Number(signal?.value);
        const evidenceMessageIds = Array.isArray(signal?.evidenceMessageIds) ? signal.evidenceMessageIds.map(Number).filter(Number.isInteger) : [];
        if (!signal || typeof signal !== 'object' || !Number.isInteger(value) || value < 0 || value > 10
            || !['low', 'medium', 'high'].includes(signal.confidence) || typeof signal.reason !== 'string' || !signal.reason.trim()
            || evidenceMessageIds.length === 0) {
            throw new Error(`Updater returned an invalid evidence-backed signal: ${key}.`);
        }
    }
}

function assertEvidenceBackedAdditions(delta) {
    const additions = [
        delta?.relationshipChanges?.evolvedPreferencesAdd,
        delta?.offscreenLifeChanges?.recentEventsAdd,
        delta?.offscreenLifeChanges?.upcomingObligationsAdd,
        delta?.offscreenLifeChanges?.peopleOnMindAdd,
        delta?.continuityChanges?.importantFactsAdd,
        delta?.continuityChanges?.openPromisesAdd,
        delta?.continuityChanges?.openThreadsAdd,
        delta?.turningPointsAdd,
    ];
    for (const items of additions) {
        if (!Array.isArray(items)) continue;
        for (const item of items) {
            const evidenceMessageIds = Array.isArray(item?.evidenceMessageIds) ? item.evidenceMessageIds.map(Number).filter(Number.isInteger) : [];
            if (!item || typeof item !== 'object' || Array.isArray(item) || typeof item.text !== 'string' || !item.text.trim() || evidenceMessageIds.length === 0) {
                throw new Error('Updater returned an addition without {text, evidenceMessageIds}.');
            }
        }
    }
}

async function onHistoryChanged(messageId) {
    historyRevision += 1;
    const context = getContext();
    if (!Array.isArray(context.chat)) return;
    if (invalidateSnapshots(context.chat, messageId)) {
        await context.saveChat();
        lastRuntime = { ...lastRuntime, status: 'stale', error: '' };
    }
    await restoreInjection();
    updateUi();
}

async function onMessageSent(messageId) {
    const settings = getSettings();
    if (!settings.enabled || selected_group) return;
    const context = getContext();
    const chat = context.chat;
    const targetMessageId = Number(messageId);
    const targetMessage = chat?.[targetMessageId];
    if (!Array.isArray(chat) || !targetMessage?.is_user || !characters[this_chid]) return;

    const subject = getSubjectIdentity(context);
    const previous = findLatestSnapshot(chat, targetMessageId - 1, subject);
    const state = previous?.state ?? createEmptyState(subject);
    if (targetMessageId < chat.length - 1) invalidateSnapshots(chat, targetMessageId + 1);
    saveSnapshot(targetMessage, targetMessageId, state, { source: 'pre-generation' }, false, 'pre-generation');
    await context.saveChat();
    await injectPrompts(state);
    updateUi();
}

async function onGenerationStarted(type, _options, dryRun) {
    const settings = getSettings();
    if (dryRun || !settings.enabled || selected_group || !['regenerate', 'swipe'].includes(type)) return;
    const context = getContext();
    const chat = context.chat;
    const responseMessageId = Array.isArray(chat) ? chat.length - 1 : -1;
    const responseMessage = chat?.[responseMessageId];
    if (!responseMessage || responseMessage.is_user || !characters[this_chid]) return;

    historyRevision += 1;
    const subject = getSubjectIdentity(context);
    const previous = findLatestSnapshot(chat, responseMessageId - 1, subject);
    const state = previous?.state ?? createEmptyState(subject);
    let snapshotChanged = false;

    const checkpointMessageId = responseMessageId - 1;
    const checkpointMessage = chat[checkpointMessageId];
    if (checkpointMessage?.is_user && previous?.index !== checkpointMessageId) {
        saveSnapshot(checkpointMessage, checkpointMessageId, state, { source: 'pre-regeneration' }, false, 'pre-generation');
        snapshotChanged = true;
    }

    const isNewSwipeSlot = type === 'swipe'
        && Number.isInteger(responseMessage.swipe_id)
        && responseMessage.swipe_id >= (responseMessage.swipes?.length ?? 0);
    if (isNewSwipeSlot && responseMessage.extra?.[SNAPSHOT_KEY]) {
        delete responseMessage.extra[SNAPSHOT_KEY];
        snapshotChanged = true;
    }

    if (snapshotChanged) await context.saveChat();
    await injectPrompts(state);
    updateUi();
}

async function onMessagesDeleted(deletedFromMessageId) {
    historyRevision += 1;
    const context = getContext();
    if (!Array.isArray(context.chat)) return;
    const deletionBoundary = Number.isInteger(Number(deletedFromMessageId)) ? Number(deletedFromMessageId) : context.chat.length;
    if (invalidateSnapshots(context.chat, deletionBoundary)) {
        await context.saveChat();
        lastRuntime = { ...lastRuntime, status: 'stale', error: '' };
    }
    await restoreInjection();
    updateUi();
}

async function onMessageSwiped() {
    historyRevision += 1;
    await restoreInjection();
    updateUi();
}

async function restoreInjection() {
    const settings = getSettings();
    const context = getContext();
    const subject = getSubjectIdentity(context);
    const latest = Array.isArray(context.chat) ? findLatestSnapshot(context.chat, Number.POSITIVE_INFINITY, subject) : null;
    if (settings.enabled && !selected_group) await injectPrompts(latest?.state);
    else clearInjection();
}

async function resetState() {
    historyRevision += 1;
    pendingStateUpdate = null;
    const context = getContext();
    if (!Array.isArray(context.chat)) return;
    for (const message of context.chat) {
        if (message.extra?.[SNAPSHOT_KEY]) delete message.extra[SNAPSHOT_KEY];
    }
    clearInjection();
    lastRuntime = { ...lastRuntime, status: 'empty', error: '', delta: null };
    await context.saveChat();
    updateUi();
}

async function confirmResetState() {
    const confirmed = await Popup.show.confirm('Reset Living State?', 'All Living State snapshots in the current chat will be removed. The next normal turn will rebuild from recent accepted messages.');
    if (confirmed) await resetState();
}

async function saveManualState() {
    const context = getContext();
    const message = [...(context.chat ?? [])].reverse().find(item => item.is_user);
    if (!message) {
        toastr.warning('Send a user message before saving a Living State.');
        return;
    }
    try {
        const state = normalizeState(JSON.parse(String($('#lsh_raw_state').val())), getSubjectIdentity(context));
        state.version += 1;
        state.processedThroughMessageId = context.chat.indexOf(message);
        const messageId = context.chat.indexOf(message);
        saveSnapshot(message, messageId, state, { source: 'manual' }, true, 'manual');
        await context.saveChat();
        await injectPrompts(state);
        lastRuntime = { ...lastRuntime, status: 'manual', error: '', delta: { source: 'manual' }, updatedAt: new Date().toISOString() };
        updateUi();
        toastr.success('Living State saved.');
    } catch (error) {
        toastr.error(error instanceof Error ? error.message : String(error), 'Invalid Living State JSON');
    }
}

function bindSettings() {
    const settings = getSettings();
    $('#lsh_enabled').prop('checked', settings.enabled).on('input', async function () {
        settings.enabled = Boolean($(this).prop('checked'));
        saveSettingsDebounced();
        await restoreInjection();
        updateUi();
    });
    $('#lsh_frozen').prop('checked', settings.frozen).on('input', function () {
        settings.frozen = Boolean($(this).prop('checked'));
        saveSettingsDebounced();
        updateUi();
    });
    $('#lsh_depth').val(settings.depth).on('change', async function () {
        settings.depth = Number($(this).val());
        saveSettingsDebounced();
        await restoreInjection();
    });
    $('#lsh_updater_model').val(settings.updaterModel).on('change', function () {
        settings.updaterModel = String($(this).val()).trim();
        saveSettingsDebounced();
    });
    $('#lsh_response_tokens').val(settings.responseTokens).on('change', function () {
        settings.responseTokens = clamp(Number($(this).val()), 8192, 16384);
        $(this).val(settings.responseTokens);
        saveSettingsDebounced();
    });
    $('#lsh_message_window').val(settings.messageWindow).on('change', function () {
        settings.messageWindow = clamp(Number($(this).val()), 2, 50);
        $(this).val(settings.messageWindow);
        saveSettingsDebounced();
    });
    for (const [selector, key] of [
        ['#lsh_state_influence', 'stateInfluence'],
        ['#lsh_initiative', 'initiative'],
        ['#lsh_pacing', 'pacing'],
        ['#lsh_user_micro_agency', 'userMicroAgency'],
    ]) {
        $(selector).val(settings[key]).on('change', async function () {
            const normalized = normalizeGuidance({ ...settings, [key]: String($(this).val()) });
            settings[key] = normalized[key];
            $(this).val(settings[key]);
            saveSettingsDebounced();
            await restoreInjection();
            updateUi();
        });
    }
    $('#lsh_recover_reasoning_story').prop('checked', settings.recoverStoryFromReasoning).on('input', function () {
        settings.recoverStoryFromReasoning = Boolean($(this).prop('checked'));
        saveSettingsDebounced();
    });
    $('#lsh_author_locks').val(settings.authorLocks).on('input', function () {
        settings.authorLocks = String($(this).val());
        saveSettingsDebounced();
    });
    $('#lsh_open_panel, #lsh_panel_toggle').on('click', () => togglePanel(true));
    $('#lsh_close_panel').on('click', () => togglePanel(false));
    $('#lsh_rebuild').on('click', confirmResetState);
    $('#lsh_reset_state').on('click', confirmResetState);
    $('#lsh_save_state').on('click', saveManualState);
}

function togglePanel(open) {
    $('#lsh_panel').toggleClass('open', open).attr('aria-hidden', String(!open));
    if (open) updateUi();
}

function updateUi() {
    const settings = getSettings();
    const context = getContext();
    const subject = getSubjectIdentity(context);
    const latest = Array.isArray(context.chat) ? findLatestSnapshot(context.chat, Number.POSITIVE_INFINITY, subject) : null;
    const state = latest?.state ?? createEmptyState(subject);
    const characterName = subject.name || '未选择角色';
    const counterpartName = subject.counterpartName || '用户';
    const status = getStatusPresentation(settings, latest);

    $('#lsh_character_name').text(characterName);
    $('#lsh_now_title').text(`${characterName} · 此刻状态`);
    $('#lsh_agency_title').text(`${characterName} · 自主性与行动`);
    $('#lsh_relationship_title').text(`${characterName} → ${counterpartName} · 关系动态`);
    $('#lsh_offscreen_title').text(`${characterName} · 场景之外的生活`);
    $('#lsh_settings_status, #lsh_panel_status').text(status.label).attr('data-state', status.state);
    $('#lsh_panel_toggle').attr('data-state', status.state);
    $('#lsh_toggle_text').text(status.shortLabel);
    renderGrid('#lsh_now_grid', [
        ['情绪', state.character.currentMood],
        ['身体状态', state.character.physicalState],
        ['注意焦点', state.character.attentionFocus],
        ['当前目标', state.character.currentGoal],
        ['担忧', state.character.currentConcern],
        ['内在冲动', state.character.privateImpulse],
        ['自我约束', state.character.inhibition],
    ]);
    renderGrid('#lsh_agency_grid', [
        ['当前计划', state.agency.currentPlan],
        ['可能的主动行动', state.agency.initiativeSeed],
        ['边界', state.agency.boundary],
        ['受阻时的反应', state.agency.responseIfBlocked],
    ]);
    renderGrid('#lsh_relationship_grid', [
        ['信任', state.relationship.trust],
        ['亲密程度', state.relationship.emotionalCloseness],
        ['权力关系', state.relationship.authorityDynamic],
        ['当前张力', state.relationship.currentTension],
    ]);
    renderSignals('#lsh_signal_grid', state.signals);
    renderGuidance('#lsh_guidance_grid', settings);
    renderLists('#lsh_offscreen_lists', [
        ['近期事件', state.offscreenLife.recentEvents],
        ['待办与责任', state.offscreenLife.upcomingObligations],
        ['挂念的人', state.offscreenLife.peopleOnMind],
    ]);
    renderLists('#lsh_continuity_lists', [
        ['重要事实', state.continuity.importantFacts],
        ['尚未兑现的承诺', state.continuity.openPromises],
        ['未完成线索', state.continuity.openThreads],
        ['近期转折点', state.recentTurningPoints],
    ]);
    $('#lsh_metrics').empty()
        .append(metric('状态版本', state.version))
        .append(metric('已处理消息', state.processedThroughMessageId))
        .append(metric('更新器输入', formatTokens(lastRuntime.updaterInputTokens)))
        .append(metric('更新器输出', formatTokens(lastRuntime.updaterOutputTokens)))
        .append(metric('注入状态', formatTokens(lastRuntime.injectionTokens)))
        .append(metric('耗时', lastRuntime.durationMs ? `${lastRuntime.durationMs} 毫秒` : '—'));
    $('#lsh_delta_preview').text(lastRuntime.error || JSON.stringify(lastRuntime.delta, null, 2) || '暂无更新记录。');
    if (!$('#lsh_raw_state').is(':focus')) $('#lsh_raw_state').val(JSON.stringify(state, null, 2));
}

function getStatusPresentation(settings, latest) {
    if (!settings.enabled) return { state: 'disabled', label: '已关闭', shortLabel: '角色状态' };
    if (selected_group) return { state: 'warning', label: '暂不支持群聊', shortLabel: '不支持群聊' };
    if (settings.frozen) return { state: 'frozen', label: '已暂停自动更新', shortLabel: '状态已暂停' };
    if (lastRuntime.status === 'updating') {
        const elapsed = backgroundStartedAt ? Math.max(0, Math.round((performance.now() - backgroundStartedAt) / 1000)) : 0;
        return { state: 'updating', label: `正在分析近期剧情 · ${elapsed} 秒 · 不阻塞正文`, shortLabel: `状态更新中 · ${elapsed} 秒` };
    }
    if (lastRuntime.status === 'error') return { state: 'error', label: '更新失败 · 正在使用上一版本', shortLabel: '状态更新异常' };
    if (!latest) return { state: 'empty', label: '已就绪 · 下一轮建立状态', shortLabel: '状态已就绪' };
    if (lastRuntime.status === 'stale') return { state: 'warning', label: '聊天历史已改变 · 等待重建', shortLabel: '状态需要重建' };
    return { state: 'active', label: `运行中 · 版本 ${latest.state.version}`, shortLabel: '角色状态' };
}

function renderGrid(selector, rows) {
    const root = $(selector).empty();
    const populated = rows.filter(([, value]) => value);
    if (!populated.length) return root.append($('<div class="lsh-empty"></div>').text('暂无状态，请发送一条消息来建立。'));
    for (const [label, value] of populated) {
        const row = $('<div class="lsh-state-row"></div>');
        row.append($('<div class="lsh-state-key"></div>').text(label));
        row.append($('<div class="lsh-state-value"></div>').text(value));
        root.append(row);
    }
}

function renderLists(selector, groups) {
    const root = $(selector).empty();
    let count = 0;
    for (const [label, items] of groups) {
        if (!items?.length) continue;
        count += items.length;
        const group = $('<div class="lsh-list-group"></div>').append($('<div class="lsh-list-label"></div>').text(label));
        const list = $('<ul></ul>');
        for (const item of items) list.append($('<li></li>').text(item.text));
        root.append(group.append(list));
    }
    if (!count) root.append($('<div class="lsh-empty"></div>').text('当前没有活跃项目。'));
}

function renderSignals(selector, signals) {
    const root = $(selector).empty();
    let populated = 0;
    const confidenceLabels = { low: '低置信', medium: '中置信', high: '高置信' };
    for (const [key, definition] of Object.entries(SIGNAL_DEFINITIONS)) {
        const signal = signals?.[key];
        if (!Number.isFinite(signal?.value)) continue;
        populated += 1;
        const value = Math.min(10, Math.max(0, Math.round(signal.value)));
        const row = $('<div class="lsh-signal"></div>');
        const header = $('<div class="lsh-signal-header"></div>')
            .append($('<span class="lsh-signal-label"></span>').text(definition.label))
            .append($('<span class="lsh-signal-score"></span>').text(`${value}/10`))
            .append($('<span class="lsh-signal-confidence"></span>').text(confidenceLabels[signal.confidence] ?? '低置信'));
        const meter = $('<div class="lsh-signal-meter"></div>')
            .append($('<span></span>').css('width', `${value * 10}%`));
        row.append(header, meter);
        if (signal.reason) row.append($('<div class="lsh-signal-reason"></div>').text(signal.reason));
        root.append(row);
    }
    if (!populated) root.append($('<div class="lsh-empty"></div>').text('暂无可靠评分；不会用默认中间分冒充已知状态。'));
}

function renderGuidance(selector, input) {
    const root = $(selector).empty();
    const guidance = normalizeGuidance(input);
    const labels = {
        stateInfluence: { subtle: '状态影响 · 轻', balanced: '状态影响 · 均衡', strong: '状态影响 · 强' },
        initiative: { restrained: '主动性 · 克制', natural: '主动性 · 自然', assertive: '主动性 · 积极' },
        pacing: { patient: '节奏 · 留白', responsive: '节奏 · 响应式', forward: '节奏 · 向前' },
        userMicroAgency: { minimal: '用户微互动 · 最少', natural: '用户微互动 · 自然', expressive: '用户微互动 · 丰富' },
    };
    for (const [key, value] of Object.entries(guidance)) {
        root.append($('<span class="lsh-guidance-chip"></span>').text(labels[key][value]));
    }
    root.append($('<div class="lsh-guidance-lock"></div>').text('硬红线：用户的关键决定、承诺、升级行为与私人心理始终由用户决定。'));
}

function metric(label, value) {
    return $('<div class="lsh-metric"></div>')
        .append($('<span></span>').text(label))
        .append($('<strong></strong>').text(value));
}

function formatTokens(value) {
    return Number.isFinite(value) ? `${value} Token` : '—';
}

async function safeTokenCount(value) {
    try {
        return await getTokenCountAsync(String(value ?? ''), 0);
    } catch {
        return null;
    }
}

function truncate(value, length) {
    const text = String(value ?? '');
    return text.length > length ? `${text.slice(0, length)}…` : text;
}

function clamp(value, minimum, maximum) {
    return Math.min(maximum, Math.max(minimum, Number.isFinite(value) ? value : minimum));
}

globalThis.livingStateHarnessInterceptor = interceptor;

export async function init() {
    getSettings();
    const settingsHtml = await renderExtensionTemplateAsync('living-state-harness', 'settings');
    $('#extensions_settings').append(settingsHtml);
    const panelHtml = await renderExtensionTemplateAsync('living-state-harness', 'panel');
    $('body').append(panelHtml);
    bindSettings();
    observeEcotRendering();
    eventSource.on(event_types.CHAT_CHANGED, async () => {
        historyRevision += 1;
        pendingStateUpdate = null;
        await restoreInjection();
        updateUi();
    });
    eventSource.on(event_types.MESSAGE_SENT, onMessageSent);
    eventSource.on(event_types.GENERATION_STARTED, onGenerationStarted);
    eventSource.on(event_types.MESSAGE_EDITED, onHistoryChanged);
    eventSource.on(event_types.MESSAGE_DELETED, onMessagesDeleted);
    eventSource.on(event_types.MESSAGE_SWIPED, onMessageSwiped);
    eventSource.on(event_types.MESSAGE_RECEIVED, (messageId, type) => {
        setTimeout(() => void (async () => {
            await recoverReceivedResponse(messageId, type);
            await updateStateInBackground(messageId, type);
        })(), 0);
    });
    setInterval(() => {
        if (backgroundUpdateRunning) updateUi();
    }, 1000);
    await restoreInjection();
    updateUi();
}
