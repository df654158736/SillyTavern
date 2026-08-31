import { describe, expect, test } from '@jest/globals';

import {
    PROMPT_BUDGET_CHARACTERS,
    SNAPSHOT_KEY,
    areCompatibleCharacterNames,
    collectMessages,
    createEmptyState,
    findLatestSnapshot,
    formatStateForPrompt,
    invalidateSnapshots,
    mergeDelta,
    normalizeState,
    normalizeDeltaReferences,
    recoverStoryContentFromReasoning,
    saveStateSnapshot,
    sanitizeEvidenceText,
} from '../public/scripts/extensions/living-state-harness/state.js';
import {
    createContinuationChat,
    formatArchiveForPrompt,
    normalizeArchive,
    splitHistoryForArchive,
} from '../public/scripts/extensions/living-state-harness/archive.js';

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
            signalChanges: {
                trust: { value: 7, confidence: 'high', reason: '仍愿意交流，但隐瞒造成损伤', evidenceMessageIds: [1] },
                closeness: { value: 6, confidence: 'medium', reason: '关心仍然存在', evidenceMessageIds: [1] },
                tension: { value: 8, confidence: 'high', reason: '刚结束争执', evidenceMessageIds: [1] },
                initiativeReadiness: { value: 6, confidence: 'medium', reason: '有主动追问冲动', evidenceMessageIds: [1] },
                boundaryPressure: { value: 7, confidence: 'high', reason: '隐瞒触及安全边界', evidenceMessageIds: [1] },
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
        expect(prompt).toContain('Trust high');
        expect(prompt).toContain('Tension high');
        expect(prompt).not.toContain('/10');
        expect(prompt).not.toContain('仍愿意交流，但隐瞒造成损伤');
        expect(prompt).toContain('No score or creative setting may override this');
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

    test('accepts only evidence-backed scores and limits sudden score jumps', () => {
        const previous = createEmptyState(subject);
        previous.signals.trust = { value: 6, confidence: 'high', reason: '长期互相信任', evidenceMessageIds: [1] };
        previous.signals.tension = { value: 3, confidence: 'medium', reason: '轻微分歧', evidenceMessageIds: [1] };
        const result = mergeDelta(previous, {
            subject: { role: 'character', name: '小雅' },
            signalChanges: {
                trust: { value: 0, confidence: 'high', reason: '一次普通争执', evidenceMessageIds: [2] },
                tension: { value: 10, confidence: 'high', reason: '争执升级', evidenceMessageIds: [2] },
                closeness: { value: 10, confidence: 'high', reason: '错误证据', evidenceMessageIds: [99] },
            },
        }, [2], 2, subject);

        expect(result.state.signals.trust.value).toBe(4);
        expect(result.state.signals.tension.value).toBe(6);
        expect(result.state.signals.closeness.value).toBeNull();
        expect(result.state.signals.trust.evidenceMessageIds).toEqual([2]);
    });

    test('prevents ordinary consecutive turns from ratcheting slow relationship signals upward', () => {
        const previous = createEmptyState(subject);
        previous.signals.closeness = { value: 8, confidence: 'high', reason: '此前已有稳定亲近', evidenceMessageIds: [10] };

        const tooSoon = mergeDelta(previous, {
            subject: { role: 'character', name: '小雅' },
            signalChanges: {
                closeness: { value: 9, confidence: 'high', reason: '本轮有普通照顾', evidenceMessageIds: [12] },
            },
        }, [12], 12, subject);
        expect(tooSoon.state.signals.closeness.value).toBe(8);
        expect(tooSoon.state.signals.closeness.evidenceMessageIds).toEqual([10]);

        const enoughHistory = mergeDelta(tooSoon.state, {
            subject: { role: 'character', name: '小雅' },
            signalChanges: {
                closeness: { value: 10, confidence: 'high', reason: '出现明确且稳定的关系里程碑', evidenceMessageIds: [14] },
            },
        }, [14], 14, subject);
        expect(enoughHistory.state.signals.closeness.value).toBe(9);
    });

    test('does not invent neutral scores for legacy state and keeps hard boundaries in assertive mode', () => {
        const legacy = createEmptyState(subject);
        delete legacy.signals;
        const normalized = normalizeState(legacy, subject);
        const prompt = formatStateForPrompt(normalized, subject, {
            stateInfluence: 'strong',
            initiative: 'assertive',
            pacing: 'forward',
            userMicroAgency: 'expressive',
        });

        expect(normalized.signals.trust.value).toBeNull();
        expect(prompt).not.toContain('Trust 5/10');
        expect(prompt).toContain('may actively pursue personal goals');
        expect(prompt).toContain('stop before any new commitment');
        expect(prompt).toContain('Hard boundary: never decide "D"');
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

    test('keeps a bloated legacy snapshot intact while projecting a bounded compact prompt', () => {
        const state = createEmptyState(subject);
        const longText = '这是保存在历史快照里的完整状态细节，包含较多背景和上下文。'.repeat(30);
        state.scene.location = longText;
        state.scene.immediateSituation = longText;
        for (const key of Object.keys(state.character)) state.character[key] = longText;
        for (const key of Object.keys(state.agency)) state.agency[key] = longText;
        for (const key of ['trust', 'emotionalCloseness', 'authorityDynamic', 'currentTension']) state.relationship[key] = longText;
        state.signals.trust = { value: 9, confidence: 'high', reason: longText, evidenceMessageIds: [1] };
        state.continuity.importantFacts = Array.from({ length: 8 }, (_, index) => ({
            id: `fact-${index}`,
            text: `${longText}${index}`,
            evidenceMessageIds: [1],
        }));

        const prompt = formatStateForPrompt(state);

        expect(prompt.length).toBeLessThanOrEqual(PROMPT_BUDGET_CHARACTERS);
        expect(prompt).toContain('Hard boundary: never decide "D"');
        expect(prompt).toContain('[/Current Living State]');
        expect(prompt).toContain('Trust very high');
        expect(prompt).not.toContain('9/10');
        expect(state.scene.location).toBe(longText);
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

    test('continues the higher-version imported state after a bracketed character rename', () => {
        const importedSubject = { role: 'character', name: '小雅', counterpartName: 'D' };
        const activeSubject = { role: 'character', name: '小雅（小姨）', counterpartName: 'D' };
        const importedState = createEmptyState(importedSubject);
        importedState.version = 18;
        importedState.processedThroughMessageId = 36;
        importedState.character.currentMood = '延续的旧状态';
        const restartedState = createEmptyState(activeSubject);
        restartedState.version = 1;
        restartedState.processedThroughMessageId = 38;

        const chat = Array.from({ length: 39 }, () => ({ is_user: false, mes: '' }));
        saveStateSnapshot(chat[36], 36, importedState);
        saveStateSnapshot(chat[38], 38, restartedState);

        const restored = findLatestSnapshot(chat, Number.POSITIVE_INFINITY, activeSubject);

        expect(areCompatibleCharacterNames('小雅', '小雅（小姨）')).toBe(true);
        expect(restored?.index).toBe(36);
        expect(restored?.state.version).toBe(18);
        expect(restored?.state.subject.name).toBe('小雅（小姨）');
        expect(restored?.state.character.currentMood).toBe('延续的旧状态');
    });

    test('does not import state from a genuinely different character', () => {
        const unrelatedState = createEmptyState({ role: 'character', name: '林雪', counterpartName: 'D' });
        unrelatedState.version = 20;
        const currentState = createEmptyState(subject);
        currentState.version = 1;
        const chat = [{}, {}];
        saveStateSnapshot(chat[0], 0, unrelatedState);
        saveStateSnapshot(chat[1], 1, currentState);

        expect(areCompatibleCharacterNames('林雪', '小雅（小姨）')).toBe(false);
        expect(findLatestSnapshot(chat, Number.POSITIVE_INFINITY, subject)?.index).toBe(1);
    });

    test('normalizes object-shaped close references returned by the updater', () => {
        const delta = {
            continuityChanges: {
                openPromiseIdsClose: [{ id: 'promise-one', reason: 'done' }, 'promise-two'],
                openThreadIdsClose: [{ id: 'thread-one' }, { broken: true }],
                importantFactIdsRemove: [],
            },
            offscreenLifeChanges: { upcomingObligationIdsClose: [{ id: 'obligation-one' }] },
        };

        normalizeDeltaReferences(delta);

        expect(delta.continuityChanges.openPromiseIdsClose).toEqual(['promise-one', 'promise-two']);
        expect(delta.continuityChanges.openThreadIdsClose).toEqual(['thread-one']);
        expect(delta.offscreenLifeChanges.upcomingObligationIdsClose).toEqual(['obligation-one']);
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

describe('Living State Harness long-chat archive', () => {
    const archiveSubject = { role: 'character', name: '小雅（小姨）', counterpartName: 'D' };

    test('splits only older messages and keeps the requested recent raw window', () => {
        const chat = Array.from({ length: 35 }, (_, index) => ({
            is_user: index % 2 === 0,
            name: index % 2 === 0 ? 'D' : '小雅',
            mes: `消息 ${index}`,
        }));

        const split = splitHistoryForArchive(chat, 20, 300);

        expect(split.boundary).toBe(15);
        expect(split.archived).toHaveLength(15);
        expect(split.recent).toHaveLength(20);
        expect(split.recent[0]).toBe(chat[15]);
        expect(split.chunks.flat()).toHaveLength(15);
        expect(split.chunks.flat()[14].id).toBe(14);
    });

    test('normalizes duplicate archive entries and formats history separately from current state', () => {
        const archive = normalizeArchive({
            overview: '共同经历已经改变双方关系。',
            chronology: ['[消息 4] 一起看书。', '[消息 4] 一起看书。'],
            relationshipHistory: ['[消息 8] 小雅开始信任D。'],
            durableFacts: ['[消息 9] D知道书店地址。'],
        }, archiveSubject);

        const prompt = formatArchiveForPrompt(archive, archiveSubject);

        expect(archive.chronology).toEqual(['[消息 4] 一起看书。']);
        expect(prompt).toContain('accepted past story facts, not current state');
        expect(prompt).toContain('关系演变及原因');
        expect(prompt).not.toContain('当前情绪');
    });

    test('keeps foundational and newest history when a repeated archive exceeds its capacity', () => {
        const chronology = Array.from({ length: 90 }, (_, index) => `[消息 ${index}] 事件 ${index}`);
        const commitments = Array.from({ length: 45 }, (_, index) => `[消息 ${index}] 承诺 ${index}`);

        const archive = normalizeArchive({ overview: '长期剧情', chronology, commitments }, archiveSubject);

        expect(archive.chronology).toHaveLength(80);
        expect(archive.chronology[0]).toContain('事件 0');
        expect(archive.chronology[11]).toContain('事件 11');
        expect(archive.chronology[12]).toContain('事件 22');
        expect(archive.chronology.at(-1)).toContain('事件 89');
        expect(archive.commitments).toHaveLength(40);
        expect(archive.commitments[0]).toContain('承诺 5');
        expect(archive.commitments.at(-1)).toContain('承诺 44');
    });

    test('creates an independent continuation and re-anchors exactly one current snapshot', () => {
        const originalState = createEmptyState(archiveSubject);
        originalState.version = 12;
        originalState.processedThroughMessageId = 99;
        originalState.relationship.trust = '已经建立信任';
        const recent = Array.from({ length: 4 }, (_, index) => ({
            is_user: index % 2 === 0,
            mes: `最近消息 ${index}`,
            extra: {
                [SNAPSHOT_KEY]: { stale: true },
                living_state_harness_calibration_backup: { stale: true },
            },
        }));

        const continuation = createContinuationChat(recent, originalState, archiveSubject);

        expect(continuation).not.toBe(recent);
        expect(continuation[0]).not.toBe(recent[0]);
        expect(recent[0].extra[SNAPSHOT_KEY]).toEqual({ stale: true });
        expect(continuation[0].extra[SNAPSHOT_KEY]).toBeUndefined();
        expect(continuation[3].extra[SNAPSHOT_KEY].anchorMessageId).toBe(3);
        expect(continuation[3].extra[SNAPSHOT_KEY].state.processedThroughMessageId).toBe(3);
        expect(continuation[3].extra[SNAPSHOT_KEY].state.version).toBe(12);
        expect(continuation[3].extra.living_state_harness_calibration_backup).toBeUndefined();
    });
});
