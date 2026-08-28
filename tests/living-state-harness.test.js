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
    recoverStoryContentFromReasoning,
    saveStateSnapshot,
    sanitizeEvidenceText,
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
        expect(prompt).not.toContain('Response Contract');
        expect(prompt).not.toContain('剧情推进单元');
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

    test('rolls a deleted assistant reply back to the surviving pre-generation checkpoint', () => {
        const stateBeforeReply = createEmptyState(subject);
        stateBeforeReply.version = 3;
        stateBeforeReply.processedThroughMessageId = 2;
        stateBeforeReply.character.currentMood = '谨慎期待';
        const stateAfterReply = normalizeState(stateBeforeReply, subject);
        stateAfterReply.version = 4;
        stateAfterReply.processedThroughMessageId = 4;
        stateAfterReply.character.currentMood = '因已经发生的拥抱而放松';

        const chat = [
            { is_user: false, mes: '较早的角色回复' },
            { is_user: true, mes: '较早的用户回复' },
            { is_user: false, mes: '上一轮角色回复' },
            { is_user: true, mes: '这次用户输入' },
            { is_user: false, mes: '稍后被删除的角色回复' },
        ];
        saveStateSnapshot(chat[3], 3, stateBeforeReply, { kind: 'pre-generation' });
        saveStateSnapshot(chat[4], 4, stateAfterReply, { kind: 'post-response' });

        chat.length = 4;
        invalidateSnapshots(chat, chat.length);
        const restored = findLatestSnapshot(chat, Number.POSITIVE_INFINITY, subject);

        expect(restored?.index).toBe(3);
        expect(restored?.snapshot.kind).toBe('pre-generation');
        expect(restored?.state.version).toBe(3);
        expect(restored?.state.character.currentMood).toBe('谨慎期待');
        expect(restored?.state.character.currentMood).not.toContain('拥抱');
    });

    test('uses the previous accepted snapshot as a safe legacy regeneration baseline', () => {
        const acceptedState = createEmptyState(subject);
        acceptedState.version = 2;
        acceptedState.processedThroughMessageId = 1;
        const deletedReplyState = normalizeState(acceptedState, subject);
        deletedReplyState.version = 3;
        deletedReplyState.processedThroughMessageId = 3;

        const chat = [
            { is_user: true, mes: '开场' },
            { is_user: false, mes: '已接受回复' },
            { is_user: true, mes: '要求继续' },
            { is_user: false, mes: '旧版扩展保存、即将重生成的回复' },
        ];
        saveStateSnapshot(chat[1], 1, acceptedState, { kind: 'post-response' });
        saveStateSnapshot(chat[3], 3, deletedReplyState, { kind: 'post-response' });

        expect(findLatestSnapshot(chat, 2, subject)?.state.version).toBe(2);
        expect(findLatestSnapshot(chat, 2, subject)?.state.processedThroughMessageId).toBe(1);
    });

    test('ignores snapshots whose message anchor or swipe branch no longer matches', () => {
        const state = createEmptyState(subject);
        state.version = 5;
        const shiftedMessage = { is_user: false, mes: '发生过前序删除', swipe_id: 0 };
        saveStateSnapshot(shiftedMessage, 2, state, { kind: 'post-response' });

        expect(findLatestSnapshot([shiftedMessage], Number.POSITIVE_INFINITY, subject)).toBeNull();

        saveStateSnapshot(shiftedMessage, 0, state, { kind: 'post-response' });
        shiftedMessage.swipe_id = 1;
        expect(findLatestSnapshot([shiftedMessage], Number.POSITIVE_INFINITY, subject)).toBeNull();

        shiftedMessage.swipe_id = 0;
        expect(findLatestSnapshot([shiftedMessage], Number.POSITIVE_INFINITY, subject)?.state.version).toBe(5);
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

});
