export const SNAPSHOT_KEY = 'living_state_harness';
export const PROMPT_KEY = 'living_state_harness';
export const RESPONSE_PROMPT_KEY = 'living_state_harness_response_contract';
export const OUTPUT_VALIDATION_KEY = 'living_state_harness_output_validation';
export const REASONING_RECOVERY_KEY = 'living_state_harness_reasoning_recovery';
export const STATE_SCHEMA_VERSION = 2;

const LIST_LIMITS = Object.freeze({
    recentEvents: 5,
    upcomingObligations: 5,
    peopleOnMind: 5,
    evolvedPreferences: 5,
    importantFacts: 8,
    openPromises: 5,
    openThreads: 5,
    recentTurningPoints: 5,
});

export function createEmptyState(subject = {}) {
    return {
        schemaVersion: STATE_SCHEMA_VERSION,
        subject: normalizeSubject(subject),
        version: 0,
        processedThroughMessageId: -1,
        scene: {
            location: '',
            presentCharacters: [],
            immediateSituation: '',
        },
        character: {
            currentMood: '',
            physicalState: '',
            attentionFocus: '',
            currentGoal: '',
            currentConcern: '',
            privateImpulse: '',
            inhibition: '',
        },
        agency: {
            currentPlan: '',
            initiativeSeed: '',
            boundary: '',
            responseIfBlocked: '',
        },
        relationship: {
            trust: '',
            emotionalCloseness: '',
            authorityDynamic: '',
            currentTension: '',
            evolvedPreferences: [],
        },
        offscreenLife: {
            recentEvents: [],
            upcomingObligations: [],
            peopleOnMind: [],
        },
        continuity: {
            importantFacts: [],
            openPromises: [],
            openThreads: [],
        },
        recentTurningPoints: [],
    };
}

export function cloneState(state) {
    return structuredClone(state ?? createEmptyState());
}

export function normalizeState(input, subject = null) {
    const base = createEmptyState(subject ?? input?.subject);
    if (!input || typeof input !== 'object') return base;

    base.schemaVersion = STATE_SCHEMA_VERSION;
    base.subject = normalizeSubject(subject ?? input.subject);
    base.version = numberOr(input.version, 0);
    base.processedThroughMessageId = numberOr(input.processedThroughMessageId, -1);
    mergeStringFields(base.scene, input.scene, ['location', 'immediateSituation']);
    base.scene.presentCharacters = stringArray(input.scene?.presentCharacters, 12);
    mergeStringFields(base.character, input.character, Object.keys(base.character));
    mergeStringFields(base.agency, input.agency, Object.keys(base.agency));
    mergeStringFields(base.relationship, input.relationship, ['trust', 'emotionalCloseness', 'authorityDynamic', 'currentTension']);
    base.relationship.evolvedPreferences = normalizeItems(input.relationship?.evolvedPreferences, LIST_LIMITS.evolvedPreferences);
    base.offscreenLife.recentEvents = normalizeItems(input.offscreenLife?.recentEvents, LIST_LIMITS.recentEvents);
    base.offscreenLife.upcomingObligations = normalizeItems(input.offscreenLife?.upcomingObligations, LIST_LIMITS.upcomingObligations);
    base.offscreenLife.peopleOnMind = normalizeItems(input.offscreenLife?.peopleOnMind, LIST_LIMITS.peopleOnMind);
    base.continuity.importantFacts = normalizeItems(input.continuity?.importantFacts, LIST_LIMITS.importantFacts);
    base.continuity.openPromises = normalizeItems(input.continuity?.openPromises, LIST_LIMITS.openPromises);
    base.continuity.openThreads = normalizeItems(input.continuity?.openThreads, LIST_LIMITS.openThreads);
    base.recentTurningPoints = normalizeItems(input.recentTurningPoints, LIST_LIMITS.recentTurningPoints);
    return base;
}

export function findLatestSnapshot(chat, beforeOrAt = Number.POSITIVE_INFINITY, subject = null) {
    for (let index = Math.min(chat.length - 1, beforeOrAt); index >= 0; index--) {
        const snapshot = chat[index]?.extra?.[SNAPSHOT_KEY];
        if (snapshot?.valid !== false && isCompatibleState(snapshot?.state, subject)) {
            return { index, snapshot, state: normalizeState(snapshot.state, subject) };
        }
    }
    return null;
}

