import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

import {
    DIRECTOR_INTERACTION_MODES,
    validateStoryPackage,
} from '../public/scripts/extensions/third-party/story-controller/package.js';

const CASE_CATEGORIES = new Set([
    'positive',
    'insufficient-evidence',
    'quoted-or-hypothetical',
    'skip-request',
    'emotional-pause',
    'topic-detour',
    'prompt-injection',
    'premature-reveal',
    'branch',
    'recovery',
]);

function fail(message) {
    console.error(`ERROR ${message}`);
    process.exitCode = 1;
}

function loadJson(filePath) {
    try {
        return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (error) {
        fail(`${filePath}: ${error instanceof Error ? error.message : String(error)}`);
        return null;
    }
}

const [storyArgument, casesArgument] = process.argv.slice(2);
if (!storyArgument || !casesArgument) {
    console.error('Usage: node scripts/validate-story-controller-package.mjs <story.json> <cases.json>');
    process.exit(2);
}

const storyPath = path.resolve(storyArgument);
const casesPath = path.resolve(casesArgument);
const story = loadJson(storyPath);
const casePackage = loadJson(casesPath);
if (!story || !casePackage) process.exit(process.exitCode || 1);

const validation = validateStoryPackage(story);
for (const error of validation.errors) fail(`${storyPath} ${error}`);
for (const warning of validation.warnings) console.warn(`WARNING ${storyPath} ${warning}`);

if (casePackage.schemaVersion !== 1) fail(`${casesPath} $.schemaVersion: must equal 1`);
if (casePackage.storyId !== story.storyId) fail(`${casesPath} $.storyId: must match ${story.storyId}`);
if (!Array.isArray(casePackage.cases) || !casePackage.cases.length) fail(`${casesPath} $.cases: must be a non-empty array`);

const stageMap = new Map(story.stages.map(stage => [stage.id, stage]));
const eventMap = new Map(story.events.map(event => [event.id, event]));
const transitionMap = new Map(story.stages.flatMap(stage => stage.transitions.map(transition => [transition.id, { stage, transition }])));
const coveredTransitions = new Set();
const coveredCategories = new Set();

for (const [index, probe] of (casePackage.cases ?? []).entries()) {
    const casePath = `${casesPath} $.cases[${index}]`;
    if (!probe || typeof probe !== 'object' || Array.isArray(probe)) {
        fail(`${casePath}: must be an object`);
        continue;
    }
    if (typeof probe.name !== 'string' || !probe.name.trim()) fail(`${casePath}.name: must be a non-empty string`);
    if (!CASE_CATEGORIES.has(probe.category)) fail(`${casePath}.category: unsupported category ${JSON.stringify(probe.category)}`);
    else coveredCategories.add(probe.category);
    const stage = stageMap.get(probe.stageId);
    if (!stage) {
        fail(`${casePath}.stageId: unknown stage ${JSON.stringify(probe.stageId)}`);
        continue;
    }
    if (!Array.isArray(probe.messages) || !probe.messages.length) fail(`${casePath}.messages: must be a non-empty array`);
    const expected = probe.expected;
    if (!expected || typeof expected !== 'object' || Array.isArray(expected)) {
        fail(`${casePath}.expected: must be an object`);
        continue;
    }
    if (!Array.isArray(expected.eventIds)) fail(`${casePath}.expected.eventIds: must be an array`);
    for (const eventId of expected.eventIds ?? []) {
        if (!eventMap.has(eventId)) fail(`${casePath}.expected.eventIds: unknown event ${eventId}`);
        if (!stage.allowedEventIds.includes(eventId)) fail(`${casePath}.expected.eventIds: ${eventId} is not allowed by ${stage.id}`);
    }
    for (const eventId of probe.confirmedEventIds ?? []) {
        if (!eventMap.has(eventId)) fail(`${casePath}.confirmedEventIds: unknown event ${eventId}`);
    }
    if (expected.interactionMode !== undefined && !DIRECTOR_INTERACTION_MODES.includes(expected.interactionMode)) {
        fail(`${casePath}.expected.interactionMode: unsupported mode ${JSON.stringify(expected.interactionMode)}`);
    }
    if (!Array.isArray(expected.violationIds)) fail(`${casePath}.expected.violationIds: must be an array`);
    if (expected.transitionId !== null) {
        const entry = transitionMap.get(expected.transitionId);
        if (!entry) {
            fail(`${casePath}.expected.transitionId: unknown transition ${JSON.stringify(expected.transitionId)}`);
            continue;
        }
        if (entry.stage.id !== stage.id) fail(`${casePath}.expected.transitionId: transition does not leave ${stage.id}`);
        const available = new Set([...(probe.confirmedEventIds ?? []), ...(expected.eventIds ?? [])]);
        if (!entry.transition.requiresAllEventIds.every(eventId => available.has(eventId))) {
            fail(`${casePath}.expected.transitionId: missing required all-event evidence`);
        }
        if (entry.transition.requiresAnyEventIds.length && !entry.transition.requiresAnyEventIds.some(eventId => available.has(eventId))) {
            fail(`${casePath}.expected.transitionId: missing required any-event evidence`);
        }
        coveredTransitions.add(expected.transitionId);
    }
}

for (const transitionId of transitionMap.keys()) {
    if (!coveredTransitions.has(transitionId)) fail(`${casesPath}: transition ${transitionId} has no advancing probe case`);
}
for (const category of ['positive', 'insufficient-evidence', 'quoted-or-hypothetical', 'skip-request']) {
    if (!coveredCategories.has(category)) fail(`${casesPath}: required category ${category} is not covered`);
}

if (process.exitCode) {
    console.error(`FAIL ${storyPath} + ${casesPath}`);
} else {
    console.log(`PASS ${storyPath} + ${casesPath} (schema v${story.schemaVersion}, ${story.stages.length} stages, ${story.events.length} OM, ${transitionMap.size} transitions, ${casePackage.cases.length} cases, ${validation.warnings.length} warnings)`);
}
