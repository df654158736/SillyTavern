import fs from 'node:fs';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { validateDirectorDecision } from '../public/scripts/extensions/third-party/story-controller/director.js';
import {
    assertSafeMainModelView,
    isCompletionDirectionReleased,
    renderCompletionMemory,
    renderMainModelView,
} from '../public/scripts/extensions/third-party/story-controller/prompt.js';
import {
    getReentryStatus,
    getStage,
    validateStoryPackage,
} from '../public/scripts/extensions/third-party/story-controller/package.js';
import {
    applyDirectorDecision,
    createRuntime,
} from '../public/scripts/extensions/third-party/story-controller/state.js';

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const packageDirectory = path.resolve(testDirectory, '../public/scripts/extensions/third-party/story-controller/packages');
const story = JSON.parse(fs.readFileSync(path.join(packageDirectory, 'xiaoya-s4-unfinished-coda.story.json'), 'utf8'));
const probeCases = JSON.parse(fs.readFileSync(path.join(packageDirectory, 'xiaoya-s4-unfinished-coda.cases.json'), 'utf8')).cases;

function enumeratePaths(stageId = story.entryStageId, pathSoFar = []) {
    const stage = getStage(story, stageId);
    if (stage.terminal) return [pathSoFar];
    return stage.transitions.flatMap(transition => enumeratePaths(
        transition.toStageId,
        [...pathSoFar, transition],
    ));
}

function advancingCase(stageId, transitionId) {
    const probe = probeCases.find(item => item.stageId === stageId && item.expected?.transitionId === transitionId);
    if (!probe) throw new Error(`Missing advancing case for ${transitionId}.`);
    return probe;
}

function remapMessages(messages, firstMessageId) {
    return messages.map((message, index) => ({
        ...message,
        id: firstMessageId + index,
    }));
}

function simulatedDirectorDecision(runtime, probe, messages) {
    const eventMap = new Map(story.events.map(event => [event.id, event]));
    const evidence = probe.expected.eventIds.map(eventId => {
        const event = eventMap.get(eventId);
        const source = [...messages].reverse().find(message => event.allowedRoles.includes(message.role));
        if (!source) throw new Error(`No allowed evidence message for ${eventId}.`);
        return { eventId, messageId: source.id, quote: source.content };
    });
    return validateDirectorDecision({
        stageId: runtime.currentStageId,
        observedEventIds: [...probe.expected.eventIds],
        evidence,
        transitionId: probe.expected.transitionId,
        interactionMode: probe.expected.interactionMode ?? 'invite_user_check',
        violationIds: [...probe.expected.violationIds],
        confidence: 'high',
    }, story, runtime, messages);
}

function interactionDecision(runtime, interactionMode) {
    return {
        stageId: runtime.currentStageId,
        observedEventIds: [],
        evidence: [],
        transitionId: null,
        interactionMode,
        violationIds: [],
        confidence: 'high',
    };
}

function assertSafeDirection(runtime) {
    const prompt = renderMainModelView(story, runtime);
    assert.doesNotThrow(() => assertSafeMainModelView(story, runtime, prompt));
    assert.ok(!prompt.includes('undefined'));
    return prompt;
}

