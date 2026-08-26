import { describe, expect, test } from '@jest/globals';

import {
    SNAPSHOT_KEY,
    collectMessages,
    createEmptyState,
    findLatestSnapshot,
    formatStateForPrompt,
    invalidateSnapshots,
    mergeDelta,
    normalizeState,
    sanitizeEvidenceText,
} from '../public/scripts/extensions/living-state-harness/state.js';

describe('Living State Harness state ledger', () => {
    test('merges evidence-backed changes and produces a stable prompt', () => {
        const previous = createEmptyState();
        const delta = {
            sceneChanges: {
                location: '客厅',
                presentCharacters: ['小雅', '用户'],
                immediateSituation: '两人刚结束争执',
            },
            characterChanges: {
                currentMood: '生气，但仍然担心用户',
                attentionFocus: '用户反常的沉默',
                privateImpulse: '想主动追问',
                inhibition: '不愿显得过分软弱',
            },
            agencyChanges: {
                currentPlan: '先收拾桌面，再询问发生了什么',
                initiativeSeed: '如果用户继续沉默，她会主动开口',
                boundary: '不接受继续隐瞒高风险事件',
                responseIfBlocked: '暂停谈话，要求先说明事实',
            },
            relationshipChanges: {
                trust: '仍然信任，但对隐瞒感到不满',
                currentTension: '关心和愤怒并存',
                evolvedPreferencesAdd: [],
            },
            offscreenLifeChanges: {
                recentEventsAdd: [],
                upcomingObligationsAdd: [{ text: '明早需要上课', reason: '既定工作', evidenceMessageIds: [1] }],
                peopleOnMindAdd: [],
            },
            continuityChanges: {
                importantFactsAdd: [],
                openPromisesAdd: [],
                openThreadsAdd: [],
            },
            turningPointsAdd: [],
        };

        const result = mergeDelta(previous, delta, [0, 1], 1);

        expect(result.changed).toBe(true);
        expect(result.state.version).toBe(1);
        expect(result.state.offscreenLife.upcomingObligations).toHaveLength(1);
        expect(formatStateForPrompt(result.state)).toContain('明早需要上课');
        expect(normalizeState(JSON.parse(JSON.stringify(result.state)))).toEqual(result.state);
    });

    test('rejects long-term additions without valid evidence', () => {
        const result = mergeDelta(createEmptyState(), {
            continuityChanges: {
                importantFactsAdd: [{ text: '没有来源的事实', evidenceMessageIds: [99] }],
            },
        }, [1, 2], 2);

        expect(result.state.continuity.importantFacts).toEqual([]);
    });

    test('removes generated metadata blocks from evidence', () => {
        const content = '真实正文<thinking>隐藏思考</thinking><meow_FM>自动摘要</meow_FM>';
        expect(sanitizeEvidenceText(content)).toBe('真实正文');
    });

    test('finds and invalidates snapshots after a changed message', () => {
        const state = createEmptyState();
        const chat = [
            { is_user: true, mes: '一', extra: { [SNAPSHOT_KEY]: { valid: true, state } } },
            { is_user: false, mes: '二' },
            { is_user: true, mes: '三', extra: { [SNAPSHOT_KEY]: { valid: true, state: { ...state, version: 1 } } } },
        ];

        expect(findLatestSnapshot(chat)?.index).toBe(2);
        expect(invalidateSnapshots(chat, 1)).toBe(true);
        expect(findLatestSnapshot(chat)?.index).toBe(0);
    });

    test('collects only the configured recent evidence window', () => {
        const chat = [
            { is_user: true, name: 'User', mes: 'one' },
            { is_user: false, name: 'Character', mes: 'two' },
            { is_user: true, name: 'User', mes: 'three' },
        ];
        expect(collectMessages(chat, -1, 2, 2).map(message => message.id)).toEqual([1, 2]);
    });
});
