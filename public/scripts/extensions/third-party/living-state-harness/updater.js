import { validateContextDelta, validateEvidence } from './context.js';
import { assertDeltaSubject, createEmptyDelta, mergeDelta, normalizeDeltaReferences, normalizeState } from './state.js';

const isObject = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const hasChange = value => Array.isArray(value) ? value.length > 0
    : isObject(value) ? Object.values(value).some(hasChange) : value !== null && value !== undefined;
const LISTS = [
    ['relationshipChanges', 'evolvedPreferencesAdd', 'evolvedPreferenceIdsRemove', 'relationship', 'evolvedPreferences'],
    ['offscreenLifeChanges', 'recentEventsAdd', 'recentEventIdsRemove', 'offscreenLife', 'recentEvents'],
    ['offscreenLifeChanges', 'upcomingObligationsAdd', 'upcomingObligationIdsClose', 'offscreenLife', 'upcomingObligations'],
    ['offscreenLifeChanges', 'peopleOnMindAdd', 'peopleOnMindIdsRemove', 'offscreenLife', 'peopleOnMind'],
    ['continuityChanges', 'importantFactsAdd', 'importantFactIdsRemove', 'continuity', 'importantFacts'],
    ['continuityChanges', 'openPromisesAdd', 'openPromiseIdsClose', 'continuity', 'openPromises'],
    ['continuityChanges', 'openThreadsAdd', 'openThreadIdsClose', 'continuity', 'openThreads'],
    ['', 'turningPointsAdd', 'turningPointIdsRemove', '', 'recentTurningPoints'],
];
const RELATIONSHIP_FIELDS = new Set(['trust', 'emotionalCloseness', 'authorityDynamic', 'currentTension']);

function searchableAnchors(value) {
    const normalized = String(value ?? '').normalize('NFKC').toLocaleLowerCase();
    const anchors = new Set(normalized.match(/[a-z0-9]{3,}/g) ?? []);
    for (const sequence of normalized.match(/[\p{Script=Han}]{2,}/gu) ?? []) {
        for (let index = 0; index < sequence.length - 1; index++) {
            const pair = sequence.slice(index, index + 2);
            if (!['我们', '你们', '他们', '这个', '那个', '现在', '已经', '还是', '就是', '可以', '没有', '自己', '一下', '一点'].includes(pair)) anchors.add(pair);
        }
    }
    return anchors;
}

function comparableText(value) {
    return String(value ?? '').normalize('NFKC').toLocaleLowerCase().replace(/[\p{P}\p{S}\s]/gu, '');
}

function hasStrongTextOverlap(text, quote) {
    const target = comparableText(text);
    const source = comparableText(quote);
    if (target.length >= 2 && source.includes(target)) return true;
    const targetAnchors = searchableAnchors(target);
    const shared = [...searchableAnchors(source)].filter(anchor => targetAnchors.has(anchor));
    return shared.some(anchor => anchor.length >= 3) || shared.length >= 2;
}

function hasRelevantUserEvidence(text, evidence, messages) {
    const sources = validateEvidence(evidence, messages);
    return sources.some((source, index) => {
        if (source.role !== 'user') return false;
        return hasStrongTextOverlap(text, evidence[index]?.quote);
    });
}

function validatedDurableAddition(item, messages) {
    if (!isObject(item) || typeof item.text !== 'string' || !item.text.trim()
        || typeof item.reason !== 'string' || !item.reason.trim()
        || !['explicit', 'observed'].includes(item.basis)) {
        throw new Error('长期记忆必须提供 text、reason、basis 和逐字证据');
    }
    const sources = validateEvidence(item.evidence, messages);
    const evidenceMessageIds = Array.isArray(item.evidenceMessageIds)
        ? item.evidenceMessageIds.map(Number).filter(Number.isInteger) : [];
    const quotedIds = [...new Set(item.evidence.map(entry => Number(entry.messageId)))];
    if (!quotedIds.length || !quotedIds.every(id => evidenceMessageIds.includes(id))
        || evidenceMessageIds.some(id => !messages.some(message => message.id === id))) {
        throw new Error('长期记忆的消息编号与逐字证据不一致');
    }
    if (!sources.some(source => source.role === 'user') || !hasRelevantUserEvidence(item.text, item.evidence, messages)) {
        throw new Error('长期记忆缺少与同一事实相关的用户确认');
    }
    return {
        text: item.text,
        reason: item.reason,
        basis: item.basis,
        evidence: structuredClone(item.evidence),
        evidenceMessageIds: quotedIds,
        confirmedByUser: true,
    };
}

function validatedRemoval(item, previousItem, messages) {
    if (!isObject(item) || String(item.id ?? '').trim() !== String(previousItem?.id ?? '')) {
        throw new Error('关闭长期记忆必须提供现有 id 和逐字证据');
    }
    validateEvidence(item.evidence, messages);
    if (!hasRelevantUserEvidence(previousItem.text, item.evidence, messages)) {
        throw new Error('关闭长期记忆缺少与原事项相关的用户确认');
    }
    return String(item.id).trim();
}

