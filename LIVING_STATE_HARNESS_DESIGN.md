# SillyTavern Living State Harness 最小设计方案

> 状态：Draft / 待评审  
> 日期：2026-08-26  
> 适用范围：网页端、固定角色卡、固定预设、单角色聊天优先  
> 北极星目标：提高女主角的“活人感”和故事输出质量——她不只是记住经历，还拥有独立注意力、即时动机、边界、现实事务和主动行为；关系与态度能够依据经历合理演化，故事因此更自然、更有连续性和推进力。

## 1. 结论摘要

当前 SillyTavern 已经具备角色卡、预设、World Info、向量召回、聊天摘要、Author's Note、Prompt Manager 和扩展注入能力。缺少的不是一个通用 Agent 平台，而是一个明确表达“角色当前状态”的中间层。

本方案建议实现一个轻量第三方扩展：`Living State Harness`。

V1 只做四件事：

1. 维护一份足以改善角色表现、但不替代聊天历史的结构化当前状态。
2. 每次正常用户回合开始时，用一次短结构化生成计算状态增量。
3. 将当前状态以 System 角色注入最新对话附近。
4. 将状态快照绑定到用户消息，正确处理 Swipe、Regenerate、编辑和删除。

V1 明确不引入 Pi Agent、Deep Agents、DeepSeek Harness、多 Agent、剧情导演、向量数据库、知识图谱或输出 Critic。

质量优先级固定为：

1. 女主是否更像拥有自身生活、判断和意志的人。
2. 故事输出是否更自然、连贯、有张力且能自主推进。
3. 人设、格式和剧情事实是否不退化。
4. 在前三项成立后，再优化额外 token、延迟、费用和缓存命中。

不得为了提高缓存数字而把有效状态放到过远位置，也不得为了满足预设 token 上限而过早删除对角色表现有显著帮助的字段。

## 2. 为什么需要轻量 Harness

### 2.1 当前项目已有能力

当前项目已经可以：

- 使用角色描述、性格、场景和示例构建提示词。
- 使用 World Info 按关键词、条件、优先级和向量相似度注入设定。
- 使用 Vector Storage 召回过去消息或资料片段。
- 使用 Summary 扩展压缩长期聊天历史。
- 使用 Author's Note 和 `setExtensionPrompt` 在聊天深处注入提示。
- 通过扩展的 generation interceptor 在主模型请求前异步处理上下文。
- 通过消息事件感知 Swipe、编辑、删除和更新。

相关代码入口：

- Chat Completion 注入组装：`public/scripts/openai.js:810-868`
- Summary 默认提示：`public/scripts/extensions/memory/index.js:105-139`
- Summary 注入：`public/scripts/extensions/memory/index.js:965`
- 扩展生成拦截器：`public/scripts/extensions.js:2024-2047`
- 动态 Prompt 注入：`public/script.js:8926-8934`
- 结构化静默生成：`public/script.js:4000-4140`
- Swipe 事件：`public/script.js:10315`

### 2.2 当前能力的核心缺口

现有模块分别解决：

- 角色卡：角色最初是什么样的人。
- World Info：世界中有哪些设定。
- Vector Storage：过去哪段文字与当前内容相似。
- Summary：过去大致发生过什么。

但没有一个模块明确维护：

- 角色此刻的情绪和私人动机。
- 角色当前如何看待用户。
- 双方关系已经发展到什么阶段。
- 哪些初始偏好已经被共同经历合理改变。
- 当前场景中有哪些未完成承诺和开放剧情线。
- 哪些过去事件正在影响本轮反应。

因此，模型即使召回了历史，也仍需要在每一轮重新推导这些信息，容易出现态度跳变、关系复位、旧偏好被机械执行或者剧情缺乏主动性。

### 2.3 必要性判断

- 对短对话、简单角色卡和高能力模型：Harness 不是必需品。
- 对长对话、关系演化、持续剧情和固定角色的高质量扮演：轻量 Harness 有明显必要性。
- 完整通用 Agent Harness：当前阶段没有必要，复杂度和提示噪声可能反而降低自然度。

### 2.4 当前目标角色与预设现状

首个基准角色“小雅（小姨）”的角色卡信息充分，核心人格、身份冲突、语言风格和长期弧线都很明确。主要问题不是缺少描述，而是：

- 行为轨迹容易被“固定推拉模式和预定转变路线”锁死，形成高一致性但低自主性的重复表演。
- 角色的大部分注意力围绕用户和核心关系冲突，工作、社交、责任与场景外生活不足。
- 当前完整主请求约 8 万 token，模型拥有大量历史，但缺少一份高信号的“此刻为何这样行动”。
- 角色卡内嵌文风书与外部关联文风书内容相同，需要在 Prompt Viewer 中确认是否发生重复注入。

当前 `MoM5.40KKMYUKI1111` 预设已经启用“优先人设”“真实 RP”“人物坐标”“角色内心”和常规 COT。这些负责本轮如何表演，应保留。它还启用了 `seeds` 伏笔和每轮摘要，与 Harness 的连续性账本重叠；质量实验应分别测试关闭和兼容剥离两种模式，不能让 Updater 把 `<meow_FM>`、seeds、状态栏、COT 或小剧场文本当成一手剧情证据。

