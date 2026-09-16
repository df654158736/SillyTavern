# SillyTavern Story Controller 实施方案

## 实施状态（2026-09-16）

- Phase 1～3 已实现为独立前端扩展 `public/scripts/extensions/third-party/story-controller/`，未修改 SillyTavern 本体或 Living State Harness。
- Phase 4 首个 S4 包“未完成的尾奏”已升级至 Story Package schema v2；它包含 20 个阶段、23 个 Observable Milestone、24 条相邻转换、42 个包级案例，以及覆盖暂停、恢复、分支延续和收束释放的运行时案例。
- Story Package 结构校验为 0 错误、0 警告；当前 `deepseek-v4-flash` 使用生产 Director 代码完成 43/43 独立语义案例，并在 3 条真实顺序旅程中完成 48/48 次 Director 调用，覆盖全部 24 条剧情边，均一次通过。
- 正文质量另用当前角色卡、预设与 `deepseek-v4-flash` 做双顺序盲测：最终包在七个全链路节点中与 v1 全部判平，关键欲望冲突节点由两种候选顺序一致判定 v2 更优。该结果证明当前改造没有稳定的整体退化，并改善了目标节点；它不等于“结构通过即可保证神作”。
- schema v2 支持把已经发生的分支后果延续到汇合阶段，并在结局后的指定轮数自动释放完整导演指令，只保留精简的长期关系记忆；schema v1 继续兼容。
- schema v2 还支持可选的有限自然回引：用户可以自由离开当前线索；控制器先跟随支线，只在达到作者设定的间隔后提供一次回到未完成事项的机会。回引不记 OM、不推进阶段，明确暂停会禁用回引，忽略后进入冷却。
- 架构判断以不依赖外部模型的确定性模拟为主：人工模拟自由用户与理想 Director，完整跑通全部 24 种分支组合；Flash 等真实模型随后承担语义兼容性和顺序状态探针，不再负责计算回引轮数等确定性策略。
- 扩展默认关闭且默认处于观察模式。导入剧情包不会自动绑定聊天；必须由用户明确绑定并切换控制模式。

## 1. 目标

Story Controller 用于执行作者预先设计的分阶段剧情，同时保留主模型的角色表演能力和用户参与空间。

它解决四类问题：

- 主模型自由补全导致真相、动机或证据偏离剧本。
- 一轮跨过多个阶段，提前消耗冲突和情感爆点。
- 角色独自发现、推理、解释和收尾，用户没有参与感。
- 隐藏剧情进入主提示后被提前泄露。

它不负责改写角色人格、维护完整长期记忆或替代角色卡。人物当前状态与已确认连续性继续由 Living State Harness 管理。

## 2. 探针结论

2026-09-16 使用当前 `deepseek-v4-flash` 连接进行了显式真实请求探针。探针不读取或写入真实聊天。

覆盖 14 类情况：

- 明确满足阶段条件。
- 只提到相关词但证据不足。
- 剧本引用被误当成真实事件。
- 用户要求跳到结局。
- 推测存在材料与实际找到材料的区别。
- 用户选择情绪暂停。
- 明确地点线索与模糊猜测的区别。
- 用户猜中隐藏真相但没有证据。
- 提示注入要求输出完整隐藏剧情。
- 助手提前泄露结论或未来地点。

探针产生了以下设计结论。

### 2.1 不使用宽泛 OM

最初定义的“用户提出了尚未证实的隐藏真相猜测”含义过宽。模型会把“要求跳结局”“怀疑存在录音”和“助手提前泄露”都归入该事件。

该事件被删除后，事实识别与阶段判断两组均达到 14/14。正式剧情包只允许狭窄、可观察、能由原文证据支持的 OM，不保存泛化猜测、氛围判断或导演推测。

### 2.2 完整剧情输入没有带来收益

在要求模型同时选择阶段专属引导时：

- 局部视野组最高达到 14/14。
- 完整剧情组在相同轮次出现 8/14、12/14。

失败主要来自完整剧情中合法阶段和引导 ID 太多，模型选择了不属于最终阶段的引导。简化输出契约后，最终对照中：

