import {
    assertSafeMainModelView,
    findLockedSecretLeaks,
    isCompletionDirectionReleased,
    renderCompletionMemory,
    renderMainModelView,
} from '../public/scripts/extensions/third-party/story-controller/prompt.js';
import { createRuntime } from '../public/scripts/extensions/third-party/story-controller/state.js';
import { createReentryStoryFixture, createStoryFixture } from './story-controller-fixture.js';

describe('Story Controller prompt rendering', () => {
    test('renders a locally complete prompt without locked truth', () => {
        const story = createStoryFixture();
        const runtime = createRuntime(story);
        runtime.activeInteractionMode = 'invite_user_check';
        const prompt = renderMainModelView(story, runtime);
        expect(prompt).toContain('共同确认资料日期');
        expect(prompt).toContain('邀请用户一起比较日期');
        expect(prompt).toContain('当前不能确认是谁处理了录音');
        expect(prompt).not.toContain('顾岚');
        expect(assertSafeMainModelView(story, runtime, prompt)).toBe(prompt);
    });

    test('allows the authored truth only in its unlock stage', () => {
        const story = createStoryFixture();
        const runtime = createRuntime(story);
        runtime.currentStageId = 'STAGE_TRUTH';
        runtime.visitedStageIds.push('STAGE_TRUTH');
        const prompt = renderMainModelView(story, runtime);
        expect(prompt).toContain('顾岚剪接了录音');
        expect(findLockedSecretLeaks(story, runtime, prompt)).toEqual([]);
    });

    test('detects accidental locked terms', () => {
        const story = createStoryFixture();
        const runtime = createRuntime(story);
        expect(() => assertSafeMainModelView(story, runtime, '顾岚剪接了录音')).toThrow(/locked secret/);
    });

    test('carries only authored continuity facts after their events are confirmed', () => {
        const story = createStoryFixture();
        story.continuityRules = [{
            id: 'CONTINUITY_DATES_CHECKED',
            whenEventIds: ['OM_DATES_CONFIRMED'],
            activeStageIds: ['STAGE_AUDIO', 'STAGE_TRUTH'],
            text: '双方已经亲自核对过日期，后续不能写成道听途说。',
        }];
        const runtime = createRuntime(story);
        runtime.currentStageId = 'STAGE_AUDIO';
        expect(renderMainModelView(story, runtime)).not.toContain('双方已经亲自核对过日期');
        runtime.confirmedEventIds.push('OM_DATES_CONFIRMED');
        const prompt = renderMainModelView(story, runtime);
        expect(prompt).toContain('已经发生并需延续的选择与后果');
        expect(prompt).toContain('双方已经亲自核对过日期');
        expect(prompt).not.toContain('CONTINUITY_DATES_CHECKED');
        expect(prompt).not.toContain('OM_DATES_CONFIRMED');
    });

    test('renders a spoiler-safe natural reentry without changing the stage objective', () => {
        const story = createReentryStoryFixture();
        const runtime = createRuntime(story);
        runtime.activeInteractionMode = 'reenter_story';
        runtime.threadStatus = 'reentry_offered';
        runtime.reentryAttemptsByStage.STAGE_DATES = 1;
        const prompt = renderMainModelView(story, runtime);
        expect(prompt).toContain('先回应当前生活话题');
        expect(prompt).toContain('用户不接就不再催促');
        expect(prompt).toContain('共同确认资料日期');
        expect(prompt).not.toContain('顾岚');
        expect(assertSafeMainModelView(story, runtime, prompt)).toBe(prompt);
    });

    test('releases terminal direction after authored epilogue turns and keeps compact memory', () => {
        const story = createStoryFixture();
        story.completion = {
            epilogueAssistantMessages: 2,
            autoRelease: true,
            memoryText: '两人已经共同面对旧资料，并形成更坦率的沟通方式。',
        };
        const runtime = createRuntime(story);
        runtime.currentStageId = 'STAGE_TRUTH';
        runtime.status = 'completed';
        runtime.completedAtMessageId = 1;
        const settlingChat = [{ is_user: true, mes: '开始' }, { is_user: true, mes: '面对' }, { is_user: false, mes: '第一轮余韵' }];
        const releasedChat = [...settlingChat, { is_user: true, mes: '我在' }, { is_user: false, mes: '第二轮余韵' }];
        expect(isCompletionDirectionReleased(story, runtime, settlingChat)).toBe(false);
        expect(isCompletionDirectionReleased(story, runtime, releasedChat)).toBe(true);
        expect(renderCompletionMemory(story)).toContain('两人已经共同面对旧资料');
        expect(renderCompletionMemory(story)).not.toContain('STAGE_TRUTH');
    });
});
