import {
    chat_metadata,
    characters,
    eventSource,
    event_types,
    extension_prompt_roles,
    extension_prompt_types,
    generateRaw,
    getCurrentChatId,
    isGenerating,
    saveSettingsDebounced,
    setExtensionPrompt,
    this_chid,
} from '../../../../script.js';
import { extension_settings, getContext, renderExtensionTemplateAsync, saveMetadataDebounced } from '../../../extensions.js';
import { ConnectionManagerRequestService } from '../../shared.js';
import { selected_group } from '../../../group-chats.js';
import { removeReasoningFromString } from '../../../reasoning.js';
import { getTokenCountAsync } from '../../../tokenizers.js';
import { Popup } from '../../../popup.js';
import {
    DIRECTOR_JSON_SCHEMA,
    buildDirectorRequest,
    buildDirectorSystemPrompt,
    runReviewedDirector,
} from './director.js';
import { getStage, normalizeStoryPackage, validateStoryPackage } from './package.js';
import {
    assertSafeMainModelView,
    isCompletionDirectionReleased,
    PROMPT_KEY,
    renderCompletionMemory,
    renderMainModelView,
} from './prompt.js';
import {
    ASSIGNMENT_METADATA_KEY,
    BASELINE_METADATA_KEY,
    advanceWithoutDecision,
    applyDirectorDecision,
    collectAcceptedMessages,
    createRuntime,
    findLatestSnapshot,
    invalidateSnapshots,
    normalizeRuntime,
    removeSnapshots,
    saveSnapshot,
} from './state.js';

const MODULE_NAME = 'storyController';
const EXTENSION_ID = 'third-party/story-controller';
const TOAST_TITLE = 'Story Controller';
const BUNDLED_S4_PACKAGE_URL = `/scripts/extensions/${EXTENSION_ID}/packages/xiaoya-s4-unfinished-coda.story.json`;
const DEFAULT_SETTINGS = Object.freeze({
    enabled: false,
    frozen: false,
    mode: 'observe',
    directorProfile: '',
    responseTokens: 2048,
    messageWindow: 10,
    depth: 2,
    selectedPackageKey: '',
});

let historyRevision = 0;
let evaluationPromise = null;
let lastRuntime = {
    status: 'idle',
    error: '',
    decision: null,
    attempts: 0,
    durationMs: 0,
    inputTokens: null,
    outputTokens: null,
    injectionTokens: null,
    updatedAt: null,
};

function packageKey(story) {
    return `${story.storyId}@${story.version}`;
}

function clamp(value, minimum, maximum) {
    return Math.min(maximum, Math.max(minimum, Number.isFinite(value) ? value : minimum));
}

function getSettings() {
    extension_settings[MODULE_NAME] ??= {};
    const settings = extension_settings[MODULE_NAME];
    const shouldAdoptHarnessProfile = !Object.hasOwn(settings, 'directorProfile');
    for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) settings[key] ??= value;
    if (shouldAdoptHarnessProfile && typeof extension_settings.livingStateHarness?.updaterProfile === 'string') {
        settings.directorProfile = extension_settings.livingStateHarness.updaterProfile;
    }
    if (!Array.isArray(settings.packages)) settings.packages = [];
    settings.mode = ['observe', 'control'].includes(settings.mode) ? settings.mode : 'observe';
    settings.depth = [1, 2, 4].includes(Number(settings.depth)) ? Number(settings.depth) : 2;
    settings.responseTokens = clamp(Number(settings.responseTokens), 1024, 4096);
    settings.messageWindow = clamp(Number(settings.messageWindow), 4, 30);
    return settings;
}

function getValidPackages() {
    return getSettings().packages.filter(story => validateStoryPackage(story).valid);
}

function findPackage(storyId, storyVersion) {
    return getValidPackages().find(story => story.storyId === storyId && Number(story.version) === Number(storyVersion)) ?? null;
}

function getSelectedPackage() {
    const key = getSettings().selectedPackageKey;
    return getValidPackages().find(story => packageKey(story) === key) ?? null;
}

function getAssignment() {
    const value = chat_metadata?.[ASSIGNMENT_METADATA_KEY];
    return value && typeof value === 'object' ? value : null;
}

function getActiveStory() {
    const assignment = getAssignment();
    if (!assignment) return null;
    return findPackage(assignment.storyId, assignment.storyVersion);
}

