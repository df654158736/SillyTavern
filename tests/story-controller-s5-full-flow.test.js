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
const story = JSON.parse(fs.readFileSync(path.join(packageDirectory, 'xiaoya-s5-beyond-the-name.story.json'), 'utf8'));
const probeCases = JSON.parse(fs.readFileSync(path.join(packageDirectory, 'xiaoya-s5-beyond-the-name.cases.json'), 'utf8')).cases;

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
    return messages.map((message, index) => ({ ...message, id: firstMessageId + index }));
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

describe('Story Controller S5 identity-and-kinship full flow', () => {
    const paths = enumeratePaths();

    // eslint-disable-next-line jest/expect-expect, playwright/expect-expect
    test('covers every branch combination and authored edge', () => {
        assert.deepEqual(validateStoryPackage(story), { valid: true, errors: [], warnings: [] });
        assert.equal(story.schemaVersion, 2);
        assert.equal(story.version, 2);
        assert.equal(paths.length, 24);
        const coveredTransitions = new Set(paths.flatMap(route => route.map(transition => transition.id)));
        const authoredTransitions = story.stages.flatMap(stage => stage.transitions.map(transition => transition.id));
        assert.deepEqual([...coveredTransitions].sort(), [...authoredTransitions].sort());
    });

    // eslint-disable-next-line jest/expect-expect, playwright/expect-expect
    test('gives every stage exactly one established-history resonance without exposing author handoff notes', () => {
        for (const stage of story.stages) {
            const historyRevealIds = stage.allowedRevealIds.filter(id => id.startsWith('REVEAL_HISTORY_'));
            assert.equal(historyRevealIds.length, 1, `${stage.id} should have one history resonance`);

            const runtime = createRuntime(story);
            runtime.currentStageId = stage.id;
            runtime.visitedStageIds = [story.entryStageId, stage.id];
            const prompt = assertSafeDirection(runtime);
            const historyReveal = story.reveals.find(item => item.id === historyRevealIds[0]);
            assert.ok(prompt.includes(historyReveal.text), `${stage.id} should render its history resonance`);
            assert.ok(!prompt.includes('S4_HANDOFF_PENDING'));
        }
    });

    // eslint-disable-next-line jest/expect-expect, playwright/expect-expect
    test.each(paths.map((route, index) => [index + 1, route]))('completes S5 route %i without false progress or leaks', (routeNumber, route) => {
        let runtime = createRuntime(story);
        let messageId = 0;
        const acceptedChat = [];

        for (const transition of route) {
            const stageId = runtime.currentStageId;
            assert.deepEqual(transition, getStage(story, stageId).transitions.find(item => item.id === transition.id));
            assertSafeDirection(runtime);

            if (routeNumber === 1 && stageId === 'STAGE_KINSHIP_UNCERTAIN') {
                const firstDetourMessages = [{ id: messageId++, role: 'user', content: '我脑子转不动了，我们先去厨房煮面，吃完再说。' }];
                const firstDetour = validateDirectorDecision(
                    interactionDecision(runtime, 'follow_user_detour'), story, runtime, firstDetourMessages,
                );
                runtime = applyDirectorDecision(runtime, story, firstDetour, firstDetourMessages.at(-1).id).runtime;
                assert.equal(runtime.threadStatus, 'deferred');
                assert.equal(getReentryStatus(story, runtime, { includeCurrentDetour: true }).eligible, true);

                const secondDetourMessages = [{ id: messageId++, role: 'user', content: '面里加点青菜吧，我去拿两只碗。' }];
                const reentry = validateDirectorDecision(
                    interactionDecision(runtime, 'follow_user_detour'), story, runtime, secondDetourMessages,
                );
                runtime = applyDirectorDecision(runtime, story, reentry, secondDetourMessages.at(-1).id).runtime;
                assert.equal(runtime.currentStageId, stageId);
                assert.equal(runtime.threadStatus, 'reentry_offered');
                assert.ok(!runtime.confirmedEventIds.includes('OM_KINSHIP_TEST_CHOSEN'));
                assert.match(assertSafeDirection(runtime), /自然带回尚未完成的身份问题/);
                acceptedChat.push(...firstDetourMessages, ...secondDetourMessages);
            }

            if (routeNumber === 2 && stageId === 'STAGE_RELEASE_SHOCK') {
                const pauseMessages = [{ id: messageId++, role: 'user', content: '我现在情绪太满了，先抱着我，暂时别替我们下任何结论。' }];
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
        assert.match(renderCompletionMemory(story), /排除小雅与\{\{user\}\}存在生物学姨甥关系/);
        assert.ok(acceptedChat.length >= route.length);
    });
});
