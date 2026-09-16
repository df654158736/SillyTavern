import {
    getStage,
    getTransition,
    INTERACTION_MODES,
    REENTRY_INTERACTION_MODE,
} from './package.js';

export const RUNTIME_SCHEMA_VERSION = 2;
export const SNAPSHOT_KEY = 'story_controller_snapshot';
export const BASELINE_METADATA_KEY = 'story_controller_baseline';
export const ASSIGNMENT_METADATA_KEY = 'story_controller_assignment';

function asInteger(value, fallback) {
    return Number.isInteger(Number(value)) ? Number(value) : fallback;
}

function uniqueStrings(value) {
    return [...new Set((Array.isArray(value) ? value : []).filter(item => typeof item === 'string' && item.trim()).map(item => item.trim()))];
}

function normalizeEvidence(value) {
    const output = {};
    if (!value || typeof value !== 'object' || Array.isArray(value)) return output;
    for (const [eventId, evidence] of Object.entries(value)) {
        const normalized = (Array.isArray(evidence) ? evidence : [])
            .filter(item => item && typeof item === 'object' && Number.isInteger(Number(item.messageId)) && typeof item.quote === 'string' && item.quote.trim())
            .map(item => ({ messageId: Number(item.messageId), quote: item.quote.trim() }));
        if (normalized.length) output[eventId] = normalized;
    }
    return output;
}

function normalizeReentryAttempts(value, story) {
    const output = {};
    if (!value || typeof value !== 'object' || Array.isArray(value)) return output;
    for (const [stageId, attempts] of Object.entries(value)) {
        const normalized = asInteger(attempts, -1);
        if (getStage(story, stageId) && normalized >= 0) output[stageId] = normalized;
    }
    return output;
}

export function createRuntime(story, processedThroughMessageId = -1) {
    return {
        schemaVersion: RUNTIME_SCHEMA_VERSION,
        storyId: story.storyId,
        storyVersion: story.version,
        version: 0,
        currentStageId: story.entryStageId,
        processedThroughMessageId: asInteger(processedThroughMessageId, -1),
        confirmedEventIds: [],
        eventEvidence: {},
        visitedStageIds: [story.entryStageId],
        activeInteractionMode: 'hold_for_evidence',
        threadStatus: 'active',
        detourTurns: 0,
        reentryAttemptsByStage: {},
        lastTransitionId: null,
        violations: [],
        status: 'active',
        completedAtMessageId: null,
    };
}

export function normalizeRuntime(input, story) {
    const base = createRuntime(story);
    if (!input || typeof input !== 'object' || input.storyId !== story.storyId || Number(input.storyVersion) !== Number(story.version)) return base;
    base.version = Math.max(0, asInteger(input.version, 0));
    base.currentStageId = getStage(story, input.currentStageId) ? input.currentStageId : story.entryStageId;
    base.processedThroughMessageId = asInteger(input.processedThroughMessageId, -1);
    base.confirmedEventIds = uniqueStrings(input.confirmedEventIds).filter(id => story.events.some(event => event.id === id));
    base.eventEvidence = normalizeEvidence(input.eventEvidence);
    base.visitedStageIds = uniqueStrings(input.visitedStageIds).filter(id => getStage(story, id));
    if (!base.visitedStageIds.includes(story.entryStageId)) base.visitedStageIds.unshift(story.entryStageId);
    if (!base.visitedStageIds.includes(base.currentStageId)) base.visitedStageIds.push(base.currentStageId);
    base.activeInteractionMode = INTERACTION_MODES.includes(input.activeInteractionMode)
        && (input.activeInteractionMode !== REENTRY_INTERACTION_MODE || story.reentry)
        ? input.activeInteractionMode
        : 'hold_for_evidence';
    base.threadStatus = ['active', 'deferred', 'paused', 'reentry_offered'].includes(input.threadStatus) ? input.threadStatus : 'active';
    base.detourTurns = Math.max(0, asInteger(input.detourTurns, 0));
    base.reentryAttemptsByStage = normalizeReentryAttempts(input.reentryAttemptsByStage, story);
    base.lastTransitionId = typeof input.lastTransitionId === 'string' ? input.lastTransitionId : null;
    base.violations = (Array.isArray(input.violations) ? input.violations : [])
        .filter(item => item && typeof item === 'object' && typeof item.id === 'string')
        .slice(-10)
        .map(item => ({
            id: item.id,
            messageIds: [...new Set((item.messageIds ?? []).map(Number).filter(Number.isInteger))],
            detectedAtMessageId: asInteger(item.detectedAtMessageId, base.processedThroughMessageId),
        }));
    base.status = ['active', 'paused', 'completed', 'conflict'].includes(input.status) ? input.status : 'active';
    if (getStage(story, base.currentStageId)?.terminal) base.status = 'completed';
    base.completedAtMessageId = Number.isInteger(Number(input.completedAtMessageId)) ? Number(input.completedAtMessageId) : null;
    if (base.status !== 'completed') base.completedAtMessageId = null;
    return base;
}

