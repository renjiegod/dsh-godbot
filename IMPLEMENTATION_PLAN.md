# Godbot 多 Agent 调度插件实施方案

本文件保留首版和 2026-11-20 扩展方案的设计记录，包含当时的双工作台与独立成员实现。当前任务板直接向 Bot 私聊派工，原生面板接管同一 Bot 的会话。操作和验证入口见 [使用说明](README.md) 与 [功能对照](FEATURE_PARITY.md)。

**2026-11-20 增补**　[对照 OpenMausBot 的实施计划](#openmaus-roadmap) · [端到端验证方案](#openmaus-e2e)。第 1–7 节保留首版设计背景，当前行为以代码、README 和下文注明的实测为准。

2026-11-19 · 设计基线为本机 macOS 和 dsh `0.2.2-rc.1`。下文将当前源码或握手能证明的行为与拟交付的功能分别标出。

Godbot 以独立的 dsh 插件交付。首版移植了三个 CLI 的协议驱动和团队消息处理，重点改造运行中插话、成员会话控制和工作台。复用代码的版本、来源与修改范围见 [THIRD_PARTY_NOTICES](THIRD_PARTY_NOTICES)。

## 1. 用户最终怎样使用

在 dsh 里开一个 Godbot 团队，为同一个任务选 Claude Code、Codex、Antigravity 或 dsh。每个成员有自己的会话、工作目录、原生工具和权限。用户可以从群里点名，也可以进入一个成员的对话，看它正在做什么、回答它的问题、改方向或停下来。Godbot 控制用户本机启动的 Agent，会话里的模型调用和账号认证由该 Agent 自己完成。

例如，用户让 Claude 梳理影响范围，Codex 实现修改，Antigravity 审查，dsh 汇总。Codex 运行到一半，用户点开它，发送“保留旧配置字段，加一条兼容性测试”。Codex 支持时，界面显示这条指令追加到了哪个回合。Antigravity 可以同时向 Codex 索取改动的 commit。Claude 等待一次工具批准时，其他成员继续工作。最后用户看到每人的结论、改动和测试证据，仍能单独续聊其中一人。

第一版按**单用户、单机、dsh Web 工作台**设计，命令和模型工具共用 Host 接口。支持结构化控制和原生会话续聊。完整终端画面、任意快捷键和接手一个已在其他终端运行的进程，分别有独立的技术条件，在第 7 节处理。

## 2. 三个项目给出的设计依据

| 项目 | 已核对的实现 | 对 Godbot 的影响 |
|---|---|---|
| Zed `bb5e6dfd07` | 按配置启动 ACP 子进程，分离协议流与 stderr。客户端处理 Agent 发回的授权、文件和终端请求。外部 Agent 生成时，默认消息入队，Send Now 先中断、等待旧轮结束，再发新消息。Zed 面板的 Steer 只对原生 Zed Agent 开放。 | 复用会话、回执、能力协商和人机交互的分层。运行中能否插话依具体 Agent 判定，不能从“兼容 Zed”推断。进程传输（`~/code/zed/crates/agent_servers/src/acp/transport.rs:66`） · 面板行为（`~/code/zed/docs/src/ai/agent-panel.md:65`） · 中断后发送（`~/code/zed/crates/agent_ui/src/conversation_view/thread_view.rs:2561`） |
| 团队工作台的初始实现 | 外部 CLI 可注册为 dsh 模型路由，每个群内按成员创建会话，支持点名、并行、派工和回报。 | Godbot 复用团队消息寻址与迟到回复处理，并保存原生工具事件和会话控制回执。[团队接口](src/host/team-workspace.js) · [原生驱动](src/drivers/external) |
| DeepSeek Harness | 本机发布版是 `0.2.2-rc.1`，对应 tag 提交 `66491b05e3`。本地开发源码是 `2e39e70496`。已有外部 Codex、Claude、ACP、dsh SDK 委派后端，其任务接口围绕一次执行、取结果和释放设计。原生 Team 面向 dsh 管理的成员，rc.1 的包名还带 `experimental`。 | 复用 dsh 的插件、Session、进程管理、权限和 UI 扩展。用 Godbot 自己的成员名册关联外部会话。把外部会话 ID 填进原生 Team 的任务 owner 无法获得跨进程协作。首版无需修改 dsh 核心，也不要求先升级用户的安装。[rc.1 Team 说明](https://github.com/deepseek-ai/deepseek-harness/blob/66491b05e3/packages/experimental/agent-team/README.md) · 外部运行接口（`~/code/deepseek-harness/packages/subagent/subagent/src/types.ts:296`） · 开发版 Team owner 校验（`~/code/deepseek-harness/packages/team/agent-team/src/task-board.ts:233`） |

magpie 的中文说明列出了从文件或钥匙串发现订阅、进行模型协议转换的路径。Godbot 的基本数据流是“用户指令 → 本机 Agent → 原生事件和结果”。插件只存会话标识、团队消息和执行证据，不读取或集中保管各家订阅令牌，不为其他客户端提供模型推理端点。若用户原本已给 CLI 配置代理，Godbot 应提示核对 CLI 自身的路由，保留其设置。调用原版 CLI 解决的是凭据和请求转发的架构问题，账号仍受厂商各自的使用条件约束。尤其对 Claude，个人登录未修改的二进制、第三方提供 Claude 登录、用个人订阅替多人转发推理，在官方说明中有不同条件。magpie 账号发现（`~/code/magpie/README.zh-CN.md:76`） · [Anthropic 认证与产品集成说明](https://code.claude.com/docs/en/legal-and-compliance)

### 2.1 协议驱动和团队工作台的移植范围

首版选用模块级移植，插件使用自己的包名、Cordis 入口、数据目录和侧栏。桌面程序、移动客户端与 Godbot 插件分别交付。浏览器工作台和 Host 的构建入口见 [package.json](package.json)。

| 移植批次 | 来源 | Godbot 的处理 |
|---|---|---|
| 协议与测试基线 | `src/host/local-agents/{codex,claude,acp,jsonrpc,discover,engines}.js`、`test/local-agents-startup.test.js`、fake CLI 和协议录制样本 | 六个 ESM 文件可独立加载。先以未改动快照跑原测试，再分别改驱动。保留可执行文件定位、协议编解码及已知兼容处理；正式运行时适配 dsh 的受管进程，仅启用已支持的引擎配置，登录状态使用 CLI 提供的机制。已有 JavaScript 可以与新 TypeScript 接口共存。 |
| 团队协作 | `src/shared/mentions.js`、`host/groups.js` 的每群每成员会话寻址、`delivery.js` 的 exchange/replyTo、`handoffs.js` 的父子派工，以及 `goals.js` 的 task/pass/complete 规则 | 点名解析直接移植。群路由、父子回传和目标校验按函数抽取，让它们读写 Godbot 的团队、任务、消息记录；移植对应的并发、迟到结果及验收用例。普通群消息送协调者，多点名并行。外部成员需要主动派工时，移植 `mcp.js` 和 `mcp-stdio.js` 的通信部分，按成员身份授权。[点名解析](src/team/mentions.js) · [父子派工](test/team/service-handoff.test.js) · [阶段验收](src/host/team.js) |
| Godbot 自有部分 | 独立会话控制器、dsh 原生成员驱动、指令与回执账本、成员操作面板 | 用原生 session/turn 直接驱动团队成员。初始团队适配器 中有价值的会话标识保存、过期消息过滤和权限请求清理分别迁入这些模块。Zed 提供交互行为参照；`dsh-superagent-prototype` 提供 Host 和浏览器双入口的打包示例。[原适配器](src/host/workspace-agent-controls.js) · 双入口示例（`~/code/dsh-superagent-prototype/tsdown.config.ts:9`） |

**已经核实的拆分边界。** 在新的临时目录仅放入六个驱动及依赖文件、上游 startup 测试、两个模拟 CLI 和声明 ESM 的最小 package.json，未安装 npm 依赖。ACP/Codex 共 6 项启动测试全部通过，覆盖并发建连、初始化失败重试、旧进程关闭与新进程竞态。Claude 驱动也从模拟进程读到了工具活动、文本和回合结束。这证明传输层可以单独搬出；真实 CLI 的本轮插话仍按第 7 节验收。[启动测试](test/external/local-agents-startup.test.js) · [Claude 测试进程](test/external/fixtures/fake-claude.mjs)

**移植后先改三个会直接影响用户的行为。**

1. **Codex 停止与恢复。** 上游把非 failed 的回合结束归为普通 done，并在恢复异常时可开启新 thread。保留原生结束原因和 interrupt 错误，在原 thread 恢复失败时让用户看到状态。给已有 fake Codex 加入“只回受理、旧轮稍后结束”的用例；旧轮结束以前不启动替代轮。[结束与恢复](src/drivers/external/codex.js) · [interrupt 实现](src/drivers/external/codex.js) · [现有测试夹具](test/external/fixtures/fake-codex.mjs)
2. **Claude 输入与工具事件。** 保留多内容块和工具调用 ID、输入、结果。区分写入 stdin、CLI 确认以及指令在哪一轮生效，分别验证文本追加、工具待审批时追加和取消后续发。[输入实现](src/drivers/external/claude.js) · [工具事件处理](src/drivers/external/claude.js)
3. **ACP 忙碌与插话。** 原驱动可以判断运行中，排队动作在旧适配器里。把“本轮追加 / 排到下轮 / 打断后发送”交给 Godbot 的会话控制器。原驱动已经合并了结构化工具更新，工作台直接消费这些对象。Antigravity 通过专门的双 prompt 用例才启用本轮追加。[原排队分支](src/host/workspace-agent-controls.js) · [ACP 工具更新](src/drivers/external/acp.js)

实现时把上游原样导入与行为改动分成两次提交，记录来源仓库、提交、原路径和上游测试，同时随包保留 Apache-2.0 许可证、相关版权与 NOTICE，在修改过的文件标注修改。后续升级按原路径审阅修复，优先合入能由回归用例重现的协议变化。[版权、许可与组件来源](THIRD_PARTY_NOTICES)

## 3. 四种 Agent 的接入方式

| 成员 | 第一版驱动 | 运行中控制 | 会话与复核依据 |
|---|---|---|---|
| Codex CLI `0.170.0` | 常驻 `codex app-server --stdio`，完成初始化，使用 `thread/start`、`turn/start`，逐条接收 item、审批及 turn 事件。 | 原生 `turn/steer(threadId, expectedTurnId, input)` 追加到目标轮，`turn/interrupt(threadId, turnId)` 请求停止。若指定轮刚结束，将指令留给用户选择下一轮。 | 保存可恢复的 `threadId`，通过 `thread/resume` 重连。已在本机完成 initialize，并从该二进制生成的 schema 核实两个动作的必填字段。真实插话与重启续聊放入 P1。协议方法（`~/code/codex/codex-rs/app-server-protocol/src/protocol/common.rs:1119`） |
| dsh `0.2.2-rc.1` | 同 Host 内为每位 dsh 成员创建独立原生 Session，使用 SessionController 和 Agent inbox。需要不同 profile 或进程时另配 dsh ACP 驱动。 | 进程内 `steer` 投入最近可接收输入的 step，`followup` 放到后续轮次，`cancel` 请求中断。通过收件记录和实际 step 事件对齐。跨进程 dsh ACP 同会话只允许一个未结束的 prompt，开放排队和中断后发送。 | 成员保存 dsh session ID；使用同一持久化配置恢复。分开测试进程内与独立 profile 两条路径。[rc.1 命令实现](https://github.com/deepseek-ai/deepseek-harness/blob/66491b05e3/packages/api/session-controller/src/commands.ts#L304) · dsh ACP 并发校验（`~/code/deepseek-harness/packages/acp/acp/src/session.ts:229`） |
| Claude Code `2.1.328` | 每个会话保留一个原版 `claude --print --input-format stream-json --output-format stream-json --verbose` 进程。按版本接入流式增量、宿主权限询问、用户消息回显及原生 interrupt。 | stdin 可在进程运行时接收 user 消息。写入完成和 CLI 回显只能分别证明写入与接收。用受控工具边界测出本版本何时消费后，再标记“当前轮追加”或“下一轮处理”。先提供明确的排队与中断后发送。 | 固定原生 session ID，按 CLI 的 `--resume` 恢复；保持登录、项目指令和工具配置归 Claude 管理。本机已核实版本与参数，协议处理见本地驱动。[Claude 驱动](src/drivers/external/claude.js) · [输入与 interrupt](src/drivers/external/claude.js) |
| Antigravity CLI `1.5.12` | 使用 Google 原生 `agy acp`。按成员的工作目录启动进程，协商 ACP 版本、load/resume 和可用权限选项。 | Google 从 1.5.0 开始记录“运行中再发 prompt 可 steer”，初版工作台对忙碌的 ACP 成员主动排队。本机 1.5.12 握手成功，返回 ACP v1 和 load、resume、list、close，握手里没有独立的 steer 声明。单列该版本的双 prompt 测试，通过后只对已验证组合开启。 | 持久化原生 session ID；分别测试恢复对话和历史回放。恢复历史与重新连接仍在运行的工具是两种能力。[Google ACP](https://antigravity.google/docs/cli/acp/) · [Google 1.5.0 更新记录](https://antigravity.google/docs/changelog?tab=cli&version=1.5.0) · [进程目录处理](src/drivers/external/engines.js) |

新增第五种 Agent 时，先尝试通用 ACP 驱动，只有存在可验证的额外能力才增加专用映射。ACP v1 给出了 prompt、update、取消和结束原因。v2 目前是草案，允许在 running 或 requires_action 时提交 prompt，但消息立即插入、延后插入、作用于当前轮还是下一轮，仍由 Agent 决定。Godbot v1 只定义插件内部的 TypeScript 控制接口，以后出现远程执行器的真实需求再版本化为网络协议。[ACP v1 回合与取消](https://agentclientprotocol.com/protocol/v1/prompt-turn) · [ACP v2 活跃工作中的 prompt](https://agentclientprotocol.com/protocol/v2/prompt-lifecycle#prompts-during-active-work)

## 4. 插件边界与控制语义

```text
dsh 工作台 / slash 命令 / dsh 模型工具 / 外部成员的协作工具
                         │
                 Godbot Host service
           ┌─────────────┴──────────────┐
     团队、任务、消息和验收         成员会话、投递、审批和事件
           └─────────────┬──────────────┘
               每成员一个会话控制器
        ┌────────┬───────┴──────┬─────────┐
     Codex 原生   Claude 原生   ACP 客户端   dsh 原生 Session
                                └─ agy 或其他 ACP Agent
```

**交付形态。** 一个 npm profile bundle，提供 `package.json` 的 `dsh.bundle.patch`、`cordis.patch.yml`、Host `apply(ctx, config)` 和 Web client 入口。建议源码分为 `src/host`、`src/drivers`、`src/team`、`src/client`。Host 持有所有进程和活跃会话，页面刷新只需重新订阅。客户端走当前版本 dsh 的 Remote 与资源权限，使用现有 sidebar/main slot；模型通过工具调用同一服务，后台轮询和 UI 均不占用某个模型的运行回合。安装验收从打包产物执行 `dsh plugin --profile <profile> add <本地 tgz>`。bundle 示例（`~/code/dsh-superagent-prototype/package.json:30`） · 侧栏注册（`~/code/dsh-superagent-prototype/src/client/index.tsx:53`） · [rc.1 进程服务](https://github.com/deepseek-ai/deepseek-harness/blob/66491b05e3/packages/subprocess/subprocess/src/index.ts#L153)

**对用户开放四个动作。**

| 动作 | 行为与完成条件 |
|---|---|
| 本轮追加 | 明确绑定正在运行的 turn。后端能保证该语义时显示按钮。若该轮已经结束，显示原因并保留草稿。 |
| 下一轮发送 | 先在 Godbot 持久化排队，允许编辑、撤回；旧轮结束才真正投递。待审批期间也能排队。 |
| 停止当前轮 | 只作用于指定成员和回合。显示“正在停止”，收到原轮终态后显示结果。已发生的文件修改、已提交的外部动作保留，单列仍在运行或状态未知的工具。 |
| 打断并发送 | 把新指令与待停的 turn 一并持久化。确认旧轮已停止或已自然结束，才在同一 session 开新轮；旧轮自然结束时如实显示。超时或断线保留指令，进入待核实状态。 |

**驱动契约。** `open/resume` 返回原生 session 标识与能力，`startTurn` 返回或异步关联 turn，`steer`、`interrupt` 指定目标轮，`respond` 按原生请求 ID 回答审批或提问，`close` 释放 Godbot 所有的资源。事件至少区分会话、回合、文本增量、工具开始/更新/结束、权限、提问、错误和连接断开。仅转发后端公开的活动；不能识别的原生事件保留类型和受限诊断。按驱动和版本记录能力及其证据来源，例如协议声明、本机验证、尚待验证。

**保留原生 CLI 习惯。** 新成员默认继承 CLI 自己的模型、推理强度、项目指令与工具设置。驱动能枚举模型、模式或原生命令时，在成员页展示真实选项和生效回合。Godbot 的命令在工作台处理，成员自己的命令发给该成员。ACP 客户端只声明自己实际实现的文件、终端或交互回调；启用宿主回调时，按会话目录和原工具权限执行。首版优先让 CLI 使用自己的执行环境，避免同一命令被宿主和 CLI 各执行一次。

**状态与回执。** 单独跟踪进程连接、会话、turn、单条输入、工具与团队任务。每条命令带 `requestId`，每轮可绑定 `expectedTurnId`，事件带 `memberSessionId`、`connectionEpoch` 和本地序号。界面区分“本地排队、已写入、Agent 已确认、已在某轮生效、结果未知”；只有存在可关联的原生证据才继续推进。没有原生 turn ID 的后端由驱动生成本地轮次并标明来源。迟到事件归回原轮，旧进程事件不能结束新进程的任务。

**持久化与崩溃恢复。** 第一版建议插件专用 SQLite 保存 teams、members、sessions、turns、commands、events、tasks、deliveries 和待处理交互。命令和待投递记录同事务提交，按成员串行写入；每个原生会话只有一个活跃的控制者。重启按原生 ID 复核，能 resume 的成员恢复会话并对齐历史。无原生幂等键且断线前可能已受理的输入标记“投递未知”，允许用户核对并决定重发。会话丢失时提供“以交接摘要新开会话”，明确新 ID 和上下文来源。日志按 profile 和工作区隔离，过滤凭据，文本增量分批持久化，优先保存审批和终态。

页面关闭只解除订阅。禁用插件或退出 Host 时停止新派工、结清待处理回调、按驱动请求取消和关闭，再通过 dsh 进程服务核实受管子进程及其子进程已释放。若工具卡住，显示具体成员、回合和仍在运行的工具；用户可显式终止该成员的受管进程范围。该路径保留原终止原因和可核实的磁盘改动。

## 5. 多 Agent 如何真正协作

1. **成员与寻址。** 一个团队对应一个协调空间；团队里的每个成员拥有独立可寻址的会话。同种 CLI 可建多个成员。默认 dsh 担任协调者，用户可以直接把任务交给任何成员；具有团队工具的外部成员也能担任协调角色。原生 CLI 自己派生的内部 subagent 可以展示在该成员下，只有后端明确给出控制权时才提供操作。
2. **派工和回传。** 共享任务存目标、负责人、依赖、验收条件、工作产物和状态版本。用事务校验认领或移交，依赖完成后只唤醒目标成员。消息封装包含 `from`、`to`、`taskId`、`exchangeId`、`replyTo`。群内普通发言默认给协调者，`@成员` 定向投递，多个点名才并发。成员提交结果后沿原 exchange 回发，其他成员需要上下文时读取摘要、文件或 commit 引用。
3. **让外部 CLI 主动协作。** dsh 成员使用插件注册的工具；外部成员优先通过限定到该团队和会话的本地 MCP bridge 获得同一组操作，例如 `list_members`、`send_message`、`assign_task`、`report_result`。身份由 Host 绑定，Agent 无法通过传参自称另一成员。只具备接收能力的 CLI 也可接任务并由 Host 回传最终结果，UI 显示其可用动作。MCP 承载协作工具调用，运行中插话仍走各自的会话驱动。[会话级工具桥](src/team/mcp.js)
4. **执行与验收。** 区分“成员回复完毕”“提交待验收”“任务完成”。验收可以是测试结果、文件或 commit，由指定验收人或协调者确认。依赖失败可阻塞下游。停止一个成员只终止它的当前轮，停止整个团队先关闭该轮派工入口，再取消在跑的成员；迟到回复保留到历史，不能重开已停的任务。
5. **工作区。** 只读分析默认允许共享目录；修改任务可使用独立 Git worktree 或明确串行的共享目录。在非 Git 项目首版采用单写者。审查成员收到正确的基准 commit 与补丁，验收后由指定集成人合并，冲突保留两方产物。角色标签只决定调度意图，实际文件权限以 CLI 沙箱与宿主可执行的授权为准。

## 6. 工作台与审批

侧栏列团队、成员和当前活动。主区可切换群聊、成员时间线和任务板。成员页常驻显示实际 CLI、工作目录、原生会话标识、当前轮、工具活动与输入状态。输入框直接提供该成员支持的发送方式。工具审批卡和 Agent 向用户提问的卡片分开展示，显示发起人、目标目录、动作与后端原始选项；回复关联原请求，回合结束或被替换后卡片失效。取消 ACP 回合时按协议结束待处理的权限请求。

建议的命令交互为 `/godbot team`、`/godbot members`、`/godbot send <成员>`、`/godbot stop <成员>`。相同动作可由人直接发起，协调模型下线时仍能停任务和回答审批。启动配置通过可信的本地 profile 显式设置可执行文件、参数数组、工作根目录与权限；用户 prompt 仅进入协议输入。子进程在 Host 受管范围内启动，凭据由 CLI 的正常登录流程使用，团队消息和工作台不接触令牌。

## 7. 交付阶段与验收

按一名熟悉 TypeScript 和 dsh 插件的工程师估算，P0–P3 共 **13–21 个工程日**。这是排期估算，假设本机 CLI、测试账号和持久化配置可用。P0–P1 可先交付可操作的双 Agent 版本。

| 阶段 | 产物 | 可复核的完成条件 |
|---|---|---|
| P0，1–2 天 | 移植 CLI 驱动及其回归用例，打包安装 Godbot 最小 bundle，记录本机版本与能力；在原夹具上增加可控工具阻塞。 | 导入前后的上游启动用例结果一致；在独立 rc.1 profile 中从包安装、加载、看到面板，能创建和释放测试会话；夹具可复现“回合刚结束”和“正在等审批”。 |
| P1，4–6 天 | Codex + dsh 原生驱动、成员页、四种控制动作、基础持久化，以及 Codex 给 dsh 的单次定向结果回传。 | 运行中追加唯一指令，在原轮终态之前观测下一步工具参数改变；排队指令等旧轮终态后执行；打断后新轮只启动一次。页面刷新不打断运行；同一 dsh 会话和 Codex thread 均可再聊，dsh 收到带来源的执行证据。 |
| P2，3–5 天 | 将移植的 Claude、ACP 驱动接入成员控制器，完成 Antigravity 专项、权限和提问卡、恢复与诊断。 | 在四个真实 Agent 上分别完成新建、流式活动、两轮上下文、打断、再发、重启后恢复或显示明确能力边界。逐一验证实际提供的审批/提问路径；独立记录 Claude 输入消费时机、Antigravity 双 prompt 和两工作目录并发结果。 |
| P3，5–8 天 | 抽取群路由、派工、验收及消息回传，接入 Godbot 账本；移植成员协作工具桥并集成验证。 | 四成员完成一次“分析 → 实现 → 审查 → 汇总”；有两个成员并行，有一条外部成员主动发出的点对点消息，有一次中途改向和一次审批。按每条消息、每次任务认领、每个产物可追溯，重启后无重复派工。 |
| 后续，单独排期 | 原生 TUI 人工接管、更多外部 ACP Agent、远程执行。 | 有官方 attach 或安全交接机制的后端，移交前停止自动写入，归还后核对会话和控制权。只有独占 TUI 的 CLI，可从一开始经受管 PTY 启动，提供人工交互；分别验证终端接管、会话恢复和结构化工具事件覆盖度。Zed Terminal Threads（`~/code/zed/docs/src/ai/terminal-threads.md:8`） |

**验收方法。** 在临时工作区放一个可控工具，第一步上报 `ready` 并等待释放。收到 ready 后分别注入“下一步产出 B”的 steer、queue 和打断后发送。用原生事件、回合标识和实际文件/工具参数三个证据比对。释放阻塞后，同轮插话应在旧轮结束前改变后续步骤；排队应始于下一轮；打断应有旧轮终态及一次新轮开始。再覆盖用户输入与自然完成同时发生、工具等待审批时停止、重复点击投递、CLI 崩溃以及另一团队使用同种 CLI 的场景。离线回放覆盖时序，真实 CLI 复核行为，分别出结果。

**首个里程碑。** 打开一个 dsh 面板，并排启动一个原生 dsh 成员和一个 Codex 成员。用户在 Codex 工作中改变其下一步动作，dsh 随后收到含文件和测试证据的结果。这一条链路同时检验了插件装载、原生 CLI、运行中干预与跨成员交接；跑通后再扩充其余驱动和完整团队面板。

<a id="openmaus-roadmap"></a>

## 8. 对照 OpenMausBot 的实施计划

**交付目标。** 已在 DSH 使用 Claude、Codex 的开发者，可以把同一个已授权工具交给不同成员，在完整工作台接手原生团队留下的任务，并从 CI 等到整项工作验收完成、取回对应证据。以 Godbot `71e8cac`、DSH `0.2.2-rc.1` 和 OpenMausBot `ecabd15ca` 的本地源码为基线。

### 8.1 首发范围、顺序与工程量

以下是按一名熟悉 DSH、Node.js 和 CLI 协议的工程师估算的**人日**，包含实现和该阶段的自动化验收。假设已有可运行的 rc.1 测试宿主及发布前验证 CLI 的条件。不同宿主、云服务开通及人工等待时间另计。M1 和 M2 可由两人并行，M3 的任务状态设计也可提前开始。

| 阶段 | 实施与现有代码落点 | 交付、依赖和退出条件 | 人日 |
|---|---|---|---|
| M0　建可重放的基线 | 从实际 npm 安装包启动临时 DSH Web。准备脚本模型、Claude/Codex 协议夹具、可计数的工单 MCP、浏览器场景和统一报告。贯穿新装、升级、重启，沿用 [宿主依赖解析](scripts/host-peers.mjs) 与 [现有测试入口](package.json)。 | E0 可在干净环境连跑两次，每次创建独立数据；当前缺口作为 M1–M3 的验收目标。 | 2–3 |
| M1　让完整团队的成员使用已授权连接器 | 改 [完整团队适配器](src/host/team-runtime/local-agents.js)。把当前 Session 真正获准、已挂载的连接器工具加入现有团队工具桥，继续经宿主原有的权限、审批与连接器网关执行。目录和调用使用同一套授权判定，调用前再检查撤权、只读和账号范围。面板按成员展示后端、工具及不可用原因。 | 依赖 M0。完整团队入口内，DSH、Claude、Codex 均完成 E1；撤权、拒绝及重连通过 E2。原生控制台有[独立的成员工具桥](src/host/service.js)，该入口单列能力。若后续开放同类工具，须绑定可验证的执行身份并独立通过 E1/E2。 | 5–8 |
| M2　从完整工作台接手原生任务 | 在[已有导入映射](test/fixtures/team-import.js)上增加分页的来源视图。按稳定的团队、成员、任务、证据修订 ID 读原记录，每次核对绑定和可见性。owner 可预览、选取交接内容，附来源和证据版本送入当前 Bot 私聊。群聊使用单独选择的共享内容。 | 依赖 M0。E3 验证跨入口追到原证据，新 Bot 可用指定版本继续工作；重复确认仅产生一份交接。原生记录继续持有审批和验收权，面板提供返回原记录的操作。 | 4–6 |
| M3　用 CLI 驱动原生团队完成工作 | 在包中发布 `godbot` 命令。复用 [Host 事务与回执](src/host/service.js)、[任务验收](src/host/team.js)和同一写入实例。提供 `run / wait / inspect / export`；外部 Agent 通过 stdio MCP 调用同一组 Host 操作。由 owner 签发可撤销、限定团队及操作的凭据，CLI 与 MCP 使用相同的权限和运行 ID。Host 从活动命令传播 `runId` 及父任务关联，跟踪整棵委派树。 | 依赖 M0；与 M2 集成验收 E4/E5。首发目标为原生团队，能导出证据、结构化状态和退出码。完整团队的 room/会话另接团队服务的派工回执与消息账本，按同样场景验收后开放该目标。 | 6–9 |

**首发合计约 17–26 人日**，第一项可独立试用的能力是 M0＋M1，约 7–11 人日。M1 处理 ES 模块适配和打包源文件，修改上游行为时在仓库内维护适配及夹具，确保干净安装能重建相同产物。

**实现时需先固定三项用户可见的约定。**

1. **工具授权和工具形状。** 连接器设置的“已连接”、当前成员 CLI 实际列出的工具和最近一次调用结果分别展示。只允许桥接归属于已启用连接器且在本 Session 工具集内的工具。CLI 收到会话级的调用入口，第三方凭据由 Host 保管。初版回环桥会简化 JSON Schema，须验证嵌套对象、可选字段、枚举及引用；凡当前 CLI 无法可靠表达的工具，显示具体原因。Shell、PTY 和 CLI 自配 MCP 分别保留其原有权限边界。
2. **身份和证据连续性。** 新 Bot 会话和旧原生会话保留各自 ID。来源链接在读取时检查群成员和私密状态，历史审批作为只读回执。已确认发出的摘要会进入目标会话历史，预览应标明受众；重复确认以来源、证据版本、目标和内容摘要去重。旧记录缺少关联字段时展示可验证的历史，新建运行才自动归集完整委派树。
3. **CI 完成语义。** Host 按运行树而非整个团队计算结果。根任务和必要子任务都通过各自验收才返回成功；`reported` 显示“待验收”。独立返回“需人工处理”“失败/已停止”“等待超时”和“结果待核对”。超时只结束此次等待，可凭同一 `runId` 续查。请求 ID 与规范化入参绑定，同 ID 换内容返回冲突。现有证据为文本，首发导出原文与修订；若承诺文件导出，同期增加显式附件清单，按该运行获准目录取文件，记录相对路径、大小和 SHA-256。提议 CLI 退出码为 0 成功、1 失败或已停止、2 参数或授权错误、3 需人工、4 等待超时、5 结果待核对。JSON 同时给出状态、原因及运行 ID。CLI/MCP 身份可派工、查询和导出其获准的运行，审批和任务验收沿用现有 owner 权限。

参考对照可直接查看 OpenMausBot 的 [Codex 工具挂载](../OpenMausBot/server/drivers/codex.ts)、[无界面运行和退出状态](../OpenMausBot/server/headless/run.ts)及[打包后行为回放](../OpenMausBot/evals/README.md)。

### 8.2 后续交付

| 顺序 | 实施边界 | 对应验收 |
|---|---|---|
| M4　事件派工与无人值守运行 | 先做通用入站 Webhook，绑定一个已选团队和任务模板，持久化投递号、内容摘要及运行 ID。和 M3 共用派工事务。再做 Bot/profile 级 UTC 日、月用量准入和预选备用模型。零用量、未报告、未定价分开表示；订阅费用标明估算。最后为有实际接入条件的应用增加原生事件适配器。 | E6、E7。Webhook 可先独立交付。每种应用另需通过“真实应用事件 → 同一个运行回执”；预算和备用引擎可各自启用。 |
| M5　模板、换机与日常协作 | 模板携带角色、群、技能清单和默认暂停的计划；备份另做一致性快照，包含两套工作台必要状态、所属 DSH Sessions、附件、记忆和映射。先给 owner 做跨线程收件箱，再增加群自动路由，显式点名优先、低置信度回原管理员。 | E8、E9。模板导入、全量恢复、收件箱与群路由可分别交付。 |
| M6　远程桌面与多人工作区 | 先做服务端浏览器和 Web 实时接管，再接每 Bot 独立容器，云电脑为单独 provider。多人模式引入可信真人身份、资源级查看/聊天/管理权限和操作者审计，覆盖 API、订阅、附件和导出。 | E10、E11。每种执行环境和多人模式单独验收；计划扩展到多设备或多真人共享时分别排期。 |
| 贯穿各阶段　发布与兼容 | 每个发布候选验证 npm 包安装、从前一支持版本升级、失败恢复、当前选择的宿主及 CLI 版本。对上游 UI 构建产物做摘要校验和真实页面冒烟。 | E0、E12。某后端仅通过协议夹具时，报告保留该覆盖范围。 |

<a id="openmaus-e2e"></a>

## 9. 端到端验证方案

### 9.1 测试环境、入口与数据

- **确定性环境。** 临时根目录下建立独立的 `DSH_HOME`、标准 `web` profile、Godbot 数据目录、导入父目录、Git 工作树、下载目录和夹具 CLI 配置。用回环端口启动真实 DSH Web、脚本模型和测试工单 MCP。安装实际 `.tgz` 并用 [hostPeerSpecs](scripts/host-peers.mjs) 链接同一份宿主依赖。现有 [本地安装器](scripts/install-local.mjs) 会把包写进系统用户目录，导入也有 home 下的默认目录；测试启动器应显式指定临时路径，或在独立系统用户中覆盖整条安装路径。读取该 profile 实际加载的 build ID。
- **用户入口。** 浏览器以该 profile 的测试 owner 进入 `/#/godbot` 和 `/#/godbot/agents`，完成创建、授权、迁入、审批和验收。CLI 测试从安装后的可执行文件开独立进程；Webhook 从另一进程发送真实 HTTP 请求。内部数据库只承担结果核对。复用本仓库 [CLI 夹具](test/external/fixtures)、[导入恢复用例](test/service/team-import.test.js)和[任务交接用例](test/team/service-handoff.test.js)；M0 将回环模型及必要夹具纳入本仓库。
- **测试数据。** 创建 A、B 两个团队和重名成员。工单服务在测试开始后生成随机工单值，独立记录调用、读写对象与副作用次数。测试仓库准备一条依赖链、一条并行无关任务和一份内容可校验的报告。所有断言关联本次运行 ID，异步步骤等待真实回执或可控阻塞点。需要重启时保留同一临时数据目录。
- **真机复核。** 对发布声称支持的 Claude/Codex 版本，使用实际二进制、本机测试登录和同一个回环工单服务，从完整工作台做一次读回、拒绝、断线重连。记录二进制版本；调用模型可能使用账号额度。[现有真机控制探针](test/external/live-control.mjs)验证插话/中断，连接器接入另走聊天端到端。真实 SaaS、容器和云电脑各用专属测试资源和唯一标记复核。

### 9.2 验收场景

| ID | 操作及故障注入 | 通过条件和独立证据 |
|---|---|---|
| E0　安装基线 | 从 tarball 在空 profile 安装，打开两个入口，创建团队、发送夹具消息；关闭再启动 Host。 | 页面能正常交互；Host build ID 匹配该包，成员及消息重启后可读。第二个临时 profile 查不到第一个的随机标记。保存安装清单、build ID 和浏览器记录。 |
| E1　跨引擎工具一致性 | owner 给完整团队 A 授权工单读取。分别从 DSH、Claude、Codex 聊天读取本次随机工单；再传入含嵌套筛选与可选枚举的参数。B 在同一时间运行。 | 三种后端均能在实际工具目录看到允许的操作；各自收到新生成的值和调用回执，服务端收到预期参数及预期次数。未获权成员看不到或调用被拒，服务端无该成员的请求。 |
| E2　授权变化与人工接管 | 对需要确认的写分别批准和拒绝；切只读，在工具列出后撤权，再试旧会话。重启 Host、重连 CLI、将支持的原生终端接手后再交还聊天。 | 工单服务按用例分别观察到一次和零次写入；只读、撤权及旧请求均无新增写入。交还后同一聊天按当时授权重新取得目录。记录审批 ID、工具调用 ID 和业务回执；终端内活动单独标注。 |
| E3　跨工作台接手 | 原生任务证据 R1 退回，R2 验收。迁入完整团队时中断，再启动并重复确认；从新 Bot 打开来源并确认交接 R2。另测同名成员、转私密和群共享。 | 只生成一份对应 Bot/群和一份 R2 交接。来源页展示 R1、R2 与各自决定，新 Bot 可引用 R2 的随机标记和源 ID。原生会话、目录可继续使用，旧审批触发次数为零。失效关联、其他团队及群共享场景不返回私聊内容。 |
| E4　CI 等到整棵树验收 | CLI 启动一个原生团队运行。负责人给下游派工后先结束；下游依次经历等待审批、报告、退回、重报、验收。另一独立运行在同团队并行。期间让 CLI 超时，再按原 ID 重连；外部 stdio MCP 客户端用同范围凭据查询同一运行。 | 负责人已结束、子任务仍运行或待验收时，CI 均不返回成功。仅当前树全部通过后退出成功。其余状态有独立 JSON 值和退出码。导出的证据明确修订；文件导出纳入发布时逐字节核对散列。CLI 与 MCP 返回同一状态和修订；另一运行的数据不进入本次导出。凭据撤销后，两种入口都拒绝后续读取。 |
| E4-FULL　CI 运行已绑定的完整团队 Bot 或群 | owner 向一个已关联 Bot 和一个已关联群分别签发凭据。Bot 交接给已关联成员，在负责人结束本轮后让下游请求审批；owner 退回第一版并验收新修订。另经 stdio MCP 向群派工，核对实际群账本及成员回报。 | 两个目标各有可导出的关联回执；根结束时 CI 仍等待子工作，审批前没有外部副作用。CLI 与 MCP 的等待、验收修订、失败、撤销、跨目标隔离及 Host 强杀后的 unknown 都有独立断言。 |
| E5　请求重放与失联 | 并发发送相同请求 ID；再用相同 ID 变更内容。分别在派工事务提交后响应前、原生动作已发送而回执未落盘时终止临时 Host。 | 已提交请求可返回原 `runId`，不同入参返回冲突。已送达但无法核对的动作显示“结果待核对”，不自动重发。恢复后 CLI 凭运行 ID 重新读状态；对照提交记录、任务数和夹具副作用数。 |
| E6　Webhook | 发有效事件、两份并发重复、同投递号不同内容、无效签名及暂停后的事件；在入队事务提交前和提交后响应前分别重启，再重投。 | 仅在回执与入队记录一起提交后返回 `202 + runId`。重复投递返回原 ID；同号异内容报冲突，无效或暂停不派工。重启后同一有效事件只有一个运行。CI 可据此 ID 读到 E4 的终态。 |
| E7　预算与恢复 | 用可控时钟和已知用量跑两项并发任务，达到日/月门槛后尝试无人值守新派工；重启、跨周期、注入明确的供应商额度拒绝，以及“已发送、未确认”的另一种故障。 | 账本按调用去重，已开始的回合允许结束，达到门槛后的新派工被阻止；跨周期恢复。确认额度拒绝且有兼容预选引擎时仅接管一次，原额度恢复后按策略切回；待核对动作不重放。记录每次准入、用量来源和所选引擎。 |
| E8　模板和换机 | 在另一干净 profile 导入团队模板；再以两个临时环境做加密备份恢复，覆盖目标目录重映射、错误密码、截断包和恢复中断。 | 模板生成新 ID、计划暂停、无历史和凭据。恢复后原任务关系、证据版本、会话和附件内容可读，执行一轮新任务成功；失败可回到目标原数据。外部 CLI 登录和原生会话能否在目标机恢复需逐后端记录。 |
| E9　收件箱与自动路由 | 两个 Bot 在不同会话同时提问。连续处理并并发回答同一卡片；发送显式点名、可明确分类的消息、低置信和路由器超时的消息。 | 每次回复只解除相应回合，两次并发回答仅一条生效；显式点名命中指定成员，高置信单选只启动目标一次，其余按既有管理员策略回退。核对会话 ID、审批回执和实际启动成员。 |
| E10　远程浏览器和桌面 | 两个 Bot 各持一个资料目录或容器并登录不同测试账号。通过 Web 观看、接手、在页面填写随机值、交还；模拟断连和 Host 重启。 | A/B 登录状态独立；接管期间只有人能输入，交还后 Bot 在同一页面读回随机值。断连有可见状态，租约按策略回收。真实本地容器和云 provider 分别保存设备回执及画面证据。 |
| E11　多人授权 | 用两个人类凭据分别开浏览器，通过列表、深链、搜索、附件、导出和活动订阅访问同一组公开及私密数据；中途调整成员权限。 | 每个入口只返回该身份获准的数据；活动订阅随权限收敛，已撤权者无法读取后续事件或批准任务；每项管理操作均可追到真人和对象。 |
| E12　安装升级和回退 | 在隔离 profile 从上一支持包创建历史、任务和待处理请求；安装候选包并启动，检查旧数据，再模拟候选加载失败。 | 新装和升级的两个工作台均可用，旧记录仍可定位。按声明的兼容性回到上个包；若有不可逆数据变化，使用升级前一致快照与对应包恢复。复核原证据、待办状态、包摘要及回退后的一轮新任务。 |

**贯穿首发的一条人工验收路径。** CI 向原生开发团队派发“生成测试报告”。开发成员提交报告，审查成员核对结果并给出意见。owner 退回一次，开发成员重报后由 owner 验收。owner 从完整工作台打开已关联的原任务，核对最新报告并把选定证据交给新 Bot。该 Bot 在完整团队的 Claude 或 Codex 聊天里读取已授权的测试工单，并引用报告修订与工单标记。最后核对 CLI 导出的运行证据和工单服务的实际回执。两条会话以显式来源关联，各自记录执行身份。M4 交付时把起点换成 Webhook，并重投同一事件，重复检查运行数和副作用数。

### 9.3 如何运行和判断发布

**现有入口**可在干净 checkout 中执行。构建会生成浏览器包和 Host build ID。

```sh
npm ci
npm test
npm run build
npm pack --json
```

**候选包验收入口**为 `npm run test:e2e -- --case E0` 和 `npm run test:e2e -- --suite release --artifact <绝对路径.tgz> --report-dir <结果目录>`。任一必测用例失败或未执行，进程返回非零。报告分别记录功能失败、环境失败和未执行。发布套件覆盖 E0–E5、完整团队的 E4-FULL 及 E12。全量套件额外运行 E6–E11。

```sh
npm run test:e2e -- --suite all --artifact "$candidate" --previous "$previous" --report-dir "$reports/all"
npm run test:e2e -- --case E0 --artifact "$candidate" --report-dir "$reports/second-install"
npm run test:e2e -- --suite live-connectors --artifact "$candidate" --report-dir "$reports/live"
```

其中 `candidate` 和 `previous` 分别指向两个本地 npm 包，`reports` 指向结果目录。E10 容器用例使用 `docker build -t dsh-godbot-browser:1 src/host/team-runtime/browser-container` 构建的镜像。按本轮确认的范围，E10 验收本机浏览器及真实本地容器。远程云端设备单列为未验证。E6 可用 `GODBOT_E2E_GITHUB_REPO=owner/repository` 读取真实公开事件。真实 CLI 套件使用本机已有的 Claude Code 和 Codex 登录。

每次报告记录提交、包 SHA-256、Host build ID、OS、Node/DSH/CLI 版本、执行层级、场景 ID、预期与实际，以及脱敏的 UI/RPC、任务/证据修订、上游调用次数和产物散列。脚本夹具、真实 CLI、真实第三方服务分别列出。支持声明对应的用例须通过；故障看首次失败证据，修复后复跑失败用例与贯穿场景。发布先装隔离 profile，再在一个试用 profile 验证原生和完整工作台，之后扩大范围；触发 E12 回退后复核数据与运行状态。

**立项基线（2026-11-20）**使用 Node `24.14.0`、DSH `0.2.2-rc.1`。当时的 184 项回归中有 183 项通过、1 项 Windows 专项在本机跳过。0.2.0-rc.1 的实施和验收记录另见[候选包验证报告](VERIFICATION.md)。