因此 Harness 的首要增量不是再添加“写得真实”的泛化要求，而是提供预设当前没有可靠维护的内容：独立注意力、竞争性目标、冲动与制约、边界、主动计划、现实事务以及有证据的关系变化。

## 3. 设计原则

### 3.1 固定变化逻辑，不固定角色永远不变

角色卡中的内容必须区分：

- 作者级不可变约束：用户控制权、内容红线、世界硬规则。
- 核心人格：变化缓慢，但表现方式可以发展。
- 初始倾向：例如不喜欢牵手，可以被关系和经历改变。
- 当前态度：可以随本轮事件快速变化。
- 当前状态：地点、伤势、物品、在场人物等。

Living State 不能修改作者级不可变约束和世界客观事实，但可以记录初始倾向如何合理演化。

### 3.2 随机的是创作，确定的是事实账本

主模型继续自由创作剧情，不由 Harness 规定固定剧情路线。Harness 只向模型提供当前状态、角色动机和未完成线索。

剧情可以意外，状态提交必须可追溯。

### 3.3 当前状态不是命令清单

Living State 应描述人物当前状态，而不是要求模型逐条复述。注入提示应明确：

- 自然体现即可，不必全部提及。
- 不得在回复中直接解释或引用 Living State。
- `privateImpulse` 是潜在冲动，不是必须完成的剧情任务。

### 3.4 只处理已接受的剧情

未被用户接受的 Swipe、Regenerate 草稿和隐藏计划不得写入正式状态。

### 3.5 失败时降级，不阻断聊天

状态更新失败时，沿用上一版本状态并继续主生成。Harness 不应因为辅助模型错误导致用户无法聊天。

## 4. V1 范围

### 4.1 V1 包含

- 单角色聊天。
- 固定角色卡和固定预设。
- 一份结构化 Living State。
- 增量状态更新。
- 状态近端注入。
- 用户消息级状态快照。
- Swipe、Regenerate、编辑、删除的基础一致性处理。
- 状态查看、手动编辑、冻结、重置。
- Token、延迟、更新次数和状态差异日志。
- 固定的短格式契约。

### 4.2 V1 不包含

- 手机端布局、触控交互和移动端适配。
- 多角色共享状态。
- 独立剧情导演模型。
- 输出 Critic 和自动重写。
- 自动生成多个候选剧情并排序。
- 自定义向量数据库。
- 世界书重写或自动拆解。
- 全量知识图谱。
- 数值化好感度系统。
- 自动推断所有角色卡语句属于硬规则还是软规则。
- 跨聊天、跨角色共享长期记忆。
- 通用工具调用、文件系统、Shell 或子 Agent。

## 5. 最小系统架构

```text
当前角色卡 / 固定预设 / World Info
                 │
                 │ 保持现有流程
                 ▼
上一版 Living State + 新增聊天消息
                 │
                 ▼
       State Updater（短 JSON 调用）
                 │
                 ▼
          State Delta 校验与合并
                 │
                 ├── 保存到用户消息 extra
                 │
                 ▼
       Living State 格式化（先验证质量，再压缩预算）
                 │
                 ▼
 setExtensionPrompt / In-chat depth 1、2、4 A/B
                 │
                 ▼
         SillyTavern 原有主模型生成流程
```

系统只有一个额外模型步骤：`State Updater`。它不写角色回复，只输出结构化状态变化。

### 5.1 基于当前 staging 的可行性核对

当前代码时序支持这个架构：

- 正常生成先把最新用户消息加入 `chat`，再构造 `coreChat`，随后运行 generation interceptor。
- interceptor 完成后才继续 World Info、扩展 Prompt 和主请求组装，因此可以先更新状态再调用 `setExtensionPrompt`。
- `setExtensionPrompt` 支持 `IN_CHAT`、depth、role 和 World Info scan 开关；Harness 使用独立 key、System role、`scan = false`。
- Chat Completion 在组装时会按 depth 插入扩展消息，Prompt Manager 也能看到最终注入结果。
- `MESSAGE_SWIPED`、`MESSAGE_EDITED`、`MESSAGE_DELETED` 和 `MESSAGE_UPDATED` 事件当前均存在。
- `generateRaw` / `generateRawData` 支持消息数组、专用 system prompt、response length 和 JSON Schema。

需要正视的限制：

- `generateRaw` 不会自动套用整份创作预设，但会触发通用 `CHAT_COMPLETION_PROMPT_READY` 事件，其他扩展仍可能修改 Updater 请求。调试模式必须展示实际 Updater 请求，并检测非 Harness 消息注入。
- 当前 `generateRaw` 参数不能独立覆盖 temperature。V1 不能假设 Updater 已经是低温调用；应依赖 JSON Schema、Delta 白名单、证据校验和失败丢弃。若 A/B 证明温度影响稳定性，再新增独立连接或核心 API 参数，而不是临时修改全局设置。
- interceptor 是串行执行的，执行顺序由扩展 manifest 排序决定。Harness 应声明稳定的加载顺序，并记录与 Summary、Vectors 等扩展的相对顺序。
- interceptor 在 dry run 时不会执行，因此 Prompt Manager 的某些纯 dry-run 预览可能显示上一次已保存状态，而不会现场计算新状态。UI 必须明确“已保存状态”和“本次实际发送状态”。