function getBaseline(story) {
    const value = chat_metadata?.[BASELINE_METADATA_KEY];
    if (value?.storyId === story.storyId && Number(value.storyVersion) === Number(story.version)) {
        return normalizeRuntime(value.runtime, story);
    }
    return createRuntime(story);
}

function setBaseline(story, runtime) {
    chat_metadata[BASELINE_METADATA_KEY] = {
        storyId: story.storyId,
        storyVersion: story.version,
        runtime: normalizeRuntime(runtime, story),
        savedAt: new Date().toISOString(),
    };
    saveMetadataDebounced();
}

function getRuntimeEntry(story, beforeOrAt = Number.POSITIVE_INFINITY) {
    const chat = getContext().chat ?? [];
    const latest = findLatestSnapshot(chat, story, beforeOrAt);
    const baseline = getBaseline(story);
    if (!latest || baseline.processedThroughMessageId > latest.runtime.processedThroughMessageId) {
        return { index: -1, snapshot: null, runtime: baseline, source: 'baseline' };
    }
    return { ...latest, source: 'snapshot' };
}

function clearInjection() {
    setExtensionPrompt(PROMPT_KEY, '', extension_prompt_types.IN_CHAT, getSettings().depth, false, extension_prompt_roles.SYSTEM);
    lastRuntime.injectionTokens = null;
    lastRuntime.injectionMode = null;
}

async function safeTokenCount(value) {
    try {
        return await getTokenCountAsync(String(value ?? ''), 0);
    } catch {
        return null;
    }
}

async function injectRuntime(story, runtime) {
    const settings = getSettings();
    if (!settings.enabled || settings.mode !== 'control') {
        clearInjection();
        return;
    }
    const released = isCompletionDirectionReleased(story, runtime, getContext().chat);
    const prompt = assertSafeMainModelView(story, runtime, released ? renderCompletionMemory(story) : renderMainModelView(story, runtime));
    setExtensionPrompt(PROMPT_KEY, prompt, extension_prompt_types.IN_CHAT, settings.depth, false, extension_prompt_roles.SYSTEM);
    lastRuntime.injectionTokens = await safeTokenCount(prompt);
    lastRuntime.injectionMode = released ? 'memory' : 'direction';
}

async function restoreInjection() {
    const settings = getSettings();
    const story = getActiveStory();
    if (!settings.enabled || !story || selected_group || !Array.isArray(getContext().chat)) {
        clearInjection();
        return;
    }
    await injectRuntime(story, getRuntimeEntry(story).runtime);
}

function getProfiles() {
    try {
        return ConnectionManagerRequestService.getSupportedProfiles();
    } catch (error) {
        console.warn('Story Controller could not read connection profiles:', error);
        return [];
    }
}

function populateProfiles() {
    const settings = getSettings();
    const select = $('#sc_director_profile').empty();
    select.append($('<option></option>').val('').text('使用当前正文连接'));
    for (const profile of getProfiles()) {
        select.append($('<option></option>').val(profile.id).text(`${profile.name} · ${profile.model || '默认模型'}`));
    }
    if (settings.directorProfile && !getProfiles().some(profile => profile.id === settings.directorProfile)) {
        select.append($('<option></option>').val(settings.directorProfile).text(`不可用连接 · ${settings.directorProfile}`));
    }
    select.val(settings.directorProfile || '');
}

function requestOverrides(profileId) {
    const profile = getProfiles().find(item => item.id === profileId);
    const isCustomDeepSeek = profile?.api === 'custom' && /deepseek/i.test(`${profile.model || ''} ${profile['api-url'] || ''}`);
    if (isCustomDeepSeek) {
        return {
            custom_include_body: JSON.stringify({
                thinking: { type: 'disabled' },
                response_format: { type: 'json_object' },
                temperature: 0,
            }),
        };
    }
    return { json_schema: DIRECTOR_JSON_SCHEMA };
}

async function runDirectorCompletion(story, runtime, messages, referenceMessages, correction) {
    const settings = getSettings();
    const systemPrompt = buildDirectorSystemPrompt();
    const prompt = buildDirectorRequest(story, runtime, messages, correction, referenceMessages);
    if (!settings.directorProfile) {
        return generateRaw({
            prompt,
            systemPrompt,
            responseLength: settings.responseTokens,
            trimNames: false,
            jsonSchema: DIRECTOR_JSON_SCHEMA,
        });
    }
    const result = await ConnectionManagerRequestService.sendRequest(
        settings.directorProfile,
        [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: prompt },
        ],
        settings.responseTokens,
        { extractData: true, includePreset: false, stream: false },
        requestOverrides(settings.directorProfile),
    );
    if (result?.content === undefined || result?.content === null || result?.content === '') throw new Error('Director connection returned no content.');
    return removeReasoningFromString(String(result.content));
}

