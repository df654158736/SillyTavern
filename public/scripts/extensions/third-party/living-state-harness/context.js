// Evidence and scope are stored separately from the legacy display fields.
// Version 2 snapshots remain readable; unverified interpretations are not promoted.
export const CONTEXT_VERSION = 1;
export const REFERENCE_WINDOW = Object.freeze({ maxTurns: 5, maxMessages: 16, maxCharacters: 24000 });
const BASES = new Set(['explicit', 'observed', 'inferred']);
const SCOPES = new Set(['scene', 'topic', 'ongoing']);
const LIMIT_KINDS = new Set(['refusal', 'consent', 'privacy', 'safety', 'principle']);
const FIELD_PATHS = new Set([
    'scene.location', 'scene.presentCharacters', 'scene.immediateSituation',
    'character.currentMood', 'character.physicalState', 'character.attentionFocus',
    'character.currentGoal', 'character.currentConcern', 'character.privateImpulse',
    'character.inhibition', 'agency.currentPlan', 'agency.initiativeSeed',
    'relationship.trust', 'relationship.emotionalCloseness',
    'relationship.authorityDynamic', 'relationship.currentTension',
]);
// These fields describe internal intent rather than directly visible action. A
// narrator's interpretation is not enough to turn them into working memory.
const EXPLICIT_ONLY_PATHS = new Set([
    'character.currentGoal', 'character.currentConcern', 'character.privateImpulse',
    'character.inhibition', 'agency.currentPlan', 'agency.initiativeSeed',
    'relationship.trust', 'relationship.emotionalCloseness', 'relationship.authorityDynamic',
]);
const EPHEMERAL_PATHS = new Set(['agency.currentPlan', 'agency.initiativeSeed']);
// Version-2 snapshots predate provenance. Preserve them for inspection and the
// updater, but never silently inject an unverified legacy value into narration.
const LEGACY_INTERPRETATIONS = new Set(FIELD_PATHS);

// A turn may contain consecutive user messages or multiple assistant continuations.
// Keep complete recent turns; a long older turn is omitted rather than tail-clipped.
export function buildReferenceContext(messages) {
    const turns = [];
    for (const message of messages) {
        if (!['user', 'assistant'].includes(message.role) || !message.content) continue;
        const last = turns.at(-1);
        if (!last || (message.role === 'user' && last.some(m => m.role === 'assistant'))) turns.push([message]);
        else last.push(message);
    }
    // A leading assistant fragment from a bounded history read has lost its question.
    if (turns[0]?.[0].role === 'assistant' && turns[0][0].id > 0) turns.shift();
    const selected = [];
    let characters = 0;
    let count = 0;
    let incomplete = false;
    for (const turn of turns.slice(-REFERENCE_WINDOW.maxTurns).reverse()) {
        const length = turn.reduce((sum, m) => sum + m.content.length, 0);
        if (selected.length && (characters + length > REFERENCE_WINDOW.maxCharacters
            || count + turn.length > REFERENCE_WINDOW.maxMessages)) break;
        if (!selected.length && (length > REFERENCE_WINDOW.maxCharacters || turn.length > REFERENCE_WINDOW.maxMessages)) {
            const fragment = turn.slice(-REFERENCE_WINDOW.maxMessages);
            selected.unshift(compactReferenceTurn(fragment));
            incomplete = true;
            break;
        }
        selected.unshift(turn.map(m => ({ ...m })));
        characters += length;
        count += turn.length;
    }
    return {
        referenceMessages: selected.flat(),
        referenceContext: { includedTurns: selected.length, incomplete },
    };
}

function compactReferenceTurn(messages) {
    const result = messages.map(m => ({ ...m }));
    const shortestFirst = [...result].sort((a, b) => a.content.length - b.content.length);
    let remaining = REFERENCE_WINDOW.maxCharacters;
    for (const [index, message] of shortestFirst.entries()) {
        const allowance = Math.min(message.content.length, Math.floor(remaining / (result.length - index)));
        if (message.content.length > allowance) {
            const marker = '\n[中段已省略；缺失语境不能作为判断依据]\n';
            const head = Math.ceil((allowance - marker.length) / 2);
            const tail = allowance - marker.length - head;
            message.content = message.content.slice(0, head) + marker + message.content.slice(-tail);
            message.truncated = true;
        }
        remaining -= message.content.length;
    }
    return result;
}