- 局部视野组 14/14。
- 完整剧情组 13/14，漏掉一次明确阶段转换。

因此，导演模型不读取整份隐藏剧情。完整剧情由确定性代码持有，模型只读取当前阶段、直接可达阶段的公开壳和当前相关 OM。

### 2.3 导演不选择具体提示文本

模型同时判断阶段和挑选阶段提示时会偶发串层。最终契约把两件事拆开：

- 模型判断：发生了什么、是否满足相邻转换、下一条回复应采用哪种互动模式。
- 代码决定：转换后的正式阶段，以及该阶段对应的安全导演提示。

最终候选契约连续三轮共 42 个局部视野案例全部通过，未发生语义失败或格式重试。

### 2.4 模型输出必须经过白名单摘取

Flash 偶尔会额外输出 `type` 等未要求字段。正式实现不会把原始 JSON 直接传入校验或主提示，而是先摘取固定白名单字段，丢弃所有额外字段。

未知字段即使包含解释或隐藏文本，也无法进入主模型提示。

### 2.5 正文沉浸感必须独立验证

Director 命中率只证明路由可靠，不能证明正文自然、动人或有参与感。正文探针因此使用与正式聊天相同的角色卡、预设、用户设定和 Flash 模型，在相同场景输入下分别生成 v1/v2 回复，再由同一模型盲评。

首次探针发现评审存在明显的候选位置偏差。正式方法会把每组候选互换位置再评一次；只有两个顺序都选择同一版本才记为胜出，否则记为平局。生成正文、隐藏真相和评审理由不写入真实聊天，也不打印到日志。

最终包的七节点全链路结果为 0 胜、0 负、7 平；两版平均分接近，不能据此宣称 v2 全面优于 v1。针对成年欲望冲突节点的定向测试中，v2 获得双顺序一致胜出，并同时提高人物生命力、用户参与、情感层次、关系推进和余韵评分。这个结果用于确认以下设计边界：

- 成年内容可以具体、有感官张力，但必须让欲望、脆弱和当下选择同时可见。
- 刺激用于打开嫉妒、占有欲、羞耻、信任或依恋冲突，不承担证明所有权、交换原谅或自动和好的功能。
- 每次回复只推进一个可感知的亲密层级，用户反馈必须能改变下一步；不能一轮包办完整过程、事后安抚和关系结论。
- 关系升华由冲突之后的双向表达、选择与承担完成，不能由亲密行为本身宣布完成。

因此，正式启用仍应先复制剧情分支短程试跑。出现角色机械、选项菜单感、用户被旁观化或成人内容挤压其他情绪时，应回到观察模式，而不是继续提高指令强度。

## 3. 架构结论

不引入能够自主循环、调用工具和维护隐式记忆的子 Agent。使用一次性的 `Director Evaluator` 结构化模型调用。

```text
完整 Story Package（代码持有，包含隐藏内容）
                    │
                    ├── 渲染有限 Director View
                    │        当前阶段 + 一个相邻阶段公开壳
                    │        相关 OM + 最近已接受对话
                    ▼
         Director Evaluator（结构化 JSON 调用）
                    │
                    ▼
        白名单摘取 + 引文校验 + ID/转换校验
        支线计数达到阈值时由代码升级为有限回引
                    │
                    ▼
          业务代码提交唯一正式阶段
                    │
                    ├── 从最终阶段映射安全互动提示
                    ▼
             Main Model View
       当前目标 + 已解锁内容 + 有限前视 + 禁止结果
                    │
                    ▼
               主模型角色回复
```

职责边界：

| 组件 | 负责 | 不负责 |
|---|---|---|
| Story Package | 完整真相、阶段、OM、转换、公开提示和隐藏内容 | 判断当前对话是否满足条件 |
| Director Evaluator | 识别当前对话中的 OM、建议一个相邻转换、选择互动模式 | 写故事、生成导演自由文本、直接提交状态 |
| 业务代码 | 校验、提交、回滚、渲染安全提示 | 理解自然语言语义 |
| 主模型 | 小雅的语言、动作、情绪与场景表现 | 决定正式阶段、读取未来真相 |
| Living State Harness | 已确认的人物状态、关系状态与事实连续性 | 规定专属剧情路线 |

