export const STORY_SCHEMA_VERSION = 2;
export const SUPPORTED_STORY_SCHEMA_VERSIONS = Object.freeze([1, 2]);
export const REENTRY_INTERACTION_MODE = 'reenter_story';
export const DIRECTOR_INTERACTION_MODES = Object.freeze([
    'hold_for_evidence',
    'invite_user_check',
    'emotional_pause',
    'follow_user_detour',
    'recover_from_leak',
]);
export const INTERACTION_MODES = Object.freeze([...DIRECTOR_INTERACTION_MODES, REENTRY_INTERACTION_MODE]);
// reenter_story resolves through the package-level reentry policy. Keeping it
// out of the required per-stage routes preserves schema v1/v2 package compatibility.
export const INTERACTION_ROUTES = Object.freeze(['default', ...DIRECTOR_INTERACTION_MODES]);
export const BUILTIN_VIOLATION_IDS = Object.freeze(['V_PREMATURE_REVEAL']);

const CONTROLLER_ID = /^[A-Z][A-Z0-9_:-]*$/;
const STORY_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MESSAGE_ROLES = new Set(['user', 'assistant']);

function isObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isText(value) {
    return typeof value === 'string' && value.trim().length > 0;
}

function addError(errors, path, message) {
    errors.push(`${path}: ${message}`);
}

function validateId(errors, value, path) {
    if (!isText(value) || !CONTROLLER_ID.test(value)) {
        addError(errors, path, 'must be an uppercase controller ID');
        return false;
    }
    return true;
}

function validateText(errors, value, path) {
    if (!isText(value)) addError(errors, path, 'must be a non-empty string');
}

function validateStringArray(errors, value, path, { required = false } = {}) {
    if (!Array.isArray(value)) {
        addError(errors, path, 'must be an array');
        return [];
    }
    if (required && value.length === 0) addError(errors, path, 'must not be empty');
    for (let index = 0; index < value.length; index++) validateText(errors, value[index], `${path}[${index}]`);
    if (new Set(value).size !== value.length) addError(errors, path, 'must not contain duplicates');
    return value;
}

function registerId(errors, registry, id, path) {
    if (!validateId(errors, id, path)) return;
    if (registry.has(id)) addError(errors, path, `duplicates ${registry.get(id)}`);
    else registry.set(id, path);
}

function mapById(items) {
    return new Map((Array.isArray(items) ? items : []).filter(isObject).map(item => [item.id, item]));
}

function validateReferences(errors, ids, registry, path, label) {
    for (let index = 0; index < ids.length; index++) {
        if (!registry.has(ids[index])) addError(errors, `${path}[${index}]`, `references unknown ${label} ${JSON.stringify(ids[index])}`);
    }
}

function collectPublicText(story, stage, revealMap, outcomeMap, guidanceMap) {
    return [
        story.publicPremise,
        ...(story.authorRules ?? []),
        stage.spoilerSafeName,
        stage.publicObjective,
        ...(stage.allowedRevealIds ?? []).map(id => revealMap.get(id)?.text ?? ''),
        ...(stage.forbiddenOutcomeIds ?? []).map(id => outcomeMap.get(id)?.safeDescription ?? ''),
        ...Object.values(stage.interactionRoutes ?? {}).map(id => guidanceMap.get(id)?.text ?? ''),
        story.reentry?.guidanceId ? guidanceMap.get(story.reentry.guidanceId)?.text ?? '' : '',
    ].filter(isText).join('\n');
}

function activeContinuityText(story, stageId) {
    return (story.continuityRules ?? [])
        .filter(rule => rule.activeStageIds?.includes(stageId))
        .map(rule => rule.text)
        .filter(isText);
}

