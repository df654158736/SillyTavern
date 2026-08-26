export const SNAPSHOT_KEY = 'living_state_harness';
export const PROMPT_KEY = 'living_state_harness';

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

export function createEmptyState() {
    return {
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

export function normalizeState(input) {
    const base = createEmptyState();
    if (!input || typeof input !== 'object') return base;

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

export function findLatestSnapshot(chat, beforeOrAt = Number.POSITIVE_INFINITY) {
    for (let index = Math.min(chat.length - 1, beforeOrAt); index >= 0; index--) {
        const snapshot = chat[index]?.extra?.[SNAPSHOT_KEY];
        if (snapshot?.valid !== false && snapshot?.state) {
            return { index, snapshot, state: normalizeState(snapshot.state) };
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
        .replace(/<meow_FM>[\s\S]*?<\/meow_FM>/gi, '')
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

export function mergeDelta(previousState, delta, evidenceIds, throughMessageId) {
    const state = normalizeState(previousState);
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

export function formatStateForPrompt(input) {
    const state = normalizeState(input);
    const lines = [
        '[Current Living State — private working context; never quote, explain, or enumerate it in the reply.]',
        formatLine('Scene', [state.scene.location, state.scene.immediateSituation].filter(Boolean).join('；')),
        formatLine('Present', state.scene.presentCharacters.join('、')),
        formatLine('Mood', state.character.currentMood),
        formatLine('Physical state', state.character.physicalState),
        formatLine('Attention', state.character.attentionFocus),
        formatLine('Current goal', state.character.currentGoal),
        formatLine('Concern', state.character.currentConcern),
        formatLine('Plan', state.agency.currentPlan),
        formatLine('Possible initiative', state.agency.initiativeSeed),
        formatLine('Impulse / inhibition', [state.character.privateImpulse, state.character.inhibition].filter(Boolean).join('；')),
        formatLine('Boundary', [state.agency.boundary, state.agency.responseIfBlocked].filter(Boolean).join('；')),
        formatLine('Relationship', [state.relationship.trust, state.relationship.emotionalCloseness, state.relationship.authorityDynamic, state.relationship.currentTension].filter(Boolean).join('；')),
        formatList('Evolved preferences', state.relationship.evolvedPreferences),
        formatList('Offscreen life', [...state.offscreenLife.recentEvents, ...state.offscreenLife.upcomingObligations, ...state.offscreenLife.peopleOnMind]),
        formatList('Continuity', [...state.continuity.importantFacts, ...state.continuity.openPromises, ...state.continuity.openThreads]),
        formatList('Recent turning points', state.recentTurningPoints),
        'Use this state as latent context. Let the character choose naturally; do not force every item into the next reply. Character card, established chat facts, and world rules take precedence.',
        '[/Current Living State]',
    ];
    return lines.filter(Boolean).join('\n');
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

function formatList(label, items) {
    const values = items.map(item => item.text).filter(Boolean);
    return values.length ? `${label}: ${values.join('；')}` : '';
}

function hash(value) {
    let result = 2166136261;
    for (let index = 0; index < value.length; index++) {
        result ^= value.charCodeAt(index);
        result = Math.imul(result, 16777619);
    }
    return (result >>> 0).toString(36);
}