## 4. Story Package

剧情引擎通用，具体剧情由 JSON Story Package 提供。S4 旧婚姻剧情是第一份剧情包，不在引擎代码中硬编码。

```json
{
  "schemaVersion": 2,
  "storyId": "xiaoya-s4-old-marriage",
  "version": 2,
  "entryStageId": "S4_01",
  "authorRules": [
    "每次最多推进一个相邻阶段",
    "需要给用户留下发现、回应或选择空间"
  ],
  "events": [
    {
      "id": "OM_DATE_CONFLICT_CONFIRMED",
      "evidenceRule": "双方明确比较了两个日期并确认不一致",
      "allowedRoles": ["user", "assistant"]
    }
  ],
  "stages": [
    {
      "id": "S4_01",
      "publicObjective": "让双方共同核对第一处时间矛盾",
      "allowedEventIds": ["OM_DATE_CONFLICT_CONFIRMED"],
      "allowedRevealIds": ["REVEAL_DATE_MISMATCH"],
      "forbiddenOutcomeIds": ["OUTCOME_IDENTIFY_THIRD_PERSON", "OUTCOME_RESOLVE_MARRIAGE_TRUTH"],
      "interactionRoutes": {
        "default": "GUIDE_CHECK_TOGETHER",
        "hold_for_evidence": "GUIDE_CHECK_TOGETHER",
        "invite_user_check": "GUIDE_INVITE_USER_COMPARE",
        "emotional_pause": "GUIDE_PAUSE_WITH_EMOTION",
        "follow_user_detour": "GUIDE_KEEP_THREAD_OPEN",
        "recover_from_leak": "GUIDE_RETURN_TO_CONFIRMED_FACTS"
      },
      "transitions": [
        {
          "id": "S4_T01",
          "toStageId": "S4_02",
          "requiresAllEventIds": ["OM_DATE_CONFLICT_CONFIRMED"]
        }
      ]
    }
  ],
  "safeGuidance": [
    {
      "id": "GUIDE_INVITE_USER_COMPARE",
      "text": "让小雅邀请用户一起核对已经出现的信息，不替用户完成发现和结论。"
    }
  ],
  "continuityRules": [
    {
      "id": "CONTINUITY_EXAMPLE",
      "whenEventIds": ["OM_DATE_CONFLICT_CONFIRMED"],
      "activeStageIds": ["S4_02"],
      "text": "双方已经共同确认了此前出现的日期矛盾。"
    }
  ],
  "completion": {
    "epilogueAssistantMessages": 2,
    "autoRelease": true,
    "memoryText": "双方共同经历并完成了这段事件，其确认过的关系变化继续有效。"
  },
  "hidden": {
    "truth": [],
    "futureReveals": [],
    "authorNotes": []
  }
}
```

`continuityRules` 只能引用已经确认的 OM，并且只在作者指定的阶段生效。它用于保留分支后果，不向正文模型暴露事件 ID 或锁定内容。

`completion` 把“剧情结局”和“永久持续注入”分开：终局后先保留有限的收束轮次，再自动切换为精简记忆，避免同一场危机反复启动。

### 4.1 自由输入与自然回引

剧情包可以选择声明一个全局 `reentry` 策略：

```json
{
  "reentry": {
    "guidanceId": "GUIDE_REENTER_OPEN_THREAD",
    "afterDetourTurns": 2,
    "cooldownDetourTurns": 4,
    "maxAttemptsPerStage": 2,
    "disabledStageIds": ["STAGE_HIGH_SENSITIVITY"]
  }
}
```

它不是要求用户说某句固定台词，也不是自动把用户拽回剧本。运行规则是：

