import { describe, expect, test } from '@jest/globals';
import { collectMessages, createEmptyState, formatStateForPrompt, mergeDelta, normalizeState, sanitizeEvidenceText, saveStateSnapshot, findLatestSnapshot } from '../public/scripts/extensions/living-state-harness/state.js';
import { buildReferenceContext, describeContext, getContextStatus, prepareStateForUpdater, projectContext, REFERENCE_WINDOW } from '../public/scripts/extensions/living-state-harness/context.js';
import { createContinuationChat } from '../public/scripts/extensions/living-state-harness/archive.js';

const subject = { role: 'character', name: 'Alice', counterpartName: 'Sam' };
const message = (id, content) => ({ id, role: 'assistant', content });
const scope = (source, options = {}) => ({
    basis: 'explicit', scope: 'ongoing', evidence: [{ messageId: source.id, quote: source.content }],
    appliesWhen: '当前感受持续期间', endsWhen: '新事件明确改变感受', topics: [], ...options,
});
const delta = (changes = {}) => ({
    subject, contextDelta: { fields: {}, boundariesAdd: [], boundariesResolve: [] }, ...changes,
});
const apply = (state, changes, messages) => mergeDelta(state, changes, messages.map(m => m.id), messages.at(-1).id, subject, messages).state;
const fieldDelta = (path, value, record) => {
    const [group, key] = path.split('.');
    return delta({ [group + 'Changes']: { [key]: value }, contextDelta: { fields: { [path]: record }, boundariesAdd: [], boundariesResolve: [] } });
};
function photoLimit() {
    const source = message(0, '这张照片我不想公开。');
    return apply(createEmptyState(subject), delta({ contextDelta: {
        fields: {}, boundariesResolve: [], boundariesAdd: [{
            ...scope(source, { scope: 'topic', topics: ['照片', '发朋友圈', '晒图'], appliesWhen: '考虑公开这张照片时', endsWhen: '她明确改变公开这张照片的意愿' }),
            kind: 'privacy', text: '不公开这张照片',
        }],
    } }), [source]);
}