这些限制不阻断 V1，但都必须进入测试矩阵，不能只验证理想路径。

## 6. Living State 数据模型

### 6.1 状态示例

```json
{
  "version": 12,
  "processedThroughMessageId": 69,
  "scene": {
    "location": "王都旅馆",
    "presentCharacters": ["角色", "用户"],
    "immediateSituation": "两人刚从地下拍卖会逃脱，暂时安全"
  },
  "character": {
    "currentMood": "疲惫、警惕，并对用户的冒险行为有些生气",
    "physicalState": "右手轻伤，精神疲惫",
    "attentionFocus": "用户的伤势、门外动静和买家名单",
    "currentGoal": "确认用户是否受伤，同时确保藏身处没有暴露",
    "currentConcern": "用户可能再次冒险，也担心追兵找到旅馆",
    "privateImpulse": "想靠近用户并确认对方安全",
    "inhibition": "仍在生气，不愿让关心显得像无条件纵容"
  },
  "agency": {
    "currentPlan": "先检查伤势，再连夜整理名单中的线索",
    "initiativeSeed": "如果用户继续回避伤势，她会主动拿来药箱并追问",
    "boundary": "不会接受用户再次隐瞒高风险计划",
    "responseIfBlocked": "暂停合作并要求先把风险说清楚"
  },
  "relationship": {
    "trust": "高度信任，但对用户刚才的隐瞒感到不满",
    "emotionalCloseness": "已经确认彼此重要，仍不习惯直接示弱",
    "authorityDynamic": "重大决定上趋于平等，危机处理中角色会强势接管",
    "currentTension": "关心、愤怒和害怕失去对方同时存在",
    "evolvedPreferences": [
      {
        "id": "evolution-hand-holding",
        "change": "已经可以接受与用户牵手，偶尔会主动接触，但会掩饰动机",
        "reason": "共同脱险并确认关系",
        "evidenceMessageIds": [67, 68]
      }
    ]
  },
  "offscreenLife": {
    "recentEvents": ["角色收到同伴询问去向的未读讯息"],
    "upcomingObligations": ["天亮前必须决定是否更换藏身处"],
    "peopleOnMind": ["失踪的姐姐", "可能泄密的接头人"]
  },
  "continuity": {
    "importantFacts": [
      {
        "id": "fact-injured-hand",
        "text": "角色右手仍有轻伤",
        "evidenceMessageIds": [63]
      }
    ],
    "openPromises": [
      {
        "id": "promise-find-sister",
        "text": "角色答应陪用户寻找失踪的姐姐",
        "evidenceMessageIds": [47, 48]
      }
    ],
    "openThreads": [
      {
        "id": "thread-buyer-list",
        "text": "地下拍卖会买家名单尚未解读",
        "evidenceMessageIds": [65]
      }
    ]
  },
  "recentTurningPoints": [
    {
      "id": "turning-point-relationship-confirmed",
      "text": "双方在逃离拍卖会后确认关系",
      "evidenceMessageIds": [67, 68]
    }
  ]
}
```

### 6.2 为什么不使用单一好感度

V1 不使用 `affection = 85` 之类的单一数值。关系可能同时包含信任、喜欢、愤怒、尴尬、依赖和身体接触舒适度。自然语言状态更适合当前目标，也避免角色表现像游戏数值系统。

### 6.3 为什么加入 Agency 和 Offscreen Life

只有 `currentMood + attitudeToUser` 的状态仍然以用户为中心，容易让女主成为对用户输入作出精致反应的 NPC，而不是一个自己正在生活的人。

- `attentionFocus` 表示她此刻真正注意什么，允许注意力不在用户身上。
- `currentPlan` 表示她在用户开口前已经打算做什么。
- `initiativeSeed` 给主模型一个可选择的主动行为起点，不规定固定剧情 Beat。
- `boundary + responseIfBlocked` 让她能够拒绝、改变策略或暂时离开，而不只是表达情绪。
- `offscreenLife` 保存工作、社交、责任和他人关系，让场景之外的生活持续影响当前选择。

这些字段必须来自角色设定或已发生剧情，不能为了制造“活人感”而随机编造忙碌事项。主模型不必每轮表现全部字段；自然遗漏本身也是正常人物行为。

### 6.4 状态容量与质量门槛

建议默认限制：

- `importantFacts`：最多 8 条。
- `openPromises`：最多 5 条。
- `openThreads`：最多 5 条。
- `evolvedPreferences`：最多 5 条。
- `recentTurningPoints`：最多 5 条。
- 最终注入文本：验证阶段先允许 600～1,200 token，确认有效字段后再寻找不降低质量的最小预算。

超过列表限制时，优先保留未完成、仍然影响当前行为、与当前场景相关的项目。原始聊天仍是最终来源，不通过无限增大 Living State 保存所有历史。

Token 上限在质量验证前不是成功指标。Stage 0/早期 Stage 1 应先证明完整状态能改善输出，再逐项移除或压缩字段，以盲评确认压缩没有损害活人感和故事质量。

## 7. State Delta

### 7.1 只输出变化，不重写整份状态

State Updater 不允许每轮重新生成完整状态，而是输出固定结构的增量：

