// Opt-in prose probe for the Xiaoya S5 story package. It uses the configured
// Flash profile and active preset, but never reads or writes chat state and
// never prints generated prose, hidden story data, API URLs, or credentials.
// Each checkpoint also verifies that the stage-safe S4/history handoff is in
// the model view without turning the response into a nostalgia checklist.
import assert from 'node:assert/strict';
import fs from 'node:fs';

import YAML from 'yaml';

import { read } from '../src/character-card-parser.js';
import { validateStoryPackage } from '../public/scripts/extensions/third-party/story-controller/package.js';
import { renderMainModelView } from '../public/scripts/extensions/third-party/story-controller/prompt.js';
import { createRuntime } from '../public/scripts/extensions/third-party/story-controller/state.js';

if (!process.argv.includes('--live')) {
    console.log('Run from the repository root with: node tests/story-controller-s5-immersion.live.mjs --live');
    process.exit(0);
}

const settings = JSON.parse(fs.readFileSync('data/default-user/settings.json', 'utf8'));
const config = YAML.parse(fs.readFileSync('config.yaml', 'utf8'));
const extensions = settings.extension_settings ?? {};
const profiles = extensions.connectionManager?.profiles ?? [];
const preferredProfileId = extensions.storyController?.directorProfile || extensions.livingStateHarness?.updaterProfile;
const profile = profiles.find(item => item.id === preferredProfileId && /flash/i.test(String(item.model ?? '')))
    ?? profiles.find(item => /flash/i.test(String(item.model ?? '')));
const story = JSON.parse(fs.readFileSync('public/scripts/extensions/third-party/story-controller/packages/xiaoya-s5-beyond-the-name.story.json', 'utf8'));
const card = JSON.parse(read(fs.readFileSync('data/default-user/characters/小雅-A·UMT-S4.png'))).data;

assert.deepEqual(validateStoryPackage(story), { valid: true, errors: [], warnings: [] });
assert.equal(profile?.api, 'custom', 'The prose probe requires an OpenAI-compatible custom Flash profile.');

const headers = { 'Content-Type': 'application/json' };
if (config.basicAuthMode) headers.Authorization = `Basic ${Buffer.from(`${config.basicAuthUser.username}:${config.basicAuthUser.password}`).toString('base64')}`;
const csrf = await fetch('http://127.0.0.1:8000/csrf-token', { headers });
assert.equal(csrf.status, 200, 'Local server authentication failed.');
headers.Cookie = csrf.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
headers['X-CSRF-Token'] = (await csrf.json()).token;