export function prepareStateForUpdater(state) {
    const result = structuredClone(state);
    // Old snapshots stay intact in storage, but guesses and provenance-free
    // values are hidden from the next updater so they cannot self-corroborate.
    for (const path of FIELD_PATHS) {
        const record = result.context?.fields?.[path];
        if (record && record.basis !== 'inferred'
            && (!path.startsWith('relationship.') || record.confirmedByUser === true)) continue;
        const [group, key] = path.split('.');
        result[group][key] = path === 'scene.presentCharacters' ? [] : '';
        if (record) delete result.context.fields[path];
    }
    const listPaths = [
        ['relationship', 'evolvedPreferences'],
        ['offscreenLife', 'recentEvents'], ['offscreenLife', 'upcomingObligations'], ['offscreenLife', 'peopleOnMind'],
        ['continuity', 'importantFacts'], ['continuity', 'openPromises'], ['continuity', 'openThreads'],
    ];
    for (const [group, key] of listPaths) result[group][key] = (result[group]?.[key] ?? []).filter(item => item?.confirmedByUser === true);
    result.recentTurningPoints = (result.recentTurningPoints ?? []).filter(item => item?.confirmedByUser === true);
    for (const signal of Object.values(result.signals ?? {})) {
        signal.value = null;
        signal.confidence = 'low';
        signal.reason = '';
        signal.evidenceMessageIds = [];
    }
    result.agency.boundary = '';
    result.agency.responseIfBlocked = '';
    return result;
}

export function normalizeContext(input) {
    const fields = {};
    for (const [path, value] of Object.entries(input?.fields ?? {})) {
        const record = normalizeRecord(value);
        if (FIELD_PATHS.has(path) && record) fields[path] = record;
    }
    return {
        version: input?.version === CONTEXT_VERSION ? CONTEXT_VERSION : 0,
        fields,
        boundaries: (Array.isArray(input?.boundaries) ? input.boundaries : [])
            .map(normalizeBoundary).filter(Boolean),
    };
}

function normalizeRecord(input) {
    if (!input || !BASES.has(input.basis) || !SCOPES.has(input.scope)) return null;
    const evidence = (Array.isArray(input.evidence) ? input.evidence : [])
        .filter(e => Number.isInteger(e?.messageId) && typeof e.quote === 'string' && e.quote.trim())
        .slice(0, 4).map(e => ({ messageId: e.messageId, quote: e.quote.trim().slice(0, 400) }));
    if (!evidence.length || !text(input.appliesWhen) || !text(input.endsWhen)) return null;
    const topics = (Array.isArray(input.topics) ? input.topics : [])
        .map(t => text(t, 60)).filter(Boolean).slice(0, 12);
    if (input.scope === 'topic' && !topics.length) return null;
    return {
        basis: input.basis, scope: input.scope, evidence, topics,
        appliesWhen: text(input.appliesWhen), endsWhen: text(input.endsWhen),
        scene: text(input.scene),
        ...(input.confirmedByUser === true ? { confirmedByUser: true } : {}),
        // Citation numbers from an archived chat must never match a new chat's IDs.
        origin: input.origin === 'archived' ? 'archived' : 'current',
    };
}

function normalizeBoundary(input) {
    const record = normalizeRecord(input);
    if (!record || record.basis !== 'explicit' || !LIMIT_KINDS.has(input.kind) || !text(input.text)) return null;
    return { ...record, id: text(input.id, 80), kind: input.kind, text: text(input.text) };
}

export function validateContextDelta(delta, messages) {
    const changes = delta?.contextDelta;
    if (!changes || typeof changes.fields !== 'object' || !changes.fields || Array.isArray(changes.fields)
        || !Array.isArray(changes.boundariesAdd) || !Array.isArray(changes.boundariesResolve)) {
        throw new Error('Updater must return evidence-backed contextDelta.');
    }
    for (const group of ['scene', 'character', 'agency', 'relationship']) {
        for (const [key, value] of Object.entries(delta[group + 'Changes'] ?? {})) {
            const path = group + '.' + key;
            const isPresentCharacters = path === 'scene.presentCharacters' && Array.isArray(value);
            if (typeof value !== 'string' && !isPresentCharacters) continue;
            if (path === 'agency.boundary' || path === 'agency.responseIfBlocked') {
                if (value.trim()) throw new Error('Use explicit boundary records; do not script a blocked response.');
                continue;
            }
            if (!FIELD_PATHS.has(path)) continue;
            // Abstention is allowed even without a quote; it will never be applied.
            if (changes.fields[path]?.basis === 'inferred') continue;
            // Clearing a feeling needs evidence too, so a topic change cannot reset hurt.
            const record = normalizeRecord(changes.fields[path]);
            if (!record) throw new Error('Missing state evidence/scope: ' + path);
            if (EXPLICIT_ONLY_PATHS.has(path) && record.basis !== 'explicit') {
                throw new Error('Inner intent and durable relationship claims require explicit dialogue: ' + path);
            }
            validateEvidence(changes.fields[path].evidence, messages);
        }
    }
    for (const input of changes.boundariesAdd) {
        const record = normalizeBoundary(input);
        if (!record) throw new Error('Boundary requires an explicit source, scope and end condition.');
        validateEvidence(input.evidence, messages);
        if (record.scope === 'scene' && !record.scene) throw new Error('Scene boundary requires a scene.');
    }
    for (const resolution of changes.boundariesResolve) {
        if (!text(resolution?.id, 80)) throw new Error('Boundary resolution requires an existing ID.');
        validateEvidence(resolution.evidence, messages);
    }
}