function latestUserMessageId(chat) {
    for (let index = chat.length - 1; index >= 0; index--) if (chat[index]?.is_user) return index;
    return -1;
}

async function evaluateThrough(story, targetMessageId, { force = false } = {}) {
    if (evaluationPromise) return evaluationPromise;
    evaluationPromise = (async () => {
        const settings = getSettings();
        const context = getContext();
        const chat = context.chat;
        const target = chat?.[targetMessageId];
        if (!Array.isArray(chat) || !target?.is_user) return;
        const existing = findLatestSnapshot(chat, story, targetMessageId);
        if (!force && existing?.index === targetMessageId && existing.runtime.processedThroughMessageId >= targetMessageId) return;

        const previousEntry = getRuntimeEntry(story, targetMessageId - 1);
        const previous = previousEntry.runtime;
        if (!force && previous.processedThroughMessageId >= targetMessageId) return;
        const messages = collectAcceptedMessages(chat, previous.processedThroughMessageId, targetMessageId, settings.messageWindow);
        if (!messages.length) return;
        const referenceMessages = collectAcceptedMessages(
            chat,
            Math.max(-1, previous.processedThroughMessageId - settings.messageWindow),
            previous.processedThroughMessageId,
            settings.messageWindow,
        );
        const revision = historyRevision;
        const startedAt = performance.now();
        lastRuntime = { ...lastRuntime, status: 'updating', error: '', decision: null, attempts: 0 };
        updateUi();
        try {
            const requestText = buildDirectorRequest(story, previous, messages, '', referenceMessages);
            lastRuntime.inputTokens = await safeTokenCount(requestText);
            const reviewed = await runReviewedDirector(
                correction => runDirectorCompletion(story, previous, messages, referenceMessages, correction),
                story,
                previous,
                messages,
                async (error, attempt) => {
                    console.warn(`Story Controller Director attempt ${attempt} needs repair`, error);
                    await new Promise(resolve => setTimeout(resolve, 300));
                },
            );
            if (revision !== historyRevision || getContext().chat !== chat || chat[targetMessageId] !== target) {
                lastRuntime = { ...lastRuntime, status: 'stale', error: '', updatedAt: new Date().toISOString() };
                return;
            }
            const commit = settings.mode === 'control';
            const applied = applyDirectorDecision(previous, story, reviewed.decision, targetMessageId, { commit });
            saveSnapshot(target, targetMessageId, story, applied.runtime, {
                kind: commit ? 'controlled' : 'observed',
                decision: commit ? reviewed.decision : null,
                observation: commit ? null : reviewed.decision,
            });
            await context.saveChat();
            await injectRuntime(story, applied.runtime);
            lastRuntime = {
                status: commit ? (applied.transitioned ? 'advanced' : 'held') : 'observed',
                error: '',
                decision: reviewed.decision,
                attempts: reviewed.attempts,
                durationMs: Math.round(performance.now() - startedAt),
                inputTokens: lastRuntime.inputTokens,
                outputTokens: await safeTokenCount(JSON.stringify(reviewed.decision)),
                injectionTokens: lastRuntime.injectionTokens,
                updatedAt: new Date().toISOString(),
            };
        } catch (error) {
            console.error('Story Controller evaluation failed', error);
            const runtime = advanceWithoutDecision(previous, story, targetMessageId);
            saveSnapshot(target, targetMessageId, story, runtime, {
                kind: 'skipped',
                error: error instanceof Error ? error.message : String(error),
            });
            await context.saveChat();
            await injectRuntime(story, runtime);
            lastRuntime = {
                ...lastRuntime,
                status: 'error',
                error: error instanceof Error ? error.message : String(error),
                decision: null,
                durationMs: Math.round(performance.now() - startedAt),
                updatedAt: new Date().toISOString(),
            };
            toastr.warning('Director 判断失败，剧情保持原阶段，正文仍可继续。', TOAST_TITLE);
        } finally {
            updateUi();
        }
    })();
    try {
        return await evaluationPromise;
    } finally {
        evaluationPromise = null;
    }
}

