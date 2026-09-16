import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
    getReentryStatus,
    validateStoryPackage,
} from '../public/scripts/extensions/third-party/story-controller/package.js';
import { validateDirectorDecision } from '../public/scripts/extensions/third-party/story-controller/director.js';
import { renderMainModelView } from '../public/scripts/extensions/third-party/story-controller/prompt.js';
import {
    applyDirectorDecision,
    createRuntime,
} from '../public/scripts/extensions/third-party/story-controller/state.js';

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const bundledStoryPath = path.resolve(testDirectory, '../public/scripts/extensions/third-party/story-controller/packages/xiaoya-s4-unfinished-coda.story.json');

function decision(stageId, interactionMode, overrides = {}) {
    return {
        stageId,
        observedEventIds: [],
        evidence: [],
        transitionId: null,
        interactionMode,
        violationIds: [],
        confidence: 'high',
        ...overrides,
    };
}

function runtimeAt(story, stageId) {
    const runtime = createRuntime(story);
    runtime.currentStageId = stageId;
    runtime.visitedStageIds = [story.entryStageId, stageId];
    return runtime;
}

function acceptedUserMessage(id, content) {
    return [{ id, role: 'user', content }];
}

describe('Story Controller natural reentry A/B simulation', () => {
    const storyB = JSON.parse(fs.readFileSync(bundledStoryPath, 'utf8'));
    const storyA = structuredClone(storyB);
    delete storyA.reentry;

    test('A keeps following a free detour while B offers one bounded natural return', () => {
        expect(validateStoryPackage(storyA).valid).toBe(true);
        expect(validateStoryPackage(storyB).valid).toBe(true);

        const stageId = 'STAGE_BOX_CLOSED';
        const firstUserInput = '先别打开，我现在有点饿。我们去厨房煮碗面，吃完再说。';
        const secondUserInput = '面里多放点青菜吧，冰箱里的鸡蛋也快过期了。';
        expect(firstUserInput).toContain('先别打开');
        expect(secondUserInput).not.toMatch(/打开|箱子|旧物/);

        const firstDecisionA = validateDirectorDecision(
            decision(stageId, 'follow_user_detour'),
            storyA,
            runtimeAt(storyA, stageId),
            acceptedUserMessage(1, firstUserInput),
        );
        const firstDecisionB = validateDirectorDecision(
            decision(stageId, 'follow_user_detour'),
            storyB,
            runtimeAt(storyB, stageId),
            acceptedUserMessage(1, firstUserInput),
        );
        const afterFirstA = applyDirectorDecision(runtimeAt(storyA, stageId), storyA, firstDecisionA, 1).runtime;
        const afterFirstB = applyDirectorDecision(runtimeAt(storyB, stageId), storyB, firstDecisionB, 1).runtime;
        expect(afterFirstA.threadStatus).toBe('deferred');
        expect(afterFirstB.threadStatus).toBe('deferred');

        const secondDecisionA = validateDirectorDecision(
            decision(stageId, 'follow_user_detour'),
            storyA,
            afterFirstA,
            acceptedUserMessage(3, secondUserInput),
        );
        const secondDecisionB = validateDirectorDecision(
            decision(stageId, 'follow_user_detour'),
            storyB,
            afterFirstB,
            acceptedUserMessage(3, secondUserInput),
        );
        const afterSecondA = applyDirectorDecision(afterFirstA, storyA, secondDecisionA, 3).runtime;
        const afterSecondB = applyDirectorDecision(afterFirstB, storyB, secondDecisionB, 3).runtime;
        const promptA = renderMainModelView(storyA, afterSecondA);
        const promptB = renderMainModelView(storyB, afterSecondB);

        expect(promptA).toContain('自然回应用户转向的生活话题');
        expect(promptA).not.toContain('自然带回一次开放事项');
        expect(promptB).toContain('先完整回应用户当前正在聊的生活话题');
        expect(promptB).toContain('自然带回一次开放事项');
        expect(promptB).toContain('不替用户决定');
        expect(afterSecondB.currentStageId).toBe(stageId);
        expect(afterSecondB.confirmedEventIds).not.toContain('OM_BOX_OPENING_CHOSEN');
        expect(afterSecondB.reentryAttemptsByStage[stageId]).toBe(1);
    });

    test('ignoring the return offer enters cooldown instead of nagging every turn', () => {
        const stageId = 'STAGE_BOX_CLOSED';
        const first = applyDirectorDecision(runtimeAt(storyB, stageId), storyB, decision(stageId, 'follow_user_detour'), 1).runtime;
        const offered = applyDirectorDecision(first, storyB, decision(stageId, 'reenter_story'), 3).runtime;
        const ignored = applyDirectorDecision(offered, storyB, decision(stageId, 'follow_user_detour'), 5).runtime;
        expect(ignored.threadStatus).toBe('deferred');
        expect(ignored.detourTurns).toBe(1);
        expect(getReentryStatus(storyB, ignored, { includeCurrentDetour: true }).eligible).toBe(false);
        expect(renderMainModelView(storyB, ignored)).toContain('不机械催剧情');
    });

    test('an explicit pause blocks automatic return until the user reopens the thread', () => {
        const stageId = 'STAGE_BOX_CLOSED';
        const deferred = applyDirectorDecision(runtimeAt(storyB, stageId), storyB, decision(stageId, 'follow_user_detour'), 1).runtime;
        const paused = applyDirectorDecision(deferred, storyB, decision(stageId, 'emotional_pause'), 3).runtime;
        expect(paused.threadStatus).toBe('paused');
        expect(getReentryStatus(storyB, paused, { includeCurrentDetour: true }).eligible).toBe(false);
        expect(renderMainModelView(storyB, paused)).toContain('允许沉默、哭泣、安慰或暂停');
    });

    test('the first detour is always respected even with the minimum package threshold', () => {
        const story = structuredClone(storyB);
        story.reentry.afterDetourTurns = 1;
        const stageId = 'STAGE_BOX_CLOSED';
        const fresh = runtimeAt(story, stageId);
        expect(getReentryStatus(story, fresh, { includeCurrentDetour: true }).eligible).toBe(false);
        expect(validateDirectorDecision(
            decision(stageId, 'follow_user_detour'),
            story,
            fresh,
            acceptedUserMessage(1, '先去外面走走吧，这件事晚点再说。'),
        ).interactionMode).toBe('follow_user_detour');
    });

    test('a free user return advances by OM evidence rather than being mislabeled reentry', () => {
        const stageId = 'STAGE_BOX_CLOSED';
        const deferred = applyDirectorDecision(runtimeAt(storyB, stageId), storyB, decision(stageId, 'follow_user_detour'), 1).runtime;
        const userInput = '面吃完了。我们现在一起打开箱子吧，不管里面是什么，我都在。';
        const returnedDecision = validateDirectorDecision(decision(stageId, 'invite_user_check', {
            observedEventIds: ['OM_BOX_OPENING_CHOSEN'],
            evidence: [{ eventId: 'OM_BOX_OPENING_CHOSEN', messageId: 3, quote: '我们现在一起打开箱子吧' }],
            transitionId: 'TRANSITION_BOX_TO_OPENED',
        }), storyB, deferred, acceptedUserMessage(3, userInput));
        const returned = applyDirectorDecision(deferred, storyB, returnedDecision, 3).runtime;
        expect(returned.currentStageId).toBe('STAGE_BOX_OPENED');
        expect(returned.threadStatus).toBe('active');
        expect(returned.activeInteractionMode).toBe('invite_user_check');
    });
});