describe('Story Controller complete deterministic journey simulation', () => {
    const paths = enumeratePaths();

    // eslint-disable-next-line jest/expect-expect, playwright/expect-expect
    test('enumerates every authored branch combination', () => {
        assert.deepEqual(validateStoryPackage(story), { valid: true, errors: [], warnings: [] });
        assert.equal(paths.length, 24);
        const coveredTransitions = new Set(paths.flatMap(route => route.map(transition => transition.id)));
        const authoredTransitions = story.stages.flatMap(stage => stage.transitions.map(transition => transition.id));
        assert.deepEqual([...coveredTransitions].sort(), [...authoredTransitions].sort());
    });

    // eslint-disable-next-line jest/expect-expect, playwright/expect-expect
    test.each(paths.map((route, index) => [index + 1, route]))('completes route %i without skipping, leaking or stalling', (_routeNumber, route) => {
        let runtime = createRuntime(story);
        let messageId = 0;
        const acceptedChat = [];

        for (const transition of route) {
            const stageId = runtime.currentStageId;
            assert.deepEqual(transition, getStage(story, stageId).transitions.find(item => item.id === transition.id));
            assertSafeDirection(runtime);

            // One journey deliberately leaves the plot for ordinary life. The first
            // turn is respected, the second receives one bounded invitation back,
            // and neither turn may become story evidence or a transition.
            if (_routeNumber === 1 && stageId === 'STAGE_BOX_CLOSED') {
                const firstDetourMessages = [{ id: messageId++, role: 'user', content: '先不碰箱子，我有点饿，我们去厨房煮面。' }];
                const firstDetour = validateDirectorDecision(
                    interactionDecision(runtime, 'follow_user_detour'), story, runtime, firstDetourMessages,
                );
                runtime = applyDirectorDecision(runtime, story, firstDetour, firstDetourMessages.at(-1).id).runtime;
                assert.equal(runtime.threadStatus, 'deferred');
                assert.equal(getReentryStatus(story, runtime, { includeCurrentDetour: true }).eligible, true);

                const secondDetourMessages = [{ id: messageId++, role: 'user', content: '面里加点青菜吧，吃完我们收拾一下厨房。' }];
                const reentry = validateDirectorDecision(
                    interactionDecision(runtime, 'follow_user_detour'), story, runtime, secondDetourMessages,
                );
                runtime = applyDirectorDecision(runtime, story, reentry, secondDetourMessages.at(-1).id).runtime;
                assert.equal(runtime.currentStageId, stageId);
                assert.equal(runtime.threadStatus, 'reentry_offered');
                assert.ok(!runtime.confirmedEventIds.includes('OM_BOX_OPENING_CHOSEN'));
                assert.match(assertSafeDirection(runtime), /自然带回一次开放事项/);
                acceptedChat.push(...firstDetourMessages, ...secondDetourMessages);
            }

            // A separate journey explicitly asks for emotional room. Pausing never
            // causes progress and suppresses automatic reentry until dialogue resumes.
            if (_routeNumber === 2 && stageId === 'STAGE_AFTER_PLAYBACK') {
                const pauseMessages = [{ id: messageId++, role: 'user', content: '我现在有点难受，先抱我一会儿，暂时不要继续。' }];
                const pause = validateDirectorDecision(
                    interactionDecision(runtime, 'emotional_pause'), story, runtime, pauseMessages,
                );
                runtime = applyDirectorDecision(runtime, story, pause, pauseMessages.at(-1).id).runtime;
                assert.equal(runtime.threadStatus, 'paused');
                assert.equal(runtime.currentStageId, stageId);
                assert.equal(getReentryStatus(story, runtime, { includeCurrentDetour: true }).eligible, false);
                acceptedChat.push(...pauseMessages);
            }

            const probe = advancingCase(stageId, transition.id);
            const messages = remapMessages(probe.messages, messageId);
            messageId += messages.length;
            const decision = simulatedDirectorDecision(runtime, probe, messages);
            const applied = applyDirectorDecision(runtime, story, decision, messages.at(-1).id);
            assert.equal(applied.transitioned, true);
            assert.equal(applied.runtime.currentStageId, transition.toStageId);
            assert.equal(applied.runtime.threadStatus, 'active');
            runtime = applied.runtime;
            acceptedChat.push(...messages);
        }

        assert.equal(getStage(story, runtime.currentStageId).terminal, true);
        assert.equal(runtime.status, 'completed');
        assertSafeDirection(runtime);

        const chatThroughCompletion = Array.from({ length: runtime.completedAtMessageId + 1 }, () => ({ is_user: true, mes: 'accepted' }));
        assert.equal(isCompletionDirectionReleased(story, runtime, chatThroughCompletion), false);
        const epilogueChat = [
            ...chatThroughCompletion,
            ...Array.from({ length: story.completion.epilogueAssistantMessages }, () => ({ is_user: false, mes: 'epilogue' })),
        ];
        assert.equal(isCompletionDirectionReleased(story, runtime, epilogueChat), true);
        assert.match(renderCompletionMemory(story), /<story_memory>/);
        assert.ok(acceptedChat.length >= route.length);
    });
});