function preferResult(best, candidate) {
    if (!best) return candidate;
    if (!candidate.changed) return best;
    if (!best.changed) return candidate;
    const oldLimits = best.delta.contextDelta;
    const newLimits = candidate.delta.contextDelta;
    // Do not discard an already verified limit while repairing an unrelated field.
    if (oldLimits.boundariesAdd.some(b => !newLimits.boundariesAdd.some(n => n.text === b.text))
        || oldLimits.boundariesResolve.some(r => !newLimits.boundariesResolve.some(n => n.id === r.id))) return best;
    const count = result => Object.keys(result.delta.contextDelta.fields).length
        + result.delta.contextDelta.boundariesAdd.length + result.delta.contextDelta.boundariesResolve.length;
    return count(candidate) >= count(best) ? candidate : best;
}

// A repair attempt never discards the first safely reviewed result. Only request /
// JSON / envelope failures without any safe result propagate as whole-update errors.
export async function runReviewedUpdater(request, previousState, messages, subject, onRetry = async () => {}) {
    let best;
    let lastError;
    let attempts = 0;
    for (let attempt = 1; attempt <= 2; attempt++) {
        attempts = attempt;
        try {
            const candidate = prepareUpdaterResult(await request(lastError?.message ?? '', attempt), previousState, messages, subject);
            best = preferResult(best, candidate);
            const repairable = candidate.delta._validation.skipped.filter(item => /quotation|Missing state evidence|requires|unknown boundary|格式|必须|新消息证据无效|旧版边界字段/.test(item.reason));
            if (!repairable.length) break;
            lastError = new Error('Repair only invalid output format or exact source citations; use null if uncertain. Do not invent facts or evidence. ' + repairable.map(item => `${item.path}: ${item.reason}`).join('; '));
        } catch (error) {
            lastError = error;
        }
        if (attempt < 2) await onRetry(lastError, attempt);
    }
    if (!best) throw lastError;
    best.delta._validation.attempts = attempts;
    return best;
}