```json
{
  "sceneChanges": {},
  "characterChanges": {
    "currentMood": "惊讶，但并不排斥用户的亲近",
    "attentionFocus": "用户先征求同意的行为",
    "privateImpulse": "想试探性地回应用户",
    "inhibition": "仍需要确认这不是一时冲动"
  },
  "agencyChanges": {
    "currentPlan": null,
    "initiativeSeed": "主动问清用户如何看待双方关系",
    "boundary": null,
    "responseIfBlocked": null
  },
  "relationshipChanges": {
    "trust": null,
    "emotionalCloseness": "愿意进行更直接但仍克制的沟通",
    "authorityDynamic": null,
    "currentTension": "期待回应，同时担心关系失控",
    "evolvedPreferencesAdd": [
      {
        "change": "开始接受用户主动牵手",
        "reason": "用户先询问并尊重了她的犹豫",
        "evidenceMessageIds": [68, 69]
      }
    ],
    "evolvedPreferenceIdsRemove": []
  },
  "continuityChanges": {
    "importantFactsAdd": [],
    "importantFactIdsRemove": [],
    "openPromisesAdd": [],
    "openPromiseIdsClose": [],
    "openThreadsAdd": [],
    "openThreadIdsClose": []
  },
  "offscreenLifeChanges": {
    "recentEventsAdd": [],
    "recentEventIdsRemove": [],
    "upcomingObligationsAdd": [],
    "upcomingObligationIdsClose": [],
    "peopleOnMindAdd": [],
    "peopleOnMindIdsRemove": []
  },
  "turningPointsAdd": []
}
```

无变化时输出所有空对象和空数组，注入文本保持逐字一致。

### 7.2 合并规则

Delta 由代码合并，模型不能直接覆盖整份状态：

- 只允许更新白名单字段。
- 长期变化必须包含 `evidenceMessageIds`。
- ID 由代码根据类型、文本和来源生成，不信任模型生成的随机 ID。
- 删除或关闭项目必须引用现有 ID。
- `authorLocks` 中的规则不可由 Delta 修改。
- World Info 中的客观设定不可由 Living State 覆盖。
- 如果 Delta 无法通过 Schema 或来源检查，则丢弃 Delta，沿用旧状态。

## 8. 作者锁定规则和格式契约

V1 不尝试自动理解角色卡里的每一句话。固定角色允许人工配置两个很短的静态字段。

### 8.1 Author Locks

```json
{
  "authorLocks": [
    "不得替用户决定思想、台词或关键行动",
    "角色不能使用尚未在剧情中获知的秘密",
    "世界客观规律以 World Info 为准"
  ]
}
```

这些是不可被关系发展覆盖的作者级约束。

“不喜欢牵手”之类的角色初始倾向不应默认放入 `authorLocks`。

### 8.2 Format Contract

格式契约保持短小、固定，并继续由现有预设和示例承担主要作用：

```text
只输出角色在故事中的自然回复，不输出分析、规则说明或状态 JSON。
保持当前预设约定的动作、对白和 Markdown 格式。
不要替用户书写思想、对白或关键决定。
```

V1 不增加第二次模型校验。优先使用现有 Regex、Markdown 修复和标准示例。只有 A/B 测试证明格式仍是主要失败来源，才增加确定性 Format Gate。

## 9. 注入格式

不建议直接将完整 JSON 发送给主模型。应转换为简短、稳定的自然语言块：

```text
[Current Living State — this is the character's current state, not text to quote.]
Scene: 王都旅馆；角色与用户在场；两人刚从地下拍卖会逃脱。
Mood: 疲惫、警惕，对用户的冒险行为有些生气。
Physical state: 右手轻伤，精神疲惫。
Attention: 用户的伤势、门外动静和买家名单。
Current goal: 确认用户是否受伤，并确保藏身处安全。
Plan: 先检查伤势，再连夜整理名单；如果用户回避，她会主动拿来药箱追问。
Impulse / inhibition: 想靠近并确认对方安全；仍在生气，不愿显得无条件纵容。自然体现即可，不必强制执行或直接说明。
Boundary: 不接受用户再次隐瞒高风险计划；受阻时会暂停合作并要求说明风险。
Relationship: 高度信任但正在生气；关系亲密，脆弱面仍然克制。
Evolved preference: 已经可以接受与用户牵手，但主动时仍会掩饰动机。
Offscreen life: 天亮前必须决定是否更换藏身处；仍惦记失踪的姐姐。
Continuity: 右手仍有轻伤；答应陪用户寻找姐姐；买家名单尚未解读。
[/Current Living State]
```

约束：

- 字段顺序固定。
- 相同状态必须生成逐字相同的注入文本。
- 不写时间戳、随机 ID、向量分数或调试信息。
- 不要求模型逐项提及。
- 不把状态放在整个 System Prompt 最前面。
- 使用 `IN_CHAT`、System role；depth 1、2、4 均进入质量 A/B，不因缓存推测预先固定位置。
- 默认不参与 World Info 扫描，避免递归激活和额外提示抖动。

## 10. 回合与提交时序

### 10.1 正常用户回合

```text
用户发送消息
  → SillyTavern 将用户消息加入 chat
  → generation interceptor 读取：上一快照 + 上次选中的角色回复 + 最新用户消息
  → State Updater 输出 Delta
  → 代码校验并合并 Delta
  → 状态快照保存到最新用户消息 extra.living_state
  → 注入 Living State
  → 主模型生成角色回复
```

