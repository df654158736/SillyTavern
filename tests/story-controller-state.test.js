import {
    applyDirectorDecision,
    collectAcceptedMessages,
    createRuntime,
    findLatestSnapshot,
    invalidateSnapshots,
    normalizeRuntime,
    saveSnapshot,
} from '../public/scripts/extensions/third-party/story-controller/state.js';
import { getReentryStatus } from '../public/scripts/extensions/third-party/story-controller/package.js';
import { createReentryStoryFixture, createStoryFixture } from './story-controller-fixture.js';

function dateDecision(confidence = 'high') {
    return {
        stageId: 'STAGE_DATES',
        observedEventIds: ['OM_DATES_CONFIRMED'],
        evidence: [{ eventId: 'OM_DATES_CONFIRMED', messageId: 1, quote: '两个日期确实对不上' }],
        transitionId: 'TRANSITION_DATES_TO_AUDIO',
        interactionMode: 'invite_user_check',
        violationIds: [],
        confidence,
    };
}

describe('Story Controller runtime', () => {
    test('commits a high-confidence adjacent transition with evidence', () => {
        const story = createStoryFixture();
        const result = applyDirectorDecision(createRuntime(story), story, dateDecision(), 1);
        expect(result.transitioned).toBe(true);
        expect(result.runtime.currentStageId).toBe('STAGE_AUDIO');
        expect(result.runtime.activeInteractionMode).toBe('invite_user_check');
        expect(result.runtime.confirmedEventIds).toEqual(['OM_DATES_CONFIRMED']);
        expect(result.runtime.eventEvidence.OM_DATES_CONFIRMED[0].messageId).toBe(1);
        expect(result.runtime.version).toBe(1);
    });

    test('does not commit medium-confidence or observation-mode decisions', () => {
        const story = createStoryFixture();
        const medium = applyDirectorDecision(createRuntime(story), story, dateDecision('medium'), 1);
        const observed = applyDirectorDecision(createRuntime(story), story, dateDecision(), 1, { commit: false });
        expect(medium.runtime.currentStageId).toBe('STAGE_DATES');
        expect(medium.runtime.confirmedEventIds).toEqual([]);
        expect(observed.runtime.currentStageId).toBe('STAGE_DATES');
        expect(observed.runtime.processedThroughMessageId).toBe(1);
    });

    test('normalizes committed transitions and gives leak recovery priority', () => {
        const story = createStoryFixture();
        const conservative = dateDecision();
        conservative.interactionMode = 'hold_for_evidence';
        const transitioned = applyDirectorDecision(createRuntime(story), story, conservative, 1);
        expect(transitioned.runtime.activeInteractionMode).toBe('invite_user_check');

        const leaked = applyDirectorDecision(createRuntime(story), story, {
            stageId: 'STAGE_DATES',
            observedEventIds: [],
            evidence: [],
            transitionId: null,
            interactionMode: 'emotional_pause',
            violationIds: ['V_PREMATURE_REVEAL'],
            confidence: 'high',
        }, 1);
        expect(leaked.runtime.activeInteractionMode).toBe('recover_from_leak');
    });

    test('can record a milestone without transitioning while the interaction is paused', () => {
        const story = createStoryFixture();
        const paused = dateDecision();
        paused.interactionMode = 'emotional_pause';
        const result = applyDirectorDecision(createRuntime(story), story, paused, 1);
        expect(result.transitioned).toBe(false);
        expect(result.runtime.currentStageId).toBe('STAGE_DATES');
        expect(result.runtime.confirmedEventIds).toEqual(['OM_DATES_CONFIRMED']);
        expect(result.runtime.activeInteractionMode).toBe('emotional_pause');
    });

    test('tracks deferred threads, bounded reentry attempts and explicit pauses separately', () => {
        const story = createReentryStoryFixture();
        const decision = interactionMode => ({
            stageId: 'STAGE_DATES',
            observedEventIds: [],
            evidence: [],
            transitionId: null,
            interactionMode,
            violationIds: [],
            confidence: 'high',
        });
        const firstDetour = applyDirectorDecision(createRuntime(story), story, decision('follow_user_detour'), 1).runtime;
        expect(firstDetour.threadStatus).toBe('deferred');
        expect(firstDetour.detourTurns).toBe(1);
        expect(getReentryStatus(story, firstDetour, { includeCurrentDetour: true }).eligible).toBe(true);

        const reentered = applyDirectorDecision(firstDetour, story, decision('reenter_story'), 3).runtime;
        expect(reentered.threadStatus).toBe('reentry_offered');
        expect(reentered.detourTurns).toBe(0);
        expect(reentered.reentryAttemptsByStage.STAGE_DATES).toBe(1);

        const ignored = applyDirectorDecision(reentered, story, decision('follow_user_detour'), 5).runtime;
        expect(ignored.threadStatus).toBe('deferred');
        expect(ignored.detourTurns).toBe(1);
        expect(getReentryStatus(story, ignored, { includeCurrentDetour: true }).eligible).toBe(false);

        const paused = applyDirectorDecision(ignored, story, decision('emotional_pause'), 7).runtime;
        expect(paused.threadStatus).toBe('paused');
        expect(paused.detourTurns).toBe(0);
        expect(getReentryStatus(story, paused, { includeCurrentDetour: true }).eligible).toBe(false);
    });

    test('migrates old runtime snapshots to active thread defaults', () => {
        const story = createReentryStoryFixture();
        const old = createRuntime(story);
        delete old.threadStatus;
        delete old.detourTurns;
        delete old.reentryAttemptsByStage;
        const migrated = normalizeRuntime(old, story);
        expect(migrated.threadStatus).toBe('active');
        expect(migrated.detourTurns).toBe(0);
        expect(migrated.reentryAttemptsByStage).toEqual({});
    });

    test('records the message where a terminal stage was reached', () => {
        const story = createStoryFixture();
        const first = applyDirectorDecision(createRuntime(story), story, dateDecision(), 1).runtime;
        const completed = applyDirectorDecision(first, story, {
            stageId: 'STAGE_AUDIO',
            observedEventIds: ['OM_AUDIO_CONFIRMED'],
            evidence: [{ eventId: 'OM_AUDIO_CONFIRMED', messageId: 3, quote: '我找到并打开录音了' }],
            transitionId: 'TRANSITION_AUDIO_TO_TRUTH',
            interactionMode: 'invite_user_check',
            violationIds: [],
            confidence: 'high',
        }, 3).runtime;
        expect(completed.currentStageId).toBe('STAGE_TRUTH');
        expect(completed.status).toBe('completed');
        expect(completed.completedAtMessageId).toBe(3);
    });

    test('finds and invalidates compatible snapshots', () => {
        const story = createStoryFixture();
        const chat = [{ is_user: true, extra: {} }, { is_user: true, extra: {} }];
        saveSnapshot(chat[0], 0, story, createRuntime(story, 0));
        const advanced = { ...createRuntime(story, 1), version: 2, currentStageId: 'STAGE_AUDIO', visitedStageIds: ['STAGE_DATES', 'STAGE_AUDIO'] };
        saveSnapshot(chat[1], 1, story, advanced);
        expect(findLatestSnapshot(chat, story)?.runtime.currentStageId).toBe('STAGE_AUDIO');
        expect(invalidateSnapshots(chat, 1)).toBe(true);
        expect(findLatestSnapshot(chat, story)?.index).toBe(0);
    });

    test('collects accepted story text without hidden reasoning blocks', () => {
        const chat = [
            { is_user: true, mes: '开始检查。' },
            { is_user: false, mes: '<thinking>秘密推演</thinking>她拿起信封。' },
            { is_user: true, mes: '两个日期确实对不上。' },
        ];
        const messages = collectAcceptedMessages(chat, -1, 2, 10);
        expect(messages).toHaveLength(3);
        expect(messages[1].content).toBe('她拿起信封。');
        expect(JSON.stringify(messages)).not.toContain('秘密推演');
    });
});