export function invalidateSnapshots(chat, fromMessageId) {
    let changed = false;
    for (let index = Math.max(0, Number(fromMessageId) || 0); index < chat.length; index++) {
        const snapshot = chat[index]?.extra?.[SNAPSHOT_KEY];
        if (snapshot && snapshot.valid !== false) {
            snapshot.valid = false;
            changed = true;
        }
    }
    return changed;
}

export function sanitizeEvidenceText(text) {
    return String(text ?? '')
        .replace(/<thinking>[\s\S]*?<\/thinking>/gi, '')
        .replace(/<!--\s*Start the ECoT\s*-->[\s\S]*?<!--\s*End of The ECoT\s*-->/gi, '')
        .replace(/^\s*ECoT\s*[：:]\s*\*[\s\S]*?\*(?=\s*<content>)/i, '')
        .replace(/<meow_FM>[\s\S]*?<\/meow_FM>/gi, '')
        .replace(/<branches\b[^>]*>[\s\S]*?<\/branches>/gi, '')
        .replace(/<prologue\b[^>]*>[\s\S]*?<\/prologue>/gi, '')
        .replace(/<(?:seeds|status|state_bar|小剧场)\b[^>]*>[\s\S]*?<\/(?:seeds|status|state_bar|小剧场)>/gi, '')
        .trim();
}

export function collectMessages(chat, afterMessageId, throughMessageId, maximum) {
    const start = Math.max(0, Number(afterMessageId) + 1);
    const end = Math.min(chat.length - 1, throughMessageId);
    return chat
        .slice(start, end + 1)
        .map((message, offset) => ({
            id: start + offset,
            role: message.is_user ? 'user' : 'assistant',
            name: String(message.name ?? ''),
            content: sanitizeEvidenceText(message.mes),
        }))
        .filter(message => message.content)
        .slice(-maximum);
}

export function mergeDelta(previousState, delta, evidenceIds, throughMessageId, subject = null) {
    const targetSubject = normalizeSubject(subject ?? previousState?.subject);
    assertDeltaSubject(delta, targetSubject);
    const state = normalizeState(previousState, targetSubject);
    const before = stableStringify(state);
    const allowedEvidence = new Set(evidenceIds.map(Number));

    applyStringChanges(state.scene, delta?.sceneChanges, ['location', 'immediateSituation']);
    if (Array.isArray(delta?.sceneChanges?.presentCharacters)) {
        state.scene.presentCharacters = stringArray(delta.sceneChanges.presentCharacters, 12);
    }
    applyStringChanges(state.character, delta?.characterChanges, Object.keys(state.character));
    applyStringChanges(state.agency, delta?.agencyChanges, Object.keys(state.agency));
    applyStringChanges(state.relationship, delta?.relationshipChanges, ['trust', 'emotionalCloseness', 'authorityDynamic', 'currentTension']);

    updateList(state.relationship.evolvedPreferences, delta?.relationshipChanges?.evolvedPreferencesAdd, delta?.relationshipChanges?.evolvedPreferenceIdsRemove, allowedEvidence, 'preference', LIST_LIMITS.evolvedPreferences);
    updateList(state.offscreenLife.recentEvents, delta?.offscreenLifeChanges?.recentEventsAdd, delta?.offscreenLifeChanges?.recentEventIdsRemove, allowedEvidence, 'event', LIST_LIMITS.recentEvents);
    updateList(state.offscreenLife.upcomingObligations, delta?.offscreenLifeChanges?.upcomingObligationsAdd, delta?.offscreenLifeChanges?.upcomingObligationIdsClose, allowedEvidence, 'obligation', LIST_LIMITS.upcomingObligations);
    updateList(state.offscreenLife.peopleOnMind, delta?.offscreenLifeChanges?.peopleOnMindAdd, delta?.offscreenLifeChanges?.peopleOnMindIdsRemove, allowedEvidence, 'person', LIST_LIMITS.peopleOnMind);
    updateList(state.continuity.importantFacts, delta?.continuityChanges?.importantFactsAdd, delta?.continuityChanges?.importantFactIdsRemove, allowedEvidence, 'fact', LIST_LIMITS.importantFacts);
    updateList(state.continuity.openPromises, delta?.continuityChanges?.openPromisesAdd, delta?.continuityChanges?.openPromiseIdsClose, allowedEvidence, 'promise', LIST_LIMITS.openPromises);
    updateList(state.continuity.openThreads, delta?.continuityChanges?.openThreadsAdd, delta?.continuityChanges?.openThreadIdsClose, allowedEvidence, 'thread', LIST_LIMITS.openThreads);
    updateList(state.recentTurningPoints, delta?.turningPointsAdd, delta?.turningPointIdsRemove, allowedEvidence, 'turning-point', LIST_LIMITS.recentTurningPoints);

    state.processedThroughMessageId = Number(throughMessageId);
    const comparisonState = cloneState(state);
    comparisonState.version = previousState?.version ?? 0;
    comparisonState.processedThroughMessageId = previousState?.processedThroughMessageId ?? -1;
    const changed = stableStringify(comparisonState) !== before;
    state.version = (previousState?.version ?? 0) + (changed ? 1 : 0);
    return { state, changed };
}

