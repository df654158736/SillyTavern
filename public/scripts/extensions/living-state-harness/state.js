export const SNAPSHOT_KEY = 'living_state_harness';
export const PROMPT_KEY = 'living_state_harness';
export const REASONING_RECOVERY_KEY = 'living_state_harness_reasoning_recovery';
export const STATE_SCHEMA_VERSION = 2;
export const PROMPT_BUDGET_CHARACTERS = 3200;

export const SIGNAL_DEFINITIONS = Object.freeze({
    trust: Object.freeze({ label: '信任', promptLabel: 'Trust', maximumStep: 2, slowPositive: true }),
    closeness: Object.freeze({ label: '亲密', promptLabel: 'Closeness', maximumStep: 2, slowPositive: true }),
    tension: Object.freeze({ label: '紧张', promptLabel: 'Tension', maximumStep: 3 }),
    initiativeReadiness: Object.freeze({ label: '主动准备', promptLabel: 'Initiative readiness', maximumStep: 3 }),
    boundaryPressure: Object.freeze({ label: '边界压力', promptLabel: 'Boundary pressure', maximumStep: 3 }),
});

const CONFIDENCE_LEVELS = new Set(['low', 'medium', 'high']);

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
        signals: Object.fromEntries(Object.keys(SIGNAL_DEFINITIONS).map(key => [key, createEmptySignal()])),
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
    for (const key of Object.keys(SIGNAL_DEFINITIONS)) base.signals[key] = normalizeSignal(input.signals?.[key]);
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
        if (Number.isInteger(snapshot?.anchorMessageId) && snapshot.anchorMessageId !== index) continue;
        if (Number.isInteger(snapshot?.swipeId) && Number.isInteger(chat[index]?.swipe_id) && snapshot.swipeId !== chat[index].swipe_id) continue;
        if (snapshot?.valid !== false && isCompatibleState(snapshot?.state, subject)) {
            return { index, snapshot, state: normalizeState(snapshot.state, subject) };
        }
    }
    return null;
}

