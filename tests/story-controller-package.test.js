import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    buildDirectorView,
    getReentryStatus,
    normalizeStoryPackage,
    resolveStageDirection,
    validateStoryPackage,
} from '../public/scripts/extensions/third-party/story-controller/package.js';
import { createRuntime } from '../public/scripts/extensions/third-party/story-controller/state.js';
import { createReentryStoryFixture, createStoryFixture } from './story-controller-fixture.js';

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const bundledStoryPath = path.resolve(testDirectory, '../public/scripts/extensions/third-party/story-controller/packages/xiaoya-s4-unfinished-coda.story.json');

describe('Story Controller package contract', () => {
    test('accepts a valid package and clones it', () => {
        const story = createStoryFixture();
        expect(validateStoryPackage(story)).toEqual({ valid: true, errors: [], warnings: [] });
        const normalized = normalizeStoryPackage(story);
        expect(normalized).toEqual(story);
        expect(normalized).not.toBe(story);
    });

    test('rejects unknown transition targets and unreachable stages', () => {
        const story = createStoryFixture();
        story.stages[0].transitions[0].toStageId = 'STAGE_MISSING';
        const result = validateStoryPackage(story);
        expect(result.valid).toBe(false);
        expect(result.errors.join('\n')).toMatch(/unknown stage|unreachable/);
    });

    test('rejects hidden terms in locked public stage packets', () => {
        const story = createStoryFixture();
        story.stages[0].publicObjective = '现在告诉用户顾岚剪接了录音。';
        const result = validateStoryPackage(story);
        expect(result.valid).toBe(false);
        expect(result.errors.join('\n')).toContain('leaks through locked stage STAGE_DATES');
    });

    test('rejects secrets exposed only through Director OM definitions or adjacent shells', () => {
        const eventLeak = createStoryFixture();
        eventLeak.events[0].evidenceRule = '需要证明顾岚剪接了录音。';
        expect(validateStoryPackage(eventLeak).errors.join('\n')).toContain('leaks through locked stage STAGE_DATES');

        const adjacentLeak = createStoryFixture();
        adjacentLeak.stages[1].publicObjective = '下一阶段说明顾岚剪接了录音。';
        expect(validateStoryPackage(adjacentLeak).errors.join('\n')).toContain('leaks through locked stage STAGE_DATES');
    });

    test('director view exposes only the current and adjacent public shell', () => {
        const story = createStoryFixture();
        const view = buildDirectorView(story, createRuntime(story));
        const serialized = JSON.stringify(view);
        expect(view.currentStage.id).toBe('STAGE_DATES');
        expect(view.reachableStages.map(item => item.id)).toEqual(['STAGE_AUDIO']);
        expect(serialized).not.toContain('STAGE_TRUTH');
        expect(serialized).not.toContain('顾岚');
        expect(serialized).not.toContain('测试专用隐藏说明');
        expect(serialized).not.toContain('GUIDE_SHARE_TRUTH');
    });

    test('resolves stage-specific guidance after a transition', () => {
        const story = createStoryFixture();
        const direction = resolveStageDirection(story, 'STAGE_AUDIO', 'hold_for_evidence');
        expect(direction.guidance.id).toBe('GUIDE_HOLD_AUDIO');
        expect(direction.reveals.map(item => item.id)).toEqual(['REVEAL_AUDIO']);
    });

    test('validates optional reentry policy and resolves its package-level guidance', () => {
        const story = createReentryStoryFixture();
        expect(validateStoryPackage(story)).toEqual({ valid: true, errors: [], warnings: [] });
        const runtime = createRuntime(story);
        runtime.detourTurns = 20;
        expect(getReentryStatus(story, runtime, { includeCurrentDetour: true }).eligible).toBe(false);
        runtime.threadStatus = 'deferred';
        runtime.detourTurns = 1;
        expect(getReentryStatus(story, runtime, { includeCurrentDetour: true }).eligible).toBe(true);
        expect(resolveStageDirection(story, runtime.currentStageId, 'reenter_story').guidance.id).toBe('GUIDE_REENTER_THREAD');

        story.reentry.guidanceId = 'GUIDE_MISSING';
        expect(validateStoryPackage(story).errors.join('\n')).toContain('references unknown guidance');
    });

    test('keeps schema v1 packages compatible without requiring a reentry route', () => {
        const story = createStoryFixture();
        expect(story.stages[0].interactionRoutes.reenter_story).toBeUndefined();
        expect(validateStoryPackage(story)).toEqual({ valid: true, errors: [], warnings: [] });
    });

    test('validates continuity references and prevents locked truth from leaking through them', () => {
        const story = createStoryFixture();
        story.schemaVersion = 2;
        story.continuityRules = [{
            id: 'CONTINUITY_DATES_CHECKED',
            whenEventIds: ['OM_DATES_CONFIRMED'],
            activeStageIds: ['STAGE_AUDIO'],
            text: '双方已经共同核对过日期。',
        }];
        story.completion = {
            epilogueAssistantMessages: 2,
            autoRelease: true,
            memoryText: '双方已经处理完这次旧资料事件。',
        };
        expect(validateStoryPackage(story)).toEqual({ valid: true, errors: [], warnings: [] });

        story.continuityRules[0].whenEventIds = ['OM_MISSING'];
        expect(validateStoryPackage(story).errors.join('\n')).toContain('unknown event');

        story.continuityRules[0].whenEventIds = ['OM_DATES_CONFIRMED'];
        story.continuityRules[0].text = '双方已经确认顾岚剪接了录音。';
        expect(validateStoryPackage(story).errors.join('\n')).toContain('leaks through locked stage STAGE_AUDIO');
    });

    test('accepts the bundled S4 package without warnings and keeps every Director stage view spoiler-safe', () => {
        const story = JSON.parse(fs.readFileSync(bundledStoryPath, 'utf8'));
        expect(validateStoryPackage(story)).toEqual({ valid: true, errors: [], warnings: [] });
        for (const stage of story.stages) {
            const runtime = createRuntime(story);
            runtime.currentStageId = stage.id;
            expect(() => buildDirectorView(story, runtime)).not.toThrow();
        }
    });

    test('keeps the bundled mature relationship path participatory and multi-turn', () => {
        const story = JSON.parse(fs.readFileSync(bundledStoryPath, 'utf8'));
        const stage = story.stages.find(item => item.id === 'STAGE_INTIMATE_PATH');
        const guidance = story.safeGuidance.find(item => item.id === 'GUIDE_INTIMATE_PATH');
        const pastReveal = story.reveals.find(item => item.id === 'REVEAL_FULL_PLAYBACK');
        expect(stage.publicObjective).toContain('本阶段不完成解释或和好');
        expect(guidance.text).toContain('每轮只推进一个可感知的亲密层级');
        expect(guidance.text).toContain('不能在同一回复里包办完整性过程、高潮、事后安抚和关系结论');
        expect(pastReveal.text).toContain('不逐动作展示完整性过程');
    });
});