将快照保存到用户消息而不是刚生成的角色消息，是为了把“用户发送下一条消息”视为对上一条角色 Swipe 的隐式确认。

### 10.2 Swipe

- 新 Swipe 生成时，当前候选回复不写入状态。
- 同一个用户回合的所有 Swipe 使用同一份回合前 Living State。
- 用户选择某个 Swipe 并发送下一条消息后，下一次状态更新才处理被选中的回复。
- 因此不会将多个互相矛盾的候选同时写入状态。

### 10.3 Regenerate

- Regenerate 删除或替换当前角色候选时，继续使用当前用户消息保存的同一状态快照。
- 被替换的回复未被下一条用户消息确认，因此不需要状态回滚。

### 10.4 Continue

- Continue 属于同一条角色回复，不单独推进 Living State。
- 状态在用户发送下一条消息时统一处理完整回复。

### 10.5 编辑和删除

- 监听 `MESSAGE_EDITED`、`MESSAGE_DELETED`、`MESSAGE_UPDATED` 和 `MESSAGE_SWIPED`。
- 如果被修改消息之后存在 Living State 快照，则将这些快照标记失效。
- 找到修改点之前最近的有效快照。
- 下一次生成时，从该快照和后续有效消息重新计算状态。
- V1 如果回放尾部超过状态更新模型上下文，应提示用户并沿用最近有效状态；分块回放属于后续优化。

## 11. State Updater 提示要求

State Updater 应使用低随机性和 JSON Schema。核心规则：

```text
你是角色连续性状态更新器，不写故事回复。
根据上一状态和新增消息，只输出确实发生的状态变化。

要求：
1. 不得把可能发生、计划发生或角色猜测的内容写成已发生事实。
2. 不得因为用户单方面要求，就立刻改变角色长期偏好。
3. 关系和偏好变化需要剧情证据，并提供来源消息 ID。
4. 已有状态如果没有被新事实改变，保持不变。
5. 角色卡中的初始倾向可以合理演化；authorLocks 和世界客观事实不可修改。
6. privateImpulse 描述潜在内心冲动，不代表下一条回复必须执行。
7. 无变化时输出空 Delta。
8. 只输出符合 Schema 的 JSON。
```

输入包括：

- 上一版 Living State。
- `authorLocks`。
- 固定角色核心的简短摘要。
- 上一状态之后的消息及其 message ID。
- 当前生成类型。

不需要把完整 World Info 或全部角色卡重复发送给 State Updater。

## 12. 缓存、Token、成本与延迟

### 12.1 主模型 Prompt Cache

加入动态 Living State 后，完整请求缓存命中率通常会下降。候选注入位置通过质量 A/B 后，优先选择能将动态影响限制在提示词末端的方案：

```text
固定预设                    可缓存
固定角色卡                  可缓存
固定世界书/大部分历史       尽量缓存
Living State               动态
最新用户消息                动态
```

禁止把 Living State 放在最前面的 System Prompt，也禁止每轮重写整个角色卡。

多数供应商的 Prompt Cache 依赖从请求开头开始的稳定前缀。Living State 的目标不是让整次请求逐字不变，而是避免不必要地破坏前方原本可缓存的预设、角色卡、World Info 和大段历史。但注入位置首先由输出质量 A/B 决定，缓存只用于在质量相当的候选中择优。因此注入位置满足：

- 使用 `IN_CHAT`、System role，在 depth 1、2、4 中实测；质量相当时选择更靠后的缓存友好位置。
- 不插入预设和角色卡之前。
- 不因 UI 展示方式改变注入文本。
- 状态没有语义变化时，不改变任何空格、标点、字段顺序或数组顺序。
- 不把调试信息、更新时间、调用耗时、来源 ID 或 token 数写入主模型注入块。

需要通过实际请求日志分别记录“缓存前缀长度”和“未缓存尾部长度”。供应商只返回总 cached input token 时，用相邻回合请求差异进行估算，不假设所有 API 的缓存规则相同。

### 12.2 State Updater 自身的缓存布局

State Updater 请求也采用稳定前缀、动态尾部：

```text
固定 Updater 契约 / JSON Schema       稳定，可缓存
固定角色核心摘要 / authorLocks       稳定，可缓存
上一版 Living State                  低频变化
本轮新增的已接受消息                  每轮变化
```

固定角色核心摘要在首次启用或角色卡变更时生成并保存，之后直接复用，不在每轮重新生成。JSON Schema 使用固定字段和固定顺序，避免因序列化抖动使缓存失效。

如果供应商不支持显式或隐式 Prompt Cache，此布局仍可减少日志差异和调试复杂度，但不得把“预计缓存”记作真实命中。

### 12.3 降低状态抖动

- State Updater 只输出 Delta。
- 无变化时保持注入文本逐字一致。
- 字段和数组按稳定顺序输出。
- 不加入时间戳、随机值和相似度分数。
- 长期状态只有真正发生变化时才更新。
- `currentMood` 和 `privateImpulse` 是最容易变化的字段，应保持简短。

合并 Delta 后先做语义比较：规范化前后状态完全相同时，不增加 `version`，不重写消息快照，不调用 `setExtensionPrompt`。数组项目使用稳定 ID 排序；用户手动排序只影响 UI，不影响注入序列。

