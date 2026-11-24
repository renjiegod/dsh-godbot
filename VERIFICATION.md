# Godbot 0.2.0-rc.1 候选包验收

本报告记录 2026-11-20 当时的 0.2.0-rc.1 安装包。表中的独立成员、跨工作台迁入与旧备份属于该版本的验收范围。当前 Bot 工作区的入口与测试见 [功能对照](FEATURE_PARITY.md)。

2026-11-20 在 macOS 上完成 M0–M6 本轮约定范围。常规测试 200 项，其中 199 项通过，1 项 Windows 专项在 macOS 跳过。实际安装包的 E0–E12 和 E4-FULL 共 14 个场景通过。另在独立 profile 重复通过 E0，并用两种真实 CLI 和一个公开 GitHub 仓库完成复核。远程云设备按本轮约定列为未验证。

## 可以复核的产物

| 项目 | 结果 |
| --- | --- |
| 候选版本 | 0.2.0-rc.1 安装包（`~/.local/share/dsh-godbot/verification/2026-11-20/verified/dsh-godbot-0.2.0-rc.1.tgz`），SHA-256 `f61a8b38d021ed07efc3db6cd9d83396c8d1e1870a90c8dc4cf441990d90d8da` |
| 实际加载 | Host build `35c4dee9c23a3a64`，浏览器模块 SHA-256 `85e26f6d73042d78d60878d6b193675c3b381d236643c394950d79d5d82ca0c6` |
| 构建来源 | 当前工作区，基线 `e6aed125`，含未提交改动。干净目录执行 `npm ci` 后构建，与当前工作区构建的包逐字节相同。 |
| 升级基线 | e6aed12 对应的 0.1.0 原始构建（`~/.local/share/dsh-godbot/verification/2026-11-20/verified/dsh-godbot-0.1.0.tgz`），SHA-256 `4ce4449dd26b293fcc48fa73f756bb20a491ba04d093ed2650d5e6dfeb28cd50` |
| 环境 | macOS 27.2 arm64，Node v24.14.0，DSH 0.2.2-rc.1，Playwright Chromium 156.0.8078.4 |
| 原始回执 | 全量 14 项（`~/.local/share/dsh-godbot/verification/2026-11-20/verified/all/report.json`） · 第二次独立安装（`~/.local/share/dsh-godbot/verification/2026-11-20/verified/second-install/report.json`） · 真实 CLI（`~/.local/share/dsh-godbot/verification/2026-11-20/verified/live/report.json`） · 真实 GitHub 事件（`~/.local/share/dsh-godbot/verification/2026-11-20/verified/github/report.json`） · 常规测试（`~/.local/share/dsh-godbot/verification/2026-11-20/verified/unit.log`） |

## 场景与结果