export function validateStoryPackage(input) {
    const errors = [];
    const warnings = [];
    if (!isObject(input)) return { valid: false, errors: ['$: must be an object'], warnings };
    if (!SUPPORTED_STORY_SCHEMA_VERSIONS.includes(input.schemaVersion)) {
        addError(errors, '$.schemaVersion', `must be one of ${SUPPORTED_STORY_SCHEMA_VERSIONS.join(', ')}`);
    }
    if (!isText(input.storyId) || !STORY_ID.test(input.storyId)) addError(errors, '$.storyId', 'must be lowercase kebab case');
    if (!Number.isInteger(input.version) || input.version < 1) addError(errors, '$.version', 'must be a positive integer');
    validateText(errors, input.title, '$.title');
    validateText(errors, input.publicPremise, '$.publicPremise');
    validateId(errors, input.entryStageId, '$.entryStageId');
    validateStringArray(errors, input.authorRules, '$.authorRules', { required: true });

    const collectionKeys = ['events', 'reveals', 'forbiddenOutcomes', 'safeGuidance', 'stages'];
    for (const key of collectionKeys) {
        if (!Array.isArray(input[key])) addError(errors, `$.${key}`, 'must be an array');
    }
    const events = Array.isArray(input.events) ? input.events : [];
    const reveals = Array.isArray(input.reveals) ? input.reveals : [];
    const outcomes = Array.isArray(input.forbiddenOutcomes) ? input.forbiddenOutcomes : [];
    const guidance = Array.isArray(input.safeGuidance) ? input.safeGuidance : [];
    const stages = Array.isArray(input.stages) ? input.stages : [];
    const continuityRules = Array.isArray(input.continuityRules) ? input.continuityRules : [];
    if (input.continuityRules !== undefined && !Array.isArray(input.continuityRules)) addError(errors, '$.continuityRules', 'must be an array');
    if (input.schemaVersion === 1 && (input.continuityRules !== undefined || input.completion !== undefined)) {
        addError(errors, '$.schemaVersion', 'must be 2 when continuityRules or completion is used');
    }
    if (input.schemaVersion === 1 && input.reentry !== undefined) {
        addError(errors, '$.schemaVersion', 'must be 2 when reentry is used');
    }
    if (stages.length === 0) addError(errors, '$.stages', 'must contain at least one stage');

    const registry = new Map();
    events.forEach((item, index) => {
        const path = `$.events[${index}]`;
        if (!isObject(item)) return addError(errors, path, 'must be an object');
        registerId(errors, registry, item.id, `${path}.id`);
        validateText(errors, item.description, `${path}.description`);
        validateText(errors, item.evidenceRule, `${path}.evidenceRule`);
        const roles = validateStringArray(errors, item.allowedRoles, `${path}.allowedRoles`, { required: true });
        roles.forEach((role, roleIndex) => {
            if (!MESSAGE_ROLES.has(role)) addError(errors, `${path}.allowedRoles[${roleIndex}]`, 'must be user or assistant');
        });
    });
    for (const [key, items, textKey] of [
        ['reveals', reveals, 'text'],
        ['forbiddenOutcomes', outcomes, 'safeDescription'],
        ['safeGuidance', guidance, 'text'],
    ]) {
        items.forEach((item, index) => {
            const path = `$.${key}[${index}]`;
            if (!isObject(item)) return addError(errors, path, 'must be an object');
            registerId(errors, registry, item.id, `${path}.id`);
            validateText(errors, item[textKey], `${path}.${textKey}`);
        });
    }

    continuityRules.forEach((rule, index) => {
        const path = `$.continuityRules[${index}]`;
        if (!isObject(rule)) return addError(errors, path, 'must be an object');
        registerId(errors, registry, rule.id, `${path}.id`);
        validateStringArray(errors, rule.whenEventIds, `${path}.whenEventIds`, { required: true });
        validateStringArray(errors, rule.activeStageIds, `${path}.activeStageIds`, { required: true });
        validateText(errors, rule.text, `${path}.text`);
    });

    stages.forEach((stage, stageIndex) => {
        const path = `$.stages[${stageIndex}]`;
        if (!isObject(stage)) return addError(errors, path, 'must be an object');
        registerId(errors, registry, stage.id, `${path}.id`);
        validateText(errors, stage.spoilerSafeName, `${path}.spoilerSafeName`);
        validateText(errors, stage.publicObjective, `${path}.publicObjective`);
        if (typeof stage.terminal !== 'boolean') addError(errors, `${path}.terminal`, 'must be a boolean');
        validateStringArray(errors, stage.allowedEventIds, `${path}.allowedEventIds`);
        validateStringArray(errors, stage.allowedRevealIds, `${path}.allowedRevealIds`);
        validateStringArray(errors, stage.forbiddenOutcomeIds, `${path}.forbiddenOutcomeIds`);
        if (!isObject(stage.interactionRoutes)) {
            addError(errors, `${path}.interactionRoutes`, 'must be an object');
        } else {
            for (const route of INTERACTION_ROUTES) validateId(errors, stage.interactionRoutes[route], `${path}.interactionRoutes.${route}`);
            const unknownRoutes = Object.keys(stage.interactionRoutes).filter(route => !INTERACTION_ROUTES.includes(route));
            if (unknownRoutes.length) addError(errors, `${path}.interactionRoutes`, `contains unknown routes: ${unknownRoutes.join(', ')}`);
            if (new Set(Object.values(stage.interactionRoutes)).size === 1) warnings.push(`${path}.interactionRoutes: all modes use the same guidance`);
        }
        if (!Array.isArray(stage.transitions)) {
            addError(errors, `${path}.transitions`, 'must be an array');
            return;
        }
        if (stage.terminal && stage.transitions.length) addError(errors, `${path}.transitions`, 'terminal stage cannot have transitions');
        if (stage.terminal === false && !stage.transitions.length) addError(errors, `${path}.transitions`, 'non-terminal stage needs a transition');
        stage.transitions.forEach((transition, transitionIndex) => {
            const transitionPath = `${path}.transitions[${transitionIndex}]`;
            if (!isObject(transition)) return addError(errors, transitionPath, 'must be an object');
            registerId(errors, registry, transition.id, `${transitionPath}.id`);
            validateId(errors, transition.toStageId, `${transitionPath}.toStageId`);
            const all = validateStringArray(errors, transition.requiresAllEventIds, `${transitionPath}.requiresAllEventIds`);
            const any = validateStringArray(errors, transition.requiresAnyEventIds, `${transitionPath}.requiresAnyEventIds`);
            if (!all.length && !any.length) addError(errors, transitionPath, 'requires at least one event guard');
        });
    });

    if (!isObject(input.hidden)) {
        addError(errors, '$.hidden', 'must be an object');
    }
    const secrets = Array.isArray(input.hidden?.secrets) ? input.hidden.secrets : [];
    if (!Array.isArray(input.hidden?.secrets)) addError(errors, '$.hidden.secrets', 'must be an array');
    validateStringArray(errors, input.hidden?.authorNotes, '$.hidden.authorNotes');
    secrets.forEach((secret, index) => {
        const path = `$.hidden.secrets[${index}]`;
        if (!isObject(secret)) return addError(errors, path, 'must be an object');
        registerId(errors, registry, secret.id, `${path}.id`);
        validateText(errors, secret.text, `${path}.text`);
        validateStringArray(errors, secret.unlockStageIds, `${path}.unlockStageIds`, { required: true });
        validateStringArray(errors, secret.leakTerms, `${path}.leakTerms`, { required: true });
    });

    if (input.completion !== undefined) {
        const path = '$.completion';
        if (!isObject(input.completion)) {
            addError(errors, path, 'must be an object');
        } else {
            if (!Number.isInteger(input.completion.epilogueAssistantMessages)
                || input.completion.epilogueAssistantMessages < 0
                || input.completion.epilogueAssistantMessages > 20) {
                addError(errors, `${path}.epilogueAssistantMessages`, 'must be an integer from 0 to 20');
            }
            if (typeof input.completion.autoRelease !== 'boolean') addError(errors, `${path}.autoRelease`, 'must be a boolean');
            validateText(errors, input.completion.memoryText, `${path}.memoryText`);
        }
    }

    if (input.reentry !== undefined) {
        const path = '$.reentry';
        if (!isObject(input.reentry)) {
            addError(errors, path, 'must be an object');
        } else {
            const allowedKeys = new Set(['guidanceId', 'afterDetourTurns', 'cooldownDetourTurns', 'maxAttemptsPerStage', 'disabledStageIds']);
            const unknownKeys = Object.keys(input.reentry).filter(key => !allowedKeys.has(key));
            if (unknownKeys.length) addError(errors, path, `contains unknown fields: ${unknownKeys.join(', ')}`);
            validateId(errors, input.reentry.guidanceId, `${path}.guidanceId`);
            for (const [key, minimum, maximum] of [
                ['afterDetourTurns', 1, 20],
                ['cooldownDetourTurns', 1, 50],
                ['maxAttemptsPerStage', 1, 10],
            ]) {
                if (!Number.isInteger(input.reentry[key]) || input.reentry[key] < minimum || input.reentry[key] > maximum) {
                    addError(errors, `${path}.${key}`, `must be an integer from ${minimum} to ${maximum}`);
                }
            }
            validateStringArray(errors, input.reentry.disabledStageIds, `${path}.disabledStageIds`);
        }
    }

    const eventMap = mapById(events);
    const revealMap = mapById(reveals);
    const outcomeMap = mapById(outcomes);
    const guidanceMap = mapById(guidance);
    const stageMap = mapById(stages);
    if (!stageMap.has(input.entryStageId)) addError(errors, '$.entryStageId', 'references an unknown stage');
    stages.forEach((stage, stageIndex) => {
        if (!isObject(stage)) return;
        const path = `$.stages[${stageIndex}]`;
        validateReferences(errors, stage.allowedEventIds ?? [], eventMap, `${path}.allowedEventIds`, 'event');
        validateReferences(errors, stage.allowedRevealIds ?? [], revealMap, `${path}.allowedRevealIds`, 'reveal');
        validateReferences(errors, stage.forbiddenOutcomeIds ?? [], outcomeMap, `${path}.forbiddenOutcomeIds`, 'forbidden outcome');
        for (const [route, guidanceId] of Object.entries(stage.interactionRoutes ?? {})) {
            if (!guidanceMap.has(guidanceId)) addError(errors, `${path}.interactionRoutes.${route}`, 'references unknown guidance');
        }
        for (let transitionIndex = 0; transitionIndex < (stage.transitions ?? []).length; transitionIndex++) {
            const transition = stage.transitions[transitionIndex];
            if (!isObject(transition)) continue;
            const transitionPath = `${path}.transitions[${transitionIndex}]`;
            if (!stageMap.has(transition.toStageId)) addError(errors, `${transitionPath}.toStageId`, 'references unknown stage');
            if (transition.toStageId === stage.id) addError(errors, `${transitionPath}.toStageId`, 'self transition is not supported');
            const guards = [...(transition.requiresAllEventIds ?? []), ...(transition.requiresAnyEventIds ?? [])];
            validateReferences(errors, guards, eventMap, transitionPath, 'event');
            guards.forEach(eventId => {
                if (!(stage.allowedEventIds ?? []).includes(eventId)) addError(errors, transitionPath, `guard ${eventId} is not allowed by this stage`);
            });
        }
    });
    secrets.forEach((secret, index) => validateReferences(errors, secret.unlockStageIds ?? [], stageMap, `$.hidden.secrets[${index}].unlockStageIds`, 'stage'));
    continuityRules.forEach((rule, index) => {
        validateReferences(errors, rule.whenEventIds ?? [], eventMap, `$.continuityRules[${index}].whenEventIds`, 'event');
        validateReferences(errors, rule.activeStageIds ?? [], stageMap, `$.continuityRules[${index}].activeStageIds`, 'stage');
    });
    if (isObject(input.reentry)) {
        if (!guidanceMap.has(input.reentry.guidanceId)) addError(errors, '$.reentry.guidanceId', 'references unknown guidance');
        validateReferences(errors, input.reentry.disabledStageIds ?? [], stageMap, '$.reentry.disabledStageIds', 'stage');
    }

    if (stageMap.has(input.entryStageId)) {
        const reachable = new Set([input.entryStageId]);
        const queue = [input.entryStageId];
        while (queue.length) {
            const stage = stageMap.get(queue.shift());
            for (const transition of stage?.transitions ?? []) {
                if (stageMap.has(transition.toStageId) && !reachable.has(transition.toStageId)) {
                    reachable.add(transition.toStageId);
                    queue.push(transition.toStageId);
                }
            }
        }
        stages.forEach((stage, index) => {
            if (isObject(stage) && !reachable.has(stage.id)) addError(errors, `$.stages[${index}].id`, 'stage is unreachable');
        });
    }

    secrets.forEach((secret, secretIndex) => {
        stages.forEach(stage => {
            if (!isObject(stage) || (secret.unlockStageIds ?? []).includes(stage.id)) return;
            let packet = collectPublicText(input, stage, revealMap, outcomeMap, guidanceMap);
            packet += `\n${activeContinuityText(input, stage.id).join('\n')}`;
            if (stage.terminal && isText(input.completion?.memoryText)) packet += `\n${input.completion.memoryText}`;
            try {
                // The Director sees more than the main model: current OM definitions and
                // the public shell of directly reachable stages. Validate the exact view
                // instead of assuming the authored fields are harmless.
                packet += `\n${JSON.stringify(buildDirectorView(input, { currentStageId: stage.id }))}`;
            } catch {
                // Malformed stage structures already produce their own validation errors.
            }
            packet = packet.toLocaleLowerCase();
            (secret.leakTerms ?? []).forEach((term, termIndex) => {
                if (isText(term) && packet.includes(term.toLocaleLowerCase())) {
                    addError(errors, `$.hidden.secrets[${secretIndex}].leakTerms[${termIndex}]`, `leaks through locked stage ${stage.id}`);
                }
            });
        });
    });

    return { valid: errors.length === 0, errors, warnings };
}