async function interceptor() {
    const settings = getSettings();
    const story = getActiveStory();
    const context = getContext();
    const chat = context.chat;
    if (!settings.enabled || !story || selected_group || !Array.isArray(chat) || !characters[this_chid]) {
        clearInjection();
        updateUi();
        return;
    }
    const lastMessageId = chat.length - 1;
    if (!settings.frozen && chat[lastMessageId]?.is_user) await evaluateThrough(story, lastMessageId);
    await restoreInjection();
    updateUi();
}

function populatePackages() {
    const settings = getSettings();
    const packages = getValidPackages();
    const select = $('#sc_package_select').empty();
    select.append($('<option></option>').val('').text('选择剧情包'));
    for (const story of packages) select.append($('<option></option>').val(packageKey(story)).text(`${story.storyId} · v${story.version}`));
    if (settings.selectedPackageKey && packages.some(story => packageKey(story) === settings.selectedPackageKey)) select.val(settings.selectedPackageKey);
    else {
        settings.selectedPackageKey = '';
        select.val('');
    }
}

async function storePackage(input) {
    const story = normalizeStoryPackage(input);
    const settings = getSettings();
    const key = packageKey(story);
    const existingIndex = settings.packages.findIndex(item => packageKey(item) === key);
    if (existingIndex >= 0) {
        const approved = await Popup.show.confirm('替换剧情包？', `${key} 已存在。相同版本的结构变化可能使旧快照失效；推荐修改内容后提升 version。`);
        if (!approved) return;
        settings.packages.splice(existingIndex, 1, story);
    } else {
        settings.packages.push(story);
    }
    settings.selectedPackageKey = key;
    saveSettingsDebounced();
    populatePackages();
    updateUi();
    toastr.success(`已导入 ${key}，尚未绑定聊天。`, TOAST_TITLE);
}

async function importPackageFile(file) {
    if (!file) return;
    if (file.size > 2_000_000) throw new Error('剧情包超过 2 MB。');
    await storePackage(JSON.parse(await file.text()));
}

async function loadBundledS4Package() {
    const response = await fetch(BUNDLED_S4_PACKAGE_URL, { cache: 'no-store' });
    if (!response.ok) throw new Error(`内置剧情包读取失败（HTTP ${response.status}）。`);
    await storePackage(await response.json());
}

async function bindSelectedPackage() {
    const story = getSelectedPackage();
    const context = getContext();
    if (!story) return toastr.warning('请先选择剧情包。', TOAST_TITLE);
    if (!getCurrentChatId() || !Array.isArray(context.chat) || selected_group) return toastr.warning('请先打开一个单角色聊天。', TOAST_TITLE);
    const legacyNote = story.storyId === 'xiaoya-s4-unfinished-coda'
        ? ' 如果角色世界书仍启用旧版 OM-00～OM-E1 条目，请先停用那些条目，避免两个剧情系统同时发令；本操作不会自动修改世界书。'
        : '';
    const approved = await Popup.show.confirm('绑定当前聊天？', `将从当前消息起以 ${story.storyId} v${story.version} 的开场阶段运行，不会回写之前的聊天。${legacyNote}`);
    if (!approved) return;
    chat_metadata[ASSIGNMENT_METADATA_KEY] = { storyId: story.storyId, storyVersion: story.version, assignedAt: new Date().toISOString() };
    const runtime = createRuntime(story, context.chat.length - 1);
    setBaseline(story, runtime);
    removeSnapshots(context.chat);
    await context.saveChat();
    historyRevision += 1;
    lastRuntime = { ...lastRuntime, status: 'idle', error: '', decision: null };
    await restoreInjection();
    updateUi();
    toastr.success('剧情包已绑定当前聊天。', TOAST_TITLE);
}

async function unbindCurrentChat() {
    const context = getContext();
    if (!getAssignment()) return;
    const approved = await Popup.show.confirm('解除剧情绑定？', '将删除当前聊天的 Story Controller 快照与基线；原聊天正文不会删除。');
    if (!approved) return;
    delete chat_metadata[ASSIGNMENT_METADATA_KEY];
    delete chat_metadata[BASELINE_METADATA_KEY];
    if (Array.isArray(context.chat)) removeSnapshots(context.chat);
    saveMetadataDebounced();
    await context.saveChat();
    historyRevision += 1;
    clearInjection();
    updateUi();
}

