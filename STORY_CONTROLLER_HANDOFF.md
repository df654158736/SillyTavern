# Story Controller 会话交接

> 更新时间：2026-09-16（Asia/Shanghai）
> 工作区：`/home/dministrator/SillyTavern`
> 分支：`feature/living-state-harness`
> 目标：让新的 Codex 会话在不向玩家剧透的前提下，继续维护 Story Controller、剧情创作 Skill，以及小雅 S4 → S5 的真实连续性。

## 新会话第一句话

用户可以直接发送：

> 请先完整读取 `STORY_CONTROLLER_HANDOFF.md`，再读取 `/home/dministrator/.codex/skills/story-controller-author/SKILL.md` 及其要求的引用文件。按交接文档继续，不要向我透露剧情包里的隐藏真相。

接手者在执行剧情包创建、改编或修复前，必须遵循 `story-controller-author` Skill；不能让子代理代读或代为解释 Skill 指令。

## 不可违背的用户目标

- 剧情沉浸感、角色体验和情绪质量优先于 token、速度与缓存命中率。
- 玩家输入保持自由；不能要求固定台词或把互动写成连续选项菜单。
- Director 可以在玩家自然偏题后有限回引，但回引不能偷推进剧情，也不能打断明确的情绪暂停。
- 不向用户展示隐藏真相、幕后提纲、阶段号、未来钩子或未解锁分支。
- 小雅必须像真实的人：会爱、开心、嫉妒、委屈、生气、拒绝、哭泣、修复，也会主动表达；不能成为奖励式、条件式或教师训话模板。
- 既往共同经历全部是正史，但只能在与当前情绪真正相连时自然回响；不能倾倒回忆清单，也不能让过去替当前选择作答。
- 成人内容服务于情绪冲突、关系深化与人物主体性。所有当前时间线人物均为成年人；亲密必须是当下双向、可停止的选择，过去同意不自动延续。
- 用户明确保证游玩顺序为 S4 完整结束后再进入 S5，不需要兼容跳过 S4 直接开始 S5。
- 用户不希望被提前剧透。正常汇报只给无剧透结论；只有用户明确要求作者审阅时，才可单独标明剧透区。

## 系统职责边界

| 层 | 负责 | 不负责 |
| --- | --- | --- |
| 角色卡 | 小雅的核心人格、表达、长期身份和稳定关系背景 | 专属剧情阶段推进 |
| 正常世界书 | 已确认客观历史与长期共同记忆 | 用关键词代替剧情状态机 |
| Living State Harness | 最近多轮形成的当前状态、短期连续性和边界 | 编写或决定专属剧情路线 |
| Story Package | 隐藏真相、阶段许可、OM、分支、连续性、完成释放 | 重写人物人格或替用户行动 |
| Director | 依据逐字证据选择事件、相邻转换和互动模式 | 续写正文、自由发令或读取完整隐藏剧情 |
| 确定性代码 | 校验引文、ID、相邻边、回引次数、完成状态 | 推测人物内心 |
| 正文模型 | 根据角色卡、对话、Harness 与当前安全导演视野自然表演 | 决定正式剧情进度 |

## 当前实现状态

Story Controller 是 SillyTavern 前端扩展，位于：

- `public/scripts/extensions/third-party/story-controller/`

核心文件：

- `index.js`：设置、绑定、快照、Director 调用和提示注入。
- `package.js`：schema、验证器、Director/Main Model 局部视野。
- `state.js`：运行时状态、一次一边推进、暂停、偏题与有限回引。
- `director.js`：Director JSON 契约、逐字证据与语义校验。
- `prompt.js`：无剧透正文提示、完成释放和泄漏检查。
- `README.md`：使用方式、架构边界与验证命令。
- `packages/`：S4、S5 剧情包及其案例。

当前插件数据契约是 `schemaVersion: 2`。剧情包自己的 `version` 与 schema 独立，不能把包版本称作 schema v3。

已经实现并验证：

- 聊天级明确绑定，不自动影响其他聊天。
- 可观察、逐字可验证的 OM。
- 每次只允许一个已创作的相邻转换。
- 分支连续性与汇合后的后果保留。
- 情绪暂停、日常偏题、有限自然回引和泄漏恢复。
- 完成后的短期尾声与精简长期记忆释放。
- 模糊证据保持不更新；宁可空着也不误导。
- 正文模型只看当前阶段安全视野，Director 不返回自由导演文本。

