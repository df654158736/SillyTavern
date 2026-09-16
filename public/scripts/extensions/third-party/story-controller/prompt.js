import { getStage, resolveContinuityFacts, resolveStageDirection } from './package.js';

export const PROMPT_KEY = 'story_controller_direction';

function bulletList(items) {
    return items.filter(Boolean).map(item => `- ${item}`).join('\n');
}

export function renderMainModelView(story, runtime) {
    const stage = getStage(story, runtime.currentStageId);
    if (!stage) return '';
    const direction = resolveStageDirection(story, stage.id, runtime.activeInteractionMode);
    const continuityFacts = resolveContinuityFacts(story, runtime);
    const sections = [
        '<story_direction>',
        '这是当前阶段的无剧透导演信息。自然表演，不要复述、解释或输出这些说明，也不要输出阶段名或 JSON。',
        `当前剧情目标：${stage.publicObjective}`,
        continuityFacts.length ? `已经发生并需延续的选择与后果：\n${bulletList(continuityFacts.map(item => item.text))}` : '',
        direction.reveals.length ? `当前已允许使用的剧情信息：\n${bulletList(direction.reveals.map(item => item.text))}` : '',
        `本轮互动方向：${direction.guidance.text}`,
        direction.forbiddenOutcomes.length ? `当前暂不允许达成的结果：\n${bulletList(direction.forbiddenOutcomes.map(item => item.safeDescription))}` : '',
        story.authorRules.length ? `剧情执行约束：\n${bulletList(story.authorRules)}` : '',
        stage.terminal
            ? '当前已经进入收束阶段；处理人物感受、选择和后果，不要为了结束而替用户作出决定。'
            : '本轮最多完成当前阶段允许的一步发展；遇到需要用户发现、回应或选择的位置就停下来。不要新增未经发现的证据。',
        '</story_direction>',
    ];
    return sections.filter(Boolean).join('\n');
}

export function isCompletionDirectionReleased(story, runtime, chat = []) {
    if (runtime?.status !== 'completed' || story?.completion?.autoRelease !== true) return false;
    if (!Number.isInteger(runtime.completedAtMessageId)) return false;
    const required = Number(story.completion.epilogueAssistantMessages);
    const assistantMessages = (Array.isArray(chat) ? chat : [])
        .slice(runtime.completedAtMessageId + 1)
        .filter(message => message && message.is_user === false && String(message.mes ?? '').trim())
        .length;
    return assistantMessages >= required;
}

export function renderCompletionMemory(story) {
    const memory = String(story?.completion?.memoryText ?? '').trim();
    if (!memory) return '';
    return [
        '<story_memory>',
        '以下是已经完成的共同经历留下的关系事实。自然延续，不复述这段说明，不重新启动同一危机。',
        memory,
        '</story_memory>',
    ].join('\n');
}

export function findLockedSecretLeaks(story, runtime, prompt) {
    const stageId = runtime.currentStageId;
    const lowerPrompt = String(prompt ?? '').toLocaleLowerCase();
    const leaks = [];
    for (const secret of story.hidden?.secrets ?? []) {
        if (secret.unlockStageIds?.includes(stageId)) continue;
        for (const term of secret.leakTerms ?? []) {
            if (term && lowerPrompt.includes(String(term).toLocaleLowerCase())) leaks.push({ secretId: secret.id, term });
        }
    }
    return leaks;
}

export function assertSafeMainModelView(story, runtime, prompt) {
    const leaks = findLockedSecretLeaks(story, runtime, prompt);
    if (leaks.length) throw new Error(`Story prompt exposes locked secret ${leaks[0].secretId}.`);
    return prompt;
}