export function normalizeStoryPackage(input) {
    const result = validateStoryPackage(input);
    if (!result.valid) throw new Error(result.errors.join('\n'));
    return structuredClone(input);
}

export function getStage(story, stageId) {
    return story?.stages?.find(stage => stage.id === stageId) ?? null;
}

export function getTransition(stage, transitionId) {
    return stage?.transitions?.find(transition => transition.id === transitionId) ?? null;
}

export function getReentryStatus(story, runtime, { includeCurrentDetour = false } = {}) {
    const stage = getStage(story, runtime?.currentStageId) ?? getStage(story, story?.entryStageId);
    const policy = story?.reentry;
    const disabled = !stage
        || stage.terminal
        || !policy
        || (policy.disabledStageIds ?? []).includes(stage.id);
    const attempts = Math.max(0, Number(runtime?.reentryAttemptsByStage?.[stage?.id] ?? 0));
    const detourTurns = Math.max(0, Number(runtime?.detourTurns ?? 0));
    const requiredDetourTurns = attempts > 0 ? Number(policy?.cooldownDetourTurns ?? 1) : Number(policy?.afterDetourTurns ?? 1);
    const effectiveDetourTurns = detourTurns + (includeCurrentDetour ? 1 : 0);
    const threadStatus = ['active', 'deferred', 'paused', 'reentry_offered'].includes(runtime?.threadStatus)
        ? runtime.threadStatus
        : 'active';
    const hasDeferredThread = threadStatus === 'deferred' || threadStatus === 'reentry_offered';
    return {
        enabled: !disabled,
        eligible: !disabled
            && hasDeferredThread
            && threadStatus !== 'paused'
            && attempts < Number(policy.maxAttemptsPerStage)
            && effectiveDetourTurns >= requiredDetourTurns,
        hasDeferredThread,
        threadStatus,
        detourTurns,
        effectiveDetourTurns,
        requiredDetourTurns,
        attempts,
        maxAttempts: Number(policy?.maxAttemptsPerStage ?? 0),
    };
}

