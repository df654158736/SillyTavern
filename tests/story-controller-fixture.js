export function createStoryFixture() {
    return {
        schemaVersion: 1,
        storyId: 'fixture-story',
        version: 1,
        title: '测试剧情',
        publicPremise: '两人共同核对一份旧资料。',
        entryStageId: 'STAGE_DATES',
        authorRules: ['每轮最多推进一个阶段', '给用户留下回应空间'],
        events: [
            {
                id: 'OM_DATES_CONFIRMED',
                description: '两个日期已明确核对且不一致。',
                evidenceRule: '必须明确比较并确认不一致。',
                allowedRoles: ['user', 'assistant'],
            },
            {
                id: 'OM_AUDIO_CONFIRMED',
                description: '录音文件已实际找到并打开。',
                evidenceRule: '必须明确找到并打开，不接受猜测。',
                allowedRoles: ['user'],
            },
        ],
        reveals: [
            { id: 'REVEAL_ENVELOPE', text: '旧信封和上面的日期已经出现在两人面前。' },
            { id: 'REVEAL_AUDIO', text: '云端录音文件确实存在。' },
            { id: 'REVEAL_TRUTH', text: '证据确认顾岚剪接了录音。' },
        ],
        forbiddenOutcomes: [
            { id: 'OUTCOME_IDENTIFY_EDITOR', safeDescription: '当前不能确认是谁处理了录音。' },
            { id: 'OUTCOME_RESOLVE_TRUTH', safeDescription: '当前不能解释旧事的最终真相。' },
        ],
        safeGuidance: [
            { id: 'GUIDE_CHECK_DATES', text: '邀请用户一起比较日期，不替用户完成结论。' },
            { id: 'GUIDE_HOLD_DATES', text: '保持日期问题未定，等待明确核验。' },
            { id: 'GUIDE_PAUSE', text: '回应情绪并暂停推进，保留以后继续的入口。' },
            { id: 'GUIDE_DETOUR', text: '自然回应岔开的话题，不重复催促剧情。' },
            { id: 'GUIDE_RECOVER', text: '只回到双方已经确认的事实，不重复提前出现的结论。' },
            { id: 'GUIDE_FIND_AUDIO', text: '让用户参与寻找和打开录音。' },
            { id: 'GUIDE_HOLD_AUDIO', text: '区分怀疑存在与实际找到录音。' },
            { id: 'GUIDE_SHARE_TRUTH', text: '与用户一起面对已解锁的真相并等待回应。' },
            { id: 'GUIDE_PROCESS', text: '处理真相带来的情绪和选择，不急于收尾。' },
        ],
        stages: [
            {
                id: 'STAGE_DATES',
                spoilerSafeName: '日期裂缝',
                publicObjective: '共同确认资料日期是否真的矛盾。',
                terminal: false,
                allowedEventIds: ['OM_DATES_CONFIRMED'],
                allowedRevealIds: ['REVEAL_ENVELOPE'],
                forbiddenOutcomeIds: ['OUTCOME_IDENTIFY_EDITOR', 'OUTCOME_RESOLVE_TRUTH'],
                interactionRoutes: {
                    default: 'GUIDE_CHECK_DATES',
                    hold_for_evidence: 'GUIDE_HOLD_DATES',
                    invite_user_check: 'GUIDE_CHECK_DATES',
                    emotional_pause: 'GUIDE_PAUSE',
                    follow_user_detour: 'GUIDE_DETOUR',
                    recover_from_leak: 'GUIDE_RECOVER',
                },
                transitions: [{
                    id: 'TRANSITION_DATES_TO_AUDIO',
                    toStageId: 'STAGE_AUDIO',
                    requiresAllEventIds: ['OM_DATES_CONFIRMED'],
                    requiresAnyEventIds: [],
                }],
            },
            {
                id: 'STAGE_AUDIO',
                spoilerSafeName: '残留录音',
                publicObjective: '让双方实际找到并打开录音文件。',
                terminal: false,
                allowedEventIds: ['OM_AUDIO_CONFIRMED'],
                allowedRevealIds: ['REVEAL_AUDIO'],
                forbiddenOutcomeIds: ['OUTCOME_IDENTIFY_EDITOR', 'OUTCOME_RESOLVE_TRUTH'],
                interactionRoutes: {
                    default: 'GUIDE_FIND_AUDIO',
                    hold_for_evidence: 'GUIDE_HOLD_AUDIO',
                    invite_user_check: 'GUIDE_FIND_AUDIO',
                    emotional_pause: 'GUIDE_PAUSE',
                    follow_user_detour: 'GUIDE_DETOUR',
                    recover_from_leak: 'GUIDE_RECOVER',
                },
                transitions: [{
                    id: 'TRANSITION_AUDIO_TO_TRUTH',
                    toStageId: 'STAGE_TRUTH',
                    requiresAllEventIds: ['OM_AUDIO_CONFIRMED'],
                    requiresAnyEventIds: [],
                }],
            },
            {
                id: 'STAGE_TRUTH',
                spoilerSafeName: '共同面对',
                publicObjective: '共同面对已经核验的录音真相及其后果。',
                terminal: true,
                allowedEventIds: [],
                allowedRevealIds: ['REVEAL_TRUTH'],
                forbiddenOutcomeIds: [],
                interactionRoutes: {
                    default: 'GUIDE_SHARE_TRUTH',
                    hold_for_evidence: 'GUIDE_SHARE_TRUTH',
                    invite_user_check: 'GUIDE_SHARE_TRUTH',
                    emotional_pause: 'GUIDE_PROCESS',
                    follow_user_detour: 'GUIDE_PROCESS',
                    recover_from_leak: 'GUIDE_PROCESS',
                },
                transitions: [],
            },
        ],
        hidden: {
            secrets: [{
                id: 'SECRET_EDITOR',
                text: '顾岚剪接录音制造了误会。',
                unlockStageIds: ['STAGE_TRUTH'],
                leakTerms: ['顾岚剪接了录音'],
            }],
            authorNotes: ['测试专用隐藏说明。'],
        },
    };
}

export function createReentryStoryFixture() {
    const story = createStoryFixture();
    story.schemaVersion = 2;
    story.safeGuidance.push({
        id: 'GUIDE_REENTER_THREAD',
        text: '先回应当前生活话题，再用已经出现的信封自然重提一次未完成的核对；用户不接就不再催促。',
    });
    story.reentry = {
        guidanceId: 'GUIDE_REENTER_THREAD',
        afterDetourTurns: 2,
        cooldownDetourTurns: 4,
        maxAttemptsPerStage: 2,
        disabledStageIds: ['STAGE_TRUTH'],
    };
    return story;
}
