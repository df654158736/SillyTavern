# Story Controller

Story Controller 是一个独立的 SillyTavern 前端扩展。它运行经过验证的 JSON Story Package，通过有证据的 Observable Milestone 推进相邻剧情阶段，并只向正文模型注入当前阶段的无剧透导演信息。

插件当前实现 Story Package schema v2，并继续兼容 v1。v2 支持 `continuityRules`、`completion` 和可选的 `reentry`；v1 包无需迁移即可继续运行。

## 核心边界

- 完整剧情和隐藏真相由确定性代码持有。
- 剧情包可通过 `continuityRules` 把已经确认的分支选择及其后果安全延续到汇合阶段；正文模型不会看到原始事件 ID。
- 剧情包可通过 `completion` 指定收束轮数和长期关系记忆；收束完成后自动停止完整导演指令，只保留精简的已完成事实。
- Director 模型只读取当前阶段、一个相邻阶段的公开壳和相关 OM。
- Director 只返回事件、证据、相邻转换、互动模式和违规 ID，不返回导演自由文本。
- 业务代码验证逐字引文、ID 和转换条件，再从最终阶段映射安全提示。
- 用户输入始终自由。Director 只负责把无关话题识别为 `follow_user_detour`；只有剧情包开启 `reentry`、主线此前已经暂存且满足间隔时，确定性业务代码才把该模式升级为一次自然回引。
- 自然回引不算剧情进度，不能确认 OM 或切换阶段。用户忽略后进入冷却；明确暂停后停止自动回引；用户主动回来时按正常 OM 流程判断。
- 判断失败或含糊时保持阶段，不阻断正文生成。
- 每个剧情包按聊天明确绑定，不会自动影响其他聊天。

## 使用

1. 在扩展设置中导入由 `$story-controller-author` 生成并验证的 `.story.json`。
2. 选择剧情包并绑定当前聊天。
3. 先使用观察模式核对实际对话中的 OM 判断。
4. 在复制出的剧情分支中短程试用控制模式，对照人物自然度、用户参与感和剧情节奏。
5. 只有路由判断与正文沉浸感都通过后，才在正式聊天中使用控制模式。
6. 为 Director 选择独立的 Connection Manager 配置。优先选择结构化输出稳定、语义判断可靠且延迟合适的模型；Flash 可作低成本兼容性探针，但不负责评判剧情设计质量。

观察模式通过只代表阶段判断可靠，不代表正文一定更有沉浸感。若控制模式使回复出现选择题感、频繁停顿等用户表态、角色反应趋同或自然生活感下降，应立即切回观察模式；观察模式不会向正文模型注入剧情指令。

扩展内置了第一份经过验证的剧情包“未完成的尾奏”。点击“载入内置「未完成的尾奏」”只会把它加入剧情包列表，不会自动绑定聊天、修改世界书或改写已有消息。建议在新聊天或专门复制出的剧情分支中，从开场阶段使用。

当前内置包版本为 v3。它包含有限自然回引策略和对应的新运行时状态；已绑定 v2 的旧聊天不会被静默迁移。需要使用新策略时，请重新载入内置包并在新聊天或复制分支中绑定 v3。

`packages/xiaoya-s5-beyond-the-name.story.json` 是后续实验包“名字之外”（包版本 v2）。它只按“先完整游玩 S4，再进入 S5”的顺序设计，以成年身份档案和亲属称谓冲突为入口，重点测试身份震动、家庭隐瞒、等待、关系松绑以及结果后的多种真实反应。v2 会承接 S4 所有路线共有的关系成果，并为每个阶段提供恰好一项与当下主题相符的既往共同记忆；每轮至多自然回响一处，避免回忆清单、强行怀旧和用过去替当前选择作答。该包不会由“载入内置「未完成的尾奏」”按钮自动加入；请手动导入，并只在“未完成的尾奏”已经收束的复制分支或原聊天中绑定。若角色世界书仍带有 `OM-00`～`OM-E1`，仍应先停用旧控制条目。

S4 的实际分支选择不会被 v2 猜测或预写。玩家完成 S4 后，可以在绑定 S5 前根据真实聊天补审一次交接，只把已经发生且会影响后续的选择、余痛、处置结果和双方形成的具体说法加入连续性；不补也能使用，S5 会保守依赖聊天正文和通用完成事实。

如果角色世界书仍启用旧版 `OM-00`～`OM-E1` 控制条目，绑定该内置包前应先停用这些旧条目，避免旧关键词触发器与新控制器同时发令。扩展会在绑定时再次提醒，但不会擅自修改用户世界书。