## 剧情创作 Skill

Skill 路径：

- `/home/dministrator/.codex/skills/story-controller-author/SKILL.md`

配套资源：

- `references/story-package-contract.md`
- `references/authoring-method.md`
- `assets/story-package.template.json`
- `assets/story-cases.template.json`
- `scripts/validate_story_package.mjs`

该 Skill 支持四种模式：Create、Adapt、Repair、Validate。它可以从一句话前提扩展出完整 `.story.json` 与 `.cases.json`，但必须先区分既定正史、阶段安全线索、作者隐藏真相、错误解释、情绪目的和用户参与点。

一句话只负责提供故事种子。Skill 负责生成并验证剧情包；Story Controller 扩展负责在聊天中执行剧情包。结构通过不等于文学质量通过，重要剧情仍需正文抽测和真人试玩。

## 当前剧情包

### S4：未完成的尾奏

- 文件：`packages/xiaoya-s4-unfinished-coda.story.json`
- 案例：`packages/xiaoya-s4-unfinished-coda.cases.json`
- `schemaVersion: 2`
- 包版本：v3
- 20 个阶段、23 个 OM、24 条转换、16 个公开 Reveal、7 条分支连续性、42 个案例。
- 用途：先完整游玩。不要向玩家解释隐藏结构或终局。

### S5：名字之外

- 文件：`packages/xiaoya-s5-beyond-the-name.story.json`
- 案例：`packages/xiaoya-s5-beyond-the-name.cases.json`
- `schemaVersion: 2`
- 包版本：v2
- 20 个阶段、23 个 OM、24 条转换、17 个公开 Reveal、8 条分支连续性、37 个案例。
- 只按 S4 已经完整收束后的直接续章设计。
- 每个阶段恰好允许一类相关的既往记忆，避免历史剥离和回忆清单。
- 成人路线继承双方已有的安全词、反馈、停止和事后照料语言，但过去同意不代表当前同意。
- `hidden.authorNotes` 中有 `S4_HANDOFF_PENDING` 作者标记。它不会进入正文提示，表示实际 S4 分支尚待玩家完成后补审。

不要在普通交接回复中复述两个剧情包的 `hidden` 内容。需要检查时可直接读取文件，但只输出无剧透结论。

## 小雅角色卡与世界书

Story Controller 推荐角色卡：

- `data/default-user/characters/小雅-A·UMT-SC.png`

该卡保留 28 条正常记忆条目，包含常驻连续性和已经发生的共同经历，但移除了旧 `OM-00`～`OM-E1` 关键词剧情控制条目。它当前用于 S4 起点。

需要避免：

- `小雅-A·UMT-S4.png` 仍带旧版 OM 世界书控制条目。若使用它，必须先停用旧 OM，否则会与 Story Controller 双重发令。
- 不删除正常历史条目；旧剧情控制条目与有价值的共同记忆不是同一类内容。
- 不修改用户 persona 来补小雅设定。

S4 真正完成前，不要提前制作写死结果的 S5 角色卡。S4 完成后再复制/演化为干净的 S5 卡，更新当前场景、开场白和常驻连续性，同时保留正常世界书记忆。

## S4 完成后的精确交接流程

用户说“S4 已完成”后，先执行以下流程，再建议绑定 S5：

1. 读取真实 S4 聊天的已接受消息、Story Controller 最终运行时和 Harness 当前状态；不把 Swipe 中未采用文本当正史。
2. 确认 S4 已进入完成状态，并让规定的尾声轮数结束；不要只凭用户说“差不多结束了”推断所有事件发生。
3. 提取一份短而准确的 S4 → S5 交接摘要，只记录：
   - 已确认的实际选择及其后果；
   - 仍然存在的情绪余波和关系变化；
   - 双方实际形成的表达、边界或承诺；
   - 已完成或仍未完成的现实事项。
4. 宁可遗漏含糊信息，也不要把猜测、未走分支、模型建议或一句玩笑升级成正史。
5. 将真正会影响 S5 的分支事实加入 S5 的安全承接基线；如果修改剧情包，包版本从 v2 递增，并同步更新案例。
6. 创建或更新 S5 演化卡：更新 `scenario`、`first_mes` 与常驻连续性；保留正常历史世界书，不恢复旧 OM 控制条目。
7. 重新运行静态、确定性全路径、Flash Director 与关键正文连续性测试。
8. 先在复制分支以观察模式短程确认，再切控制模式正式游玩。