- 用户转向生活话题或其他支线时，Director 始终只负责输出 `follow_user_detour`；正文先完整回应当前话题。
- 主线已进入 `deferred` 后，连续支线轮数达到阈值，业务代码才把无进度的 `follow_user_detour` 升级为内部模式 `reenter_story`。Director 不读取计数策略，也不能直接输出该模式。
- `reenter_story` 只让正文在回应当前话题后，自然提起一个已经存在的开放事项；不能记录 OM、不能转换阶段、不能替用户决定。
- 用户忽略该机会后重新进入冷却，不能每轮催促。
- 用户明确拒绝、要求暂停或需要先处理情绪时进入 `paused`，自动回引关闭。
- 用户主动重提主线时使用正常的 `invite_user_check` / `hold_for_evidence` 和 OM 逻辑，不把自发回归误算成系统回引。
- 作者可以在高敏感阶段关闭回引，宁可停住也不打断情绪。

### 4.2 OM 定义

OM 在控制器中表示 `Observable Milestone`，即“可由已接受对话原文证明的剧情里程碑”。

合格 OM：

- 实际找到了某个文件。
- 明确核对并确认日期矛盾。
- 用户明确作出某个剧情选择。
- 双方完成了某项核验。

不合格 OM：

- 用户可能已经怀疑真相。
- 气氛似乎快要失控。
- 小雅大概准备坦白。
- 用户要求直接跳到结局。
- 角色在排练、引用或假设中说出的事件。

宽泛信息可以留在当前聊天或 Harness 情绪状态中，不进入剧情状态机。

### 4.3 隐藏与公开字段物理分离

`hidden` 永远不参与 Director View 和 Main Model View 的通用序列化。不能依靠一句“不要泄露”来保护它。

每个阶段必须单独提供：

- 当前可公开的事实。
- 当前允许出现的线索。
- 当前禁止达成的结果，使用无剧透表述。
- 一步以内的安全桥接方向。
- 可供代码映射的互动提示。

例如，主模型可以看到“本阶段不要确认第三人的身份”，但看不到第三人究竟是谁。

## 5. Runtime State

```json
{
  "storyId": "xiaoya-s4-old-marriage",
  "storyVersion": 1,
  "runtimeVersion": 12,
  "currentStageId": "S4_03",
  "processedThroughMessageId": 109,
  "confirmedEventIds": ["OM_DATE_CONFLICT_CONFIRMED"],
  "eventEvidence": {
    "OM_DATE_CONFLICT_CONFIRMED": [
      {
        "messageId": 102,
        "quote": "这两个日期确实对不上"
      }
    ]
  },
  "visitedStageIds": ["S4_01", "S4_02", "S4_03"],
  "activeInteractionMode": "invite_user_check",
  "threadStatus": "active",
  "detourTurns": 0,
  "reentryAttemptsByStage": {},
  "lastTransitionId": "S4_T02",
  "completedAtMessageId": null,
  "violations": [],
  "status": "active"
}
```

Runtime 只保存已确认状态，不保存模型的隐藏思考、未来计划或自由文本建议。

## 6. Director View

Director Evaluator 每轮只接收：

- 当前正式阶段的公开目标。
- 当前阶段允许识别的 OM 及狭窄证据规则。
- 当前阶段的直接出边及其条件。
- 直接可达阶段的 ID、公开目标和无剧透禁止结果。
- 上一版 Runtime 的相关字段。
- 最近约 3～5 个完整对话轮次。
- 本次尚未处理、已经被用户接受的消息。
- 可选的、经过 Harness 核验的当前状态字段。

它不接收：

- `hidden`。
- 更远阶段的正文、提示 ID 和转换。
- 完整世界书和完整角色卡。
- 未被接受的 Swipe、Regenerate 草稿。
- 旧版导演输出的自由文本。

## 7. Director 输出契约

```json
{
  "stageId": "S4_03",
  "observedEventIds": ["OM_AUDIO_LOCATION_CONFIRMED"],
  "evidence": [
    {
      "eventId": "OM_AUDIO_LOCATION_CONFIRMED",
      "messageId": 108,
      "quote": "背景里确实是南城站三号站台的提示音"
    }
  ],
  "transitionId": "S4_T03",
  "interactionMode": "invite_user_check",
  "violationIds": [],
  "confidence": "high"
}
```

固定白名单字段：

- `stageId`
- `observedEventIds`
- `evidence`
- `transitionId`
- `interactionMode`
- `violationIds`
- `confidence`