两套剧情的作者测试用例分别位于 `packages/xiaoya-s4-unfinished-coda.cases.json` 与 `packages/xiaoya-s5-beyond-the-name.cases.json`，不会被发送给正文模型。

## 数据

- 设置：`extension_settings.storyController`
- 聊天绑定：`story_controller_assignment`
- 初始/手动基线：`story_controller_baseline`
- 用户消息快照：`story_controller_snapshot`
- 提示词：`story_controller_direction`

## 测试

剧情包与探针用例校验（支持本插件实现的 schema v1/v2）：

```bash
node scripts/validate-story-controller-package.mjs \
  public/scripts/extensions/third-party/story-controller/packages/xiaoya-s4-unfinished-coda.story.json \
  public/scripts/extensions/third-party/story-controller/packages/xiaoya-s4-unfinished-coda.cases.json

node scripts/validate-story-controller-package.mjs \
  public/scripts/extensions/third-party/story-controller/packages/xiaoya-s5-beyond-the-name.story.json \
  public/scripts/extensions/third-party/story-controller/packages/xiaoya-s5-beyond-the-name.cases.json
```

```bash
NODE_OPTIONS=--experimental-vm-modules npx jest \
  --config tests/jest.config.json --runInBand \
  tests/story-controller-package.test.js \
  tests/story-controller-state.test.js \
  tests/story-controller-director.test.js \
  tests/story-controller-prompt.test.js \
  tests/story-controller-reentry-ab.test.js \
  tests/story-controller-full-flow.test.js \
  tests/story-controller-s5-full-flow.test.js
```

`story-controller-reentry-ab.test.js` 是主架构 A/B：用人工推演的自由用户行为和理想 Director 决策，对比“仅跟随支线”和“有限自然回引”，验证首次偏离不拉回、回引不偷推进、忽略后冷却、明确暂停不打扰，以及用户主动回归时正常按 OM 推进。它不依赖任何外部模型，结果可重复。

`story-controller-full-flow.test.js` 会枚举并完成全部 24 种分支组合，逐边验证 20 个阶段、24 条转换、提示词防剧透、暂停/回引状态以及终局后的记忆释放。

`story-controller-s5-full-flow.test.js` 对“名字之外”执行同样的 24 路完整遍历，并额外验证身份档案、检测暂缓、三种结果后反应与最终称谓共识不会互相串线；v2 还验证每个阶段只注入一项既往记忆类别，作者层的 S4 待交接说明不会进入正文提示。

可选的真实模型兼容性探针：

```bash
node tests/story-controller-s4.live.mjs --live
node tests/story-controller-full-flow.live.mjs --live
node tests/story-controller-full-flow.live.mjs --live \
  --story=public/scripts/extensions/third-party/story-controller/packages/xiaoya-s5-beyond-the-name.story.json \
  --detour-stage=STAGE_KINSHIP_UNCERTAIN \
  --pause-stage=STAGE_RELEASE_SHOCK
node tests/story-controller-s5-immersion.live.mjs --live
```

全流程 Flash 探针选择 3 条从入口到终局的顺序旅程覆盖全部 24 条剧情边，并在真实状态链中加入偏题回引和明确暂停。2026-09-16 使用 `deepseek-v4-flash` 完成 48/48 次 Director 调用，均一次通过；探针不读取或写入真实聊天，也不打印正文或隐藏剧情。

“名字之外”v2 在 2026-09-16 使用同一 Flash 模型完成 3 条顺序旅程、覆盖全部 24 条边：47/47 次 Director 调用均首次通过。另以当前小雅角色卡与 `MoM5.40KKMYUKI222-双向互动` 预设抽测等待坦白、结果松绑、亲密释放和称谓重建四个正文检查点，全部通过沉浸度、共同历史回响、无回忆清单、当前同意与非瞬间治愈阈值；该评分是兼容性抽样，不替代 S4 实际游玩后的交接复审和人工试玩。

`story-controller-s4.live.mjs` 会用当前剧情包的全部作者案例抽测真实 Director，包括推进、停留、情绪暂停和提前泄露恢复；`story-controller-full-flow.live.mjs` 负责顺序状态链与全部剧情边；`story-controller-s5-immersion.live.mjs` 只负责当前角色卡、预设与 S5 关键正文检查点。三者均为显式 `--live` 的本机探针，不属于默认 Jest 测试，也不会写入真实聊天或打印生成正文。