export function buildDirectorView(story, runtime) {
    const stage = getStage(story, runtime.currentStageId) ?? getStage(story, story.entryStageId);
    if (!stage) throw new Error('Story has no active stage.');
    const events = mapById(story.events);
    const reveals = mapById(story.reveals);
    const outcomes = mapById(story.forbiddenOutcomes);
    const reachableStages = stage.transitions
        .map(transition => getStage(story, transition.toStageId))
        .filter(Boolean)
        .map(next => ({
            id: next.id,
            publicObjective: next.publicObjective,
            forbiddenOutcomes: next.forbiddenOutcomeIds.map(id => outcomes.get(id)?.safeDescription).filter(Boolean),
        }));
    return {
        schemaVersion: story.schemaVersion,
        storyId: story.storyId,
        storyVersion: story.version,
        publicPremise: story.publicPremise,
        authorRules: structuredClone(story.authorRules),
        currentStage: {
            id: stage.id,
            publicObjective: stage.publicObjective,
            allowedEventIds: structuredClone(stage.allowedEventIds),
            allowedReveals: stage.allowedRevealIds.map(id => reveals.get(id)).filter(Boolean).map(item => ({ id: item.id, text: item.text })),
            forbiddenOutcomes: stage.forbiddenOutcomeIds.map(id => outcomes.get(id)).filter(Boolean).map(item => ({ id: item.id, safeDescription: item.safeDescription })),
            transitions: structuredClone(stage.transitions),
        },
        eventDefinitions: stage.allowedEventIds.map(id => events.get(id)).filter(Boolean).map(item => structuredClone(item)),
        reachableStages,
        violationIds: structuredClone(BUILTIN_VIOLATION_IDS),
    };
}

