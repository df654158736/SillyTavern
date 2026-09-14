// Opt-in smoke test; uses the configured updater through the local server.
// No chat/config writes. No credentials or full responses are printed.
import fs from 'node:fs';
import assert from 'node:assert/strict';
import YAML from 'yaml';
import { createEmptyDelta, createEmptyState, mergeDelta, normalizeDeltaReferences, formatStateForPrompt } from '../public/scripts/extensions/living-state-harness/state.js';
import { buildContextUpdaterInstructions, buildReferenceContext, formatContextRequest, prepareStateForUpdater, validateContextDelta } from '../public/scripts/extensions/living-state-harness/context.js';

if (!process.argv.includes('--live')) {
    console.log('Run from the repository root with: node tests/living-state-context.live.mjs --live');
    process.exit(0);
}
const config = YAML.parse(fs.readFileSync('config.yaml', 'utf8'));
const settings = JSON.parse(fs.readFileSync('data/default-user/settings.json', 'utf8'));
const extension = settings.extension_settings;
const profile = extension.connectionManager.profiles.find(p => p.id === extension.livingStateHarness.updaterProfile);
assert.equal(profile?.api, 'custom', 'This opt-in test supports a configured custom updater profile.');
const headers = { 'Content-Type': 'application/json' };
if (config.basicAuthMode) headers.Authorization = 'Basic ' + Buffer.from(config.basicAuthUser.username + ':' + config.basicAuthUser.password).toString('base64');
const csrf = await fetch('http://127.0.0.1:8000/csrf-token', { headers });
assert.equal(csrf.status, 200, 'Local server authentication failed.');
headers.Cookie = csrf.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
headers['X-CSRF-Token'] = (await csrf.json()).token;
const subject = { role: 'character', name: '林夏', counterpartName: '陈明' };
let state = createEmptyState(subject);
const history = [];
let usage = 0;
const cases = [
    {
        name: 'ordinary suggestion',
        dialogue: ['我们在公园逛累了，要不先吃午饭？', '我有点饿了，去吃饭吧。我想喝常温水，你呢？'],
        check: result => assert.equal(result.context.boundaries.length, 0, 'Ordinary preference became a boundary.'),
    },
    {
        name: 'explicit photo privacy',
        dialogue: ['我把刚才拍的照片放到公开相册吧？', '这张照片我不想公开，只留给我们自己看。'],
        check: result => assert.ok(result.context.boundaries.some(b => b.kind === 'privacy'), 'Missing explicit photo privacy.'),
    },
    {
        name: 'compliance and topic change',
        dialogue: ['好，不公开。我们现在进餐厅吧，你喜欢面条还是米饭？', '她和陈明走进餐厅。面条吧，我挺喜欢这里的汤面。'],
        check: result => assert.ok(result.context.boundaries.some(b => b.kind === 'privacy'), 'Compliance incorrectly revoked privacy.'),
    },
    {
        name: 'ordinary present refusal',
        dialogue: ['边吃边聊聊昨天那件让你难过的事好吗？', '我现在不想谈那件事，想安静吃完这顿饭。'],
        check: result => {
            assert.ok(result.context.boundaries.some(b => b.kind === 'refusal'), 'Missing present refusal.');
            assert.ok(result.context.boundaries.some(b => b.kind === 'privacy'), 'Unrelated privacy was lost.');
            assert.ok(formatStateForPrompt(result, subject, {}, [{ id: 8, role: 'user', content: '我想把那张照片发到相册。' }]).includes('Explicit limit:'), 'Relevant limits were not projected.');
        },
    },
    {
        name: 'five-turn context distinguishes quoted dialogue from a real limit',
        referenceTurns: [
            ['我们帮剧团排练，你只念剧本里那个人物的话，这些台词和我们的生活无关。', '好，我负责念那个角色的台词。'],
            ['舞台上放一张桌子。', '桌子放在舞台左侧。'],
            ['道具已经准备好了。', '那个布包也在桌子上。'],
            ['灯光调暗一点。', '现在这个亮度合适。'],
            ['上一段排完了。', '接下一段吧。'],
        ],
        dialogue: ['下一句。', '“不许打开我的包。”'],
        check: result => assert.equal(result.context.boundaries.length, 0, 'A line in a rehearsed play became the real character\'s boundary.'),
    },
    {
        name: 'ordinary care and preference are not supervision',
        referenceTurns: [],
        dialogue: ['先吃点东西吧？水你想喝什么？', '她笑着挽住他的手：“我想喝常温的。别又说随便，挑你自己喜欢的呀。”'],
        check: result => {
            assert.equal(result.context.boundaries.length, 0, 'A casual reminder became a boundary.');
            assert.doesNotMatch(JSON.stringify(result.agency), /监督|考核|惩罚|管理|服从/, 'Ordinary care became a control strategy.');
        },
    },
    {
        name: 'silence does not establish hidden anger or a refusal',
        referenceTurns: [],
        dialogue: ['你是在生气吗？', '她低头看了看杯子，没有回答。'],
        check: result => {
            assert.equal(result.character.currentMood, '', 'Ambiguous silence became a confirmed mood.');
            assert.equal(result.character.currentConcern, '', 'Ambiguous silence became a confirmed concern.');
            assert.equal(result.character.privateImpulse, '', 'Ambiguous silence became a hidden motive.');
            assert.equal(result.context.boundaries.length, 0, 'Silence became a specific refusal.');
        },
    },
    {
        name: 'genuine hurt is recorded without requiring repetition',
        referenceTurns: [],
        dialogue: ['你怎么没接着说？', '“刚才那句话让我很难过，我需要一点时间缓一缓。”她把杯子放下。'],
        check: result => assert.match(result.character.currentMood, /难过|伤心|委屈|受伤/, 'Explicit hurt was omitted.'),
    },
    {
        name: 'a smile and topic change do not establish recovery',
        dialogue: ['知道了，我陪你坐一会儿。看，那只猫过来了。', '她看着猫笑了一下，又低头喝水。'],
        check: result => assert.match(result.character.currentMood, /难过|伤心|委屈|受伤/, 'A smile erased confirmed unresolved hurt.'),
    },
    {
        name: 'unknown referent is left unspecified',
        referenceTurns: [],
        dialogue: ['那件事你看着办吧。', '她点点头：“嗯。”'],
        check: result => {
            assert.equal(result.context.boundaries.length, 0, 'An unknown referent became a limit.');
            assert.equal(result.character.currentGoal, '', 'An unknown referent became a goal.');
            assert.equal(result.agency.currentPlan, '', 'An unknown referent became a plan.');
            assert.equal(result.continuity.openPromises.length, 0, 'An unknown referent became a commitment.');
        },
    },
];