// Shared by the real background updater and regression/live tests. Never writes a chat.
export function prepareUpdaterResult(raw, previousState, messages, subject) {
    let input = raw;
    if (typeof raw === 'string') {
        // Only strip leading reasoning, never modify quotation strings inside the JSON.
        const text = raw.trim().replace(/^(?:<(think|thinking)\b[^>]*>[\s\S]*?<\/\1>\s*)+/i, '');
        const start = text.indexOf('{');
        const end = text.lastIndexOf('}');
        if (start < 0 || end < start) throw new Error('Updater did not return a JSON object.');
        input = JSON.parse(text.slice(start, end + 1));
    }
    if (!isObject(input)) throw new Error('Updater returned an invalid Delta object.');
    assertDeltaSubject(input, subject);
    const rawContext = input.contextDelta;
    if (!isObject(rawContext) || !isObject(rawContext.fields)
        || !Array.isArray(rawContext.boundariesAdd) || !Array.isArray(rawContext.boundariesResolve)) {
        throw new Error('Updater must return evidence-backed contextDelta.');
    }
    const originalInput = structuredClone(input);
    input = normalizeDeltaReferences(structuredClone(input));
    const previous = normalizeState(previousState, subject);
    const delta = createEmptyDelta(subject);
    delta.contextDelta = { fields: {}, boundariesAdd: [], boundariesResolve: [] };
    const skipped = [];
    const skip = (path, reason, evidence = []) => {
        skipped.push({ path, reason, messageIds: [...new Set((Array.isArray(evidence) ? evidence : []).map(e => e?.messageId).filter(Number.isInteger))] });
    };
    const check = (path, action, evidence) => {
        try { action(); return true; } catch (error) {
            skip(path, error.message, evidence);
            return false;
        }
    };
    const unit = () => ({ subject: delta.subject, contextDelta: { fields: {}, boundariesAdd: [], boundariesResolve: [] } });

    for (const group of ['scene', 'character', 'agency', 'relationship']) {
        const container = group + 'Changes';
        const source = input[container];
        if (source == null) continue;
        if (!isObject(source)) { skip(container, '状态分组格式不正确'); continue; }
        for (const key of Object.keys(delta[container])) {
            if (group === 'relationship' && !RELATIONSHIP_FIELDS.has(key)) continue;
            const value = source[key];
            if (value == null) continue;
            const path = group + '.' + key;
            const record = rawContext.fields[path];
            if (key === 'presentCharacters') {
                if (!Array.isArray(value) || !value.every(v => typeof v === 'string')) {
                    skip(path, '在场人物必须是名称数组');
                    continue;
                }
                const candidate = unit();
                candidate[container] = { [key]: value };
                candidate.contextDelta.fields[path] = record;
                if (check(path, () => validateContextDelta(candidate, messages), record?.evidence)) {
                    delta[container][key] = [...value];
                    delta.contextDelta.fields[path] = structuredClone(record);
                }
                continue;
            }
            if (['boundary', 'responseIfBlocked'].includes(key)) {
                if (value !== '') skip(path, '旧版边界字段或预编反应不再接收新内容');
                continue;
            }
            if (record?.basis === 'inferred') { skip(path, '不确定推测，不写入正式状态'); continue; }
            if (typeof value !== 'string') { skip(path, '状态字段必须是字符串或 null'); continue; }
            const candidate = unit();
            candidate[container] = { [key]: value };
            candidate.contextDelta.fields[path] = record;
            if (check(path, () => {
                validateContextDelta(candidate, messages);
                if (group === 'relationship') {
                    if (!hasRelevantUserEvidence(value || previous.relationship[key], record.evidence, messages)) {
                        throw new Error('关系变化缺少与同一关系事实相关的用户确认');
                    }
                }
                const old = previous.context.fields[path];
                if (old?.origin === 'current' && Math.max(...record.evidence.map(e => e.messageId)) <= Math.max(...old.evidence.map(e => e.messageId))) {
                    throw new Error('重复引用旧证据，未提供新的状态变化依据');
                }
            }, record?.evidence)) {
                delta[container][key] = value;
                delta.contextDelta.fields[path] = structuredClone(record);
                if (group === 'relationship') delta.contextDelta.fields[path].confirmedByUser = true;
            }
        }
    }

    const sceneUnknown = skipped.some(s => ['sceneChanges', 'scene.location'].includes(s.path));
    if (sceneUnknown) {
        // A failed move cannot attach new scene-local facts to the old location.
        for (const group of ['scene', 'character', 'agency', 'relationship']) {
            for (const [key, value] of Object.entries(delta[group + 'Changes'])) {
                const path = group + '.' + key;
                if (value == null || RELATIONSHIP_FIELDS.has(key) || (group !== 'scene' && delta.contextDelta.fields[path]?.scope !== 'scene')) continue;
                skip(path, '转场地点未通过核验，依赖该场景的更新一并暂缓');
                delta[group + 'Changes'][key] = null;
                delete delta.contextDelta.fields[path];
            }
        }
    }

    // Revocation + replacement are one transaction: never remove an old limit
    // when its proposed replacement failed validation. Other state can still update.
    const limits = unit();
    limits.contextDelta.boundariesAdd = structuredClone(rawContext.boundariesAdd);
    limits.contextDelta.boundariesResolve = structuredClone(rawContext.boundariesResolve);
    if (hasChange(limits.contextDelta.boundariesAdd) || hasChange(limits.contextDelta.boundariesResolve)) {
        const accepted = check('context.boundaries', () => {
            validateContextDelta(limits, messages);
            if (sceneUnknown && (limits.contextDelta.boundariesAdd.some(b => b.scope === 'scene')
                || limits.contextDelta.boundariesResolve.some(r => previous.context.boundaries.some(b => b.id === r.id && b.scope === 'scene')))) {
                throw new Error('转场地点未通过核验，相关边界变更一并暂缓');
            }
            limits.contextDelta.boundariesResolve = limits.contextDelta.boundariesResolve.filter((r, i, all) => all.findIndex(other => other.id === r.id) === i);
            // Includes existing-ID and capacity checks, with no mutation of previous.
            mergeDelta(previous, limits, messages.map(m => m.id), messages.at(-1)?.id ?? previous.processedThroughMessageId, subject, messages);
        });
        if (accepted) {
            delta.contextDelta.boundariesAdd = limits.contextDelta.boundariesAdd;
            delta.contextDelta.boundariesResolve = limits.contextDelta.boundariesResolve;
        }
    }

    const coreRejected = skipped.length > 0;
    const evidenceIds = new Set(messages.map(m => m.id));
    const validIds = ids => Array.isArray(ids) && ids.length > 0 && ids.every(id => Number.isInteger(Number(id)) && evidenceIds.has(Number(id)));
    // Lists and scores cannot launder a field that failed exact-source review.
    const deferred = new Set();
    for (const group of ['signalChanges', 'offscreenLifeChanges', 'continuityChanges']) {
        if (input[group] == null) continue;
        if (!isObject(input[group]) || (coreRejected && hasChange(input[group]))) {
            skip(group, coreRejected ? '本轮存在未核验状态，无法独立核验的关联概括暂缓' : '更新分组格式不正确');
            deferred.add(group);
        }
    }
    const acceptedEvidenceIds = new Set([
        ...Object.values(delta.contextDelta.fields).flatMap(record => record.evidence?.map(item => item.messageId) ?? []),
        ...delta.contextDelta.boundariesAdd.flatMap(record => record.evidence?.map(item => item.messageId) ?? []),
        ...delta.contextDelta.boundariesResolve.flatMap(record => record.evidence?.map(item => item.messageId) ?? []),
    ].map(Number).filter(Number.isInteger));
    if (!deferred.has('signalChanges')) {
        for (const key of Object.keys(delta.signalChanges)) {
            const value = input.signalChanges?.[key];
            if (value == null) continue;
            if (isObject(value) && Number.isInteger(Number(value.value)) && Number(value.value) >= 0 && Number(value.value) <= 10
                && ['low', 'medium', 'high'].includes(value.confidence) && typeof value.reason === 'string' && value.reason.trim()
                && validIds(value.evidenceMessageIds) && value.evidenceMessageIds.some(id => acceptedEvidenceIds.has(Number(id)))) {
                delta.signalChanges[key] = structuredClone(value);
            } else skip('signalChanges.' + key, '信号格式无效，或同轮没有通过逐字核验的相关状态');
        }
    }
    for (const [group, add, remove, stateGroup, stateKey] of LISTS) {
        if (deferred.has(group)) continue;
        const source = group ? input[group] : input;
        const rawSource = group ? originalInput[group] : originalInput;
        const target = group ? delta[group] : delta;
        if (!source) continue;
        if (coreRejected) {
            if (hasChange(source[add]) || hasChange(source[remove])) skip(add, '本轮存在未核验状态，长期记忆晋升暂缓');
            continue;
        }
        let additionRejected = false;
        if (source[add] != null) {
            if (!Array.isArray(source[add])) { skip(add, '新增记忆必须是数组'); additionRejected = true; } else source[add].forEach((item, index) => {
                if (check(`${add}[${index}]`, () => target[add].push(validatedDurableAddition(item, messages)), item?.evidence)) return;
                additionRejected = true;
            });
        }
        if (!hasChange(source[remove])) continue;
        if (additionRejected || !Array.isArray(rawSource?.[remove])) {
            skip(remove, '记忆替换未完整通过核验，保留原记录');
            continue;
        }
        const known = new Map((stateGroup ? previous[stateGroup][stateKey] : previous[stateKey]).map(item => [String(item.id), item]));
        for (const [index, item] of rawSource[remove].entries()) {
            const id = String(item?.id ?? '').trim();
            const oldItem = known.get(id);
            if (!oldItem) { skip(`${remove}[${index}]`, '待关闭的记忆编号不存在', item?.evidence); continue; }
            check(`${remove}[${index}]`, () => target[remove].push(validatedRemoval(item, oldItem, messages)), item?.evidence);
        }
    }

    validateContextDelta(delta, messages);
    const through = messages.at(-1)?.id ?? previous.processedThroughMessageId;
    const hasAcceptedChanges = Object.entries(delta).some(([key, value]) => key !== 'subject' && hasChange(value));
    const result = hasAcceptedChanges
        ? mergeDelta(previous, delta, messages.map(m => m.id), through, subject, messages)
        : { state: { ...previous, processedThroughMessageId: through }, changed: false };
    delta._validation = {
        status: skipped.length ? (result.changed ? 'partial' : 'skipped') : (result.changed ? 'updated' : 'unchanged'),
        skipped,
        throughMessageId: through,
    };
    return { ...result, delta };
}

