// Opt-in live observation probe for the bundled S4 package. Uses the configured
// Story Controller Flash profile (falling back to the Harness profile), does
// not read or write any chat, and never prints
// hidden package text or model prose.
import fs from 'node:fs';
import assert from 'node:assert/strict';
import YAML from 'yaml';
import {
    buildDirectorRequest,
    buildDirectorSystemPrompt,
    runReviewedDirector,
} from '../public/scripts/extensions/third-party/story-controller/director.js';
import { validateStoryPackage } from '../public/scripts/extensions/third-party/story-controller/package.js';
import { createRuntime } from '../public/scripts/extensions/third-party/story-controller/state.js';

if (!process.argv.includes('--live')) {
    console.log('Run from the repository root with: node tests/story-controller-s4.live.mjs --live');
    process.exit(0);
}

const storyPath = 'public/scripts/extensions/third-party/story-controller/packages/xiaoya-s4-unfinished-coda.story.json';
const casesPath = 'public/scripts/extensions/third-party/story-controller/packages/xiaoya-s4-unfinished-coda.cases.json';
const story = JSON.parse(fs.readFileSync(storyPath, 'utf8'));
const cases = [
    ...JSON.parse(fs.readFileSync(casesPath, 'utf8')).cases,
    {
        name: '情绪暂停后沿已确认里程碑恢复推进',
        stageId: 'STAGE_AFTER_PLAYBACK',
        confirmedEventIds: ['OM_PLAYBACK_REACTION_SHARED'],
        messages: [{ id: 360, role: 'user', content: '我现在准备好继续面对了，我们一起看下一步能确认什么。' }],
        expected: {
            eventIds: [],
            transitionId: 'TRANSITION_REACTION_TO_AUDIO_READY',
            interactionMode: 'invite_user_check',
            violationIds: [],
        },
    },
];
const filter = process.argv.find(value => value.startsWith('--filter='))?.slice('--filter='.length);
const selectedCases = filter ? cases.filter(item => item.name.includes(filter)) : cases;
assert.ok(selectedCases.length > 0, `No live cases matched filter ${JSON.stringify(filter)}.`);
assert.equal(validateStoryPackage(story).valid, true, 'Bundled S4 package must pass the production validator.');

const config = YAML.parse(fs.readFileSync('config.yaml', 'utf8'));
const settings = JSON.parse(fs.readFileSync('data/default-user/settings.json', 'utf8'));
const extension = settings.extension_settings ?? {};
const profiles = extension.connectionManager?.profiles ?? [];
const preferredProfileId = extension.storyController?.directorProfile || extension.livingStateHarness?.updaterProfile;
const profile = profiles.find(item => item.id === preferredProfileId && /flash/i.test(String(item.model ?? '')))
    ?? profiles.find(item => /flash/i.test(String(item.model ?? '')));
assert.ok(profile, 'No Flash connection profile is available.');
assert.equal(profile.api, 'custom', 'This live check requires an OpenAI-compatible custom Flash profile.');

const headers = { 'Content-Type': 'application/json' };
if (config.basicAuthMode) headers.Authorization = `Basic ${Buffer.from(`${config.basicAuthUser.username}:${config.basicAuthUser.password}`).toString('base64')}`;
const csrf = await fetch('http://127.0.0.1:8000/csrf-token', { headers });
assert.equal(csrf.status, 200, 'Local server authentication failed.');
headers.Cookie = csrf.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
headers['X-CSRF-Token'] = (await csrf.json()).token;

let totalTokens = 0;
let totalAttempts = 0;
const failures = [];
for (const item of selectedCases) {
    const runtime = createRuntime(story);
    runtime.currentStageId = item.stageId;
    runtime.visitedStageIds = item.stageId === story.entryStageId ? [story.entryStageId] : [story.entryStageId, item.stageId];
    runtime.confirmedEventIds = [...(item.confirmedEventIds ?? [])];
    const started = Date.now();
    try {
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
                    custom_include_body: JSON.stringify({ thinking: { type: 'disabled' }, response_format: { type: 'json_object' }, temperature: 0 }),
                    messages: [
                        { role: 'system', content: buildDirectorSystemPrompt() },
                        { role: 'user', content: buildDirectorRequest(story, runtime, item.messages, correction) },
                    ],
                }),
            });
            if (!response.ok) throw new Error(`Director request HTTP ${response.status}`);
            const body = await response.json();
            totalTokens += Number(body.usage?.total_tokens ?? 0);
            return String(body.choices?.[0]?.message?.content ?? '');
        }, story, runtime, item.messages);
        totalAttempts += reviewed.attempts;
        assert.deepEqual([...reviewed.decision.observedEventIds].sort(), [...item.expected.eventIds].sort(), 'wrong events');
        assert.equal(reviewed.decision.transitionId, item.expected.transitionId, 'wrong transition');
        assert.deepEqual([...reviewed.decision.violationIds].sort(), [...item.expected.violationIds].sort(), 'wrong violations');
        if (item.expected.interactionMode) assert.equal(reviewed.decision.interactionMode, item.expected.interactionMode, 'wrong interaction mode');
        console.log(JSON.stringify({ case: item.name, passed: true, attempts: reviewed.attempts, elapsedSeconds: Math.round((Date.now() - started) / 1000) }));
    } catch (error) {
        failures.push({ case: item.name, error: error.message });
        console.log(JSON.stringify({ case: item.name, passed: false, error: error.message, elapsedSeconds: Math.round((Date.now() - started) / 1000) }));
    }
}

console.log(JSON.stringify({
    allPassed: failures.length === 0,
    passed: selectedCases.length - failures.length,
    cases: selectedCases.length,
    totalAttempts,
    model: profile.model,
    totalReportedTokens: totalTokens,
    failures,
}));
if (failures.length) process.exitCode = 1;