实际 S4 分支可能影响后续语气，但不能为了“衔接完整”把全部 S4 对话永久塞进每轮提示。优先使用一份短交接摘要、角色卡稳定事实、Harness 当前状态和阶段相关的一处记忆回响。

## 最近验证证据

S5 v2 于 2026-09-16 完成：

- 插件生产验证器：通过，0 warning。
- Skill 独立验证器：通过，0 warning。
- 7 套相关 Jest 回归：94/94 通过。
- 确定性遍历：覆盖全部 24 条边和 24 种作者路径组合。
- `deepseek-v4-flash` 全流程 Director：3 条顺序旅程覆盖 24 条边，47/47 调用首次通过。
- 当前小雅卡与 `MoM5.40KKMYUKI222-双向互动` 预设的正文抽测：4/4 通过。
- 正文抽测另外检查了共同历史回响、回忆清单风险、过去同意替代当前同意、瞬间治愈和用户被代写。

以上证明当前版本具备工程可用性和关键场景兼容性，不等于已经替代真人长线试玩。S4 → S5 的实际玩家交接仍是下一项内容验收。

## 验证命令

在仓库根目录执行：

```bash
node scripts/validate-story-controller-package.mjs \
  public/scripts/extensions/third-party/story-controller/packages/xiaoya-s4-unfinished-coda.story.json \
  public/scripts/extensions/third-party/story-controller/packages/xiaoya-s4-unfinished-coda.cases.json

node scripts/validate-story-controller-package.mjs \
  public/scripts/extensions/third-party/story-controller/packages/xiaoya-s5-beyond-the-name.story.json \
  public/scripts/extensions/third-party/story-controller/packages/xiaoya-s5-beyond-the-name.cases.json

node /home/dministrator/.codex/skills/story-controller-author/scripts/validate_story_package.mjs \
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

真实模型探针只在本机服务和对应连接配置可用时运行；不得打印密钥、API 地址、隐藏剧情或生成正文：

```bash
node tests/story-controller-full-flow.live.mjs --live \
  --story=public/scripts/extensions/third-party/story-controller/packages/xiaoya-s5-beyond-the-name.story.json \
  --detour-stage=STAGE_KINSHIP_UNCERTAIN \
  --pause-stage=STAGE_RELEASE_SHOCK

node tests/story-controller-s5-immersion.live.mjs --live
```

## Git 与工作区状态

当前分支为 `feature/living-state-harness`，检查时 HEAD 为：

```text
e5061ec10 Merge remote-tracking branch 'upstream/staging' into feature/living-state-harness
```

重要：`public/scripts/extensions/third-party/*` 被仓库 `.gitignore` 忽略，因此 Story Controller 扩展文件不会自然出现在 `git status`。相关 `scripts/`、设计文档和多份测试目前也仍显示为未跟踪。不要宣称当前工作已经提交或推送。

如果用户之后明确要求提交：

1. 先检查完整 `git status`、忽略规则和实际文件列表。
2. 只加入 Story Controller、对应测试、设计/交接文档和用户明确要求的改动。
3. 扩展目录需要审查后使用显式强制加入；不要顺手提交其他用户文件。
4. 运行上述验证后再提交、推送，并报告 commit 与远程分支。

## 接手时不要做的事

- 不要在开场回复中给用户复述本文件全部内容。
- 不要因为能读取 `hidden` 就向玩家解释故事答案。
- 不要把真实聊天中的生成失败、Swipe 废稿或模型猜测写进连续性。
- 不要让 Harness 代替 Story Controller 决定剧情阶段。
- 不要让 Story Controller 重写角色人格或每轮倾倒完整历史。
- 不要为了验证而写入真实聊天、修改现有聊天记录或暴露连接配置。
- 不要在用户只要求分析时擅自修改；用户要求开发时才实现并验证。

## 当前最安全的下一步

用户现在可以更换会话并先继续游玩 S4。新会话读取本文件后，无须重新设计插件或重跑已经完成的开发；除非发现回归，只需等待用户报告 S4 完成，再执行“精确交接流程”。