export function findLatestSnapshot(chat, story, beforeOrAt = Number.POSITIVE_INFINITY) {
    let best = null;
    for (let index = Math.min(chat.length - 1, beforeOrAt); index >= 0; index--) {
        const snapshot = chat[index]?.extra?.[SNAPSHOT_KEY];
        if (!snapshot || snapshot.valid === false || snapshot.storyId !== story.storyId || Number(snapshot.storyVersion) !== Number(story.version)) continue;
        if (Number.isInteger(snapshot.anchorMessageId) && snapshot.anchorMessageId !== index) continue;
        const runtime = normalizeRuntime(snapshot.runtime, story);
        const candidate = { index, snapshot, runtime };
        if (!best
            || runtime.processedThroughMessageId > best.runtime.processedThroughMessageId
            || (runtime.processedThroughMessageId === best.runtime.processedThroughMessageId && runtime.version > best.runtime.version)
            || (runtime.processedThroughMessageId === best.runtime.processedThroughMessageId && runtime.version === best.runtime.version && index > best.index)) {
            best = candidate;
        }
    }
    return best;
}

export function saveSnapshot(message, messageId, story, runtime, details = {}) {
    if (!message || typeof message !== 'object') return null;
    const anchorMessageId = asInteger(messageId, null);
    message.extra ??= {};
    message.extra[SNAPSHOT_KEY] = {
        valid: true,
        storyId: story.storyId,
        storyVersion: story.version,
        anchorMessageId,
        runtime: normalizeRuntime(runtime, story),
        kind: details.kind ?? 'evaluated',
        decision: details.decision ?? null,
        observation: details.observation ?? null,
        error: typeof details.error === 'string' ? details.error : '',
        savedAt: new Date().toISOString(),
    };
    return message.extra[SNAPSHOT_KEY];
}

export function invalidateSnapshots(chat, fromMessageId = 0) {
    let changed = false;
    for (let index = Math.max(0, asInteger(fromMessageId, 0)); index < chat.length; index++) {
        const snapshot = chat[index]?.extra?.[SNAPSHOT_KEY];
        if (snapshot && snapshot.valid !== false) {
            snapshot.valid = false;
            changed = true;
        }
    }
    return changed;
}

export function removeSnapshots(chat) {
    let changed = false;
    for (const message of chat) {
        if (message?.extra?.[SNAPSHOT_KEY]) {
            delete message.extra[SNAPSHOT_KEY];
            changed = true;
        }
    }
    return changed;
}

export function sanitizeStoryText(text) {
    return String(text ?? '')
        .replace(/<(thinking|think)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '')
        .replace(/<(?:thinking|think)\b[^>]*>[\s\S]*$/gi, '')
        .replace(/<!--\s*Start the ECoT\s*-->[\s\S]*?<!--\s*End of The ECoT\s*-->/gi, '')
        .replace(/<meow_FM>[\s\S]*?<\/meow_FM>/gi, '')
        .replace(/<branches\b[^>]*>[\s\S]*?<\/branches>/gi, '')
        .trim();
}

export function collectAcceptedMessages(chat, afterMessageId, throughMessageId, maximum = 10) {
    const start = Math.max(0, asInteger(afterMessageId, -1) + 1);
    const end = Math.min(chat.length - 1, asInteger(throughMessageId, chat.length - 1));
    const messages = chat.slice(start, end + 1).map((message, offset) => ({
        id: start + offset,
        role: message.is_user ? 'user' : 'assistant',
        content: sanitizeStoryText(message.mes),
    })).filter(message => message.content);
    return messages.slice(-Math.max(2, asInteger(maximum, 10)));
}

function appendEvidence(runtime, eventId, evidence) {
    runtime.eventEvidence[eventId] ??= [];
    const known = new Set(runtime.eventEvidence[eventId].map(item => `${item.messageId}:${item.quote}`));
    for (const item of evidence) {
        const key = `${item.messageId}:${item.quote}`;
        if (!known.has(key)) {
            runtime.eventEvidence[eventId].push({ messageId: item.messageId, quote: item.quote });
            known.add(key);
        }
    }
}