export function resolveStageDirection(story, stageId, interactionMode = 'hold_for_evidence') {
    const stage = getStage(story, stageId);
    if (!stage) throw new Error(`Unknown story stage: ${stageId}`);
    const guidanceId = interactionMode === REENTRY_INTERACTION_MODE
        ? story.reentry?.guidanceId
        : stage.interactionRoutes?.[interactionMode] ?? stage.interactionRoutes?.default;
    const guidance = story.safeGuidance.find(item => item.id === guidanceId);
    if (!guidance) throw new Error(`Missing guidance for stage ${stage.id}.`);
    const revealMap = mapById(story.reveals);
    const outcomeMap = mapById(story.forbiddenOutcomes);
    return {
        stage,
        guidance,
        reveals: stage.allowedRevealIds.map(id => revealMap.get(id)).filter(Boolean),
        forbiddenOutcomes: stage.forbiddenOutcomeIds.map(id => outcomeMap.get(id)).filter(Boolean),
    };
}

export function resolveContinuityFacts(story, runtime) {
    const confirmed = new Set(runtime?.confirmedEventIds ?? []);
    const stageId = runtime?.currentStageId;
    return (story?.continuityRules ?? [])
        .filter(rule => rule.activeStageIds.includes(stageId) && rule.whenEventIds.every(eventId => confirmed.has(eventId)))
        .map(rule => ({ id: rule.id, text: rule.text }));
}