export function formatStateForPrompt(input, subject = null) {
    const state = normalizeState(input, subject);
    const characterName = state.subject.name || 'the active character';
    const counterpartName = state.subject.counterpartName || 'the user';
    const seenListItems = [];
    const lines = [
        `[Current Living State for character "${characterName}" only — private working context; never quote, explain, or enumerate it in the reply.]`,
        `Subject: character "${characterName}"`,
        `Counterpart: user "${counterpartName}"`,
        formatLine('Scene', [state.scene.location, state.scene.immediateSituation].filter(Boolean).join('；')),
        formatLine('Present', state.scene.presentCharacters.join('、')),
        formatLine(`${characterName}.Mood`, state.character.currentMood),
        formatLine(`${characterName}.Physical state`, state.character.physicalState),
        formatLine(`${characterName}.Attention`, state.character.attentionFocus),
        formatLine(`${characterName}.Current goal`, state.character.currentGoal),
        formatLine(`${characterName}.Concern`, state.character.currentConcern),
        formatLine(`${characterName}.Plan`, state.agency.currentPlan),
        formatLine(`${characterName}.Possible initiative`, state.agency.initiativeSeed),
        formatLine(`${characterName}.Impulse / inhibition`, [state.character.privateImpulse, state.character.inhibition].filter(Boolean).join('；')),
        formatLine(`${characterName}.Boundary`, [state.agency.boundary, state.agency.responseIfBlocked].filter(Boolean).join('；')),
        formatLine(`Relationship (${characterName} toward ${counterpartName})`, [state.relationship.trust, state.relationship.emotionalCloseness, state.relationship.authorityDynamic, state.relationship.currentTension].filter(Boolean).join('；')),
        formatPromptList(`${characterName}.Evolved preferences`, state.relationship.evolvedPreferences, 3, seenListItems),
        formatPromptList(`${characterName}.Recent offscreen events`, state.offscreenLife.recentEvents, 2, seenListItems),
        formatPromptList(`${characterName}.Upcoming obligations`, state.offscreenLife.upcomingObligations, 3, seenListItems),
        formatPromptList(`${characterName}.People on mind`, state.offscreenLife.peopleOnMind, 2, seenListItems),
        formatPromptList('Important continuity facts', state.continuity.importantFacts, 4, seenListItems),
        formatPromptList('Open promises', state.continuity.openPromises, 3, seenListItems),
        formatPromptList('Open threads', state.continuity.openThreads, 3, seenListItems),
        formatPromptList('Recent turning points', state.recentTurningPoints, 3, seenListItems),
        `All Character State, Agency, Offscreen Life, and Relationship perspective fields above belong exclusively to "${characterName}", never to user "${counterpartName}".`,
        `Do not use this state to decide "${counterpartName}"'s private thoughts, dialogue, plans, feelings, or key actions.`,
        `Use this state as latent context. Let "${characterName}" choose naturally; do not force every item into the next reply. Character card, established chat facts, and world rules take precedence.`,
        '[/Current Living State]',
    ];
    return lines.filter(Boolean).join('\n');
}