export function saveStateSnapshot(message, messageId, state, {
    changed = false,
    delta = null,
    kind = 'post-response',
} = {}) {
    if (!message || typeof message !== 'object') return null;
    const anchorMessageId = Number(messageId);
    const normalizedState = normalizeState(state);
    message.extra ??= {};
    message.extra[SNAPSHOT_KEY] = {
        valid: true,
        kind,
        anchorMessageId: Number.isInteger(anchorMessageId) ? anchorMessageId : null,
        swipeId: Number.isInteger(message.swipe_id) ? message.swipe_id : null,
        stateThroughMessageId: normalizedState.processedThroughMessageId,
        changed: Boolean(changed),
        state: normalizedState,
        delta,
        savedAt: new Date().toISOString(),
    };
    return message.extra[SNAPSHOT_KEY];
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
    applySignalChanges(state.signals, delta?.signalChanges, allowedEvidence);

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

export function formatStateForPrompt(input, subject = null, guidance = {}) {
    const state = normalizeState(input, subject);
    const characterName = state.subject.name || 'the active character';
    const counterpartName = state.subject.counterpartName || 'the user';
    const fixedStart = [
        `[Current Living State for character "${characterName}" only — private working context; never quote, explain, or enumerate it in the reply.]`,
        `Subject: character "${characterName}"`,
        `Counterpart: user "${counterpartName}"`,
    ];
    const fixedEnd = [
        ...formatNarrativeGuidance(guidance, characterName, counterpartName),
        `All Character State, Agency, Offscreen Life, and Relationship perspective fields above belong exclusively to "${characterName}", never to user "${counterpartName}".`,
        `Hard boundary: never decide "${counterpartName}"'s private thoughts, new commitments, consequential dialogue, plans, feelings, or key actions. No score or creative setting may override this.`,
        'Behavior signals are coarse descriptive estimates, not objectives to maximize. Accepted story facts and textual state take precedence.',
        `Use this state as latent context. Let "${characterName}" choose naturally; do not force every item into the next reply. Character card, established chat facts, and world rules take precedence.`,
        '[/Current Living State]',
    ];
    const candidates = [
        promptTextCandidate(10, 0, 'Scene', [state.scene.location, state.scene.immediateSituation], 220),
        promptTextCandidate(20, 2, 'Present', [state.scene.presentCharacters.join('、')], 100),
        promptTextCandidate(30, 0, `${characterName}.Mood`, [state.character.currentMood], 150),
        promptTextCandidate(40, 3, `${characterName}.Physical state`, [state.character.physicalState], 100),
        promptTextCandidate(50, 2, `${characterName}.Attention`, [state.character.attentionFocus], 120),
        promptTextCandidate(60, 0, `${characterName}.Current goal`, [state.character.currentGoal], 140),
        promptTextCandidate(70, 1, `${characterName}.Concern`, [state.character.currentConcern], 140),
        promptTextCandidate(80, 0, `${characterName}.Plan`, [state.agency.currentPlan], 160),
        promptTextCandidate(90, 2, `${characterName}.Possible initiative`, [state.agency.initiativeSeed], 130),
        promptTextCandidate(100, 2, `${characterName}.Impulse / inhibition`, [state.character.privateImpulse, state.character.inhibition], 180),
        promptTextCandidate(110, 1, `${characterName}.Boundary`, [state.agency.boundary, state.agency.responseIfBlocked], 180),
        promptTextCandidate(120, 0, `Relationship (${characterName} toward ${counterpartName})`, [state.relationship.trust, state.relationship.emotionalCloseness, state.relationship.authorityDynamic, state.relationship.currentTension], 260),
        promptSignalCandidate(130, 1, state.signals),
        promptListCandidate(140, 4, `${characterName}.Evolved preferences`, state.relationship.evolvedPreferences, 1),
        promptListCandidate(150, 4, `${characterName}.Recent offscreen events`, state.offscreenLife.recentEvents, 1),
        promptListCandidate(160, 1, `${characterName}.Upcoming obligations`, state.offscreenLife.upcomingObligations, 2),
        promptListCandidate(170, 4, `${characterName}.People on mind`, state.offscreenLife.peopleOnMind, 1),
        promptListCandidate(180, 1, 'Important continuity facts', state.continuity.importantFacts, 3),
        promptListCandidate(190, 1, 'Open promises', state.continuity.openPromises, 2),
        promptListCandidate(200, 1, 'Open threads', state.continuity.openThreads, 2),
        promptListCandidate(210, 3, 'Recent turning points', state.recentTurningPoints, 1),
    ];
    return composeBudgetedPrompt(fixedStart, candidates, fixedEnd);
}

export function normalizeGuidance(input = {}) {
    return {
        stateInfluence: enumOr(input.stateInfluence, ['subtle', 'balanced', 'strong'], 'balanced'),
        initiative: enumOr(input.initiative, ['restrained', 'natural', 'assertive'], 'natural'),
        pacing: enumOr(input.pacing, ['patient', 'responsive', 'forward'], 'responsive'),
        userMicroAgency: enumOr(input.userMicroAgency, ['minimal', 'natural', 'expressive'], 'natural'),
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

function createEmptySignal() {
    return { value: null, confidence: 'low', reason: '', evidenceMessageIds: [] };
}

function normalizeSignal(input) {
    const signal = createEmptySignal();
    if (!input || typeof input !== 'object') return signal;
    const numericValue = input.value === null || input.value === '' ? Number.NaN : Number(input.value);
    signal.value = Number.isFinite(numericValue) ? Math.min(10, Math.max(0, Math.round(numericValue))) : null;
    signal.confidence = CONFIDENCE_LEVELS.has(input.confidence) ? input.confidence : 'low';
    signal.reason = cleanString(input.reason).slice(0, 240);
    signal.evidenceMessageIds = numberArray(input.evidenceMessageIds).slice(-6);
    return signal;
}

function applySignalChanges(target, changes, allowedEvidence) {
    if (!changes || typeof changes !== 'object') return;
    for (const [key, definition] of Object.entries(SIGNAL_DEFINITIONS)) {
        const candidate = changes[key];
        if (!candidate || typeof candidate !== 'object') continue;
        const evidenceMessageIds = numberArray(candidate.evidenceMessageIds).filter(id => allowedEvidence.has(id)).slice(-6);
        const value = Number(candidate.value);
        if (!Number.isFinite(value) || evidenceMessageIds.length === 0) continue;
        const previous = normalizeSignal(target[key]);
        const requested = Math.min(10, Math.max(0, Math.round(value)));
        if (definition.slowPositive && previous.value !== null && requested > previous.value) {
            const previousEvidenceId = Math.max(-1, ...previous.evidenceMessageIds);
            const candidateEvidenceId = Math.max(...evidenceMessageIds);
            const hasEnoughNewHistory = previousEvidenceId < 0 || candidateEvidenceId - previousEvidenceId >= 4;
            const hasStrongEvidenceAtHighLevels = previous.value < 8 || candidate.confidence === 'high';
            if (!hasEnoughNewHistory || !hasStrongEvidenceAtHighLevels) continue;
        }
        const nextValue = previous.value === null
            ? requested
            : Math.min(previous.value + (definition.slowPositive ? 1 : definition.maximumStep), Math.max(previous.value - definition.maximumStep, requested));
        target[key] = {
            value: nextValue,
            confidence: CONFIDENCE_LEVELS.has(candidate.confidence) ? candidate.confidence : 'low',
            reason: cleanString(candidate.reason).slice(0, 240),
            evidenceMessageIds,
        };
    }
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

function enumOr(value, allowed, fallback) {
    return allowed.includes(value) ? value : fallback;
}

function cleanString(value) {
    return typeof value === 'string' ? value.trim().slice(0, 1000) : '';
}

function formatSignalLine(signals) {
    const values = Object.entries(SIGNAL_DEFINITIONS)
        .map(([key, definition]) => {
            const signal = normalizeSignal(signals?.[key]);
            if (signal.value === null) return '';
            return `${definition.promptLabel} ${signalBand(signal.value)}`;
        })
        .filter(Boolean);
    return values.length ? `Behavior signals: ${values.join('；')}` : '';
}

function formatNarrativeGuidance(input, characterName, counterpartName) {
    const guidance = normalizeGuidance(input);
    const stateInfluence = {
        subtle: 'Use Living State quietly and only when directly relevant to the immediate exchange.',
        balanced: 'Let the most relevant Living State signals shape reactions without displaying or mechanically acting out the state sheet.',
        strong: 'Let relevant Living State tensions, goals, and boundaries meaningfully shape the character’s choices, without forcing unrelated items into the scene.',
    }[guidance.stateInfluence];
    const initiative = {
        restrained: `${characterName} favors observation and small reversible responses unless the situation clearly demands action.`,
        natural: `${characterName} may initiate plausible dialogue or low-risk action when motivated by the current state.`,
        assertive: `${characterName} may actively pursue personal goals, press a boundary, or change the immediate situation while respecting established facts.`,
    }[guidance.initiative];
    const pacing = {
        patient: 'Favor reaction, texture, and unresolved space; avoid introducing a new consequential development unless the user clearly invites it.',
        responsive: 'Advance only the locally relevant situation and leave room for user intervention after a meaningful change; do not resolve several consequential developments at once.',
        forward: 'Allow a clear next development driven by existing motives, while stopping before the user’s next consequential choice.',
    }[guidance.pacing];
    const userMicroAgency = {
        minimal: `Do not supply new dialogue or actions for ${counterpartName}; rely on the user’s explicit input.`,
        natural: `You may supply brief, low-stakes ${counterpartName} reactions already implied by the exchange for conversational flow, but no new decision, commitment, escalation, or private intent.`,
        expressive: `You may render short natural ${counterpartName} exchanges when their stance is already established, but must stop before any new commitment, escalation, key action, or private intent.`,
    }[guidance.userMicroAgency];
    return [
        `State use: ${stateInfluence}`,
        `Agency and pacing: ${initiative} ${pacing}`,
        `User portrayal: ${userMicroAgency}`,
    ];
}

function formatPromptList(label, items, limit, seen) {
    const values = [];
    for (const item of [...items].reverse()) {
        const value = compactPromptText(item?.text, 110);
        if (!value || seen.some(previous => areNearDuplicate(previous, value))) continue;
        values.push(value);
        seen.push(value);
        if (values.length >= limit) break;
    }
    return values.length ? `${label}: ${values.join('；')}` : '';
}

function promptTextCandidate(order, priority, label, parts, maximumCharacters) {
    return {
        order,
        priority,
        render(seen) {
            const values = [];
            const localSeen = [...seen];
            for (const part of parts) {
                const value = compactPromptText(part, Math.max(60, Math.floor(maximumCharacters / Math.max(1, parts.length))));
                if (!value || localSeen.some(previous => areNearDuplicate(previous, value))) continue;
                values.push(value);
                localSeen.push(value);
            }
            const joined = compactPromptText(values.join('；'), maximumCharacters);
            return joined ? { line: `${label}: ${joined}`, values } : null;
        },
    };
}

function promptListCandidate(order, priority, label, items, limit) {
    return {
        order,
        priority,
        render(seen) {
            const localSeen = [...seen];
            const line = formatPromptList(label, items, limit, localSeen);
            return line ? { line, values: localSeen.slice(seen.length) } : null;
        },
    };
}

function promptSignalCandidate(order, priority, signals) {
    return {
        order,
        priority,
        render() {
            const line = formatSignalLine(signals);
            return line ? { line, values: [] } : null;
        },
    };
}

function composeBudgetedPrompt(fixedStart, candidates, fixedEnd) {
    const start = fixedStart.filter(Boolean);
    const end = fixedEnd.filter(Boolean);
    const fixedCharacters = [...start, ...end].join('\n').length;
    let remaining = Math.max(0, PROMPT_BUDGET_CHARACTERS - fixedCharacters - start.length - end.length);
    const seen = [];
    const selected = [];
    for (const candidate of [...candidates].sort((left, right) => left.priority - right.priority || left.order - right.order)) {
        const rendered = candidate.render(seen);
        if (!rendered || rendered.line.length + 1 > remaining) continue;
        selected.push({ order: candidate.order, line: rendered.line });
        seen.push(...rendered.values);
        remaining -= rendered.line.length + 1;
    }
    return [...start, ...selected.sort((left, right) => left.order - right.order).map(item => item.line), ...end].join('\n');
}

function compactPromptText(value, maximumCharacters) {
    const text = cleanString(value).replace(/\s+/g, ' ');
    if (text.length <= maximumCharacters) return text;
    const prefix = text.slice(0, Math.max(1, maximumCharacters - 1));
    const minimumBoundary = Math.floor(prefix.length * 0.6);
    const boundary = Math.max(prefix.lastIndexOf('。'), prefix.lastIndexOf('；'), prefix.lastIndexOf('！'), prefix.lastIndexOf('？'));
    return `${prefix.slice(0, boundary >= minimumBoundary ? boundary + 1 : prefix.length).trim()}…`;
}

function signalBand(value) {
    if (value <= 2) return 'very low';
    if (value <= 4) return 'low';
    if (value <= 6) return 'moderate';
    if (value <= 8) return 'high';
    return 'very high';
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

function hash(value) {
    let result = 2166136261;
    for (let index = 0; index < value.length; index++) {
        result ^= value.charCodeAt(index);
        result = Math.imul(result, 16777619);
    }
    return (result >>> 0).toString(36);
}