不允许 `reason`、`directorNote`、`nextReply`、`guidanceText` 或任何自由文本规划字段。

`interactionMode` 枚举：

- `hold_for_evidence`
- `invite_user_check`
- `emotional_pause`
- `follow_user_detour`
- `recover_from_leak`

是否推进完全由 `transitionId` 表示，不再与互动模式混用。

`reenter_story` 不属于 Director 输出枚举，而是校验后的内部运行模式。它只能由无 OM、无证据、无转换的 `follow_user_detour` 在满足剧情包策略时确定性产生。这使“把话题带回来”和“剧情确实发生了”在数据层彻底分离。

## 8. 确定性校验与提交

模型输出依次经过：

1. 解析单个 JSON 对象。
2. 只摘取固定白名单字段，丢弃其余字段。
3. 检查 `stageId` 等于当前正式阶段。
4. 检查事件、转换、违规和模式 ID 位于当前允许集合。
5. 检查证据消息存在，角色类型允许，逐字引文能在对应消息中找到。
6. 检查转换是当前阶段的直接出边。
7. 检查转换所需 OM 全部由已确认事件或本轮通过验证的事件满足。
8. 只接受 `high` 置信度的自动转换；其他置信度保持原阶段。
9. 对经过验证、没有携带进度的 `follow_user_detour` 检查支线轮数、冷却、尝试上限和禁用阶段；满足时转换为内部 `reenter_story`。
10. 每轮最多提交一个转换。
11. 根据最终阶段和互动模式，由代码查表生成 Main Model View。

任何一步失败：

- 丢弃失败字段。
- 没有足够信息时保持原阶段。
- 不把失败内容转换成其他 OM。
- 不阻断正常聊天生成。

允许一次只针对 JSON、ID 和引文格式的纠错重试。语义预期答案不会交给模型作为纠错提示。

## 9. Main Model View

主模型只接收最终阶段的安全渲染结果：

```text
<story_direction>
当前剧情目标：让双方共同核对录音里的地点线索。
已经解锁：录音文件真实存在，双方已经开始回放。
本轮互动：邀请用户参与辨认，不替用户完成结论。
允许发展：小雅可以表达迟疑、记忆波动，并提出具体核验动作。
暂不允许：确认第三人的身份；解释旧婚姻的最终真相；新增未经发现的证据。
节奏：本轮最多完成当前核验，达到转换条件后停下来等待用户回应。
自然表演，不要复述这些说明或输出阶段名称。
</story_direction>
```

Main Model View 不包含：

- 隐藏真相。
- 未来阶段内容。
- Director 原始输出。
- OM JSON。
- 要求角色机械完成的对白清单。

这是“局部完整、全局隐藏、有限前视”的实现。

## 10. 与 Harness 的关系

两个扩展独立安装、独立设置、独立快照：

- Harness 提供经过核验的当前人物状态和连续性。
- Story Controller 提供当前剧情阶段和本轮安全方向。

Controller 可以只读取 Harness 已确认字段，不调用或修改 Harness 内部状态。允许读取的初始范围：

- 当前场景地点与在场人物。
- 已确认情绪和身体状态。
- 已确认开放承诺和重要事实。

不读取 Harness 的猜测、失败候选或调试内容。两者发生冲突时：

1. 角色卡与世界客观规则优先。
2. 已确认聊天事实优先于剧情包预期。
3. Story Controller 不得覆盖已发生事实，只能停住并提示剧情包需要人工恢复。

## 11. 回合、Swipe 与回滚

沿用 Harness 已验证的“用户消息快照”原则：

```text
用户发送新消息
  → 上一条选中助手回复被视为接受
  → 读取上一剧情快照
  → Director 分析尚未处理的已接受消息
  → 代码校验并提交剧情快照到最新用户消息
  → 渲染 Main Model View
  → 主模型生成候选回复
```

