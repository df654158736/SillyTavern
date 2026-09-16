// Opt-in sequential live probe for a Story Controller package. It selects
// enough complete journeys through the real Flash Director to cover every
// authored edge. It never writes chat state or prints model prose, package
// secrets, API URLs, or credentials.
import assert from 'node:assert/strict';
import fs from 'node:fs';

import YAML from 'yaml';

import {
    buildDirectorRequest,
    buildDirectorSystemPrompt,
    runReviewedDirector,
} from '../public/scripts/extensions/third-party/story-controller/director.js';
import {
    getStage,
    validateStoryPackage,
} from '../public/scripts/extensions/third-party/story-controller/package.js';
import {
    assertSafeMainModelView,
    renderMainModelView,
} from '../public/scripts/extensions/third-party/story-controller/prompt.js';
import {
    applyDirectorDecision,
    createRuntime,
} from '../public/scripts/extensions/third-party/story-controller/state.js';

if (!process.argv.includes('--live')) {
    console.log('Run from the repository root with: node tests/story-controller-full-flow.live.mjs --live [--story=path] [--cases=path] [--detour-stage=ID] [--pause-stage=ID]');
    process.exit(0);
}

const argumentValue = (name, fallback) => process.argv.find(argument => argument.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
const storyPath = argumentValue('story', 'public/scripts/extensions/third-party/story-controller/packages/xiaoya-s4-unfinished-coda.story.json');
const casesPath = argumentValue('cases', storyPath.replace(/\.story\.json$/, '.cases.json'));
const detourStageId = argumentValue('detour-stage', 'STAGE_BOX_CLOSED');
const pauseStageId = argumentValue('pause-stage', 'STAGE_AFTER_PLAYBACK');
const story = JSON.parse(fs.readFileSync(storyPath, 'utf8'));
const probeCases = JSON.parse(fs.readFileSync(casesPath, 'utf8')).cases;
assert.deepEqual(validateStoryPackage(story), { valid: true, errors: [], warnings: [] });

function enumeratePaths(stageId = story.entryStageId, pathSoFar = []) {
    const stage = getStage(story, stageId);
    if (stage.terminal) return [pathSoFar];
    return stage.transitions.flatMap(transition => enumeratePaths(
        transition.toStageId,
        [...pathSoFar, transition],
    ));
}

function selectEdgeCoveringJourneys(paths) {
    const uncovered = new Set(story.stages.flatMap(stage => stage.transitions.map(transition => transition.id)));
    const selected = [];
    while (uncovered.size) {
        const candidate = paths
            .filter(path => !selected.includes(path))
            .map(path => ({ path, gain: path.filter(transition => uncovered.has(transition.id)).length }))
            .sort((left, right) => right.gain - left.gain)[0];
        assert.ok(candidate?.gain, `Unable to cover transitions: ${[...uncovered].join(', ')}`);
        selected.push(candidate.path);
        candidate.path.forEach(transition => uncovered.delete(transition.id));
    }
    return selected;
}

function advancingCase(stageId, transitionId) {
    const probe = probeCases.find(item => item.stageId === stageId && item.expected?.transitionId === transitionId);
    assert.ok(probe, `Missing advancing case for ${transitionId}.`);
    return probe;
}

function remapMessages(messages, firstMessageId) {
    return messages.map((message, index) => ({ ...message, id: firstMessageId + index }));
}

const config = YAML.parse(fs.readFileSync('config.yaml', 'utf8'));
const settings = JSON.parse(fs.readFileSync('data/default-user/settings.json', 'utf8'));
const extensions = settings.extension_settings ?? {};
const profiles = extensions.connectionManager?.profiles ?? [];
const preferredProfileId = extensions.storyController?.directorProfile || extensions.livingStateHarness?.updaterProfile;
const profile = profiles.find(item => item.id === preferredProfileId && /flash/i.test(String(item.model ?? '')))
    ?? profiles.find(item => /flash/i.test(String(item.model ?? '')));
assert.ok(profile, 'No Flash connection profile is available.');
assert.equal(profile.api, 'custom', 'This live probe currently requires an OpenAI-compatible custom Flash profile.');

const headers = { 'Content-Type': 'application/json' };
if (config.basicAuthMode) {
    headers.Authorization = `Basic ${Buffer.from(`${config.basicAuthUser.username}:${config.basicAuthUser.password}`).toString('base64')}`;
}
const csrf = await fetch('http://127.0.0.1:8000/csrf-token', { headers });
assert.equal(csrf.status, 200, 'Local server authentication failed.');
headers.Cookie = csrf.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
headers['X-CSRF-Token'] = (await csrf.json()).token;

let totalTokens = 0;
let totalCalls = 0;
let totalAttempts = 0;

async function requestDirector(runtime, messages, referenceMessages = []) {
    const reviewed = await runReviewedDirector(async correction => {
        const response = await fetch('http://127.0.0.1:8000/api/backends/chat-completions/generate', {
            method: 'POST',
            headers,
            signal: AbortSignal.timeout(180000),
            body: JSON.stringify({
                chat_completion_source: 'custom',
                model: profile.model,
                custom_url: profile['api-url'],
                secret_id: profile['secret-id'],
                stream: false,
                max_tokens: 2048,
                custom_include_body: JSON.stringify({
                    thinking: { type: 'disabled' },
                    response_format: { type: 'json_object' },
                    temperature: 0,
                }),
                messages: [
                    { role: 'system', content: buildDirectorSystemPrompt() },
                    { role: 'user', content: buildDirectorRequest(story, runtime, messages, correction, referenceMessages) },
                ],
            }),
        });
        if (!response.ok) throw new Error(`Director request HTTP ${response.status}`);
        const body = await response.json();
        totalTokens += Number(body.usage?.total_tokens ?? 0);
        return String(body.choices?.[0]?.message?.content ?? '');
    }, story, runtime, messages);
    totalCalls += 1;
    totalAttempts += reviewed.attempts;
    return reviewed;
}

function assertExpectedDecision(reviewed, expected, label) {
    assert.deepEqual([...reviewed.decision.observedEventIds].sort(), [...expected.eventIds].sort(), `${label}: wrong events`);
    assert.equal(reviewed.decision.transitionId, expected.transitionId, `${label}: wrong transition`);
    assert.deepEqual([...reviewed.decision.violationIds].sort(), [...expected.violationIds].sort(), `${label}: wrong violations`);
    if (expected.interactionMode) {
        assert.equal(reviewed.decision.interactionMode, expected.interactionMode, `${label}: wrong interaction mode`);
    }
}

async function runJourney(route, journeyNumber) {
    let runtime = createRuntime(story);
    let nextMessageId = 0;
    const history = [];
    const started = Date.now();

    for (const transition of route) {
        const stageId = runtime.currentStageId;
        const prompt = renderMainModelView(story, runtime);
        assert.equal(assertSafeMainModelView(story, runtime, prompt), prompt);

        if (journeyNumber === 1 && stageId === detourStageId) {
            const progressBeforeDetour = [...runtime.confirmedEventIds];
            const firstDetour = [{ id: nextMessageId++, role: 'user', content: '我现在脑子有点累，我们先去厨房煮面，吃完再说。' }];
            const firstResult = await requestDirector(runtime, firstDetour, history.slice(-8));
            assertExpectedDecision(firstResult, {
                eventIds: [], transitionId: null, interactionMode: 'follow_user_detour', violationIds: [],
            }, `journey ${journeyNumber} first detour`);
            runtime = applyDirectorDecision(runtime, story, firstResult.decision, firstDetour.at(-1).id).runtime;
            history.push(...firstDetour);
            console.log(JSON.stringify({ journey: journeyNumber, checkpoint: 'first-detour', passed: true }));

            const continuedDetour = [{ id: nextMessageId++, role: 'user', content: '面里多放点青菜吧，冰箱里的鸡蛋也一起用掉。' }];
            const reentryResult = await requestDirector(runtime, continuedDetour, history.slice(-8));
            assertExpectedDecision(reentryResult, {
                eventIds: [], transitionId: null, interactionMode: 'reenter_story', violationIds: [],
            }, `journey ${journeyNumber} reentry`);
            runtime = applyDirectorDecision(runtime, story, reentryResult.decision, continuedDetour.at(-1).id).runtime;
            assert.deepEqual(runtime.confirmedEventIds, progressBeforeDetour, `journey ${journeyNumber}: reentry created progress`);
            history.push(...continuedDetour);
            console.log(JSON.stringify({ journey: journeyNumber, checkpoint: 'bounded-reentry', passed: true }));
        }

        if (journeyNumber === 2 && stageId === pauseStageId) {
            const pauseMessages = [{ id: nextMessageId++, role: 'user', content: '我现在有点难受，先抱我一会儿，暂时不要继续。' }];
            const pauseResult = await requestDirector(runtime, pauseMessages, history.slice(-8));
            assertExpectedDecision(pauseResult, {
                eventIds: [], transitionId: null, interactionMode: 'emotional_pause', violationIds: [],
            }, `journey ${journeyNumber} pause`);
            runtime = applyDirectorDecision(runtime, story, pauseResult.decision, pauseMessages.at(-1).id).runtime;
            history.push(...pauseMessages);
            console.log(JSON.stringify({ journey: journeyNumber, checkpoint: 'explicit-pause', passed: true }));
        }

        const probe = advancingCase(stageId, transition.id);
        const messages = remapMessages(probe.messages, nextMessageId);
        nextMessageId += messages.length;
        const reviewed = await requestDirector(runtime, messages, history.slice(-8));
        assertExpectedDecision(reviewed, probe.expected, `journey ${journeyNumber} ${transition.id}`);
        const applied = applyDirectorDecision(runtime, story, reviewed.decision, messages.at(-1).id);
        assert.equal(applied.transitioned, true, `journey ${journeyNumber} ${transition.id}: did not transition`);
        assert.equal(applied.runtime.currentStageId, transition.toStageId, `journey ${journeyNumber} ${transition.id}: wrong stage`);
        runtime = applied.runtime;
        history.push(...messages);
        console.log(JSON.stringify({
            journey: journeyNumber,
            edge: transition.id,
            passed: true,
            attempts: reviewed.attempts,
        }));
    }

    assert.equal(getStage(story, runtime.currentStageId).terminal, true, `journey ${journeyNumber}: not terminal`);
    assert.equal(runtime.status, 'completed', `journey ${journeyNumber}: runtime not completed`);
    assertSafeMainModelView(story, runtime, renderMainModelView(story, runtime));
    console.log(JSON.stringify({
        journey: journeyNumber,
        completed: true,
        edges: route.length,
        elapsedSeconds: Math.round((Date.now() - started) / 1000),
    }));
}

const allPaths = enumeratePaths();
assert.ok(allPaths.length > 0, 'Story has no complete route.');
const selectedJourneys = selectEdgeCoveringJourneys(allPaths);
assert.ok(selectedJourneys.length > 0, 'No edge-covering journey was selected.');

const results = await Promise.allSettled(selectedJourneys.map((route, index) => runJourney(route, index + 1)));
const failures = results
    .map((result, index) => result.status === 'rejected' ? { journey: index + 1, error: result.reason?.message ?? String(result.reason) } : null)
    .filter(Boolean);

console.log(JSON.stringify({
    allPassed: failures.length === 0,
    journeys: selectedJourneys.length,
    authoredPaths: allPaths.length,
    coveredEdges: new Set(selectedJourneys.flatMap(route => route.map(transition => transition.id))).size,
    totalCalls,
    totalAttempts,
    model: profile.model,
    totalReportedTokens: totalTokens,
    failures,
}));
if (failures.length) process.exitCode = 1;