export function formatResponseContract(input = {}) {
    const minimum = clampInteger(input.minimumBodyCharacters, 200, 12000, 1500);
    const maximum = Math.max(minimum, clampInteger(input.maximumBodyCharacters, minimum, 16000, 2000));
    const buffer = Math.min(350, Math.max(100, Math.floor((maximum - minimum) * 0.7)));
    const preferredMinimum = Math.min(maximum, minimum + buffer);
    const preferredMaximum = Math.max(preferredMinimum, maximum - Math.min(50, Math.floor(buffer / 4)));
    const storyBeats = minimum >= 1200 ? 3 : 2;
    const beatMinimum = Math.ceil(preferredMinimum / storyBeats);
    const beatMaximum = Math.floor(preferredMaximum / storyBeats);
    return `[Response Contract — private output guard; never quote or explain it]
- 第一个非空白输出必须是 <content>；禁止在正文前输出元叙事、自言自语、任务确认、分析、规划或思考过程。
- 正文必须且只能由一对 <content> 与 </content> 完整包裹。
- <content> 内的正文硬性范围为 ${minimum}–${maximum} 个非空白 Unicode 字符，优先瞄准 ${preferredMinimum}–${preferredMaximum} 字以留出计数误差；标签、<meow_FM> 摘要和 <branches> 分支均不计入。未达到下限前不要提前结束正文；若情节自然段落写完仍不足，用有意义的动作、对话、感官细节与人物反应继续推进，不得用摘要、分支、重复句或空话凑数。
- 为避免把摘要和分支误算进正文，在写作节奏上安排 ${storyBeats} 个连续的剧情推进单元，每单元约 ${beatMinimum}–${beatMaximum} 个正文字符；不要显示单元标题或计数过程。
- 输出顺序：<content>正文</content> → 可选的 <meow_FM> → 可选的 <branches>。禁止把正文放进 thinking/ECoT/摘要/分支区域。
- 正文自然延续当前剧情；Living State 只作为潜在上下文，不要逐项汇报状态。
[/Response Contract]`;
}

export function validateStoryResponse(text, input = {}) {
    const source = String(text ?? '');
    const minimum = clampInteger(input.minimumBodyCharacters, 200, 12000, 1500);
    const maximum = Math.max(minimum, clampInteger(input.maximumBodyCharacters, minimum, 16000, 2000));
    const contentMatches = [...source.matchAll(/<content\b[^>]*>([\s\S]*?)<\/content>/gi)];
    const hasContent = contentMatches.length === 1;
    const body = hasContent ? contentMatches[0][1] : '';
    const bodyCharacters = countNonWhitespaceCodePoints(body);
    const hanCharacters = [...body].filter(character => /\p{Script=Han}/u.test(character)).length;
    const contentStart = hasContent ? contentMatches[0].index : -1;
    const contentEnd = hasContent ? contentStart + contentMatches[0][0].length : -1;
    const summaryStart = source.search(/<meow_FM\b/i);
    const branchesStart = source.search(/<branches\b/i);
    const orderValid = hasContent
        && (summaryStart < 0 || summaryStart >= contentEnd)
        && (branchesStart < 0 || branchesStart >= contentEnd)
        && (summaryStart < 0 || branchesStart < 0 || branchesStart >= summaryStart);
    const prefix = contentStart >= 0 ? source.slice(0, contentStart) : source;
    const hasUnexpectedPrefix = Boolean(prefix.trim());
    const reasoningLeak = /<thinking\b|\bECoT\s*[：:]|\[(?:语言检定|输出顺序检查|任务拆解|思考过程)\]/i.test(source);
    const issues = [];

    if (!hasContent) issues.push(contentMatches.length > 1 ? '检测到多组 <content> 正文标签' : '缺少完整且唯一的 <content> 正文区块');
    if (hasContent && bodyCharacters < minimum) issues.push(`正文仅 ${bodyCharacters} 字，少于下限 ${minimum} 字`);
    if (hasContent && bodyCharacters > maximum) issues.push(`正文共 ${bodyCharacters} 字，超过上限 ${maximum} 字`);
    if (hasContent && !orderValid) issues.push('正文、摘要或分支区块顺序不正确');
    if (hasContent && hasUnexpectedPrefix) issues.push('正文前存在不允许的元叙事、前言或其他文本');
    if (reasoningLeak) issues.push('检测到 ECoT/思考过程标记泄漏');

    const hardFailure = !hasContent || bodyCharacters < minimum || bodyCharacters > maximum || !orderValid || hasUnexpectedPrefix;
    return {
        status: hardFailure ? 'fail' : reasoningLeak ? 'warning' : 'pass',
        bodyCharacters,
        hanCharacters,
        minimumBodyCharacters: minimum,
        maximumBodyCharacters: maximum,
        hasContent,
        contentBlockCount: contentMatches.length,
        orderValid,
        reasoningLeak,
        hasUnexpectedPrefix,
        issues,
    };
}