| 场景 | 已从用户入口和独立回执验证的行为 |
| --- | --- |
| E0、E12 安装与兼容 | 两次独立新装都覆盖 Host 重启和第二个空 profile 的隔离。0.1.0 的原任务、证据及待处理请求能在升级后定位。注入候选加载故障后，回到原版并在原会话完成新任务。原进程的活动审批标记为已结束。 |
| E1、E2 成员工具 | 完整团队的 DSH、Claude、Codex 各读回随机工单。批准写入后上游收到一次，拒绝、切只读和撤权后无新增写入。覆盖 Host 重启及终端交还。真实 CLI 另各做了一次读、拒绝写、重启后再读。 |
| E3 跨工作台 | 中断迁入再恢复，重试后保留一份成员和来源映射。按版本预览已验收证据 R2，并在新对话读回源标记。覆盖群共享及转私密。 |
| E4、E4-FULL 团队验收 | CLI 和 stdio MCP 看到同一棵委派树。子任务待审批或待验收时保持未完成。完整团队还验证了实际 Bot 派工、一次工单写入、R1 退回和 R2 验收，以及群账本中的成员回执。 |
| E5、E6 幂等与事件 | 在 SQLite 提交前、提交后响应前分别强杀 Host。重投成功后各只有一个运行，已发往上游且结果未确认的动作保留待核对状态。无效 Webhook 签名和暂停订阅均未派工。公开 GitHub 事件通过官方列表和本地任务双向核对。 |
| E7 预算 | 已运行的并发任务可以结束，超限的新任务延期。定时任务和群派工在重启、跨周期后各执行一次；超限期间路由分类调用为零。明确的额度拒绝触发一次备用模型调用。原线路恢复后回切，另一笔已送达但未确认的请求触发零次备用重放。 |
| E8 模板与换机 | 空 profile 导入模板后使用新 ID、计划暂停。加密备份恢复了证据、DSH 会话、附件、记忆、工作树及 Git 暂存区。验证了错误密码、截断、恢复中断、回退及恢复后的新任务。外部 CLI 目标机缺少相应登录与原生存储时，只恢复关联标识和 Godbot 历史。 |
| E9 收件箱与路由 | 原生和完整工作台的待办同时出现，各答复绑定原会话；同一卡片并发回答仅一条生效。显式点名、高置信分类各只派给目标，低置信和超时回落管理员。 |
| E10 本机浏览器与容器 | 两个 Bot 的资料与交互隔离。Web 接管、交还、断连和 Host 强杀均得到可观察的设备状态。真实 Linux 容器覆盖系统窗口输入、审批、容器回收和工作文件持久化。 |
| E11 多人 | 两个浏览器身份分别核对聊天、搜索、深链、附件、导出及活动订阅。改权后旧下载地址、旧订阅和不再授权的审批失效；同一审批并发操作只发生一次上游写入。审计含操作者和目标。 |

## 两条贯穿路径

- CI 运行 `7aea4c8f-7c4e-4e79-af0b-6cd09c37e95a` 和 Webhook 运行 `6cc3f808-bf4f-460a-b152-ca2fab0b48da` 各经历派工、审批、退回、重报、验收和跨工作台交接。两条路径均导出证据 R2，迁入的 Codex 成员在独立工单服务各产生一次读取。这里的模型通过确定性夹具驱动，另行实测的登录版 Claude Code 和 Codex 的读、拒写和重连见真实 CLI 报告。
- 仓库 `milind-soni/OpenMausBot` 的公开事件 `PullRequestReviewEvent`（ID `20732199027`）对应本地运行 `964564a5-075a-485a-a45a-fbf96c17fa54`。复核使用已有的公开事件，没有向该仓库写入内容。

## 验收范围

本地候选包可用于指定 DSH 版本的 macOS profile。远程 Docker context 的设备接入代码已随包交付，本轮云端真机未验。第三方托管云机的供给、唤醒与休眠，以及独立桌面安装器，均在本轮插件交付范围之外。GitHub 原生适配覆盖公开仓库事件轮询，其他 SaaS 的原生订阅各需单独适配和验证。外部 CI 可通过受控隧道连接本机回环监听。操作说明见 [README](README.md)，复跑命令见[实施计划第 9 节](IMPLEMENTATION_PLAN.md#openmaus-e2e)。本轮使用本地隔离 profile，未触发远端 CI 或发布。

## Godbot 0.2.16 — conversation switching (2026-11-25)

- Rebased the conversation performance fix onto published 0.2.15 (`3a5b836`), retaining sandbox management; regenerated client and host build ID.
- Unit tests: 556 passed, 4 skipped; TypeScript check passed.
- Candidate SHA-256: `9ee582a406fc4aaa3d4c6b1e8054463a69728f230c69a9212611f1f0eed23de4`.
- All 26 release scenarios passed on this candidate, including COMMAND-QUIET, phone/relay and bundled computer host; E9 additionally passed its batch/individual group-history comparison.
- E12 was re-run with its required legacy two-roster baseline after the initial invocation supplied unsupported 0.2.15. UPDATE initially observed the new plugin build before a package-moved restart receipt; its independent retry passed. Initial reports are retained alongside the passing results.
- A separate isolated 0.2.15 → 0.2.16 candidate update preserved the session and complete chat, and displayed sandbox settings after restart.
- Evidence: `/tmp/godbot-perf-0216/candidate-acceptance.json`, `group-e2e/report.json`, `candidate-upgrade.json`.