export function validateEvidence(evidence, messages) {
    if (!Array.isArray(evidence) || !evidence.length) throw new Error('Missing source quotation.');
    const sources = [];
    for (const item of evidence) {
        const source = messages.find(m => m.id === item?.messageId && ['user', 'assistant'].includes(m.role));
        const quote = typeof item?.quote === 'string' ? item.quote.trim() : '';
        if (!source || !quote || !source.content.includes(quote)) {
            throw new Error('State quotation does not match new accepted dialogue.');
        }
        sources.push(source);
    }
    return sources;
}

export function applyContextDelta(state, previous, delta, messages) {
    if (!delta.contextDelta) return; // Legacy calibration/import path.
    validateContextDelta(delta, messages);
    const context = normalizeContext(previous.context);
    context.version = CONTEXT_VERSION;
    const changes = delta.contextDelta;
    for (const path of FIELD_PATHS) {
        const [group, key] = path.split('.');
        const value = delta[group + 'Changes']?.[key];
        const isPresentCharacters = path === 'scene.presentCharacters' && Array.isArray(value);
        if (typeof value !== 'string' && !isPresentCharacters) continue;
        if (changes.fields[path]?.basis === 'inferred') {
            // No speculative insert, replacement, clear, or evidence renewal.
            state[group][key] = previous[group][key];
            continue;
        }
        const record = normalizeRecord(changes.fields[path]);
        const old = context.fields[path];
        // Repeating an old quote is not fresh confirmation, even for a reset.
        if (old?.origin === 'current' && newestEvidence(record) <= newestEvidence(old)) {
            state[group][key] = previous[group][key];
            continue;
        }
        if ((typeof value === 'string' && !value.trim()) || (isPresentCharacters && !value.length)) {
            delete context.fields[path];
            continue;
        }
        record.scene = record.scope === 'scene' ? state.scene.location : '';
        record.origin = 'current';
        context.fields[path] = record;
    }
    for (const resolution of changes.boundariesResolve) {
        if (resolution.id === 'legacy-boundary') {
            state.agency.boundary = '';
        } else {
            const index = context.boundaries.findIndex(b => b.id === resolution.id);
            if (index === -1) throw new Error('Cannot resolve an unknown boundary.');
            context.boundaries.splice(index, 1);
        }
    }
    for (const input of changes.boundariesAdd) {
        const record = normalizeBoundary(input);
        record.origin = 'current';
        const existing = context.boundaries.find(b => b.text === record.text && b.appliesWhen === record.appliesWhen);
        if (existing) continue;
        // Do not silently evict an unresolved privacy/consent limit to satisfy a cap.
        if (context.boundaries.length >= 16) throw new Error('Review existing boundaries before adding more.');
        record.id = 'limit-' + newestEvidence(record) + '-' + context.boundaries.length;
        while (context.boundaries.some(b => b.id === record.id)) record.id += 'x';
        context.boundaries.push(record);
    }
    // The updater cannot erase an imported limit just by emitting an empty display field.
    if (!changes.boundariesResolve.some(r => r.id === 'legacy-boundary')) state.agency.boundary = previous.agency.boundary;
    state.agency.responseIfBlocked = '';
    state.context = context;
}

function newestEvidence(record) {
    return Math.max(-1, ...record.evidence.map(e => e.messageId));
}