async function removeSelectedPackage() {
    const story = getSelectedPackage();
    if (!story) return;
    const approved = await Popup.show.confirm('删除剧情包？', `将从扩展设置中删除 ${packageKey(story)}。其他聊天若仍绑定它，将安全停用，正文不会删除。`);
    if (!approved) return;
    const settings = getSettings();
    settings.packages = settings.packages.filter(item => packageKey(item) !== packageKey(story));
    settings.selectedPackageKey = '';
    saveSettingsDebounced();
    populatePackages();
    await restoreInjection();
    updateUi();
}

async function resetProgress(stageId = null) {
    const story = getActiveStory();
    const context = getContext();
    if (!story || !Array.isArray(context.chat)) return;
    const selectedStage = getStage(story, stageId) ?? getStage(story, story.entryStageId);
    const approved = await Popup.show.confirm('重设剧情阶段？', `将从当前消息起使用“${selectedStage.spoilerSafeName}”，并清除当前聊天已有的 Story Controller 快照。`);
    if (!approved) return;
    const runtime = createRuntime(story, context.chat.length - 1);
    runtime.currentStageId = selectedStage.id;
    runtime.visitedStageIds = selectedStage.id === story.entryStageId ? [story.entryStageId] : [story.entryStageId, selectedStage.id];
    runtime.status = selectedStage.terminal ? 'completed' : 'active';
    runtime.completedAtMessageId = selectedStage.terminal ? context.chat.length - 1 : null;
    setBaseline(story, runtime);
    removeSnapshots(context.chat);
    await context.saveChat();
    historyRevision += 1;
    lastRuntime = { ...lastRuntime, status: 'manual', error: '', decision: null };
    await restoreInjection();
    updateUi();
}

async function retryLatest() {
    const settings = getSettings();
    const story = getActiveStory();
    const context = getContext();
    if (!settings.enabled || settings.frozen || !story || !Array.isArray(context.chat)) return;
    if (isGenerating() || evaluationPromise) return toastr.warning('当前正在生成或判断，请稍后重试。', TOAST_TITLE);
    const targetMessageId = latestUserMessageId(context.chat);
    if (targetMessageId < 0) return;
    invalidateSnapshots(context.chat, targetMessageId);
    await context.saveChat();
    historyRevision += 1;
    await evaluateThrough(story, targetMessageId, { force: true });
    await restoreInjection();
}

async function onHistoryChanged(messageId = 0) {
    historyRevision += 1;
    const context = getContext();
    if (!Array.isArray(context.chat)) return;
    if (invalidateSnapshots(context.chat, Number(messageId) || 0)) await context.saveChat();
    lastRuntime = { ...lastRuntime, status: 'stale', error: '', decision: null };
    await restoreInjection();
    updateUi();
}

function statusView() {
    const settings = getSettings();
    const assignment = getAssignment();
    const story = getActiveStory();
    if (!settings.enabled) return { state: 'disabled', label: '已关闭', short: '剧情控制' };
    if (!assignment) return { state: 'empty', label: '等待绑定剧情包', short: '剧情未绑定' };
    if (!story) return { state: 'error', label: '绑定的剧情包不可用', short: '剧情包缺失' };
    if (settings.frozen) return { state: 'frozen', label: '阶段已冻结', short: '剧情已冻结' };
    if (lastRuntime.status === 'updating') return { state: 'updating', label: 'Director 正在判断', short: '剧情判断中' };
    if (lastRuntime.status === 'error') return { state: 'error', label: '判断失败 · 保持原阶段', short: '剧情判断异常' };
    if (settings.mode === 'observe') return { state: 'observe', label: '观察模式 · 不推进不注入', short: '剧情观察中' };
    const runtime = getRuntimeEntry(story).runtime;
    if (runtime.status === 'completed') {
        const released = isCompletionDirectionReleased(story, runtime, getContext().chat);
        return released
            ? { state: 'completed', label: '剧情已完成 · 保留关系记忆', short: '剧情已完成' }
            : { state: 'active', label: '已进入收束阶段', short: '剧情收束' };
    }
    return { state: 'active', label: `控制模式 · 版本 ${runtime.version}`, short: '剧情控制' };
}

function metric(label, value) {
    return $('<div class="sc-metric"></div>').append($('<span></span>').text(label), $('<strong></strong>').text(value));
}

