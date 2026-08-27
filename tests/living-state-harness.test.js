import { describe, expect, test } from '@jest/globals';

import {
    SNAPSHOT_KEY,
    applyStoryResponseContract,
    appendTerminalResponseContract,
    collectMessages,
    createEmptyState,
    findLatestSnapshot,
    formatResponseContract,
    formatStateForPrompt,
    invalidateSnapshots,
    mergeDelta,
    normalizeState,
    recoverStoryContentFromReasoning,
    sanitizeEvidenceText,
    validateStoryResponse,
} from '../public/scripts/extensions/living-state-harness/state.js';

describe('Living State Harness state ledger', () => {
    const subject = { role: 'character', name: '小雅', counterpartName: 'D' };

    test('merges evidence-backed changes and produces a stable prompt', () => {
        const previous = createEmptyState(subject);
        const delta = {
            subject: { role: 'character', name: '小雅' },
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

        const result = mergeDelta(previous, delta, [0, 1], 1, subject);

        expect(result.changed).toBe(true);
        expect(result.state.version).toBe(1);
        expect(result.state.offscreenLife.upcomingObligations).toHaveLength(1);
        const prompt = formatStateForPrompt(result.state);
        expect(prompt).toContain('明早需要上课');
        expect(prompt).toContain('Subject: character "小雅"');
        expect(prompt).toContain('小雅.Plan');
        expect(prompt).toContain('Relationship (小雅 toward D)');
        expect(prompt).toContain('never to user "D"');
        expect(normalizeState(JSON.parse(JSON.stringify(result.state)))).toEqual(result.state);
    });

    test('rejects long-term additions without valid evidence', () => {
        const result = mergeDelta(createEmptyState(subject), {
            subject: { role: 'character', name: '小雅' },
            continuityChanges: {
                importantFactsAdd: [{ text: '没有来源的事实', evidenceMessageIds: [99] }],
            },
        }, [1, 2], 2, subject);

        expect(result.state.continuity.importantFacts).toEqual([]);
    });

    test('removes generated metadata blocks from evidence', () => {
        const content = 'ECoT：*规划剧情*<content>真实正文</content><thinking>隐藏思考</thinking><meow_FM>自动摘要</meow_FM><branches>未来选项</branches>';
        expect(sanitizeEvidenceText(content)).toBe('<content>真实正文</content>');
    });

    test('clears stale transient fields and closes fulfilled obligations', () => {
        const previous = createEmptyState(subject);
        previous.agency.responseIfBlocked = '若继续推门就锁门';
        previous.offscreenLife.upcomingObligations = [{ id: 'obligation-morning', text: '明早检查背诵', evidenceMessageIds: [1] }];
        const result = mergeDelta(previous, {
            subject: { role: 'character', name: '小雅' },
            agencyChanges: { responseIfBlocked: '' },
            offscreenLifeChanges: { upcomingObligationIdsClose: ['obligation-morning'] },
        }, [2], 2, subject);

        expect(result.state.agency.responseIfBlocked).toBe('');
        expect(result.state.offscreenLife.upcomingObligations).toEqual([]);
    });

    test('deduplicates near-identical list items in the injected prompt', () => {
        const state = createEmptyState(subject);
        state.offscreenLife.recentEvents = [{ id: 'a', text: '小雅已经检查完D的劝学背诵', evidenceMessageIds: [1] }];
        state.continuity.importantFacts = [{ id: 'b', text: '小雅已经检查完D的劝学背诵。', evidenceMessageIds: [1] }];
        const prompt = formatStateForPrompt(state);

        expect(prompt.match(/小雅已经检查完D的劝学背诵/g)).toHaveLength(1);
    });

    test('finds and invalidates snapshots after a changed message', () => {
        const state = createEmptyState(subject);
        const chat = [
            { is_user: true, mes: '一', extra: { [SNAPSHOT_KEY]: { valid: true, state } } },
            { is_user: false, mes: '二' },
            { is_user: true, mes: '三', extra: { [SNAPSHOT_KEY]: { valid: true, state: { ...state, version: 1 } } } },
        ];

        expect(findLatestSnapshot(chat, Number.POSITIVE_INFINITY, subject)?.index).toBe(2);
        expect(invalidateSnapshots(chat, 1)).toBe(true);
        expect(findLatestSnapshot(chat, Number.POSITIVE_INFINITY, subject)?.index).toBe(0);
    });

    test('rejects a delta owned by the user instead of the active character', () => {
        expect(() => mergeDelta(createEmptyState(subject), {
            subject: { role: 'user', name: 'D' },
        }, [1], 1, subject)).toThrow('subject mismatch');
    });

    test('ignores legacy or differently-owned snapshots', () => {
        const legacyState = { ...createEmptyState(subject), schemaVersion: 1 };
        const otherState = createEmptyState({ role: 'character', name: '其他角色', counterpartName: 'D' });
        const chat = [
            { extra: { [SNAPSHOT_KEY]: { valid: true, state: legacyState } } },
            { extra: { [SNAPSHOT_KEY]: { valid: true, state: otherState } } },
        ];

        expect(findLatestSnapshot(chat, Number.POSITIVE_INFINITY, subject)).toBeNull();
    });

    test('collects only the configured recent evidence window', () => {
        const chat = [
            { is_user: true, name: 'User', mes: 'one' },
            { is_user: false, name: 'Character', mes: 'two' },
            { is_user: true, name: 'User', mes: 'three' },
        ];
        expect(collectMessages(chat, -1, 2, 2).map(message => message.id)).toEqual([1, 2]);
    });

    test('counts only content body characters and ignores later summary or branch blocks', () => {
        const body = '雅'.repeat(1500);
        const response = `<content>${body}</content><meow_FM>${'摘要'.repeat(300)}</meow_FM><branches>${'分支'.repeat(300)}</branches>`;
        const validation = validateStoryResponse(response, { minimumBodyCharacters: 1500, maximumBodyCharacters: 2000 });

        expect(validation.status).toBe('pass');
        expect(validation.bodyCharacters).toBe(1500);
        expect(validation.hasUnexpectedPrefix).toBe(false);
    });

    test('fails a reply whose whole output is long but content body is short', () => {
        const response = `<content>${'正文'.repeat(480)}</content><meow_FM>${'摘要'.repeat(400)}</meow_FM>`;
        const validation = validateStoryResponse(response, { minimumBodyCharacters: 1500, maximumBodyCharacters: 2000 });

        expect(response.length).toBeGreaterThan(1500);
        expect(validation.status).toBe('fail');
        expect(validation.bodyCharacters).toBe(960);
        expect(validation.issues[0]).toContain('少于下限');
    });

    test('flags reasoning markers and incorrect block order', () => {
        const response = `<meow_FM>先摘要</meow_FM>ECoT：规划<content>${'雅'.repeat(1500)}</content>`;
        const validation = validateStoryResponse(response);

        expect(validation.status).toBe('fail');
        expect(validation.orderValid).toBe(false);
        expect(validation.reasoningLeak).toBe(true);
    });

    test('recovers only a complete structured story from an otherwise empty reasoning response', () => {
        const reasoning = '内部规划，不应展示。\n<content>真正正文</content>\n<meow_FM>摘要</meow_FM>\n<branches>分支</branches>';
        const result = recoverStoryContentFromReasoning('', reasoning);

        expect(result.recovered).toBe(true);
        expect(result.content).toBe('<content>真正正文</content>\n<meow_FM>摘要</meow_FM>\n<branches>分支</branches>');
        expect(result.remainingReasoning).toBe('内部规划，不应展示。');
    });

    test('does not expose unstructured or incomplete reasoning as story content', () => {
        expect(recoverStoryContentFromReasoning('', '只有内部规划').recovered).toBe(false);
        expect(recoverStoryContentFromReasoning('', '<content>没有闭合').recovered).toBe(false);
        expect(recoverStoryContentFromReasoning('已有正文', '<content>另一份正文</content>').recovered).toBe(false);
    });

    test('rejects any text before the content block', () => {
        const response = `先确认任务。\n<content>${'雅'.repeat(1500)}</content>`;
        const validation = validateStoryResponse(response);

        expect(validation.status).toBe('fail');
        expect(validation.hasUnexpectedPrefix).toBe(true);
        expect(validation.issues).toContain('正文前存在不允许的元叙事、前言或其他文本');
    });

    test('places the response contract after late conflicting output instructions', () => {
        const messages = [
            { role: 'system', content: '普通规则' },
            { role: 'system', content: '先输出任务确认，再开始正文' },
        ];
        appendTerminalResponseContract(messages, { minimumBodyCharacters: 1500, maximumBodyCharacters: 2000 });

        expect(messages).toHaveLength(3);
        expect(messages.at(-1).content).toContain('terminal output instruction');
        expect(messages.at(-1).content).toContain('Begin directly with <content>');
    });

    test('never overrides native thinking or reasoning request settings', () => {
        const generateData = {
            type: 'normal',
            messages: [{ role: 'user', content: '继续剧情' }],
            thinking: { type: 'enabled' },
            include_reasoning: true,
            reasoning_effort: 'auto',
        };

        applyStoryResponseContract(generateData, { minimumBodyCharacters: 1500, maximumBodyCharacters: 2000 });

        expect(generateData.thinking).toEqual({ type: 'enabled' });
        expect(generateData.include_reasoning).toBe(true);
        expect(generateData.reasoning_effort).toBe('auto');
        expect(generateData.messages.at(-1).content).toContain('terminal output instruction');
    });

    test('response contract requires the story to begin directly with content', () => {
        const contract = formatResponseContract({ minimumBodyCharacters: 1500, maximumBodyCharacters: 2000 });
        expect(contract).toContain('第一个非空白输出必须是 <content>');
        expect(contract).not.toContain('果农');
        expect(contract).toContain('1500–2000');
        expect(contract).toContain('1850–1950');
        expect(contract).toContain('3 个连续的剧情推进单元');
        expect(contract).toContain('617–650');
        expect(contract).toContain('标签、<meow_FM> 摘要和 <branches> 分支均不计入');
    });
});