export function getContextStatus(record, state, messages = [], path = '') {
    if (!record) return 'unverified';
    if (record.basis === 'inferred') return 'inferred';
    if (path.startsWith('relationship.') && record.confirmedByUser !== true) return 'unconfirmed';
    if (record.scope === 'scene' && text(record.scene) !== text(state.scene.location)) return 'outside-scene';
    if (record.scope === 'topic') {
        const dialogue = messages.slice(-4).map(m => m.content).join('\n').toLocaleLowerCase();
        if (!record.topics.some(topic => dialogue.includes(topic.toLocaleLowerCase()))) return 'outside-topic';
    }
    if (EPHEMERAL_PATHS.has(path)) {
        const newestMessage = Math.max(-1, ...messages.map(message => Number(message?.id)).filter(Number.isInteger));
        if (newestMessage > newestEvidence(record) + 2) return 'expired';
    }
    return 'active';
}

export function projectContext(state, messages = []) {
    const projected = structuredClone(state);
    const context = normalizeContext(state.context);
    for (const path of FIELD_PATHS) {
        const [group, key] = path.split('.');
        const record = context.fields[path];
        const status = getContextStatus(record, state, messages, path);
        if ((record && status !== 'active') || (!record && LEGACY_INTERPRETATIONS.has(path))) {
            projected[group][key] = path === 'scene.presentCharacters' ? [] : '';
        }
    }
    projected.agency.responseIfBlocked = '';
    const boundaries = context.boundaries.filter(b => getContextStatus(b, state, messages) === 'active');
    return { state: projected, boundaries };
}

export function describeContext(record, state, messages = [], path = '') {
    if (!record) return LEGACY_INTERPRETATIONS.has(path)
        ? '旧状态：来源和适用范围尚未核验，保留记录但不注入正文'
        : '旧状态：来源和适用范围尚未核验';
    const statuses = { active: '本轮相关', inferred: '推测：保留供核对，不注入正文', unconfirmed: '缺少用户确认：保留供核对，不注入正文', expired: '临时意图已过期：不注入正文', 'outside-scene': '其他场景：当前不注入', 'outside-topic': '其他话题：当前不注入', unverified: '待核验' };
    return [
        statuses[getContextStatus(record, state, messages, path)],
        '适用：' + record.appliesWhen,
        '结束依据：' + record.endsWhen,
        ...record.evidence.map(e => (record.origin === 'archived' ? '归档原文 #' : '消息 #') + e.messageId + '：' + e.quote),
    ].join('\n');
}

export function archiveContext(context) {
    const result = normalizeContext(context);
    for (const record of [...Object.values(result.fields), ...result.boundaries]) record.origin = 'archived';
    return result;
}

function text(value, length = 240) {
    return typeof value === 'string' ? value.trim().slice(0, length) : '';
}

export function formatContextRequest(prompt, emptyDelta, correction = '') {
    const contextDelta = { fields: {}, boundariesAdd: [], boundariesResolve: [] };
    const shape = { ...emptyDelta, contextDelta };
    return prompt + '\n\nReturn exactly ONE JSON object, not multiple objects or a separate explanation. Unchanged fields may be omitted or null/[]. Do not fill the template just to be complete. A valid no-change response is:\n'
        + JSON.stringify({ subject: emptyDelta.subject, contextDelta })
        + '\n\nAvailable delta fields (schema template, not facts to copy):\n' + JSON.stringify(shape)
        + '\n\nFor every changed scene/character/agency/relationship field, including presentCharacters, contextDelta.fields["group.field"] must include {basis,scope,evidence:[{messageId,quote}],appliesWhen,endsWhen,topics}. Copy the real numeric messageId and exact quote from newMessages, not referenceMessages. Internal intent and stable relationship fields require basis=explicit. Boundary additions go ONLY in contextDelta.boundariesAdd, with the same evidence/scope fields plus text, kind, and scene for scene scope; agency.boundary and responseIfBlocked remain null. Every *Add list item requires {text,reason,basis,evidence:[{messageId,quote}],evidenceMessageIds}; its evidence must contain a relevant exact user quote confirming the same fact. Every *Close/*Remove item requires {id,evidence:[{messageId,quote}]}.'
        + (correction ? '\nThe previous attempt failed validation: ' + correction + '. Recheck the format and quotations against newMessages.' : '');
}

