# Living State Harness

Living State Harness 是一个独立的 SillyTavern 前端扩展。它在单角色聊天中维护有证据的角色当前状态，把与本轮相关的少量状态注入正文提示，并提供长对话归档续聊功能。

## 能力

- 在正文生成完成后异步更新角色状态，不阻塞当前回复。
- 使用逐字引文和消息编号校验状态来源；证据不足时允许零更新。
- 根据场景和话题筛选状态，减少旧边界或旧情绪对后续剧情的误导。
- 正确处理编辑、删除、Swipe 和 Regenerate 后的状态失效与重建。
- 使用 Connection Manager 中单独选择的连接运行状态更新和长对话归档，不随正文模型切换。
- 保留原聊天，创建带历史摘要、近期原文和当前状态的新续聊。

## 安装形态

扩展目录必须位于：

```text
public/scripts/extensions/third-party/living-state-harness
```

目录根部的 `manifest.json` 是扩展入口。独立发布到 Git 仓库时，应让 `manifest.json` 位于仓库根目录，然后通过 SillyTavern 的“安装扩展”功能使用该仓库地址安装。

当前副本随本 SillyTavern 工作区维护，因此关闭了 `auto_update`。建立独立远程仓库后，再把 `homePage` 指向扩展仓库并启用自动更新。

## 数据兼容

抽离不会迁移或重写用户数据。以下稳定标识保持不变：

- 设置键：`extension_settings.livingStateHarness`
- 状态快照：`living_state_harness_snapshot`
- 长对话摘要：`living_state_harness_archive`
- 归档运行记录：`living_state_harness_archive_runtime`
- 提示词注入键：`living_state_harness`

因此，从旧内置目录升级到第三方扩展目录后，现有设置、聊天状态和归档摘要会继续读取。

## 依赖

扩展只依赖 SillyTavern 浏览器端公开模块和内置 Connection Manager，不需要额外的服务端插件或 npm 依赖。

## 测试

在 SillyTavern 仓库根目录运行：

```bash
NODE_OPTIONS=--experimental-vm-modules npx --yes jest \
  --config tests/jest.config.json --runInBand \
  tests/living-state-harness.test.js \
  tests/living-state-context.test.js \
  tests/living-state-updater.test.js
```

真实模型测试是显式可选项，不会写入聊天：

```bash
node tests/living-state-context.live.mjs --live
```