describe('Evidence, scope and non-directive state projection', () => {
    test('has no injected instructions when there is no relevant state', () => {
        expect(formatStateForPrompt(createEmptyState(subject))).toBe('');
    });

    test('retains legacy data but suppresses unverified management motives and scripts', () => {
        const old = createEmptyState(subject);
        delete old.context;
        old.scene.location = '公园';
        old.character.currentConcern = '怕对方选错饮料';
        old.character.privateImpulse = '想管住对方';
        old.agency.currentPlan = '检查头发是否擦干';
        old.agency.responseIfBlocked = '对方不配合就数落';
        old.agency.boundary = '不公开照片';
        const before = structuredClone(old);
        const prompt = formatStateForPrompt(old);
        expect(prompt).toContain('公园');
        expect(prompt).toContain('不公开照片');
        for (const text of ['怕对方选错饮料', '想管住对方', '检查头发是否擦干', '对方不配合就数落']) expect(prompt).not.toContain(text);
        expect(old).toEqual(before);
        expect(normalizeState(old).agency.responseIfBlocked).toBe('对方不配合就数落');
    });

    test('records a wish without manufacturing a boundary or response script', () => {
        const source = message(1, '我有点饿，想去吃饭。');
        const state = apply(createEmptyState(subject), fieldDelta('character.currentGoal', '一起吃饭', scope(source)), [source]);
        expect(state.context.boundaries).toEqual([]);
        expect(state.agency.responseIfBlocked).toBe('');
        expect(formatStateForPrompt(state)).toContain('一起吃饭');
        expect(formatStateForPrompt(state)).not.toContain('Explicit limit:');
    });

    test('does not store or inject a new speculative feeling', () => {
        const source = message(1, '她低头看着杯子。');
        const state = apply(createEmptyState(subject), fieldDelta('character.currentConcern', '也许失望', scope(source, { basis: 'inferred' })), [source]);
        expect(state.character.currentConcern).toBe('');
        expect(state.context.fields['character.currentConcern']).toBeUndefined();
        expect(formatStateForPrompt(state)).not.toContain('也许失望');
    });

    test.each(['也许已经释然', ''])('uncertainty cannot replace or clear confirmed hurt (%s)', value => {
        const source = message(1, '我很难过。');
        const old = apply(photoLimit(), fieldDelta('character.currentMood', '难过', scope(source)), [source]);
        const later = message(2, '她笑了笑。');
        const next = apply(old, fieldDelta('character.currentMood', value, { basis: 'inferred' }), [later]);
        expect(next.character.currentMood).toBe('难过');
        expect(next.context).toEqual(old.context);
        expect(next.version).toBe(old.version);
        expect(next.processedThroughMessageId).toBe(2);
    });

    test('an uncertain field does not prevent a separate grounded field from updating', () => {
        const source = message(2, '她低头看着杯子，说：“我饿了。”');
        const changes = fieldDelta('character.currentMood', '失望', { basis: 'inferred' });
        changes.characterChanges.physicalState = '饿了';
        changes.contextDelta.fields['character.physicalState'] = scope(source);
        const next = apply(createEmptyState(subject), changes, [source]);
        expect(next.character.currentMood).toBe('');
        expect(next.character.physicalState).toBe('饿了');
    });

    test('legacy guesses remain recoverable but are not fed back into the updater', () => {
        const old = photoLimit();
        const source = message(1, '她低头看着杯子。');
        old.character.currentConcern = '也许失望';
        old.context.fields['character.currentConcern'] = scope(source, { basis: 'inferred' });
        const before = structuredClone(old);
        const requestState = prepareStateForUpdater(old);
        expect(requestState.character.currentConcern).toBe('');
        expect(requestState.context.fields['character.currentConcern']).toBeUndefined();
        expect(requestState.context.boundaries).toEqual(old.context.boundaries);
        expect(old).toEqual(before);
        expect(describeContext(old.context.fields['character.currentConcern'], old)).toContain('推测');
    });

    test('a change of scene deactivates local state but does not erase ongoing hurt', () => {
        let state = createEmptyState(subject);
        state.scene.location = '公园';
        const wet = message(1, '她的外套被淋湿了。');
        state = apply(state, fieldDelta('character.physicalState', '湿外套', scope(wet, { basis: 'observed', scope: 'scene', endsWhen: '换好干衣服' })), [wet]);
        const hurt = message(2, '那句话真的让我很难过。');
        state = apply(state, fieldDelta('character.currentMood', '对刚才的话仍有些难过', scope(hurt)), [hurt]);
        const moved = message(3, '两人走进餐厅。');
        state = apply(state, fieldDelta('scene.location', '餐厅', scope(moved, { basis: 'observed', scope: 'scene' })), [moved]);
        const prompt = formatStateForPrompt(state);
        expect(prompt).toContain('对刚才的话仍有些难过');
        expect(prompt).not.toContain('湿外套');
        expect(state.character.physicalState).toBe('湿外套');
    });

    test('new evidence can end hunger without inventing a new objective', () => {
        const hungry = message(1, '我饿了。');
        let state = apply(createEmptyState(subject), fieldDelta('character.physicalState', '饿了', scope(hungry)), [hungry]);
        const ate = message(2, '我吃饱了。');
        state = apply(state, fieldDelta('character.physicalState', '', scope(ate)), [ate]);
        expect(state.character.physicalState).toBe('');
        expect(state.character.currentGoal).toBe('');
    });

    test('privacy remains stored through unrelated talk and returns on the relevant topic', () => {
        const state = photoLimit();
        const lunch = [message(1, '中午吃什么？')];
        expect(formatStateForPrompt(state, subject, {}, lunch)).not.toContain('不公开这张照片');
        expect(state.context.boundaries).toHaveLength(1);
        expect(getContextStatus(state.context.boundaries[0], state, lunch)).toBe('outside-topic');
        const posting = [message(2, '我想把照片发朋友圈。')];
        expect(formatStateForPrompt(state, subject, {}, posting)).toContain('不公开这张照片');
        const unchanged = apply(state, delta(), [message(3, '好，我不发了，我们吃饭吧。')]);
        expect(unchanged.context.boundaries).toEqual(state.context.boundaries);
    });

    test('separate refusals coexist; resolving one never cancels another', () => {
        let state = photoLimit();
        state.scene.location = '餐厅';
        const privateTopic = message(1, '这里人多，我现在不想谈家里的事。');
        state = apply(state, delta({ contextDelta: {
            fields: {}, boundariesResolve: [], boundariesAdd: [{
                ...scope(privateTopic, { scope: 'scene', scene: '餐厅', appliesWhen: '餐厅有人时谈家庭话题', endsWhen: '离开餐厅或她主动愿意谈' }),
                kind: 'refusal', text: '此刻不谈家庭话题',
            }],
        } }), [privateTopic]);
        const permission = message(2, '这张照片可以公开了。');
        state = apply(state, delta({ contextDelta: {
            fields: {}, boundariesAdd: [], boundariesResolve: [{ id: state.context.boundaries[0].id, evidence: scope(permission).evidence }],
        } }), [permission]);
        expect(state.context.boundaries).toHaveLength(1);
        expect(state.context.boundaries[0].text).toBe('此刻不谈家庭话题');
        expect(formatStateForPrompt(state)).not.toContain('这张照片');
    });

    test.each([
        ['missing metadata', delta({ characterChanges: { currentMood: '开心' } })],
        ['fabricated quotation', fieldDelta('character.currentMood', '开心', scope(message(1, '不存在的引文')))],
        ['old citation', fieldDelta('character.currentMood', '开心', scope(message(0, '我开心。')))],
        ['unbacked clearing', delta({ characterChanges: { currentMood: '' } })],
        ['scripted blocked response', delta({ agencyChanges: { responseIfBlocked: '让他改口' } })],
    ])('rejects %s before modifying saved state', (_label, changes) => {
        const state = createEmptyState(subject);
        const before = structuredClone(state);
        expect(() => apply(state, changes, [message(1, '我开心。')])).toThrow();
        expect(state).toEqual(before);
    });

    test('an inferred boundary and an ungrounded revocation are both rejected', () => {
        const source = message(1, '她低头看杯子。');
        expect(() => apply(createEmptyState(subject), delta({ contextDelta: {
            fields: {}, boundariesResolve: [], boundariesAdd: [{ ...scope(source, { basis: 'inferred' }), kind: 'refusal', text: '她禁止继续讲话' }],
        } }), [source])).toThrow();
        const state = photoLimit();
        expect(() => apply(state, delta({ contextDelta: {
            fields: {}, boundariesAdd: [], boundariesResolve: [{ id: state.context.boundaries[0].id, evidence: [] }],
        } }), [source])).toThrow();
    });

    test('repeated citations do not strengthen a feeling, reset it or bump its version', () => {
        const source = message(1, '我有点失望。');
        const state = apply(createEmptyState(subject), fieldDelta('character.currentConcern', '有点失望', scope(source)), [source]);
        for (const replacement of ['非常失望', '']) {
            const repeated = apply(state, fieldDelta('character.currentConcern', replacement, scope(source)), [source]);
            expect(repeated.character.currentConcern).toBe('有点失望');
            expect(repeated.context.fields['character.currentConcern'].basis).toBe('explicit');
            expect(repeated.version).toBe(state.version);
        }
    });

    test('snapshots and archive continuations preserve evidence without reusing original citation numbers', () => {
        const source = message(50, '我还在难过。');
        const original = apply(createEmptyState(subject), fieldDelta('character.currentMood', '仍在难过', scope(source)), [source]);
        original.context.boundaries = photoLimit().context.boundaries;
        const chat = createContinuationChat([{ is_user: false, mes: '继续聊' }], original, subject);
        const restored = findLatestSnapshot(chat, Infinity, subject).state;
        expect(restored.context.fields['character.currentMood'].origin).toBe('archived');
        expect(restored.context.boundaries[0].origin).toBe('archived');
        const newSource = message(1, '现在想通了，轻松多了。');
        const next = apply(restored, fieldDelta('character.currentMood', '已经释然', scope(newSource)), [newSource]);
        expect(next.character.currentMood).toBe('已经释然');
        expect(next.context.boundaries).toHaveLength(1);
        saveStateSnapshot(chat[0], 0, next);
        expect(findLatestSnapshot(chat, Infinity, subject).state.context).toEqual(next.context);
        expect(original.context.fields['character.currentMood'].origin).toBe('current');
    });

    test('projection and source inspection never mutate stored state', () => {
        const state = photoLimit();
        const before = structuredClone(state);
        projectContext(state, [message(1, '吃饭了。')]);
        expect(describeContext(state.context.boundaries[0], state)).toContain('消息 #0');
        expect(state).toEqual(before);
    });

    test('pressure scores cannot revive a scripted response in the main prompt', () => {
        const state = createEmptyState(subject);
        state.character.currentMood = '平静';
        state.signals.boundaryPressure = { value: 8, confidence: 'high', reason: '旧误判', evidenceMessageIds: [1] };
        state.signals.initiativeReadiness = { value: 9, confidence: 'high', reason: '旧推测', evidenceMessageIds: [1] };
        const prompt = formatStateForPrompt(state);
        expect(prompt).not.toContain('Boundary pressure');
        expect(prompt).not.toContain('Initiative readiness');
        expect(state.signals.boundaryPressure.value).toBe(8);
    });
});

