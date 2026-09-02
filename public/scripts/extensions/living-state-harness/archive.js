import { SNAPSHOT_KEY, normalizeState, sanitizeEvidenceText, saveStateSnapshot } from './state.js';

export const ARCHIVE_METADATA_KEY = 'living_state_harness_archive';
export const ARCHIVE_RUNTIME_METADATA_KEY = 'living_state_harness_archive_runtime';
export const ARCHIVE_PROMPT_KEY = 'living_state_harness_archive';
export const ARCHIVE_SCHEMA_VERSION = 1;

const DEFAULT_KEEP_RECENT = 20;
const DEFAULT_CHUNK_CHARACTERS = 28000;

export function createEmptyArchive(subject = {}) {
    return {
        schemaVersion: ARCHIVE_SCHEMA_VERSION,
        subject: {
            characterName: String(subject.name ?? '').trim(),
            counterpartName: String(subject.counterpartName ?? '').trim(),
        },
        overview: '',
        chronology: [],
        relationshipHistory: [],
        durableFacts: [],
        commitments: [],
        openThreads: [],
        importantPeoplePlacesItems: [],
        meaningfulQuotes: [],
    };
}

export function normalizeArchive(input, subject = {}) {
    const source = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
    const empty = createEmptyArchive(subject);
    return {
        ...empty,
        overview: cleanText(source.overview, 4000),
        chronology: cleanBalancedList(source.chronology, 80, 12),
        relationshipHistory: cleanBalancedList(source.relationshipHistory, 40, 8),
        durableFacts: cleanBalancedList(source.durableFacts, 60, 12),
        commitments: cleanRecentList(source.commitments, 40),
        openThreads: cleanRecentList(source.openThreads, 40),
        importantPeoplePlacesItems: cleanBalancedList(source.importantPeoplePlacesItems, 50, 10),
        meaningfulQuotes: cleanBalancedList(source.meaningfulQuotes, 30, 6),
    };
}

export function parseRepairableJsonObject(value) {
    const text = String(value ?? '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start === -1 || end < start) throw new SyntaxError('Archive updater did not return a JSON object.');
    const json = text.slice(start, end + 1);
    try {
        return JSON.parse(json);
    } catch (originalError) {
        try {
            return JSON.parse(repairCommonJsonDamage(json));
        } catch {
            throw originalError;
        }
    }
}

function repairCommonJsonDamage(value) {
    let result = escapeLiteralNewlinesInsideStrings(value);
    result = result.replace(/("(?:\\.|[^"\\])*"|true|false|null|-?\d+(?:\.\d+)?|\]|\})\s*(\r?\n\s*"[^"\r\n]+"\s*:)/g, '$1,$2');
    return result.replace(/,\s*([}\]])/g, '$1');
}

function escapeLiteralNewlinesInsideStrings(value) {
    let result = '';
    let inString = false;
    let escaped = false;
    for (const character of value) {
        if (inString && (character === '\n' || character === '\r')) {
            result += character === '\n' ? '\\n' : '\\r';
            escaped = false;
            continue;
        }
        result += character;
        if (escaped) {
            escaped = false;
        } else if (character === '\\' && inString) {
            escaped = true;
        } else if (character === '"') {
            inString = !inString;
        }
    }
    return result;
}

function cleanText(value, maximum) {
    return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, maximum);
}

function cleanList(value, maximumItems) {
    const seen = new Set();
    const result = [];
    for (const item of Array.isArray(value) ? value : []) {
        const text = cleanText(typeof item === 'string' ? item : item?.text, 500);
        if (!text || seen.has(text)) continue;
        seen.add(text);
        result.push(text);
        if (result.length >= maximumItems) break;
    }
    return result;
}

function cleanRecentList(value, maximumItems) {
    const items = cleanList(value, Number.POSITIVE_INFINITY);
    return items.slice(-maximumItems);
}

function cleanBalancedList(value, maximumItems, foundationalItems) {
    const items = cleanList(value, Number.POSITIVE_INFINITY);
    if (items.length <= maximumItems) return items;
    const first = items.slice(0, foundationalItems);
    const recent = items.slice(-(maximumItems - foundationalItems));
    return cleanList([...first, ...recent], maximumItems);
}

