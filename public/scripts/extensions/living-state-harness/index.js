import {
    characters,
    chat_metadata,
    eventSource,
    event_types,
    extension_prompt_roles,
    extension_prompt_types,
    generateRaw,
    getCharacterCardFields,
    getCurrentChatId,
    getRequestHeaders,
    openCharacterChat,
    saveChat,
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
    CALIBRATION_BACKUP_KEY,
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
    normalizeDeltaReferences,
    normalizeState,
    recoverStoryContentFromReasoning,
    saveStateSnapshot,
} from './state.js';
import {
    ARCHIVE_METADATA_KEY,
    ARCHIVE_PROMPT_KEY,
    buildArchiveUpdatePayload,
    createContinuationChat,
    createEmptyArchive,
    formatArchiveForPrompt,
    normalizeArchive,
    splitHistoryForArchive,
} from './archive.js';

const MODULE_NAME = 'livingStateHarness';
const LEGACY_RESPONSE_PROMPT_KEY = 'living_state_harness_response_contract';
const DEFAULT_SETTINGS = Object.freeze({
    enabled: false,
    frozen: false,
    depth: 2,
    updaterModel: 'deepseek-v4-flash',
    archiveModel: 'deepseek-v4-pro',
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
    archiveKeepRecent: 20,
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
let calibrationRunning = false;
let archiveRunning = false;
let lastArchiveRuntime = { status: 'idle', detail: '', completedChunks: 0, totalChunks: 0 };
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
    const archivePrompt = formatStoredArchivePrompt();
    setExtensionPrompt(ARCHIVE_PROMPT_KEY, archivePrompt, extension_prompt_types.IN_CHAT, Math.max(settings.depth + 2, 4), false, extension_prompt_roles.SYSTEM);
    setExtensionPrompt(LEGACY_RESPONSE_PROMPT_KEY, '', extension_prompt_types.IN_CHAT, 0, false, extension_prompt_roles.SYSTEM);
    lastRuntime.injectionTokens = await safeTokenCount(statePrompt);
}

function clearInjection() {
    setExtensionPrompt(PROMPT_KEY, '', extension_prompt_types.IN_CHAT, getSettings().depth, false, extension_prompt_roles.SYSTEM);
    setExtensionPrompt(ARCHIVE_PROMPT_KEY, '', extension_prompt_types.IN_CHAT, Math.max(getSettings().depth + 2, 4), false, extension_prompt_roles.SYSTEM);
    setExtensionPrompt(LEGACY_RESPONSE_PROMPT_KEY, '', extension_prompt_types.IN_CHAT, 0, false, extension_prompt_roles.SYSTEM);
}

function formatStoredArchivePrompt() {
    const stored = chat_metadata?.[ARCHIVE_METADATA_KEY];
    if (!stored?.memory) return '';
    return formatArchiveForPrompt(stored.memory, getSubjectIdentity());
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
    normalizeDeltaReferences(value);
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

async function calibrateCurrentState() {
    if (calibrationRunning || backgroundUpdateRunning) {
        toastr.warning('状态更新正在进行，请稍后再校准。', 'Living State Harness');
        return;
    }
    const context = getContext();
    const chat = context.chat;
    const subject = getSubjectIdentity(context);
    const latest = Array.isArray(chat) ? findLatestSnapshot(chat, Number.POSITIVE_INFINITY, subject) : null;
    if (!latest || !chat.length) {
        toastr.warning('当前聊天还没有可校准的状态。', 'Living State Harness');
        return;
    }
    const approved = await Popup.show.confirm('校准当前角色状态？', '将检查整个聊天中的开放承诺、待办和线索，只清理已完成、失效或重复的项目。校准前状态会保留，可随时撤销。本操作会调用一次状态更新模型。');
    if (!approved) return;

    const revision = historyRevision;
    const anchorMessage = chat[latest.index];
    calibrationRunning = true;
    $('#lsh_calibrate').prop('disabled', true);
    toastr.info('正在校准状态，请稍候……', 'Living State Harness');
    try {
        const evidence = compactCalibrationEvidence(collectMessages(chat, -1, chat.length - 1, chat.length));
        const delta = await runCalibration(latest.state, evidence, getSettings().updaterModel, subject);
        restrictCalibrationDelta(delta);
        const evidenceIds = evidence.map(message => message.id);
        const { state, changed } = mergeDelta(latest.state, delta, evidenceIds, chat.length - 1, subject);
        if (!changed) {
            toastr.info('没有发现可以安全清理的过期项目。', 'Living State Harness');
            return;
        }
        const summary = describeCalibrationChanges(latest.state, state);
        const confirmed = await Popup.show.confirm('应用校准结果？', summary);
        if (!confirmed) return;
        if (revision !== historyRevision || getContext().chat !== chat || chat[latest.index] !== anchorMessage) {
            throw new Error('校准期间聊天发生了变化，请重新运行校准。');
        }
        anchorMessage.extra ??= {};
        anchorMessage.extra[CALIBRATION_BACKUP_KEY] = structuredClone(anchorMessage.extra[SNAPSHOT_KEY]);
        saveSnapshot(anchorMessage, latest.index, state, { source: 'calibration', changes: summary }, true, 'calibration');
        await context.saveChat();
        await injectPrompts(state);
        lastRuntime = { ...lastRuntime, status: 'calibrated', error: '', delta, updatedAt: new Date().toISOString() };
        updateUi();
        toastr.success(`状态已校准到版本 ${state.version}。`, 'Living State Harness');
    } catch (error) {
        console.error('Living State Harness calibration failed', error);
        toastr.error(error instanceof Error ? error.message : String(error), '状态校准失败');
    } finally {
        calibrationRunning = false;
        $('#lsh_calibrate').prop('disabled', false);
    }
}

async function undoLastCalibration() {
    const context = getContext();
    const chat = context.chat;
    if (!Array.isArray(chat)) return;
    for (let index = chat.length - 1; index >= 0; index--) {
        const backup = chat[index]?.extra?.[CALIBRATION_BACKUP_KEY];
        if (!backup) continue;
        const confirmed = await Popup.show.confirm('撤销上次状态校准？', `将恢复校准前的状态版本 ${backup.state?.version ?? '未知'}。`);
        if (!confirmed) return;
        chat[index].extra[SNAPSHOT_KEY] = structuredClone(backup);
        delete chat[index].extra[CALIBRATION_BACKUP_KEY];
        await context.saveChat();
        await restoreInjection();
        updateUi();
        toastr.success('已恢复校准前状态。', 'Living State Harness');
        return;
    }
    toastr.info('当前聊天没有可撤销的校准。', 'Living State Harness');
}

async function runCalibration(state, messages, model, subject) {
    const prompt = JSON.stringify({
        task: 'Audit the existing Living State against the accepted chat evidence. Return removals/closures only; never add new state.',
        targetSubject: subject,
        currentState: state,
        acceptedMessages: messages,
    });
    const result = await generateRaw({
        prompt: [{ role: 'user', content: `${prompt}\n\nReturn one JSON object only with this exact shape:\n${JSON.stringify(createEmptyDelta(subject))}` }],
        systemPrompt: `你是角色状态校准器，只清理已有状态，不写故事、不新增事实。逐项检查当前开放的待办、承诺和线索；只有聊天证据明确证明已完成、取消、失效或重复时才关闭。无法确定的一律保留。重要事实和转折点是历史记录，除非完全重复、被明确否定或明显不属于该角色，否则保留。关闭或移除项只返回现有 id 字符串。立即输出 JSON，不要解释。`,
        responseLength: 8192,
        trimNames: false,
        model: String(model || '').trim() || null,
        thinking: 'disabled',
        skipChatCompletionSettings: true,
        ignoreGenerationStop: true,
    });
    return parseDelta(result, subject);
}

function restrictCalibrationDelta(delta) {
    delta.sceneChanges = { location: null, presentCharacters: null, immediateSituation: null };
    delta.characterChanges = Object.fromEntries(Object.keys(delta.characterChanges ?? {}).map(key => [key, null]));
    delta.agencyChanges = Object.fromEntries(Object.keys(delta.agencyChanges ?? {}).map(key => [key, null]));
    for (const key of ['trust', 'emotionalCloseness', 'authorityDynamic', 'currentTension']) if (delta.relationshipChanges) delta.relationshipChanges[key] = null;
    if (delta.relationshipChanges) delta.relationshipChanges.evolvedPreferencesAdd = [];
    delta.signalChanges = Object.fromEntries(Object.keys(SIGNAL_DEFINITIONS).map(key => [key, null]));
    if (delta.offscreenLifeChanges) {
        delta.offscreenLifeChanges.recentEventsAdd = [];
        delta.offscreenLifeChanges.upcomingObligationsAdd = [];
        delta.offscreenLifeChanges.peopleOnMindAdd = [];
    }
    if (delta.continuityChanges) {
        delta.continuityChanges.importantFactsAdd = [];
        delta.continuityChanges.openPromisesAdd = [];
        delta.continuityChanges.openThreadsAdd = [];
    }
    delta.turningPointsAdd = [];
}

function compactCalibrationEvidence(messages, totalCharacters = 90000, perMessageCharacters = 1200) {
    const result = [];
    let remaining = totalCharacters;
    for (const message of messages) {
        if (remaining <= 0) break;
        const allowance = Math.min(perMessageCharacters, remaining);
        const content = String(message.content ?? '');
        result.push({ ...message, content: content.length > allowance ? `${content.slice(0, allowance)}…` : content });
        remaining -= Math.min(content.length, allowance);
    }
    return result;
}

function describeCalibrationChanges(before, after) {
    const groups = [
        ['待办', before.offscreenLife.upcomingObligations, after.offscreenLife.upcomingObligations],
        ['承诺', before.continuity.openPromises, after.continuity.openPromises],
        ['线索', before.continuity.openThreads, after.continuity.openThreads],
        ['重要事实', before.continuity.importantFacts, after.continuity.importantFacts],
        ['转折点', before.recentTurningPoints, after.recentTurningPoints],
    ];
    const lines = [];
    for (const [label, oldItems, newItems] of groups) {
        const kept = new Set(newItems.map(item => item.id));
        for (const item of oldItems) if (!kept.has(item.id)) lines.push(`关闭/归档${label}：${item.text}`);
    }
    return lines.length ? lines.join('\n') : '状态内容发生了规范化调整。';
}

async function archiveAndContinue() {
    if (archiveRunning || calibrationRunning || backgroundUpdateRunning) {
        toastr.warning('状态任务正在运行，请稍后再归档。', 'Living State Harness');
        return;
    }
    if (selected_group) {
        toastr.warning('长期对话归档暂不支持群聊。', 'Living State Harness');
        return;
    }
    const context = getContext();
    const sourceChat = context.chat;
    const subject = getSubjectIdentity(context);
    const latest = Array.isArray(sourceChat) ? findLatestSnapshot(sourceChat, Number.POSITIVE_INFINITY, subject) : null;
    const settings = getSettings();
    const split = Array.isArray(sourceChat) ? splitHistoryForArchive(sourceChat, settings.archiveKeepRecent) : null;
    if (!latest || !split || split.archived.length < 10 || split.recent.length < 4) {
        toastr.info('当前聊天还不需要归档，或尚未建立可续接的角色状态。', 'Living State Harness');
        return;
    }

    const storedTokens = sourceChat.reduce((sum, message) => sum + (Number(message?.extra?.token_count) || 0), 0);
    const approved = await Popup.show.confirm(
        '归档长对话并继续？',
        `原聊天将完整保留。将归档较早的 ${split.archived.length} 条消息，保留最近 ${split.recent.length} 条原文，并重新核对 Harness 中的过期项目。${storedTokens ? `当前正文累计约 ${storedTokens.toLocaleString()} Token。` : ''}`,
        { okButton: '生成预览', cancelButton: '取消' },
    );
    if (!approved) return;

    archiveRunning = true;
    lastArchiveRuntime = { status: 'starting', detail: '正在保存原聊天……', completedChunks: 0, totalChunks: split.chunks.length };
    const revision = historyRevision;
    const sourceChatId = getCurrentChatId();
    $('#lsh_archive_continue').prop('disabled', true);
    updateUi();
    toastr.info(`正在整理 ${split.chunks.length} 个历史片段，原聊天不会被修改……`, 'Living State Harness');
    try {
        await context.saveChat();
        let memory = chat_metadata?.[ARCHIVE_METADATA_KEY]?.memory
            ? normalizeArchive(chat_metadata[ARCHIVE_METADATA_KEY].memory, subject)
            : createEmptyArchive(subject);
        for (let index = 0; index < split.chunks.length; index++) {
            lastArchiveRuntime = { status: 'summarizing', detail: `正在整理历史片段 ${index + 1}/${split.chunks.length}`, completedChunks: index, totalChunks: split.chunks.length };
            updateUi();
            memory = await runArchiveUpdate(memory, split.chunks[index], subject, settings.archiveModel);
            lastArchiveRuntime = { status: 'summarizing', detail: `历史片段已完成 ${index + 1}/${split.chunks.length}`, completedChunks: index + 1, totalChunks: split.chunks.length };
            $('#lsh_archive_status').text(`正在整理历史：${index + 1}/${split.chunks.length}`);
        }
        assertUsefulArchive(memory);

        const archivedRawText = split.chunks.flat().map(message => `${message.role}: ${message.content}`).join('\n');
        const recentRawText = split.recent.map(message => String(message.mes ?? '')).join('\n');
        const archivedRawTokens = await safeTokenCount(archivedRawText);
        const recentRawTokens = await safeTokenCount(recentRawText);
        const summaryTokens = await safeTokenCount(formatArchiveForPrompt(memory, subject));
        const compactedTokens = Number.isFinite(recentRawTokens) && Number.isFinite(summaryTokens) ? recentRawTokens + summaryTokens : null;
        const estimatedSavedTokens = Number.isFinite(archivedRawTokens) && Number.isFinite(summaryTokens) ? Math.max(0, archivedRawTokens - summaryTokens) : null;
        const savingRate = Number.isFinite(estimatedSavedTokens) && archivedRawTokens > 0 ? Math.round(estimatedSavedTokens / archivedRawTokens * 100) : null;
        const metricsText = [
            Number.isFinite(archivedRawTokens) ? `较早正文：${archivedRawTokens.toLocaleString()} Token` : '',
            Number.isFinite(summaryTokens) ? `历史摘要：${summaryTokens.toLocaleString()} Token` : '',
            Number.isFinite(recentRawTokens) ? `保留原文：${recentRawTokens.toLocaleString()} Token` : '',
            Number.isFinite(compactedTokens) ? `续聊历史部分：约 ${compactedTokens.toLocaleString()} Token` : '',
            Number.isFinite(savingRate) ? `较早正文压缩率：${savingRate}%` : '',
        ].filter(Boolean).join('；');

        const edited = await Popup.show.input(
            '检查历史记忆',
            `${metricsText}<br>下面内容只负责“过去发生过什么”，不负责当前情绪、位置和计划。你可以直接修改；取消不会创建新聊天。`,
            JSON.stringify(memory, null, 2),
            { rows: 24, wide: true, large: true, okButton: '确认并创建续聊', cancelButton: '取消' },
        );
        if (edited === null) {
            lastArchiveRuntime = { status: 'cancelled', detail: '已取消：没有创建续聊，原聊天保持不变。', completedChunks: split.chunks.length, totalChunks: split.chunks.length };
            return;
        }
        memory = normalizeArchive(JSON.parse(edited), subject);
        assertUsefulArchive(memory);

        const calibrationEvidence = [
            { id: split.boundary - 1, role: 'system', name: '历史记忆', content: formatArchiveForPrompt(memory, subject) },
            ...compactCalibrationEvidence(collectMessages(sourceChat, split.boundary - 1, sourceChat.length - 1, split.recent.length), 36000, 2400),
        ];
        const cleanupDelta = await runCalibration(latest.state, calibrationEvidence, settings.archiveModel, subject);
        restrictCalibrationDelta(cleanupDelta);
        const { state: calibratedState } = mergeDelta(
            latest.state,
            cleanupDelta,
            calibrationEvidence.map(message => message.id),
            sourceChat.length - 1,
            subject,
        );
        const continuation = createContinuationChat(split.recent, calibratedState, subject);
        if (revision !== historyRevision || getContext().chat !== sourceChat || getCurrentChatId() !== sourceChatId) {
            throw new Error('整理期间聊天发生了变化。为保护原记录，没有创建续聊，请重新操作。');
        }

        const timestamp = new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14);
        const continuationName = `${subject.name} - 续聊-${timestamp}`;
        const finalSummaryTokens = await safeTokenCount(formatArchiveForPrompt(memory, subject));
        const archiveMetadata = {
            schemaVersion: 1,
            sourceChatId,
            sourceMessageCount: sourceChat.length,
            archivedThroughMessageId: split.boundary - 1,
            keptRecentMessages: split.recent.length,
            createdAt: new Date().toISOString(),
            metrics: {
                originalMessageCount: sourceChat.length,
                archivedMessageCount: split.archived.length,
                recentMessageCount: split.recent.length,
                archivedRawTokens,
                summaryTokens: finalSummaryTokens,
                recentRawTokens,
                compactedTokens: Number.isFinite(recentRawTokens) && Number.isFinite(finalSummaryTokens) ? recentRawTokens + finalSummaryTokens : null,
            },
            memory,
        };
        const continuationMetadata = {
            ...structuredClone(chat_metadata),
            integrity: crypto.randomUUID(),
            [ARCHIVE_METADATA_KEY]: archiveMetadata,
        };
        await saveChat({
            chatName: continuationName,
            withMetadata: continuationMetadata,
            chatData: continuation,
        });
        await verifySavedContinuation(continuationName, sourceChatId);
        await openCharacterChat(continuationName);
        lastArchiveRuntime = { status: 'success', detail: `已创建续聊：${continuationName}`, completedChunks: split.chunks.length, totalChunks: split.chunks.length };
        toastr.success(`续聊已创建：保留 ${split.recent.length} 条原文，原聊天仍完整保存。`, 'Living State Harness');
    } catch (error) {
        console.error('Living State Harness archive failed', error);
        const detail = error instanceof Error ? error.message : String(error);
        lastArchiveRuntime = { ...lastArchiveRuntime, status: 'error', detail: `归档失败：${detail}` };
        toastr.error(detail, '归档失败 · 原聊天未修改');
    } finally {
        archiveRunning = false;
        $('#lsh_archive_continue').prop('disabled', false);
        updateUi();
    }
}

async function verifySavedContinuation(chatName, sourceChatId) {
    const character = characters[this_chid];
    const response = await fetch('/api/chats/get', {
        method: 'POST',
        headers: getRequestHeaders(),
        cache: 'no-cache',
        body: JSON.stringify({
            ch_name: character.name,
            file_name: chatName,
            avatar_url: character.avatar,
        }),
    });
    if (!response.ok) throw new Error(`续聊保存验证失败（HTTP ${response.status}）。`);
    const saved = await response.json();
    const metadata = Array.isArray(saved) ? saved[0]?.chat_metadata?.[ARCHIVE_METADATA_KEY] : null;
    if (!metadata || metadata.sourceChatId !== sourceChatId) {
        throw new Error('SillyTavern 未能读回刚保存的续聊；已停止切换，原聊天保持不变。');
    }
}

async function viewStoredArchive() {
    const archive = chat_metadata?.[ARCHIVE_METADATA_KEY];
    if (!archive?.memory) {
        toastr.info('当前聊天没有历史摘要。', 'Living State Harness');
        return;
    }
    await Popup.show.text('历史摘要明细', renderArchiveDetailsHtml(archive), { wide: true, large: true });
}

async function editStoredArchive() {
    const archive = chat_metadata?.[ARCHIVE_METADATA_KEY];
    if (!archive?.memory) {
        toastr.info('当前聊天没有历史摘要。', 'Living State Harness');
        return;
    }
    try {
        const edited = await Popup.show.input(
            '修改历史摘要',
            `${formatArchiveMetrics(archive.metrics)}<br>只修改已经发生的历史；当前状态请使用 Harness 状态编辑或校准。`,
            JSON.stringify(archive.memory, null, 2),
            { rows: 24, wide: true, large: true, okButton: '保存并立即生效', cancelButton: '取消' },
        );
        if (edited === null) return;
        const memory = normalizeArchive(JSON.parse(edited), getSubjectIdentity());
        assertUsefulArchive(memory);
        archive.memory = memory;
        archive.updatedAt = new Date().toISOString();
        archive.metrics ??= {};
        archive.metrics.summaryTokens = await safeTokenCount(formatArchiveForPrompt(memory, getSubjectIdentity()));
        archive.metrics.compactedTokens = Number.isFinite(archive.metrics.recentRawTokens)
            ? archive.metrics.recentRawTokens + (archive.metrics.summaryTokens ?? 0)
            : null;
        await getContext().saveChat();
        await restoreInjection();
        updateUi();
        toastr.success('历史摘要已保存并立即生效。', 'Living State Harness');
    } catch (error) {
        toastr.error(error instanceof Error ? error.message : String(error), '历史摘要保存失败');
    }
}

function formatArchiveMetrics(metrics) {
    if (!metrics) return '';
    const before = Number.isFinite(metrics.archivedRawTokens) ? metrics.archivedRawTokens : null;
    const summary = Number.isFinite(metrics.summaryTokens) ? metrics.summaryTokens : null;
    const recent = Number.isFinite(metrics.recentRawTokens) ? metrics.recentRawTokens : null;
    const compacted = Number.isFinite(metrics.compactedTokens) ? metrics.compactedTokens : null;
    const rate = Number.isFinite(before) && before > 0 && Number.isFinite(summary) ? Math.max(0, Math.round((before - summary) / before * 100)) : null;
    return [
        Number.isFinite(before) ? `较早正文 ${before.toLocaleString()} Token` : '',
        Number.isFinite(summary) ? `压缩摘要 ${summary.toLocaleString()} Token` : '',
        Number.isFinite(recent) ? `最近原文 ${recent.toLocaleString()} Token` : '',
        Number.isFinite(compacted) ? `续聊历史部分约 ${compacted.toLocaleString()} Token` : '',
        Number.isFinite(rate) ? `较早正文减少 ${rate}%` : '',
    ].filter(Boolean).join(' · ');
}

function escapeArchiveHtml(value) {
    return String(value ?? '')
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#039;');
}

function renderArchiveDetailsHtml(archiveRecord) {
    const memory = normalizeArchive(archiveRecord.memory, getSubjectIdentity());
    const metrics = archiveRecord.metrics ?? {};
    const metricItems = [
        ['较早正文', metrics.archivedRawTokens, 'Token'],
        ['压缩摘要', metrics.summaryTokens, 'Token'],
        ['最近原文', metrics.recentRawTokens, 'Token'],
        ['续聊历史', metrics.compactedTokens, 'Token'],
    ];
    const rate = Number.isFinite(metrics.archivedRawTokens) && metrics.archivedRawTokens > 0 && Number.isFinite(metrics.summaryTokens)
        ? Math.max(0, Math.round((metrics.archivedRawTokens - metrics.summaryTokens) / metrics.archivedRawTokens * 100))
        : null;
    const sections = [
        ['总体脉络', memory.overview ? [memory.overview] : []],
        ['关系演变及原因', memory.relationshipHistory],
        ['仍有效的承诺与约定', memory.commitments],
        ['尚未解决的线索', memory.openThreads],
        ['已确认且持续有效的事实', memory.durableFacts],
        ['重要人物、地点与物品', memory.importantPeoplePlacesItems],
        ['时间线与长期影响', memory.chronology],
        ['具有持续意义的原话', memory.meaningfulQuotes],
    ];
    const metricHtml = metricItems
        .filter(([, value]) => Number.isFinite(value))
        .map(([label, value, unit]) => `<div class="lsh-archive-metric"><span>${label}</span><strong>${Number(value).toLocaleString()} ${unit}</strong></div>`)
        .join('');
    const rateHtml = Number.isFinite(rate) ? `<div class="lsh-archive-rate"><strong>${rate}%</strong><span>较早正文压缩率</span></div>` : '';
    const sectionHtml = sections
        .filter(([, items]) => items.length)
        .map(([title, items]) => `<section class="lsh-archive-detail-section"><h4>${escapeArchiveHtml(title)} <span>${items.length}</span></h4>${title === '总体脉络'
            ? `<p>${escapeArchiveHtml(items[0])}</p>`
            : `<ul>${items.map(item => `<li>${escapeArchiveHtml(item)}</li>`).join('')}</ul>`}</section>`)
        .join('');
    return `<div class="lsh-archive-view"><div class="lsh-archive-summary-head"><div class="lsh-archive-metric-grid">${metricHtml}</div>${rateHtml}</div><div class="lsh-archive-detail-grid">${sectionHtml}</div></div>`;
}

async function runArchiveUpdate(previousArchive, messages, subject, model) {
    const payload = buildArchiveUpdatePayload(previousArchive, messages, subject);
    const shape = createEmptyArchive(subject);
    let lastError;
    for (let attempt = 1; attempt <= 2; attempt++) {
        try {
            const result = await generateRaw({
                prompt: [{ role: 'user', content: `${JSON.stringify(payload)}\n\nReturn the complete JSON archive with this exact shape:\n${JSON.stringify(shape)}` }],
                systemPrompt: '你是长期剧情档案整理器，只整理已被接受的聊天事实，不写故事。维护一份可持续更新的历史记忆：保留关系演变的原因、承诺、秘密、伏笔和长期后果；删除已经失效的临时状态与重复项。不得推断用户未明确表达的内心。每个事实条目前缀必须包含最有力的来源消息编号，如[消息 12]。只输出一个 JSON 对象。',
                responseLength: 8192,
                trimNames: false,
                model: String(model || '').trim() || null,
                thinking: 'disabled',
                skipChatCompletionSettings: true,
                ignoreGenerationStop: true,
            });
            const parsed = typeof result === 'string' ? JSON.parse(extractJsonObject(removeReasoningFromString(result))) : result;
            const archive = normalizeArchive(parsed, subject);
            assertUsefulArchive(archive);
            return archive;
        } catch (error) {
            lastError = error;
            console.warn(`Living State Harness archive attempt ${attempt} failed`, error);
        }
    }
    throw lastError;
}

function assertUsefulArchive(archive) {
    const factCount = ['chronology', 'relationshipHistory', 'durableFacts', 'commitments', 'openThreads', 'importantPeoplePlacesItems']
        .reduce((sum, key) => sum + (archive[key]?.length ?? 0), 0);
    if (!archive.overview || factCount < 3) throw new Error('历史记忆内容不足，已停止创建续聊。');
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
    $('#lsh_archive_model').val(settings.archiveModel).on('change', function () {
        settings.archiveModel = String($(this).val()).trim();
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
    $('#lsh_archive_keep_recent').val(settings.archiveKeepRecent).on('change', function () {
        settings.archiveKeepRecent = clamp(Number($(this).val()), 10, 50);
        $(this).val(settings.archiveKeepRecent);
        saveSettingsDebounced();
        updateUi();
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
    $('#lsh_calibrate').on('click', calibrateCurrentState);
    $('#lsh_undo_calibration').on('click', undoLastCalibration);
    $('#lsh_reset_state').on('click', confirmResetState);
    $('#lsh_save_state').on('click', saveManualState);
    $('#lsh_archive_continue').on('click', archiveAndContinue);
    $('#lsh_view_archive').on('click', viewStoredArchive);
    $('#lsh_edit_archive').on('click', editStoredArchive);
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
    const messageCount = Array.isArray(context.chat) ? context.chat.length : 0;
    const storedTokens = Array.isArray(context.chat) ? context.chat.reduce((sum, message) => sum + (Number(message?.extra?.token_count) || 0), 0) : 0;

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
    const archive = chat_metadata?.[ARCHIVE_METADATA_KEY];
    const archiveText = archive
        ? [`已承接 ${archive.sourceMessageCount} 条消息`, formatArchiveMetrics(archive.metrics)].filter(Boolean).join('<br>')
        : [
            [`当前 ${messageCount} 条消息`, storedTokens ? `正文累计约 ${storedTokens.toLocaleString()} Token` : ''].filter(Boolean).join(' · '),
            ['error', 'cancelled'].includes(lastArchiveRuntime.status) ? lastArchiveRuntime.detail : '',
        ].filter(Boolean).join('<br>');
    const runningDetail = lastArchiveRuntime.detail || '正在生成历史记忆，请勿切换聊天……';
    $('#lsh_archive_status')[archiveRunning ? 'text' : 'html'](archiveRunning ? runningDetail : archiveText);
    $('#lsh_archive_continue').prop('disabled', archiveRunning || !latest || messageCount < settings.archiveKeepRecent + 10);
    $('#lsh_archive_actions').toggle(Boolean(archive?.memory));
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