### 12.4 Token 预算与裁剪顺序

质量验证期先使用 600～1,200 token 的宽松状态预算，确认哪些字段确实改善女主表现。通过质量门槛后再提供三个运行档位：

| 档位 | 主模型状态注入 | Updater 输入上限 | 适用场景 |
|---|---:|---:|---|
| Compact | 250～400 token | 2,000～4,000 token | 日常短对话、成本优先 |
| Balanced | 400～650 token | 4,000～8,000 token | 质量验证后建议默认值 |
| Detailed | 650～900 token | 8,000～12,000 token | 多线剧情、调试评测 |

正式运行时预算是硬约束，不因模型上下文上限很大而自动膨胀。即使当前主模型允许百万级上下文，Harness 仍只承担“当前工作状态”，不复制完整聊天摘要。验证阶段允许临时超过未来默认预算，但必须记录实际 token，防止无界增长被误判为质量收益。

超出预算时按以下顺序处理：

1. 删除已关闭事项和失效的短期状态。
2. 合并语义重复的事实、承诺和开放线索。
3. 缩短原因和证据说明；证据 ID 保留在存储层，不进入主提示。
4. 保留当前场景、当前目标、边界、未完成承诺和最近转折。
5. 仍超限则停止新增低优先级项目，并在 UI 显示预算警告，不静默截断 JSON。

每次压缩都必须回到固定评测集复测。如果 token 下降同时让自主性、情绪连续性或故事推进显著退化，则撤销该压缩，即使它改善了缓存或费用。

扩展在调用前使用当前连接的 tokenizer 估算 token；无法获得对应 tokenizer 时使用保守字符估算并标记为 estimate。UI 同时显示“存储状态 token”和“实际注入 token”，避免把完整 JSON 大小误认为发送成本。

### 12.5 额外调用成本

V1 每个正常用户回合增加一次短结构化调用。Swipe、Regenerate 和 Continue 复用现有状态，不重复更新。

这会增加延迟和成本。V1 优先验证质量收益，不先实现复杂的“是否需要更新”分类器。确认有效后，可在 V1.1 增加：

- 普通闲聊跳过更新。
- 每 3～5 轮兜底更新。
- 关系、地点、人物、承诺、物品或转场触发更新。
- 使用更便宜的结构化抽取模型。

Updater 默认只在正常用户回合调用一次。以下操作不得增加调用：打开 UI、折叠状态卡、切换 UI 主题、复制状态、Swipe、Regenerate、Continue。Freeze 后不调用 Updater，但继续注入冻结状态；Disable 后既不调用也不注入。

### 12.6 必须记录的指标

- 主请求总输入 token。
- cached input token（供应商支持时）。
- Living State 注入 token。
- State Updater 输入/输出 token。
- State Updater 调用次数、失败次数和平均延迟。
- 主回复首 token 延迟。
- 每轮总费用。
- 主请求缓存前缀 token、未缓存 token 和缓存命中变化。
- “状态未变化而跳过写入”的次数。
- 因预算发生的合并、裁剪和拒绝新增次数。

不能只看缓存命中百分比，应同时看未缓存 token、总成本和质量提升。

## 13. UI 设计

### 13.1 双层 UI

V1 将日常状态展示和工程调试分开，避免普通用户面对原始 JSON。

入口放在扩展面板，并在网页端聊天标题栏增加一个低干扰状态按钮。按钮使用小圆点表达运行状态：绿色表示已更新，蓝色表示冻结，黄色表示沿用旧状态或预算告警，红色表示更新失败；不得只依赖颜色，必须同时提供图标、文字和 tooltip。

### 13.2 日常状态卡

点击状态按钮打开可停靠抽屉或浮层：

```text
┌─ 小雅 · 当前状态 ─────────────────────┐
│  稳定人格  教师式克制 · 重视边界       │
│                                       │
│  此刻                                 │
│  情绪       疲惫，对刚才的敷衍不满     │
│  注意力     明早的课程与用户的异常情绪 │
│  当前目标   确认功课，同时弄清发生何事 │
│  冲动       想直接关心对方             │
│  制约       不愿显得过分软弱           │
│                                       │
│  关系                                 │
│  信任       有所增加                   │
│  当前张力   关心与长辈权威并存         │
│                                       │
│  待续  2                              │
│  · 今晚背诵《劝学》的约定              │
│  · 明早提前到校处理班级事务            │
│                                       │
│  [冻结] [编辑] [查看变化] [更多…]      │
└───────────────────────────────────────┘
```

展示原则：

- 使用短句和语义分组，不展示大段 JSON。
- 颜色只表示类别和状态，不把关系做成好感度进度条。
- `privateImpulse` 使用“冲动/未说出口”样式，但不制造神秘数值。
- 长列表默认折叠，显示数量与最高优先级项目。
- 网页端使用可调整宽度、可固定的右侧抽屉；窄窗口时允许浮层显示，但不得遮挡输入框。
- 状态卡内容来自已保存状态，不触发任何模型调用。
- 支持复制“可读状态”和“原始 JSON”，两者明确分开。

### 13.3 本轮变化视图

状态更新成功后，可在按钮上短暂显示非打扰式提示，例如“状态更新 · 3 项变化”。点击后显示语义 Diff：