describe('Multi-turn reference context', () => {
    const dialogue = pairs => pairs.flatMap(([user, assistant], index) => [
        { id: index * 2, role: 'user', content: user },
        { id: index * 2 + 1, role: 'assistant', content: assistant },
    ]);

    test.each([
        '<think>隐藏猜测</think>正文',
        '<thinking class="analysis">隐藏猜测</thinking>正文',
        '正文<think>未闭合的猜测',
    ])('excludes tagged reasoning, including incomplete blocks: %s', raw => {
        expect(sanitizeEvidenceText(raw)).toBe('正文');
    });

    test('retains five previous complete turns in chronological order', () => {
        const messages = dialogue(Array.from({ length: 8 }, (_, i) => [`问题 ${i}`, `回答 ${i}`]));
        const before = structuredClone(messages);
        const result = buildReferenceContext(messages);
        expect(result.referenceMessages).toEqual(messages.slice(-10));
        expect(result.referenceContext).toEqual({ includedTurns: 5, incomplete: false });
        expect(messages).toEqual(before);
    });

    test('consecutive inputs and assistant continuations belong to the same turn', () => {
        const result = buildReferenceContext([
            { id: 0, role: 'user', content: '还有个问题' },
            { id: 1, role: 'user', content: '补充一下' },
            message(2, '回答'), message(3, '接着说'),
            { id: 4, role: 'user', content: '下一轮' }, message(5, '明白'),
        ]);
        expect(result.referenceContext.includedTurns).toBe(2);
        expect(result.referenceMessages).toHaveLength(6);
    });

    test('long ordinary replies retain their opening context instead of only their tail', () => {
        const messages = dialogue(Array.from({ length: 5 }, () => ['先说明语境', '开头条件' + '正文'.repeat(2000) + '结尾']));
        const result = buildReferenceContext(messages);
        expect(result.referenceMessages).toEqual(messages);
        expect(result.referenceContext.incomplete).toBe(false);
    });

    test('reduces the window by whole oldest turns when the character budget is exceeded', () => {
        const messages = dialogue(Array.from({ length: 5 }, () => ['问题', '文'.repeat(9000)]));
        const result = buildReferenceContext(messages);
        expect(result.referenceMessages).toEqual(messages.slice(-4));
        expect(result.referenceContext).toEqual({ includedTurns: 2, incomplete: false });
    });

    test('an oversized latest turn keeps short inputs and marks a head/tail excerpt', () => {
        const messages = dialogue([['这是玩笑吗？', '开头' + '文'.repeat(30000) + '结尾']]);
        const before = structuredClone(messages);
        const result = buildReferenceContext(messages);
        expect(result.referenceMessages[0]).toEqual(messages[0]);
        expect(result.referenceMessages[1].content).toMatch(/^开头/);
        expect(result.referenceMessages[1].content).toMatch(/结尾$/);
        expect(result.referenceMessages[1].content).toContain('中段已省略');
        expect(result.referenceMessages[1].truncated).toBe(true);
        expect(result.referenceContext.incomplete).toBe(true);
        expect(result.referenceMessages.reduce((sum, m) => sum + m.content.length, 0)).toBeLessThanOrEqual(REFERENCE_WINDOW.maxCharacters);
        expect(messages).toEqual(before);
    });

    test('a turn with many continuations is bounded and labelled incomplete', () => {
        const messages = [{ id: 0, role: 'user', content: '请继续' }, ...Array.from({ length: 30 }, (_, i) => message(i + 1, '接着说'))];
        const result = buildReferenceContext(messages);
        expect(result.referenceMessages).toHaveLength(REFERENCE_WINDOW.maxMessages);
        expect(result.referenceContext.incomplete).toBe(true);
    });

    test('does not keep an orphaned older reply without its question', () => {
        const result = buildReferenceContext([message(12, '那就算了。'), { id: 13, role: 'user', content: '你好' }, message(14, '你好')]);
        expect(result.referenceMessages.map(m => m.id)).toEqual([13, 14]);
        expect(buildReferenceContext([message(12, '那就算了。')]).referenceMessages).toEqual([]);
        expect(buildReferenceContext([]).referenceMessages).toEqual([]);
    });

    test('the source slice excludes the current turn, future messages and hidden reasoning', () => {
        const chat = [
            { is_user: true, mes: '这句是玩笑' },
            { is_user: false, mes: '<think>隐藏猜测</think>知道啦' },
            { is_user: true, mes: '本次问题' },
            { is_user: false, mes: '本次回答' },
            { is_user: false, mes: '未来回答' },
        ];
        const newMessages = collectMessages(chat, 1, 3, 20);
        const result = buildReferenceContext(collectMessages(chat, -1, newMessages[0].id - 1, 40));
        expect(result.referenceMessages.map(m => m.id)).toEqual([0, 1]);
        expect(JSON.stringify(result)).not.toContain('隐藏猜测');
        expect(JSON.stringify(result)).not.toContain('本次');
        expect(JSON.stringify(result)).not.toContain('未来');
    });
});
