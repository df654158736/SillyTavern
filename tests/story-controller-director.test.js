import {
    buildDirectorRequest,
    buildDirectorSystemPrompt,
    parseDirectorDecision,
    runReviewedDirector,
    validateDirectorDecision,
} from '../public/scripts/extensions/third-party/story-controller/director.js';
import { applyDirectorDecision, createRuntime } from '../public/scripts/extensions/third-party/story-controller/state.js';
import { createReentryStoryFixture, createStoryFixture } from './story-controller-fixture.js';

const messages = [{ id: 4, role: 'user', content: '我把两处日期并排检查了，两个日期确实对不上。' }];
const validDecision = {
    stageId: 'STAGE_DATES',
    observedEventIds: ['OM_DATES_CONFIRMED'],
    evidence: [{ eventId: 'OM_DATES_CONFIRMED', messageId: 4, quote: '两个日期确实对不上' }],
    transitionId: 'TRANSITION_DATES_TO_AUDIO',
    interactionMode: 'invite_user_check',
    violationIds: [],
    confidence: 'high',
};

describe('Story Controller Director contract', () => {
    test('whitelists the expected decision fields', () => {
        const parsed = parseDirectorDecision(JSON.stringify({ ...validDecision, type: 'decision', hiddenNote: 'future truth' }));
        expect(parsed).toEqual(validDecision);
        expect(parsed.type).toBeUndefined();
        expect(parsed.hiddenNote).toBeUndefined();
    });

    test('validates exact evidence and an adjacent transition', () => {
        const story = createStoryFixture();
        const runtime = createRuntime(story);
        expect(validateDirectorDecision(structuredClone(validDecision), story, runtime, messages)).toEqual(validDecision);
    });

    test('rejects fabricated quotations and non-adjacent transitions', () => {
        const story = createStoryFixture();
        const runtime = createRuntime(story);
        expect(() => validateDirectorDecision({ ...structuredClone(validDecision), evidence: [{ ...validDecision.evidence[0], quote: '不存在的原文' }] }, story, runtime, messages)).toThrow(/quote/);
        expect(() => validateDirectorDecision({ ...structuredClone(validDecision), transitionId: 'TRANSITION_AUDIO_TO_TRUTH' }, story, runtime, messages)).toThrow(/non-adjacent/);
    });

    test('rejects a premature-reveal violation inferred only from user text', () => {
        const story = createStoryFixture();
        const runtime = createRuntime(story);
        const messages = [{ id: 5, role: 'user', content: '上一条提前泄露了，但这里只是我的转述。' }];
        const decision = {
            stageId: 'STAGE_DATES',
            observedEventIds: [],
            evidence: [],
            transitionId: null,
            interactionMode: 'recover_from_leak',
            violationIds: ['V_PREMATURE_REVEAL'],
            confidence: 'high',
        };
        expect(() => validateDirectorDecision(decision, story, runtime, messages)).toThrow(/requires accepted assistant text/);
    });

    test('records evidence but rejects a same-decision transition during an emotional pause', () => {
        const story = createStoryFixture();
        const runtime = createRuntime(story);
        const decision = structuredClone(validDecision);
        decision.interactionMode = 'emotional_pause';
        expect(() => validateDirectorDecision(decision, story, runtime, messages)).toThrow(/must not advance/);
        decision.transitionId = null;
        expect(validateDirectorDecision(decision, story, runtime, messages).observedEventIds).toEqual(['OM_DATES_CONFIRMED']);
    });

    test('deterministically selects a uniquely satisfied transition when the Director omits it', () => {
        const story = createStoryFixture();
        const runtime = createRuntime(story);
        const decision = structuredClone(validDecision);
        decision.transitionId = null;
        decision.interactionMode = 'invite_user_check';
        const normalized = validateDirectorDecision(decision, story, runtime, messages);
        expect(normalized.transitionId).toBe('TRANSITION_DATES_TO_AUDIO');
        expect(normalized.interactionMode).toBe('invite_user_check');
    });

    test('allows one bounded reentry only after a previous free detour', () => {
        const story = createReentryStoryFixture();
        const detourDecision = {
            stageId: 'STAGE_DATES',
            observedEventIds: [],
            evidence: [],
            transitionId: null,
            interactionMode: 'follow_user_detour',
            violationIds: [],
            confidence: 'high',
        };
        const deferred = applyDirectorDecision(createRuntime(story), story, detourDecision, 4).runtime;
        const continuedDetour = [{ id: 6, role: 'user', content: '面里加点青菜吧，吃完再收拾厨房。' }];
        expect(validateDirectorDecision(detourDecision, story, deferred, continuedDetour).interactionMode).toBe('reenter_story');
        expect(validateDirectorDecision(detourDecision, story, createRuntime(story), continuedDetour).interactionMode).toBe('follow_user_detour');
    });

    test('never reenters while the user has explicitly paused the open thread', () => {
        const story = createReentryStoryFixture();
        const runtime = createRuntime(story);
        runtime.threadStatus = 'paused';
        runtime.detourTurns = 8;
        const decision = {
            stageId: 'STAGE_DATES',
            observedEventIds: [],
            evidence: [],
            transitionId: null,
            interactionMode: 'follow_user_detour',
            violationIds: [],
            confidence: 'high',
        };
        expect(validateDirectorDecision(decision, story, runtime, [{ id: 8, role: 'user', content: '我们聊点别的。' }]).interactionMode).toBe('follow_user_detour');
    });

    test('does not turn a detour carrying real evidence into an internal reentry', () => {
        const story = createReentryStoryFixture();
        const runtime = createRuntime(story);
        runtime.threadStatus = 'deferred';
        runtime.detourTurns = 1;
        const decision = {
            ...structuredClone(validDecision),
            interactionMode: 'follow_user_detour',
            transitionId: null,
        };
        expect(validateDirectorDecision(decision, story, runtime, messages).interactionMode).toBe('follow_user_detour');
    });

    test('request contains no hidden or distant-stage content', () => {
        const story = createStoryFixture();
        const request = buildDirectorRequest(story, createRuntime(story), messages);
        expect(request).not.toContain('顾岚');
        expect(request).not.toContain('STAGE_TRUTH');
        expect(request).not.toContain('测试专用隐藏说明');
    });

    test('leaves detour counting to deterministic code instead of the Director model', () => {
        const prompt = buildDirectorSystemPrompt();
        expect(prompt).toContain('你不计算次数，也不输出 reenter_story');
        expect(prompt).toContain('回引时机由业务代码处理');
        expect(prompt).not.toContain('先查看 directorView.reentry');
    });

    test('retries a structural failure without supplying the expected answer', async () => {
        const story = createStoryFixture();
        const corrections = [];
        const result = await runReviewedDirector(async correction => {
            corrections.push(correction);
            return corrections.length === 1 ? '{}' : JSON.stringify(validDecision);
        }, story, createRuntime(story), messages);
        expect(result.attempts).toBe(2);
        expect(corrections[1]).toContain('结构或证据校验');
        expect(corrections[1]).not.toContain('TRANSITION_DATES_TO_AUDIO');
    });
});