function threadStatusLabel(value) {
    return {
        active: '主线活跃',
        deferred: '主线暂存',
        paused: '主线暂停',
        reentry_offered: '已自然回引',
    }[value] ?? '主线活跃';
}

function updateUi() {
    const settings = getSettings();
    const story = getActiveStory();
    const status = statusView();
    $('#sc_settings_status, #sc_panel_status').text(status.label).attr('data-state', status.state);
    $('#sc_panel_toggle').attr('data-state', status.state).toggle(settings.enabled);
    $('#sc_toggle_text').text(status.short);
    $('#sc_enabled').prop('checked', settings.enabled);
    $('#sc_frozen').prop('checked', settings.frozen);
    $('#sc_mode').val(settings.mode);
    const assignment = getAssignment();
    $('#sc_assignment_note').text(assignment
        ? `当前聊天：${assignment.storyId} · v${assignment.storyVersion}${story ? '' : '（剧情包缺失）'}`
        : '当前聊天尚未绑定剧情包。导入不会自动启用，必须明确绑定。');
    $('#sc_story_name').text(story?.title ?? story?.storyId ?? '未绑定剧情');

    const eventsRoot = $('#sc_events').empty();
    const metrics = $('#sc_metrics').empty();
    const decision = $('#sc_decision');
    const stageSelect = $('#sc_manual_stage').empty();
    if (!story) {
        $('#sc_stage_name').text('尚未开始');
        $('#sc_stage_objective').text('绑定剧情包后显示无剧透目标。');
        $('#sc_stage_mode').empty();
        eventsRoot.append($('<div class="sc-empty"></div>').text('暂无剧情状态。'));
        decision.text('—');
        return;
    }
    const entry = getRuntimeEntry(story);
    const runtime = entry.runtime;
    const stage = getStage(story, runtime.currentStageId);
    $('#sc_stage_name').text(stage?.spoilerSafeName ?? runtime.currentStageId);
    $('#sc_stage_objective').text(stage?.publicObjective ?? '阶段信息不可用。');
    $('#sc_stage_mode').empty()
        .append($('<span class="sc-chip"></span>').text(settings.mode === 'control' ? '控制模式' : '观察模式'))
        .append($('<span class="sc-chip"></span>').text(runtime.activeInteractionMode))
        .append($('<span class="sc-chip"></span>').text(threadStatusLabel(runtime.threadStatus)))
        .append($('<span class="sc-chip"></span>').text(runtime.status === 'completed'
            ? (isCompletionDirectionReleased(story, runtime, getContext().chat) ? '已完成' : '收束阶段')
            : '进行中'));

    const eventMap = new Map(story.events.map(item => [item.id, item]));
    if (!runtime.confirmedEventIds.length) eventsRoot.append($('<div class="sc-empty"></div>').text('尚无已确认 OM。'));
    for (const eventId of runtime.confirmedEventIds) {
        const item = $('<div class="sc-list-item"></div>').append($('<strong></strong>').text(eventMap.get(eventId)?.description ?? eventId));
        const evidence = runtime.eventEvidence[eventId] ?? [];
        if (evidence.length) {
            const details = $('<details></details>').append($('<summary></summary>').text(`${evidence.length} 条原文证据`));
            details.append($('<div></div>').css('white-space', 'pre-wrap').text(evidence.map(value => `消息 #${value.messageId}：${value.quote}`).join('\n')));
            item.append(details);
        }
        eventsRoot.append(item);
    }

    metrics
        .append(metric('状态版本', runtime.version))
        .append(metric('已处理消息', runtime.processedThroughMessageId))
        .append(metric('判断尝试', lastRuntime.attempts || '—'))
        .append(metric('耗时', lastRuntime.durationMs ? `${lastRuntime.durationMs} ms` : '—'))
        .append(metric('输入', Number.isFinite(lastRuntime.inputTokens) ? `${lastRuntime.inputTokens} Token` : '—'))
        .append(metric('注入', Number.isFinite(lastRuntime.injectionTokens) ? `${lastRuntime.injectionTokens} Token` : '—'));
    const latestDecision = entry.snapshot?.decision ?? entry.snapshot?.observation ?? lastRuntime.decision;
    decision.text(lastRuntime.error || (latestDecision ? JSON.stringify(latestDecision, null, 2) : '暂无判断记录。'));
    for (const candidate of story.stages) stageSelect.append($('<option></option>').val(candidate.id).text(candidate.spoilerSafeName));
    stageSelect.val(runtime.currentStageId);
}

