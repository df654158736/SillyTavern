import { describe, expect, test } from '@jest/globals';
import { createEmptyDelta, createEmptyState, findLatestSnapshot, formatStateForPrompt, saveStateSnapshot } from '../public/scripts/extensions/third-party/living-state-harness/state.js';
import { formatUpdateDiagnostics, getUnprocessedReply, getUpdateWarning, prepareUpdaterResult, runReviewedUpdater } from '../public/scripts/extensions/third-party/living-state-harness/updater.js';

const subject = { role: 'character', name: 'Alice', counterpartName: 'Sam' };
const messages = [{ id: 37, role: 'user', content: '吃好了吗？' }, { id: 38, role: 'assistant', content: '我吃饱了。今天很开心。照片还是不要公开。' }];
const record = (quote = '我吃饱了。', extra = {}) => ({
    basis: 'explicit', scope: 'ongoing', evidence: [{ messageId: 38, quote }],
    appliesWhen: '当前感受持续期间', endsWhen: '后续正文明确改变', topics: [], ...extra,
});
const previous = () => {
    const state = createEmptyState(subject);
    state.version = 18;
    state.processedThroughMessageId = 36;
    state.scene.location = '公园';
    state.character.currentMood = '平静';
    state.character.physicalState = '饿了';
    state.continuity.importantFacts = [{ id: 'fact-old', text: '已确认的约定', evidenceMessageIds: [36] }];
    return state;
};
const delta = () => ({ ...createEmptyDelta(subject), contextDelta: { fields: {}, boundariesAdd: [], boundariesResolve: [] } });
function field(input, path, value, evidence) {
    const [group, key] = path.split('.');
    input[group + 'Changes'][key] = value;
    input.contextDelta.fields[path] = evidence;
    return input;
}
const valid = () => field(delta(), 'character.physicalState', '吃饱了', record());
const mixed = () => field(valid(), 'character.currentMood', '非常失望', record('我很失望。'));
const run = (input, state = previous(), sources = messages) => prepareUpdaterResult(JSON.stringify(input), state, sources, subject);
const privacy = (id = 'old-limit') => ({ ...record('照片还是不要公开。'), origin: 'current', scene: '', id, kind: 'privacy', text: '不公开照片' });