export function transitionRequirementsMet(transition, confirmedEventIds) {
    const confirmed = new Set(confirmedEventIds);
    const all = transition?.requiresAllEventIds ?? [];
    const any = transition?.requiresAnyEventIds ?? [];
    return all.every(id => confirmed.has(id)) && (any.length === 0 || any.some(id => confirmed.has(id)));
}

export function applyDirectorDecision(previous, story, decision, throughMessageId, { commit = true } = {}) {
    const before = normalizeRuntime(previous, story);
    const next = structuredClone(before);
    next.processedThroughMessageId = asInteger(throughMessageId, before.processedThroughMessageId);
    const canCommit = commit && decision?.confidence === 'high';
    let transitioned = false;

    if (canCommit) {
        const evaluatedStageId = next.currentStageId;
        for (const eventId of decision.observedEventIds ?? []) {
            if (!next.confirmedEventIds.includes(eventId)) next.confirmedEventIds.push(eventId);
            appendEvidence(next, eventId, (decision.evidence ?? []).filter(item => item.eventId === eventId));
        }
        next.activeInteractionMode = INTERACTION_MODES.includes(decision.interactionMode) ? decision.interactionMode : 'hold_for_evidence';
        const stage = getStage(story, next.currentStageId);
        const transition = getTransition(stage, decision.transitionId);
        const transitionHeldByMode = ['emotional_pause', 'follow_user_detour', REENTRY_INTERACTION_MODE, 'recover_from_leak'].includes(next.activeInteractionMode);
        if (transition && !transitionHeldByMode && transitionRequirementsMet(transition, next.confirmedEventIds)) {
            next.currentStageId = transition.toStageId;
            next.lastTransitionId = transition.id;
            if (!next.visitedStageIds.includes(next.currentStageId)) next.visitedStageIds.push(next.currentStageId);
            transitioned = true;
        }
        for (const id of decision.violationIds ?? []) {
            next.violations.push({
                id,
                messageIds: [...new Set((decision.evidence ?? []).flatMap(item => item.messageIds ?? [item.messageId]).map(Number).filter(Number.isInteger))],
                detectedAtMessageId: next.processedThroughMessageId,
            });
        }
        next.violations = next.violations.slice(-10);
        if (decision.violationIds?.length) {
            next.activeInteractionMode = 'recover_from_leak';
        } else if (transitioned && !['emotional_pause', 'recover_from_leak'].includes(next.activeInteractionMode)) {
            // Once an edge is committed, evidence for the old gate is no longer
            // pending. Use the new stage's participation route instead of
            // stalling because of an overly conservative model mode.
            next.activeInteractionMode = 'invite_user_check';
        }

        if (transitioned) {
            next.threadStatus = 'active';
            next.detourTurns = 0;
        } else if (next.activeInteractionMode === 'emotional_pause') {
            next.threadStatus = 'paused';
            next.detourTurns = 0;
        } else if (next.activeInteractionMode === 'follow_user_detour') {
            next.threadStatus = 'deferred';
            next.detourTurns = before.threadStatus === 'deferred' || before.threadStatus === 'reentry_offered'
                ? before.detourTurns + 1
                : 1;
        } else if (next.activeInteractionMode === REENTRY_INTERACTION_MODE) {
            next.threadStatus = 'reentry_offered';
            next.detourTurns = 0;
            next.reentryAttemptsByStage[evaluatedStageId] = (next.reentryAttemptsByStage[evaluatedStageId] ?? 0) + 1;
        } else {
            next.threadStatus = 'active';
            next.detourTurns = 0;
        }
    }

    const stage = getStage(story, next.currentStageId);
    next.status = stage?.terminal ? 'completed' : 'active';
    if (next.status === 'completed' && next.completedAtMessageId === null) next.completedAtMessageId = next.processedThroughMessageId;
    if (next.status !== 'completed') next.completedAtMessageId = null;
    const changed = JSON.stringify({ ...before, processedThroughMessageId: next.processedThroughMessageId }) !== JSON.stringify(next);
    if (changed) next.version = before.version + 1;
    return { runtime: next, changed, transitioned };
}

export function advanceWithoutDecision(previous, story, throughMessageId) {
    const runtime = normalizeRuntime(previous, story);
    runtime.processedThroughMessageId = asInteger(throughMessageId, runtime.processedThroughMessageId);
    return runtime;
}