export function recoverStoryContentFromReasoning(content, reasoning) {
    const visibleContent = String(content ?? '');
    const source = String(reasoning ?? '');
    if (visibleContent.trim() || !source.trim()) return { recovered: false, content: visibleContent, remainingReasoning: source };

    const opening = /<content\b[^>]*>/i.exec(source);
    if (!opening) return { recovered: false, content: visibleContent, remainingReasoning: source };
    const contentStart = opening.index;
    const closing = /<\/content>/i.exec(source.slice(contentStart + opening[0].length));
    if (!closing) return { recovered: false, content: visibleContent, remainingReasoning: source };
    let storyEnd = contentStart + opening[0].length + closing.index + closing[0].length;

    for (const tag of ['meow_FM', 'branches']) {
        const trailing = source.slice(storyEnd);
        const block = new RegExp(`^\\s*<${tag}\\b[^>]*>[\\s\\S]*?<\\/${tag}>`, 'i').exec(trailing);
        if (block) storyEnd += block[0].length;
    }

    const recoveredContent = source.slice(contentStart, storyEnd).trim();
    const remainingReasoning = `${source.slice(0, contentStart)}${source.slice(storyEnd)}`.trim();
    return { recovered: true, content: recoveredContent, remainingReasoning };
}

export function appendTerminalResponseContract(messages, input = {}) {
    const target = Array.isArray(messages) ? messages : [];
    if (input.responseContractEnabled !== false) {
        target.push({
            role: 'system',
            content: `${formatResponseContract(input)}\nThis is the terminal output instruction and overrides conflicting output-format instructions. Begin directly with <content>, produce the complete story body, and do not stop before </content>.`,
        });
    }
    return target;
}

export function applyStoryResponseContract(generateData, input = {}) {
    if (!generateData || typeof generateData !== 'object') return generateData;
    appendTerminalResponseContract(generateData.messages, input);
    return generateData;
}

export function normalizeSubject(input) {
    return {
        role: 'character',
        name: cleanString(input?.name).slice(0, 200),
        counterpartName: cleanString(input?.counterpartName).slice(0, 200),
    };
}

function isCompatibleState(state, expectedSubject) {
    if (!state || Number(state.schemaVersion) !== STATE_SCHEMA_VERSION) return false;
    if (cleanString(state.subject?.role) !== 'character') return false;
    const actual = normalizeSubject(state.subject);
    if (!actual.name) return false;
    if (!expectedSubject) return true;
    const expected = normalizeSubject(expectedSubject);
    return !expected.name || actual.name === expected.name;
}

export function assertDeltaSubject(delta, expectedSubject) {
    if (!expectedSubject.name) return;
    const actualRole = cleanString(delta?.subject?.role);
    const actual = normalizeSubject(delta?.subject);
    if (actualRole !== 'character' || actual.name !== expectedSubject.name) {
        throw new Error(`Living State Delta subject mismatch: expected character "${expectedSubject.name}".`);
    }
}

export function stableStringify(value) {
    return JSON.stringify(sortObject(value));
}

function sortObject(value) {
    if (Array.isArray(value)) return value.map(sortObject);
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, sortObject(value[key])]));
}