export function buildContextUpdaterInstructions() {
    return [
        '你是角色连续性记录员，只输出 State Delta JSON，不写故事或预编下一轮行动。',
        '1. subject 原样返回 targetSubject。character/agency 只属于该角色；relationship 是角色对 counterpart 的视角。不得推测用户的内心或决定。',
        '2. 结合 referenceMessages 中近期多轮问答理解 newMessages：先辨认说话者、回应对象、场景与前因，再判断变化。referenceMessages 只供理解，newMessages 才是新增证据。previousState 是待核对的旧记录，不是新证据；重复旧猜测也不构成证实。剥离思考、摘要、分支、种子和状态栏，只引用已接受正文。',
        '3. 无变化或不能确定用 null/[]，允许整轮没有更新。含义多解、反话玩笑难分、指代不清、前因缺失或 referenceContext.incomplete 时，受影响字段宁愿不填；不得把未知写成空字符串来抹去旧事实。普通接话不需要生成新担忧、冲动、计划或关系升级。关心、偏好、打趣不推导成管理、考核、交易或禁止。稳定人格来自角色卡。',
        '4. sceneChanges、characterChanges、agencyChanges、relationshipChanges 的每个状态变化（含 presentCharacters 与清空）都在 contextDelta.fields 以完整字段名提供记录：basis(explicit/observed/inferred)、scope(scene/topic/ongoing)、evidence([{messageId,quote}])、appliesWhen、endsWhen、topics。quote 必须逐字来自 newMessages。topic 需包含可独立匹配的对象名词及常见表达，不只填整句或动作短语。跨场景仍有效的要求不标为 scene。',
        '5. explicit 是角色明确表达，observed 只用于实际可见的场景、动作、情绪或身体变化；currentGoal/currentConcern/privateImpulse/inhibition/currentPlan/initiativeSeed 及稳定关系判断只接受 explicit。仅观察到低头或微笑不足以判定失望、原谅、信任或隐藏意愿。不确定推测返回 null，不写入状态；若仍提交 basis=inferred，该字段会被丢弃。不把猜测伪装成明确表达，也不转移到事实列表、关系或信号里保存。当前心情、身体感受和愿望可以同时存在，不写台词模板或催促对方的策略。',
        '6. scene 仅本场景适用；topic 在相关话题提起时使用；ongoing 是跨场景仍在持续的事实或情绪。结束须有新证据：吃过饭可更新饥饿，换衣可更新湿衣；受伤、委屈与信任不会因换场景、一个笑或几轮闲聊自动恢复。',
        '7. agency.boundary、responseIfBlocked 始终返回 null。真实限制写到 contextDelta.boundariesAdd，含 text、kind(refusal/consent/privacy/safety/principle) 和上述证据范围记录，basis 必须 explicit，scene 还需场景名称。允许多个针对不同事情的限制。',
        '8. 按上下文判定拒绝对象与范围，不能按“不、别、先、只准”等字判定。偏好、行程、建议、玩笑通常不成为边界。明确的“我现在不想聊”当下就应尊重，不需多轮重复或上升到核心原则；分不清语气时不新增永久规则，同时不推定同意，不撤销已确认的限制。不得把真实拒绝改写成欲拒还迎或默认同意。',
        '9. 换话题或对方配合表示可能暂不相关，不代表撤回要求。停止公开某张照片的要求应保留至明确改意。取消用 boundariesResolve:[{id,evidence:[{messageId,quote}]}]，证据需明确支持撤回、完成或适用条件结束。legacy-boundary 是旧版单条边界，无法确定一律保留待核验。',
        '10. 不预设对方会纠缠、敷衍或施压，不编造受阻反应。边界的存在也不等于边界正在受压。无施压证据不要提高 boundaryPressure。',
        '11. 长期列表采取“用户确认后晋升”：*Add 必须是 {text,reason,basis,evidence:[{messageId,quote}],evidenceMessageIds}。evidence 必须含一条与 text 同一事实、逐字来自 newMessages 的用户原话；仅由 assistant 新写出的背景、回忆、承诺、伏笔、关系偏好或事件一律不晋升，等待用户后续确认。无法确认就返回 []。不把计划写成已发生事实。',
        '12. 已完成或失效事项用 {id,evidence:[{messageId,quote}]} 放入对应 *Close/*Remove 数组；证据必须明确支持完成、撤回或失效，不能只给 ID。信号格式 {value:0至10整数,confidence:low/medium/high,reason,evidenceMessageIds}，且只有同轮存在已通过引文核验的相关状态变化时才更新。分数只供面板检查，不作为正文行为指令。authorLocks 和已确认客观事实不可被覆盖。',
        '各字段简短，优先记清事实、原因、范围。不得为了填满结构编造缺失内容。',
    ].join('\n');
}