describe('Production updater partial acceptance', () => {
    test('manual retry targets the failed reply without rewriting an already checked reply', () => {
        const chat = [{ is_user: true, mes: '问题' }, { is_user: false, mes: '回答' }, { is_user: true, mes: '下一轮问题' }];
        expect(getUnprocessedReply(chat, -1)).toBe(1);
        expect(getUnprocessedReply(chat, 1)).toBe(-1);
        expect(getUnprocessedReply([], -1)).toBe(-1);
        expect(getUnprocessedReply(undefined)).toBe(-1);
    });

    test('an empty repair response does not throw away previously verified progress', async () => {
        let calls = 0;
        const result = await runReviewedUpdater(async () => ++calls === 1 ? mixed() : delta(), previous(), messages, subject);
        expect(result.state.character.physicalState).toBe('吃饱了');
        expect(result.delta._validation.status).toBe('partial');
    });

    test('repair cannot drop a verified boundary while fixing an unrelated mood field', async () => {
        let calls = 0;
        const first = mixed();
        first.contextDelta.boundariesAdd = [privacy('')];
        const result = await runReviewedUpdater(async () => ++calls === 1 ? first : valid(), previous(), messages, subject);
        expect(result.state.context.boundaries).toHaveLength(1);
        expect(result.state.context.boundaries[0].text).toBe('不公开照片');
    });

    test('two mismatching responses return safe partial progress instead of the original error', async () => {
        let calls = 0;
        const result = await runReviewedUpdater(async () => { calls++; return mixed(); }, previous(), messages, subject);
        expect(calls).toBe(2);
        expect(result.delta._validation.status).toBe('partial');
        expect(result.state.character.physicalState).toBe('吃饱了');
        expect(result.state.character.currentMood).toBe('平静');
    });

    test.each(['malformed', 'network'])('a %s repair failure cannot lose the first valid partial result', async kind => {
        let calls = 0;
        const result = await runReviewedUpdater(async () => {
            if (++calls === 1) return mixed();
            if (kind === 'network') throw new Error('Network request failed');
            return '{broken';
        }, previous(), messages, subject);
        expect(result.state.character.physicalState).toBe('吃饱了');
        expect(result.delta._validation.status).toBe('partial');
        expect(result.delta._validation.attempts).toBe(2);
    });

    test('format repair may recover the field, but does not receive an expected interpretation', async () => {
        const corrections = [];
        const result = await runReviewedUpdater(async correction => {
            corrections.push(correction);
            return corrections.length === 1 ? mixed() : field(valid(), 'character.currentMood', '开心', record('今天很开心。'));
        }, previous(), messages, subject);
        expect(result.state.character.currentMood).toBe('开心');
        expect(result.delta._validation.status).toBe('updated');
        expect(corrections[1]).toContain('quotation');
        expect(corrections[1]).not.toContain('开心');
    });

    test('explicit uncertainty is skipped without asking the model to become certain', async () => {
        let calls = 0;
        const result = await runReviewedUpdater(async () => { calls++; return field(valid(), 'character.currentMood', '猜测', { basis: 'inferred' }); }, previous(), messages, subject);
        expect(calls).toBe(1);
        expect(result.state.character.currentMood).toBe('平静');
    });

    test('two whole-response failures still fail, without changing previous state', async () => {
        const old = previous();
        const before = structuredClone(old);
        await expect(runReviewedUpdater(async () => '{bad', old, messages, subject)).rejects.toThrow();
        expect(old).toEqual(before);
    });

    test('the reported quotation mismatch skips only the invalid core field', () => {
        const input = mixed();
        const old = previous();
        const beforeInput = structuredClone(input);
        const beforeState = structuredClone(old);
        const result = prepareUpdaterResult(input, old, messages, subject);
        expect(result.state.character.physicalState).toBe('吃饱了');
        expect(result.state.character.currentMood).toBe('平静');
        expect(result.state.version).toBe(19);
        expect(result.state.processedThroughMessageId).toBe(38);
        expect(result.delta.characterChanges.currentMood).toBeNull();
        expect(result.delta._validation.status).toBe('partial');
        expect(result.delta._validation.skipped[0]).toEqual({ path: 'character.currentMood', reason: 'State quotation does not match new accepted dialogue.', messageIds: [38] });
        expect(formatUpdateDiagnostics(result.delta._validation)).toContain('引文或消息编号与本次新正文不匹配');
        expect(JSON.stringify(result.delta)).not.toContain('非常失望');
        expect(input).toEqual(beforeInput);
        expect(old).toEqual(beforeState);
    });

    test.each([
        ['missing scope', undefined],
        ['old ID', record('我吃饱了。', { evidence: [{ messageId: 36, quote: '我吃饱了。' }] })],
        ['paraphrase', record('我已经吃得很饱。')],
        ['punctuation rewrite', record('我吃饱了！')],
        ['invalid evidence shape', record('', { evidence: { messageId: 38, quote: '我吃饱了。' } })],
        ['mixed valid and invalid citations', record('', { evidence: [{ messageId: 38, quote: '我吃饱了。' }, { messageId: 'bad', quote: '猜测' }] })],
        ['inferred', { basis: 'inferred' }],
    ])('rejects %s without throwing away a separate valid update', (_name, evidence) => {
        const result = run(field(valid(), 'character.currentMood', '猜测', evidence));
        expect(result.state.character.currentMood).toBe('平静');
        expect(result.state.character.physicalState).toBe('吃饱了');
        expect(result.delta._validation.status).toBe('partial');
    });

    test('validating a quote never ignores a mismatching tail beyond the display limit', () => {
        const source = '文'.repeat(500) + '真实结尾';
        const input = field(delta(), 'character.currentMood', '开心', record('文'.repeat(500) + '编造结尾'));
        const result = run(input, previous(), [{ id: 38, role: 'assistant', content: source }]);
        expect(result.delta._validation.status).toBe('skipped');
        expect(result.state.character.currentMood).toBe('平静');
    });

    test('invalid clearing preserves the last confirmed value', () => {
        const result = run(field(valid(), 'character.currentMood', '', record('我已经不难过了。')));
        expect(result.state.character.currentMood).toBe('平静');
        expect(result.delta.characterChanges.currentMood).toBeNull();
    });

    test('a fully skipped update advances its checkpoint without claiming a new state version', () => {
        const old = previous();
        const result = run(field(delta(), 'character.currentMood', '错误内容', record('找不到的原文')), old);
        expect(result.changed).toBe(false);
        expect(result.state).toEqual({ ...old, processedThroughMessageId: 38 });
        expect(result.delta._validation.status).toBe('skipped');
        expect(formatUpdateDiagnostics(result.delta._validation)).toContain('保留上一版本');
    });

    test('a legitimate empty update is not a warning and does not migrate an empty context', () => {
        const result = run(delta());
        expect(result.changed).toBe(false);
        expect(result.delta._validation.status).toBe('unchanged');
        expect(result.delta._validation.skipped).toEqual([]);
        expect(result.state.version).toBe(18);
    });

    test('a failed location prevents dependent scene facts, not independent ongoing feelings', () => {
        const input = field(delta(), 'scene.location', '餐厅', record('两人进了餐厅。'));
        field(input, 'scene.immediateSituation', '在餐厅用餐', record());
        field(input, 'character.physicalState', '吃饱了', record('我吃饱了。', { scope: 'scene' }));
        field(input, 'character.currentMood', '开心', record('今天很开心。'));
        input.sceneChanges.presentCharacters = ['Alice', 'Sam'];
        const result = run(input);
        expect(result.state.scene.location).toBe('公园');
        expect(result.state.scene.immediateSituation).toBe('');
        expect(result.state.scene.presentCharacters).toEqual([]);
        expect(result.state.character.physicalState).toBe('饿了');
        expect(result.state.character.currentMood).toBe('开心');
    });

    test('invalid core claims cannot reappear as relationship summaries, scores or memory closures', () => {
        const input = mixed();
        input.relationshipChanges.currentTension = '她非常失望';
        input.signalChanges.tension = { value: 8, confidence: 'high', reason: '失望', evidenceMessageIds: [38] };
        input.continuityChanges.importantFactsAdd = [{ text: '她非常失望', reason: '猜测', evidenceMessageIds: [38] }];
        input.continuityChanges.importantFactIdsRemove = ['fact-old'];
        const result = run(input);
        expect(result.state.continuity.importantFacts).toEqual(previous().continuity.importantFacts);
        expect(result.state.relationship.currentTension).toBe('');
        expect(result.state.signals.tension.value).toBeNull();
        expect(result.state.character.physicalState).toBe('吃饱了');
    });

    test('an invalid boundary replacement cannot revoke the existing limit', () => {
        const old = previous();
        old.context.boundaries = [privacy()];
        const input = valid();
        input.contextDelta.boundariesResolve = [{ id: 'old-limit', evidence: record().evidence }];
        input.contextDelta.boundariesAdd = [{ ...privacy(''), evidence: record('错误引文').evidence }];
        const result = run(input, old);
        expect(result.state.context.boundaries).toEqual(old.context.boundaries);
        expect(result.delta.contextDelta.boundariesResolve).toEqual([]);
        expect(result.state.character.physicalState).toBe('吃饱了');
    });

    test('an independent verified privacy limit survives an invalid mood update', () => {
        const input = mixed();
        input.contextDelta.boundariesAdd = [privacy('')];
        const result = run(input);
        expect(result.state.context.boundaries[0].text).toBe('不公开照片');
    });

    test('unknown boundary IDs and capacity overflow are warnings, not whole-update failures', () => {
        const input = valid();
        input.contextDelta.boundariesResolve = [{ id: 'missing-limit', evidence: record().evidence }];
        expect(run(input).delta._validation.status).toBe('partial');
        const old = previous();
        old.context.boundaries = Array.from({ length: 16 }, (_, i) => ({ ...privacy('limit-' + i), text: '约定 ' + i }));
        const addition = valid();
        addition.contextDelta.boundariesAdd = [privacy('')];
        const result = run(addition, old);
        expect(result.state.context.boundaries).toEqual(old.context.boundaries);
        expect(result.state.character.physicalState).toBe('吃饱了');
    });

    test('malformed optional sections, list entries and scores do not discard valid fields', () => {
        const input = valid();
        input.relationshipChanges = 'bad';
        input.signalChanges.tension = { value: 99, confidence: 'high', reason: 'bad', evidenceMessageIds: [38] };
        input.continuityChanges.importantFactsAdd = [{ text: '假的', evidenceMessageIds: [999] }, { text: '已经吃饱', reason: '明说', evidenceMessageIds: [38] }];
        input.continuityChanges.importantFactIdsRemove = ['fact-old'];
        const result = run(input);
        expect(result.state.character.physicalState).toBe('吃饱了');
        expect(result.state.signals.tension.value).toBeNull();
        expect(result.state.continuity.importantFacts.map(f => f.text)).toEqual(['已确认的约定']);
    });

    test('assistant-only inventions never become durable memory even with a real message ID', () => {
        const input = delta();
        input.continuityChanges.importantFactsAdd = [{
            text: 'Alice答应明天去海边', reason: 'assistant 声称已经约定', basis: 'explicit',
            evidence: [{ messageId: 38, quote: '今天很开心。' }], evidenceMessageIds: [38],
        }];
        const result = run(input);
        expect(result.state.continuity.importantFacts.map(item => item.text)).toEqual(['已确认的约定']);
        expect(result.delta._validation.skipped[0].reason).toContain('用户确认');
    });

    test('a user-confirmed durable fact is stored with provenance and is the only kind injected', () => {
        const sources = [
            { id: 37, role: 'user', content: '好，我们明天去海边。' },
            { id: 38, role: 'assistant', content: '那就说定了，明天去海边。' },
        ];
        const input = delta();
        input.continuityChanges.importantFactsAdd = [{
            text: '明天去海边', reason: '双方明确确认', basis: 'explicit',
            evidence: [{ messageId: 37, quote: '明天去海边' }, { messageId: 38, quote: '明天去海边' }],
            evidenceMessageIds: [37, 38],
        }];
        const result = run(input, previous(), sources);
        const added = result.state.continuity.importantFacts.at(-1);
        expect(added).toMatchObject({ text: '明天去海边', basis: 'explicit', confirmedByUser: true });
        expect(added.evidence).toEqual(input.continuityChanges.importantFactsAdd[0].evidence);
        expect(formatStateForPrompt(result.state)).toContain('明天去海边');
        expect(formatStateForPrompt(previous())).not.toContain('已确认的约定');
    });

    test('an unrelated user line cannot confirm an assistant-created memory', () => {
        const input = delta();
        input.continuityChanges.openThreadsAdd = [{
            text: '明天去海边', reason: 'assistant 新增线索', basis: 'explicit',
            evidence: [{ messageId: 37, quote: '吃好了吗？' }, { messageId: 38, quote: '今天很开心。' }],
            evidenceMessageIds: [37, 38],
        }];
        const result = run(input);
        expect(result.state.continuity.openThreads).toEqual([]);
        expect(result.delta._validation.skipped[0].reason).toContain('同一事实');
    });

    test('one generic shared noun is not enough to confirm a detailed memory', () => {
        const sources = [
            { id: 37, role: 'user', content: '这张照片挺好看的。' },
            { id: 38, role: 'assistant', content: '我们约好了明天公开照片。' },
        ];
        const input = delta();
        input.continuityChanges.openPromisesAdd = [{
            text: '明天公开照片', reason: 'assistant 声称形成约定', basis: 'explicit',
            evidence: [{ messageId: 37, quote: '照片挺好看' }, { messageId: 38, quote: '明天公开照片' }],
            evidenceMessageIds: [37, 38],
        }];
        expect(run(input, previous(), sources).state.continuity.openPromises).toEqual([]);
    });

    test('observed narration cannot be promoted into private intent or a plan', () => {
        const sources = [{ id: 38, role: 'assistant', content: '她看向门口，像是准备离开。' }];
        const input = field(delta(), 'agency.currentPlan', '准备离开', record('准备离开', { basis: 'observed' }));
        const result = run(input, previous(), sources);
        expect(result.state.agency.currentPlan).toBe('');
        expect(result.delta._validation.skipped[0].reason).toContain('explicit dialogue');
    });

    test('relationship summaries require exact, relevant user confirmation', () => {
        const sources = [
            { id: 37, role: 'user', content: '我也爱你。' },
            { id: 38, role: 'assistant', content: '我爱你。' },
        ];
        const input = field(delta(), 'relationship.emotionalCloseness', '爱你', {
            ...record('我爱你。'),
            evidence: [{ messageId: 37, quote: '我也爱你。' }, { messageId: 38, quote: '我爱你。' }],
        });
        const result = run(input, previous(), sources);
        expect(result.state.relationship.emotionalCloseness).toBe('爱你');
        expect(result.state.context.fields['relationship.emotionalCloseness'].confirmedByUser).toBe(true);
        expect(formatStateForPrompt(result.state)).toContain('爱你');

        const assistantOnly = field(delta(), 'relationship.emotionalCloseness', '爱你', record('我爱你。'));
        const skipped = run(assistantOnly, previous(), [sources[1]]);
        expect(skipped.state.relationship.emotionalCloseness).toBe('');
    });

    test('durable removals require a relevant exact user confirmation', () => {
        const unconfirmed = delta();
        unconfirmed.continuityChanges.importantFactIdsRemove = [{ id: 'fact-old', evidence: [{ messageId: 38, quote: '约定取消了。' }] }];
        const assistantSource = [{ id: 38, role: 'assistant', content: '约定取消了。' }];
        expect(run(unconfirmed, previous(), assistantSource).state.continuity.importantFacts).toHaveLength(1);

        const confirmed = delta();
        confirmed.continuityChanges.importantFactIdsRemove = [{ id: 'fact-old', evidence: [{ messageId: 37, quote: '之前的约定取消了。' }] }];
        const userSource = [{ id: 37, role: 'user', content: '之前的约定取消了。' }];
        expect(run(confirmed, previous(), userSource).state.continuity.importantFacts).toEqual([]);
    });

    test.each([
        '{"subject":',
        '{"subject":{}} {}',
        [],
        { subject: { role: 'character', name: 'Another character' }, contextDelta: delta().contextDelta },
        { subject, contextDelta: { fields: [] } },
        { subject },
    ])('malformed JSON, ownership or envelope still fail safely: %j', input => {
        const state = previous();
        const before = structuredClone(state);
        expect(() => prepareUpdaterResult(input, state, messages, subject)).toThrow();
        expect(state).toEqual(before);
    });

    test('diagnostics survive snapshot serialization and do not enter formal character state', () => {
        const result = run(mixed());
        const chat = Array.from({ length: 39 }, () => ({ is_user: false, mes: '正文' }));
        saveStateSnapshot(chat[38], 38, result.state, { changed: result.changed, delta: result.delta });
        const restored = findLatestSnapshot(JSON.parse(JSON.stringify(chat)), Infinity, subject);
        expect(restored.snapshot.delta._validation).toEqual(result.delta._validation);
        expect(getUpdateWarning(restored.snapshot.delta._validation).shortLabel).toBe('状态部分更新');
        expect(restored.state._validation).toBeUndefined();
        expect(restored.index).toBe(38);
    });

    test('a skipped snapshot stays visibly skipped after reload, rather than reporting success', () => {
        const result = run(field(delta(), 'character.currentMood', '猜测', record('找不到的原文')));
        const report = JSON.parse(JSON.stringify(result.delta._validation));
        expect(getUpdateWarning(report).shortLabel).toBe('本轮状态已跳过');
        expect(getUpdateWarning(report).state).toBe('warning');
        expect(getUpdateWarning(run(delta()).delta._validation)).toBeNull();
    });
});