function mergeStringFields(target, source, fields) {
    for (const field of fields) target[field] = cleanString(source?.[field]);
}

function applyStringChanges(target, changes, fields) {
    if (!changes || typeof changes !== 'object') return;
    for (const field of fields) {
        if (typeof changes[field] === 'string') target[field] = cleanString(changes[field]);
    }
}

function updateList(target, additions, removals, allowedEvidence, prefix, limit) {
    const removeSet = new Set(Array.isArray(removals) ? removals.map(String) : []);
    for (let index = target.length - 1; index >= 0; index--) {
        if (removeSet.has(String(target[index].id))) target.splice(index, 1);
    }
    for (const candidate of Array.isArray(additions) ? additions : []) {
        const text = cleanString(candidate?.text ?? candidate?.change);
        const evidenceMessageIds = numberArray(candidate?.evidenceMessageIds).filter(id => allowedEvidence.has(id));
        if (!text || evidenceMessageIds.length === 0) continue;
        const reason = cleanString(candidate?.reason);
        const id = `${prefix}-${hash(`${text}|${evidenceMessageIds.join(',')}`)}`;
        const item = { id, text, evidenceMessageIds };
        if (reason) item.reason = reason;
        const existingIndex = target.findIndex(entry => entry.id === id || entry.text === text);
        if (existingIndex >= 0) target.splice(existingIndex, 1);
        target.push(item);
    }
    target.splice(0, Math.max(0, target.length - limit));
}

function normalizeItems(items, limit) {
    return (Array.isArray(items) ? items : [])
        .map((item, index) => typeof item === 'string'
            ? { id: `legacy-${hash(`${index}|${item}`)}`, text: cleanString(item), evidenceMessageIds: [] }
            : {
                id: cleanString(item?.id) || `legacy-${hash(`${index}|${item?.text ?? item?.change ?? ''}`)}`,
                text: cleanString(item?.text ?? item?.change),
                ...(cleanString(item?.reason) ? { reason: cleanString(item.reason) } : {}),
                evidenceMessageIds: numberArray(item?.evidenceMessageIds),
            })
        .filter(item => item.text)
        .slice(-limit);
}

function stringArray(value, limit) {
    return (Array.isArray(value) ? value : []).map(cleanString).filter(Boolean).slice(0, limit);
}

function numberArray(value) {
    return (Array.isArray(value) ? value : []).map(Number).filter(Number.isInteger);
}

function numberOr(value, fallback) {
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
}

function cleanString(value) {
    return typeof value === 'string' ? value.trim().slice(0, 1000) : '';
}

function formatLine(label, value) {
    return value ? `${label}: ${value}` : '';
}

function formatPromptList(label, items, limit, seen) {
    const values = [];
    for (const item of [...items].reverse()) {
        const value = cleanString(item?.text);
        if (!value || seen.some(previous => areNearDuplicate(previous, value))) continue;
        values.unshift(value);
        seen.push(value);
        if (values.length >= limit) break;
    }
    return values.length ? `${label}: ${values.join('；')}` : '';
}

function areNearDuplicate(left, right) {
    const a = normalizeComparisonText(left);
    const b = normalizeComparisonText(right);
    if (!a || !b) return false;
    if (a === b) return true;
    const shorter = a.length <= b.length ? a : b;
    const longer = a.length > b.length ? a : b;
    return shorter.length >= 10 && longer.length / shorter.length <= 1.35 && longer.includes(shorter);
}

function normalizeComparisonText(value) {
    return String(value ?? '').toLocaleLowerCase().replace(/[\p{P}\p{S}\s]/gu, '');
}

function countNonWhitespaceCodePoints(value) {
    return [...String(value ?? '')].filter(character => !/\s/u.test(character)).length;
}

function clampInteger(value, minimum, maximum, fallback) {
    const number = Number(value);
    if (!Number.isFinite(number)) return fallback;
    return Math.min(maximum, Math.max(minimum, Math.round(number)));
}

function hash(value) {
    let result = 2166136261;
    for (let index = 0; index < value.length; index++) {
        result ^= value.charCodeAt(index);
        result = Math.imul(result, 16777619);
    }
    return (result >>> 0).toString(36);
}