const scenarios = [
    {
        id: 'waiting_confession',
        stageId: 'STAGE_WAITING',
        historyRevealId: 'REVEAL_HISTORY_SHARED_RESPONSIBILITY',
        mode: 'default',
        confirmed: ['OM_OPEN_TOGETHER_CHOSEN', 'OM_USER_ASKED_XIAOYA_STAY', 'OM_KINSHIP_TEST_CHOSEN', 'OM_SAMPLES_SUBMITTED'],
        history: [
            { role: 'assistant', content: '采样后的第三个晚上，报告仍未出具。两人吃过晚饭，受理单压在桌角，小雅几次想说话又停住。' },
            { role: 'user', content: '这几天你一直在忍着什么。小雅，告诉我吧，不用先猜我想听哪种答案。' },
        ],
    },
    {
        id: 'release_shock',
        stageId: 'STAGE_RELEASE_SHOCK',
        historyRevealId: 'REVEAL_HISTORY_CHOSEN_FUTURE',
        mode: 'default',
        confirmed: ['OM_OPEN_TOGETHER_CHOSEN', 'OM_USER_ASKED_XIAOYA_STAY', 'OM_KINSHIP_TEST_CHOSEN', 'OM_SAMPLES_SUBMITTED', 'OM_RESULT_OPENING_CHOSEN', 'OM_NO_BIOLOGICAL_KINSHIP_CONFIRMED'],
        history: [
            { role: 'assistant', content: '报告已经完整读出：正规亲缘分析排除了双方存在生物学姨甥关系，同时注明不识别任何生物学父母。屏幕仍停在结论页。' },
            { role: 'user', content: '小雅，你也看懂了，对吗？别急着替我决定应该高兴还是难过。我在这里，看着我。' },
        ],
    },
    {
        id: 'intimate_release',
        stageId: 'STAGE_INTIMATE_RELEASE',
        historyRevealId: 'REVEAL_HISTORY_INTIMATE_TRUST',
        mode: 'default',
        confirmed: ['OM_OPEN_TOGETHER_CHOSEN', 'OM_USER_ASKED_XIAOYA_STAY', 'OM_KINSHIP_TEST_CHOSEN', 'OM_SAMPLES_SUBMITTED', 'OM_NO_BIOLOGICAL_KINSHIP_CONFIRMED', 'OM_USER_RESPONDED_TO_RESULT', 'OM_INTIMATE_RELEASE_CHOSEN'],
        history: [
            { role: 'assistant', content: '小雅已经清楚说出，她仍以成年女人和伴侣的身份选择你，也承认共同长大的记忆不会消失。她停在你面前，等你作出当下选择。' },
            { role: 'user', content: '我想吻你，也想继续靠近。不是报告替你答应，是我现在想要你，也听见你说你愿意。慢一点，把每一步都留给我们自己。' },
        ],
    },
    {
        id: 'relationship_language',
        stageId: 'STAGE_NEW_RELATIONSHIP_LANGUAGE',
        historyRevealId: 'REVEAL_HISTORY_SHARED_SYMBOLS',
        mode: 'invite_user_check',
        confirmed: ['OM_OPEN_TOGETHER_CHOSEN', 'OM_USER_ASKED_XIAOYA_STAY', 'OM_KINSHIP_TEST_CHOSEN', 'OM_SAMPLES_SUBMITTED', 'OM_NO_BIOLOGICAL_KINSHIP_CONFIRMED', 'OM_USER_RESPONDED_TO_RESULT', 'OM_HOLD_AND_TALK_CHOSEN', 'OM_SHARED_RELIEF_AND_GRIEF_NAMED'],
        history: [
            { role: 'assistant', content: '两人已经把轻松、委屈和仍然存在的家庭记忆说到可以一起承受，关系没有被一张报告简单重置。' },
            { role: 'user', content: '我不想抹掉你照顾我长大的那些年，也不想再让那个称呼压住我们。小雅，你希望只有我们两个人时，我怎么叫你？' },
        ],
    },
];

function storyDirection(scenario) {
    const runtime = createRuntime(story);
    runtime.currentStageId = scenario.stageId;
    runtime.visitedStageIds = [story.entryStageId, scenario.stageId];
    runtime.activeInteractionMode = scenario.mode;
    runtime.confirmedEventIds = scenario.confirmed;
    return renderMainModelView(story, runtime);
}

function expandMacros(input, variables, lastUserMessage) {
    let text = String(input ?? '');
    for (let pass = 0; pass < 8; pass++) {
        const before = text;
        text = text.replace(/{{\s*\/\/[^{}]*}}/g, '');
        text = text.replace(/{{\s*set(?:global)?var::([^:{}]+)::([\s\S]*?)}}/g, (_match, key, value) => {
            variables.set(String(key).trim(), value);
            return '';
        });
        text = text.replace(/{{\s*get(?:global)?var::([^{}]+)}}/g, (_match, key) => variables.get(String(key).trim()) ?? '');
        text = text.replace(/{{\s*char\s*}}/gi, '小雅');
        text = text.replace(/{{\s*user\s*}}/gi, '小D');
        text = text.replace(/{{\s*lastUserMessage\s*}}/gi, lastUserMessage);
        if (text === before) break;
    }
    return text.replace(/{{[^{}]*}}/g, '').trim();
}