```text
情绪       平静 → 有些担心
当前目标   检查功课 → 先确认用户是否遇到麻烦
+ 承诺     明早检查《劝学》
```

不变化的字段默认隐藏。每项长期变化可展开查看证据消息，并跳转到对应聊天位置。证据展示使用消息摘要，避免在状态卡重复渲染整段长消息。

### 13.4 编辑、冻结和恢复

- 普通编辑器使用表单字段和可增删列表。
- 高级编辑器提供原始 JSON，并在保存前进行 Schema 校验和 token 预估。
- 手动修改生成一个 `manual` 来源记录，可以撤销到修改前快照。
- Freeze 保留显示和注入，但停止自动更新。
- Disable 停止更新与注入，但不删除状态。
- Reset 只清空当前聊天状态，必须二次确认。
- Rebuild 从最近有效快照回放，执行前显示预计消息数、调用次数和成本提示。

### 13.5 设置与调试页

基础设置只提供：

- Enable / Disable。
- Compact / Balanced / Detailed 预算档位。
- Freeze / Unfreeze。
- 注入深度实验值 1 / 2 / 4；完成质量 A/B 后再确定默认值。
- 主模型跟随或独立 Updater 连接。
- 与现有 Summary / seeds 检测到重叠时的兼容提示。

高级调试折叠区提供：

- 上一 Delta、Schema 校验结果和来源消息 ID。
- 当前状态版本、最后处理消息和快照有效性。
- Updater 输入/输出 token、延迟与估算费用。
- 主提示实际注入 token、缓存 token 和未缓存 token。
- 最终注入文本预览及其在 Prompt Manager 中的位置。
- 最近错误、降级原因和裁剪记录。

V1 不提供关系数值仪表盘、好感度进度条、可视化关系图、时间线拖拽编辑器或世界书管理器。美化服务于快速理解当前状态，不能把角色重新包装成游戏数值系统。

## 14. 故障降级

| 故障 | V1 行为 |
|---|---|
| State Updater 超时 | 沿用旧状态，继续主生成 |
| 返回非 JSON | 丢弃 Delta，记录日志 |
| JSON Schema 不通过 | 丢弃 Delta，记录字段错误 |
| 引用了不存在的消息 ID | 丢弃对应长期变化 |
| 状态超过 token 上限 | 按优先级裁剪已关闭或低相关项目 |
| 状态与 authorLocks 冲突 | authorLocks 优先，拒绝对应更新 |
| 用户不喜欢状态影响 | 可冻结、编辑或关闭扩展 |

## 15. 主要风险与控制

### 15.1 状态幻觉

风险：State Updater 把未发生内容写入状态。

控制：

- 长期变化必须提供来源消息 ID。
- 使用 JSON Schema 和字段白名单。
- 只输出 Delta。
- 调试界面显示来源。
- 用户可以编辑和重建。

### 15.2 角色被状态文本操控得过于机械

风险：主模型逐项执行状态，回复像任务清单。

控制：

- 状态描述而非命令。
- `privateImpulse` 明确为可自然体现的倾向。
- 限制开放剧情线数量。
- 不加入固定 Beat Plan。
- A/B 评测重复感和说教感。

### 15.3 关系变化过快

风险：模型因为用户一句话就改变长期态度。

控制：

- 长期变化需要 evidence message ID。
- 提示中区分用户要求、角色反应和实际接受。
- 原始角色倾向保留，Living State 记录演化理由。

### 15.4 状态覆盖世界设定

风险：对话中的错误说法被当作客观世界事实。

控制：

- World Info 优先于 Living State。
- V1 不允许 State Updater修改世界规则。
- `importantFacts` 只记录当前剧情连续性，不承担世界百科功能。

### 15.5 缓存和延迟恶化

风险：每轮动态状态降低缓存，并增加一次调用。

控制：

- 先通过质量 A/B 选择注入位置，再在质量相当时优先近端注入。
- Delta 更新和稳定序列化。
- 质量验证后设置严格 token 上限。
- Swipe/Regenerate 不重复更新。
- 分开报告质量收益与成本变化，不允许缓存指标否决已经证明有效且成本可接受的质量提升。

## 16. 评测方案

### 16.1 评测对象

固定以下变量：

- 同一角色卡。
- 同一预设。
- 同一模型和采样参数。
- 相同用户输入和起始聊天历史。

比较：

- Baseline：当前 SillyTavern 配置。
- Treatment：Baseline + Living State Harness。

### 16.2 场景集合

至少准备 40 个场景：

- 10 个普通互动。
- 10 个关系和态度变化。
- 10 个长距离连续性与承诺召回。
- 10 个剧情停滞、冲突或转场。

额外覆盖：

- “不喜欢牵手”在关系发展后的合理变化。
- 用户单方面要求角色改变，但角色尚无理由接受。
- Swipe 后选择另一版本。
- Regenerate。
- 编辑或删除过去消息。
- 角色同时喜欢用户又对用户生气。
- 未完成剧情线被自然重新提起。

### 16.3 核心指标

人工盲评 1～5 分：

- 活人感。
- 是否拥有独立于用户的注意力、事务和选择。
- 角色一致性。
- 情绪和态度连续性。
- 关系变化合理性。
- 自主性和私人动机。
- 剧情自然推进能力。
- 场景是否产生新的、合乎人物逻辑的行动与后果。
- 回复是否只是复述状态或按清单逐项执行（反向指标）。
- 文风自然度。
- 重复感和机械感（反向指标）。