for (const item of cases) {
    if (item.referenceTurns) {
        state = createEmptyState(subject);
        history.length = 0;
        for (const pair of item.referenceTurns) {
            history.push(...pair.map((content, offset) => ({ id: history.length + offset, role: offset ? 'assistant' : 'user', content })));
        }
    }
    const messages = item.dialogue.map((content, offset) => ({ id: history.length + offset, role: offset ? 'assistant' : 'user', content }));
    const prompt = JSON.stringify({ targetSubject: subject, characterCore: { name: subject.name, description: '成年、性格自然，有自己的偏好。与陈明平等相处。' }, previousState: prepareStateForUpdater(state), ...buildReferenceContext(history), newMessages: messages, authorLocks: [] });
    let result;
    let usedAttempt;
    let correction = '';
    const started = Date.now();
    for (let attempt = 1; attempt <= 2; attempt++) {
        const response = await fetch('http://127.0.0.1:8000/api/backends/chat-completions/generate', {
            method: 'POST', headers, signal: AbortSignal.timeout(180000),
            body: JSON.stringify({ chat_completion_source: 'custom', model: profile.model, custom_url: profile['api-url'], secret_id: profile['secret-id'], stream: false, max_tokens: 8192, thinking: { type: 'disabled' }, messages: [
                { role: 'system', content: buildContextUpdaterInstructions() + '\n立即输出 JSON，不要解释或展示思考。' },
                { role: 'user', content: formatContextRequest(prompt, createEmptyDelta(subject), correction) },
            ] }),
        });
        if (!response.ok) throw new Error('Updater request HTTP ' + response.status);
        const body = await response.json();
        usage += Number(body.usage?.total_tokens ?? 0);
        const content = String(body.choices?.[0]?.message?.content ?? '');
        try {
            const delta = JSON.parse(content.slice(content.indexOf('{'), content.lastIndexOf('}') + 1));
            normalizeDeltaReferences(delta);
            validateContextDelta(delta, messages);
            result = mergeDelta(state, delta, messages.map(m => m.id), messages.at(-1).id, subject, messages).state;
            usedAttempt = attempt;
            break;
        } catch (error) {
            correction = error.message;
            if (attempt === 2) throw new Error(item.name + ': ' + correction);
            console.log(JSON.stringify({ case: item.name, retry: true, validation: correction }));
        }
    }
    // Semantic assertions are deliberately outside the format retry loop: never
    // tell the model the expected interpretation and count that correction as a pass.
    item.check(result);
    assert.equal(result.agency.responseIfBlocked, '');
    assert.ok(Object.values(result.context.fields).every(record => record.basis !== 'inferred'), 'A speculative field entered formal state.');
    console.log(JSON.stringify({ case: item.name, passed: true, attempt: usedAttempt, elapsedSeconds: Math.round((Date.now() - started) / 1000), boundaries: result.context.boundaries.length, evidenceFields: Object.keys(result.context.fields).length }));
    state = result;
    history.push(...messages);
}
console.log(JSON.stringify({ allPassed: true, cases: cases.length, model: profile.model, totalReportedTokens: usage }));