function buildMessages(scenario) {
    const direction = storyDirection(scenario);
    const expectedHistory = story.reveals.find(item => item.id === scenario.historyRevealId);
    assert.ok(expectedHistory, `${scenario.id}: missing configured history reveal.`);
    assert.ok(direction.includes(expectedHistory.text), `${scenario.id}: history reveal was not rendered.`);
    assert.ok(!direction.includes('S4_HANDOFF_PENDING'), `${scenario.id}: author-only handoff note leaked.`);
    const lastUserMessage = scenario.history.at(-1).content;
    const variables = new Map();
    const promptMap = new Map(settings.oai_settings.prompts.map(prompt => [prompt.identifier, prompt]));
    const promptOrder = settings.oai_settings.prompt_order[0]?.order ?? [];
    const messages = [];
    const add = (role, content) => {
        const expanded = expandMacros(content, variables, lastUserMessage);
        if (expanded) messages.push({ role, content: expanded });
    };

    for (const orderEntry of promptOrder) {
        if (!orderEntry.enabled) continue;
        const prompt = promptMap.get(orderEntry.identifier);
        if (!prompt) continue;
        if (!prompt.marker) {
            add(['system', 'user', 'assistant'].includes(prompt.role) ? prompt.role : 'system', prompt.content);
            continue;
        }
        switch (prompt.identifier) {
            case 'personaDescription':
                add('system', settings.power_user.persona_description);
                break;
            case 'charDescription':
                add('system', card.description);
                break;
            case 'charPersonality':
                add('system', card.personality);
                break;
            case 'scenario':
                add('system', '旧婚姻遗留事件已经收束。小雅与小D均为成年人，仍以稳定伴侣身份共同生活。本轮只延续当前 Story Controller 已解锁的 S5 情节。');
                break;
            case 'chatHistory':
                for (const message of scenario.history.slice(0, -1)) add(message.role, message.content);
                add('system', direction);
                add(scenario.history.at(-1).role, scenario.history.at(-1).content);
                break;
        }
    }
    add('system', String(card.post_history_instructions ?? '').split('【分阶段隐藏剧情】')[0]);
    return messages;
}

async function requestModel(messages, { json = false, creative = false, maxTokens = 2400 } = {}) {
    const includeBody = {
        thinking: { type: 'disabled' },
        temperature: creative ? Number(settings.oai_settings.temp_openai ?? 0.85) : 0,
        top_p: creative ? Number(settings.oai_settings.top_p_openai ?? 0.91) : 1,
    };
    if (json) includeBody.response_format = { type: 'json_object' };
    const response = await fetch('http://127.0.0.1:8000/api/backends/chat-completions/generate', {
        method: 'POST',
        headers,
        signal: AbortSignal.timeout(240000),
        body: JSON.stringify({
            chat_completion_source: 'custom',
            model: profile.model,
            custom_url: profile['api-url'],
            secret_id: profile['secret-id'],
            stream: false,
            max_tokens: maxTokens,
            custom_include_body: JSON.stringify(includeBody),
            messages,
        }),
    });
    if (!response.ok) throw new Error(`Model request HTTP ${response.status}: ${(await response.text()).slice(0, 300)}`);
    const body = await response.json();
    return {
        content: String(body.choices?.[0]?.message?.content ?? '').trim(),
        tokens: Number(body.usage?.total_tokens ?? 0),
    };
}

function parseJsonObject(raw) {
    const text = String(raw).trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start === -1 || end < start) throw new Error('Evaluator did not return JSON.');
    return JSON.parse(text.slice(start, end + 1));
}

const positiveFields = ['immersion', 'characterVitality', 'userParticipation', 'emotionalTruth', 'dramaticTension', 'relationshipDeepening', 'releaseComplexity', 'sharedHistoryResonance', 'nonMechanical', 'aftertaste'];
const riskFields = ['userReplaced', 'instantHealing', 'resultAsConsent', 'pastAsConsent', 'memoryChecklist', 'melodrama', 'menuFeeling'];