自动或半自动指标：

- 格式合规率。
- 重要事实召回率。
- 已关闭剧情线被错误重启次数。
- Swipe/Regenerate 状态污染次数。
- authorLocks 违规次数。
- 平均输入 token、缓存 token、延迟和费用。

### 16.4 V1 成功标准

V1 分两道门槛。第一道是必须通过的质量门槛：

1. 活人感和故事输出质量的盲评明显优于 Baseline。
2. 女主的自主性、独立注意力、情绪连续性和主动行为至少三项稳定提升。
3. 剧情推进来自人物动机和当前局势，而不是 Harness 的任务清单感。
4. 文风自然度不下降，机械感和重复感不显著增加。
5. 角色一致性和格式合规率不低于 Baseline。

只有通过第一道门槛，才进入第二道工程门槛：

1. Swipe、Regenerate 不产生可观察的状态串线。
2. 状态失败能够降级，不阻断主聊天。
3. 增加的延迟和成本在目标使用场景可接受。
4. 在不降低质量的前提下，找到最小有效状态预算和最佳缓存友好注入位置。

如果质量提升不明显，则不继续扩展框架，应优先调整角色卡、预设、模型或 State Updater 提示。

## 17. 实施顺序

### Stage 0：无代码验证

在 Author's Note 中人工维护一份信息充分的 Living State，进行小规模 A/B，确认“当前动机 + 制约 + 独立事务 + 主动计划 + 当前态度 + 合理演化 + 开放剧情线”是否能提升目标女主的活人感和故事输出质量。此阶段不为了 token 或缓存主动删字段。

如果人工状态注入都没有明显收益，应先检查模型和角色卡，而不是开发 Harness。

### Stage 1：最小扩展

- 创建第三方扩展和 generation interceptor。
- 接入 `generateRaw` + JSON Schema。
- 实现 Living State、Delta 合并和近端注入。
- 在用户消息 `extra` 中保存快照。
- 提供查看、冻结、编辑和重置。
- 完成基础日志与 A/B。

Stage 1 先实现质量验证所需的完整字段和网页端状态抽屉，不先实现复杂触发器或极限压缩。

### Stage 1.1：质量确认后的优化

- 增加“是否需要更新”的轻量触发器。
- 支持独立低成本状态模型。
- 改进旧消息编辑后的回放。
- 优化缓存和状态裁剪。
- 用消融实验删除无贡献字段，确定 Compact / Balanced / Detailed 的实际预算。

### Stage 2：仅在数据证明需要时

- 确定性 Format Gate。
- 重要记忆的混合检索。
- 更细的知识边界。
- 多角色状态。
- 轻量剧情导演或定向修复。

## 18. 技术选型结论

V1 不使用 Pi Agent、Deep Agents 或 DeepSeek Harness。

理由：

- 当前工作流是确定性的单步状态更新，不需要开放式 Agent Loop。
- SillyTavern 已经提供模型调用、JSON Schema、生成拦截、Prompt 注入和消息事件。
- 引入通用 Harness 会重复已有能力并增加工具提示、状态同步和调试复杂度。

V1 使用：

- 原生 JavaScript / TypeScript 风格实现 SillyTavern 第三方扩展。
- SillyTavern `generateRaw` 完成状态更新。
- SillyTavern `setExtensionPrompt` 完成近端注入。
- 消息 `extra` 保存状态快照。
- 现有事件系统处理 Swipe、编辑和删除。

只有后续确认需要复杂重试、多个质量步骤或独立服务时，才重新评估 `pi-agent-core`。

## 19. 待评审问题

1. 目标角色是否允许人工配置一小组 `authorLocks`？
2. State Updater 默认使用主模型，还是允许选择更便宜的独立模型？
3. 600～1,200 token 的验证状态中，哪些字段对活人感和故事质量有可测贡献？
4. depth 1、2、4 哪个质量最好；质量相当时哪个缓存和成本表现更好？
5. 当前 Summary 扩展在启用 Living State 后应关闭，还是仅作为长期历史摘要保留？
6. 用户是否需要查看并手动修正状态来源？
7. 可接受的额外平均延迟和单轮成本上限是多少？
8. V1 是否只支持单人聊天，明确排除 Group Chat？
9. 对旧消息深度编辑，V1 是完整重建、有限回放，还是提示用户手动重置？
10. A/B 评测使用哪个固定角色、模型和预设作为首个基准？

## 20. 最终决策建议

先完成 Stage 0 的人工状态注入实验。如果盲评确认有效，再实现 Stage 1。

Stage 1 的产品形态应始终保持为：

> 一份可追溯、可编辑、短小的当前角色状态，在每轮主生成前增量更新，并注入最新对话附近。

不要在 V1 扩展成通用 Agent、剧情工作流平台或完整记忆数据库。北极星不是功能数量、最低 token 或最高缓存命中，而是相同角色卡、相同模型下，女主是否更像一个拥有自身生活、会记住、会变化、会判断并主动行动的人，以及这些变化是否让故事输出更自然、更连贯、更有张力。只有质量门槛通过后，才以不损害质量为前提优化 token、延迟、费用和缓存。