function togglePanel(open) {
    $('#sc_panel').toggleClass('open', Boolean(open)).attr('aria-hidden', String(!open));
}

function bindSettings() {
    const settings = getSettings();
    populateProfiles();
    populatePackages();
    $('#sc_enabled').prop('checked', settings.enabled).on('input', async function () {
        settings.enabled = Boolean($(this).prop('checked'));
        saveSettingsDebounced();
        await restoreInjection();
        updateUi();
    });
    $('#sc_frozen').prop('checked', settings.frozen).on('input', async function () {
        settings.frozen = Boolean($(this).prop('checked'));
        saveSettingsDebounced();
        await restoreInjection();
        updateUi();
    });
    $('#sc_mode').val(settings.mode).on('change', async function () {
        settings.mode = String($(this).val()) === 'control' ? 'control' : 'observe';
        saveSettingsDebounced();
        await restoreInjection();
        updateUi();
        if (settings.mode === 'control') toastr.info('控制模式从下一条未处理消息开始；如需重放，请重置阶段。', TOAST_TITLE);
    });
    $('#sc_director_profile').on('change', function () {
        settings.directorProfile = String($(this).val() || '');
        saveSettingsDebounced();
    });
    $('#sc_depth').val(settings.depth).on('change', async function () {
        settings.depth = [1, 2, 4].includes(Number($(this).val())) ? Number($(this).val()) : 2;
        saveSettingsDebounced();
        await restoreInjection();
    });
    $('#sc_message_window').val(settings.messageWindow).on('change', function () {
        settings.messageWindow = clamp(Number($(this).val()), 4, 30);
        $(this).val(settings.messageWindow);
        saveSettingsDebounced();
    });
    $('#sc_package_select').on('change', function () {
        settings.selectedPackageKey = String($(this).val() || '');
        saveSettingsDebounced();
    });
    $('#sc_load_s4_package').on('click', async () => {
        try {
            await loadBundledS4Package();
        } catch (error) {
            toastr.error(error instanceof Error ? error.message : String(error), '内置剧情包无效');
        }
    });
    $('#sc_import_package').on('click', () => $('#sc_package_file').trigger('click'));
    $('#sc_package_file').on('change', async function () {
        try {
            await importPackageFile(this.files?.[0]);
        } catch (error) {
            toastr.error(error instanceof Error ? error.message : String(error), '剧情包无效');
        } finally {
            this.value = '';
        }
    });
    $('#sc_bind_package').on('click', bindSelectedPackage);
    $('#sc_unbind_package').on('click', unbindCurrentChat);
    $('#sc_remove_package').on('click', removeSelectedPackage);
    $('#sc_open_panel, #sc_panel_toggle').on('click', () => togglePanel(true));
    $('#sc_close_panel').on('click', () => togglePanel(false));
    $('#sc_retry, #sc_panel_retry').on('click', retryLatest);
    $('#sc_set_stage').on('click', () => resetProgress(String($('#sc_manual_stage').val() || '')));
    $('#sc_reset_progress').on('click', () => resetProgress());
}

globalThis.storyControllerInterceptor = interceptor;

export async function init() {
    getSettings();
    saveSettingsDebounced();
    const settingsHtml = await renderExtensionTemplateAsync(EXTENSION_ID, 'settings');
    $('#extensions_settings').append(settingsHtml);
    const panelHtml = await renderExtensionTemplateAsync(EXTENSION_ID, 'panel');
    $('body').append(panelHtml);
    bindSettings();
    eventSource.on(event_types.CHAT_CHANGED, async () => {
        historyRevision += 1;
        lastRuntime = { ...lastRuntime, status: 'idle', error: '', decision: null, attempts: 0, durationMs: 0 };
        await restoreInjection();
        updateUi();
    });
    eventSource.on(event_types.MESSAGE_EDITED, onHistoryChanged);
    eventSource.on(event_types.MESSAGE_DELETED, onHistoryChanged);
    eventSource.on(event_types.MESSAGE_SWIPED, async messageId => {
        if (Number.isInteger(Number(messageId))) await onHistoryChanged(Number(messageId) + 1);
        else {
            await restoreInjection();
            updateUi();
        }
    });
    await restoreInjection();
    updateUi();
}