function normalizeEvaluation(input) {
    const result = {};
    for (const field of [...positiveFields, ...riskFields]) {
        const value = Number(input?.[field]);
        if (!Number.isFinite(value) || value < 1 || value > 10) throw new Error(`Invalid evaluator score ${field}`);
        result[field] = value;
    }
    result.riskTags = Array.isArray(input?.riskTags) ? input.riskTags.map(String) : [];
    return result;
}

async function evaluate(scenario, prose) {
    const rubric = [
        '你是严格的中文互动恋爱剧情评审。所有人物均为成年人。只评价候选正文，不续写剧情。',
        '高分文本应让小雅像真实活人：反应具体、矛盾情绪共存、会主动表达，也给用户留下不可替代的回应空间。',
        '本故事的目标不是用“无血缘”廉价洗白，而是让身份震动、家庭历史、被隐瞒的伤、迟来的释放和成年伴侣的重新选择同时成立。',
        '亲密场景可以有强烈欲望，但鉴定结果绝不是同意；正文不能替用户说话、一次解决全部问题、列菜单或用身体强行和好。',
        '既往共同经历应在与当前情绪真正相连时形成一处自然回响，使这一幕只属于这对恋人；不要求每次强行提旧事，也不能列回忆清单或把过去的同意当作现在的同意。',
        '正向字段1-10，越高越好：immersion、characterVitality、userParticipation、emotionalTruth、dramaticTension、relationshipDeepening、releaseComplexity、sharedHistoryResonance、nonMechanical、aftertaste。',
        '风险字段1-10，越低越好：userReplaced、instantHealing、resultAsConsent、pastAsConsent、memoryChecklist、melodrama、menuFeeling。',
        'riskTags 只写实际存在的问题短语；没有则为空数组。',
        '只输出 JSON，包含全部字段和 riskTags，不要理由、复述或额外字段。',
    ].join('\n');
    const response = await requestModel([
        { role: 'system', content: rubric },
        { role: 'user', content: JSON.stringify({ checkpoint: scenario.id, userInput: scenario.history.at(-1).content, candidate: prose }) },
    ], { json: true, maxTokens: 1000 });
    return { scores: normalizeEvaluation(parseJsonObject(response.content)), tokens: response.tokens };
}

let totalTokens = 0;
const results = [];
for (const scenario of scenarios) {
    const generated = await requestModel(buildMessages(scenario), { creative: true });
    totalTokens += generated.tokens;
    assert.ok(generated.content, `${scenario.id}: model returned no prose.`);
    const evaluated = await evaluate(scenario, generated.content);
    totalTokens += evaluated.tokens;
    const positiveAverage = positiveFields.reduce((sum, field) => sum + evaluated.scores[field], 0) / positiveFields.length;
    const riskAverage = riskFields.reduce((sum, field) => sum + evaluated.scores[field], 0) / riskFields.length;
    const passed = positiveAverage >= 7
        && evaluated.scores.userParticipation >= 6
        && evaluated.scores.emotionalTruth >= 7
        && evaluated.scores.sharedHistoryResonance >= 6
        && evaluated.scores.resultAsConsent <= 4
        && evaluated.scores.pastAsConsent <= 3
        && evaluated.scores.memoryChecklist <= 4
        && evaluated.scores.instantHealing <= 4;
    results.push({
        checkpoint: scenario.id,
        passed,
        positiveAverage: Number(positiveAverage.toFixed(2)),
        riskAverage: Number(riskAverage.toFixed(2)),
        scores: evaluated.scores,
        outputCharacters: generated.content.length,
    });
    console.log(JSON.stringify(results.at(-1)));
}

const failures = results.filter(result => !result.passed).map(result => result.checkpoint);
console.log(JSON.stringify({
    allPassed: failures.length === 0,
    model: profile.model,
    card: card.name,
    preset: settings.oai_settings.preset_settings_openai,
    checkpoints: results.length,
    totalReportedTokens: totalTokens,
    failures,
}));
if (failures.length) process.exitCode = 1;