export function splitHistoryForArchive(messages, keepRecent = DEFAULT_KEEP_RECENT, chunkCharacters = DEFAULT_CHUNK_CHARACTERS) {
    const safeKeep = Math.max(4, Math.min(50, Math.floor(Number(keepRecent) || DEFAULT_KEEP_RECENT)));
    const boundary = Math.max(0, messages.length - safeKeep);
    const archived = messages.slice(0, boundary);
    const recent = messages.slice(boundary);
    const chunks = [];
    let chunk = [];
    let length = 0;
    for (let index = 0; index < archived.length; index++) {
        const message = archived[index];
        const entry = {
            id: index,
            role: message.is_user ? 'user' : 'assistant',
            name: String(message.name ?? ''),
            content: sanitizeEvidenceText(message.mes),
        };
        const entryLength = entry.content.length + 100;
        if (chunk.length && length + entryLength > chunkCharacters) {
            chunks.push(chunk);
            chunk = [];
            length = 0;
        }
        chunk.push(entry);
        length += entryLength;
    }
    if (chunk.length) chunks.push(chunk);
    return { archived, recent, chunks, boundary, keepRecent: recent.length };
}

export function buildArchiveUpdatePayload(previousArchive, messages, subject) {
    return {
        task: 'Update the durable historical memory from the next chronological block of accepted chat messages.',
        targetSubject: subject,
        previousArchive: normalizeArchive(previousArchive, subject),
        newMessages: messages,
        rules: [
            'Preserve causality, relationship evolution, promises, unresolved clues, revealed secrets, and durable consequences.',
            'Do not store current mood, clothing, posture, location, or a short-term plan unless it has lasting narrative consequences.',
            'When a later event completes, cancels, or contradicts an older item, update or remove the older item.',
            'Keep the archive bounded: merge adjacent low-impact older events into concise phase summaries before adding recent events. Preserve foundational causes and the newest consequences.',
            'chronology must have at most 80 entries, relationshipHistory 40, durableFacts 60, commitments 40, openThreads 40, importantPeoplePlacesItems 50, and meaningfulQuotes 30.',
            'commitments and openThreads contain only items that remain active; completed items belong in chronology only when they have lasting consequences.',
            'Prefix every factual list item with its strongest source message id in the form [消息 N].',
            'Do not infer the user private thoughts or intentions.',
            'Return the complete updated archive, not a delta.',
        ],
    };
}

export function formatArchiveForPrompt(input, subject = {}) {
    const archive = normalizeArchive(input, subject);
    const sections = [
        ['总体脉络', archive.overview ? [archive.overview] : []],
        ['关系演变及原因', archive.relationshipHistory],
        ['仍有效的承诺与约定', archive.commitments],
        ['尚未解决的线索', archive.openThreads],
        ['已确认且持续有效的事实', archive.durableFacts],
        ['重要人物、地点与物品', archive.importantPeoplePlacesItems],
        ['时间线与长期影响', archive.chronology],
        ['具有持续意义的原话', archive.meaningfulQuotes],
    ];
    const lines = [
        `[Archived continuity memory for "${archive.subject.characterName}" and "${archive.subject.counterpartName}" — accepted past story facts, not current state.]`,
        'Use this only to remember established history and causes. Current scene, mood, relationship stance, goals, and plans come from the Living State and recent raw messages. Never quote or enumerate this memory unless naturally relevant.',
    ];
    for (const [title, items] of sections) {
        if (!items.length) continue;
        lines.push(`\n${title}:`, ...items.map(item => `- ${item}`));
    }
    return lines.join('\n').slice(0, 30000);
}

export function createContinuationChat(recentMessages, state, subject) {
    const continuation = recentMessages.map(message => {
        const clone = structuredClone(message);
        if (clone.extra) {
            delete clone.extra[SNAPSHOT_KEY];
            delete clone.extra.living_state_harness_calibration_backup;
        }
        return clone;
    });
    if (!continuation.length) return continuation;
    const anchor = continuation.length - 1;
    const continuedState = normalizeState(state, subject);
    continuedState.processedThroughMessageId = anchor;
    saveStateSnapshot(continuation[anchor], anchor, continuedState, {
        kind: 'archive-continuation',
        changed: false,
        delta: { source: 'archived-chat' },
    });
    return continuation;
}