export function formatUpdateDiagnostics(report) {
    if (!report?.skipped?.length) return '';
    const heading = report.status === 'partial' ? '已保存通过核验的更新' : '本轮未采纳新状态，保留上一版本';
    return `${heading}；跳过 ${report.skipped.length} 项：\n` + report.skipped.map(item => {
        const reason = item.reason === 'State quotation does not match new accepted dialogue.'
            ? '引文或消息编号与本次新正文不匹配' : item.reason.startsWith('Missing state evidence/scope:')
                ? '缺少有效来源或适用范围' : item.reason;
        return `• ${item.path}：${reason}`;
    }).join('\n');
}

export function getUpdateWarning(report) {
    if (!report?.skipped?.length) return null;
    return {
        state: 'warning',
        label: report.status === 'partial' ? `部分更新 · ${report.skipped.length} 项未采纳，详见更新详情` : '本轮未采纳新状态 · 保留上一版本，详见更新详情',
        shortLabel: report.status === 'partial' ? '状态部分更新' : '本轮状态已跳过',
    };
}

export function getUnprocessedReply(chat, processedThrough = -1) {
    if (!Array.isArray(chat)) return -1;
    for (let index = chat.length - 1; index >= 0; index--) {
        const message = chat[index];
        if (!message || message.is_user || message.is_system || !String(message.mes ?? '').trim()) continue;
        return index > processedThrough ? index : -1;
    }
    return -1;
}