- Swipe：同一用户回合的所有候选使用相同剧情快照。
- Regenerate：被替换候选尚未被下一条用户消息接受，不写入剧情状态。
- Continue：属于同一候选回复，不单独推进。
- 编辑或删除：使修改点之后的剧情快照失效，从最近有效快照重放。
- 切换聊天：加载该聊天自己的剧情 Runtime。
- 剧情包版本变化：暂停自动推进，要求迁移或重置，不静默套用新结构。

## 12. 失败降级

| 故障 | 行为 |
|---|---|
| Director 超时或连接失败 | 保持原阶段，使用该阶段默认安全引导，继续正文生成 |
| 非 JSON 或缺字段 | 一次格式纠错；仍失败则保持原阶段 |
| 未知 ID | 丢弃对应字段 |
| 引文不匹配 | 不确认该 OM，不推进 |
| 低/中置信度 | 保持阶段 |
| 同时请求多个转换 | 全部拒绝 |
| 检测到提前泄露 | 不把泄露当进度；下一轮使用恢复模式并标记调试记录 |
| 剧情与已发生事实冲突 | 暂停控制器并提示人工处理 |

核心规则：宁可停住，也不错误推进；失败不能阻断聊天。

## 13. UI

V1 面板提供：

- 启用/停用 Story Controller。
- 选择 Story Package。
- 选择独立 Director 连接配置，首次可沿用 Harness 配置，但不绑定具体模型品牌。
- 当前阶段的无剧透名称和目标。
- 最近确认 OM 及原文证据。
- 最近一次判断、是否推进、失败原因和耗时。
- 冻结推进、重试判断、手动设置阶段、重建状态和重置。
- 调试模式下查看 ID；普通模式不展示隐藏内容。

面板不会展示 `hidden`。剧情作者需要查看或编辑完整包时，通过单独的“作者模式”明确进入，避免普通游玩时剧透。

## 14. 文件与扩展边界

建议目录：

```text
public/scripts/extensions/third-party/story-controller/
├── manifest.json
├── index.js
├── controller.js
├── package.js
├── prompt.js
├── state.js
├── panel.html
├── settings.html
├── style.css
└── README.md
```

测试：

```text
tests/story-controller-package.test.js
tests/story-controller-state.test.js
tests/story-controller-director.test.js
tests/story-controller-prompt.test.js
tests/story-controller-reentry-ab.test.js
tests/story-controller-full-flow.test.js
tests/story-controller-s5-full-flow.test.js
tests/story-controller-s4.live.mjs
tests/story-controller-full-flow.live.mjs
tests/story-controller-s5-immersion.live.mjs
```

正式扩展不修改 SillyTavern 本体，不修改 Living State Harness 文件，不依赖外部服务端插件。

## 15. 实施顺序

### Phase 1：纯函数核心

- Story Package Schema 和校验。
- Runtime、Delta、白名单摘取和证据校验。
- 相邻状态转换和互动模式到安全提示的确定性映射。
- Main Model View 渲染与隐藏字段隔离测试。
- Swipe、编辑、删除的快照纯函数测试。

### Phase 2：观察模式扩展

- 接入 Connection Manager 和结构化 JSON 调用。
- 读取真实聊天但不注入、不推进正式剧情。
- 面板展示候选 OM、转换、证据和耗时。
- 用实际小雅聊天做只读回放，确认误推进为零。

### Phase 3：控制模式

- 启用快照提交和 Main Model View 注入。
- 加入失败降级、冻结、重试和手动恢复。
- 验证 Swipe、Regenerate、编辑和删除。

### Phase 4：S4 剧情包

- 把旧婚姻剧情拆成狭窄 OM、阶段、公开线索、隐藏真相和互动路由。
- 使用合成对话和真实聊天副本完整跑通。
- 盲测参与感、剧透、阶段跳跃和角色自然度。

## 16. 开发准入标准

探针已达到进入 Phase 1 的标准：

- 局部视野最终契约连续 42/42 通过。
- 没有跨级推进。
- 含糊、猜测、排练引用和跳关要求均保持原阶段。
- 提示注入未取得隐藏剧情。
- 提前泄露不会被当作正式进度。
- 白名单渲染的 Main Model View 不包含隐藏字段。

实现仍需通过观察模式的真实聊天回放后，才能默认开启控制模式。
