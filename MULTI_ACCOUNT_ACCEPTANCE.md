# 本地 Agent 沙箱多账号验收

以下结果对应每条记录注明的安装包和运行时间。双工作台入口与独立成员的实测记录保留为该版本的历史依据。当前 Bot 的账号选择与原生会话操作见 [使用说明](README.md)。

## Codex 只读任务免审批

2026-11-20 18:34（UTC+8），沙箱 A 的 Codex 0.170.0 在 `read-only`、`approvalPolicy=never` 下完成了真实模型回合。模型从 VirtioFS 共享目录读取指定文件，答对了只存在文件中的随机值。原生会话记录确认执行了读取，没有请求提权；审批放行和宿主 CLI 回退次数均为零。DSH 验收使用本机安装包 `8a9d1b578531e38b` 和独立 profile。真实模型与原生会话回执（`~/.local/state/dsh-godbot/sandbox-install-e2e-y_w7vss4/codex-readonly-fix/strict-e2e/report.json`）

修复仅应用于 A。采用 Ubuntu Noble 的 `bwrap-userns-restrict` 策略，绑定到 root 持有的 Codex 0.170.0 随包 helper，使用独立的 profile 名称。已保存到 guest 的 `/etc/apparmor.d/godbot-codex-bwrap-0170` 并由文件重新加载。Ubuntu 的全局 userns 限制仍启用，子命令运行在 enforce 模式。对同一个可写挂载的对照测试中，guest 普通用户可创建文件，进入 Codex 只读模式后可读取但创建文件收到 `EROFS`。后续 Codex 升级若改变 helper 路径，需要重新绑定并复验。只读与写入对照回执（`~/.local/state/dsh-godbot/sandbox-install-e2e-y_w7vss4/codex-readonly-fix/persisted.json`） · [Ubuntu 对 bwrap profile 的说明](https://discourse.ubuntu.com/t/understanding-apparmor-user-namespace-restriction/58007)

## Codex 已登录后的本机验收

2026-11-20 18:28（UTC+8），3080 工作台已运行更新后的 `bbcb25e8d384aae1`，日常 `web` profile 的多账号开关为关闭。验收使用与该服务相同的安装包，在独立 profile 中选择沙箱 A。Codex 官方 CLI 报告已登录，原生线程从 VirtioFS 挂载目录读回了仅写在文件里的随机值。宿主 CLI 回退次数为零。Claude Code 本轮按用户要求暂缓。Codex 真实回合（`~/.local/state/dsh-godbot/sandbox-install-e2e-y_w7vss4/verified-codex-live/report.json`） · 本机安装核对（`~/.local/state/dsh-godbot/sandbox-install-e2e-y_w7vss4/codex-live-installed.json`）

本机使用 Apple Virtualization.framework 启动轻量虚拟机，Ubuntu 是 guest 操作系统。此次读取触发一次 Codex 原生审批，仅对当前回合读取当前测试文件放行。guest 的 AppArmor 规则阻止了 Codex 内置 `bubblewrap` 初始化网络命名空间，因此还不能把这次结果记为「内置只读沙箱中免审批读取」。外层虚拟机、账号隔离和宿主挂载均参与了该测试。guest 诊断回执（`~/.local/state/dsh-godbot/sandbox-install-e2e-y_w7vss4/codex-guest-readonly-diagnosis.json`）

## 本机安装与工作台

2026-11-20，首轮安装验收使用 DSH 本机 `web` profile 的 `dsh-godbot 0.2.0-rc.3`，当时的 Host build 为 `c8482a8283ebf277`。在 3080 端口实际加载的 Host 和浏览器客户端均与安装包匹配。原生 Agent 和完整 Bot 团队都显示同一个按 profile 保存的开关。日常 profile 保持默认关闭，验收成员与测试聊天使用独立的 DSH profile。已安装的服务与客户端（`~/.local/state/dsh-godbot/sandbox-install-e2e-y_w7vss4/installed-web.json`） · 实际设置界面（`~/.local/state/dsh-godbot/sandbox-install-e2e-y_w7vss4/installed-settings.png`）

两个入口都能绑定沙箱账号及其 VirtioFS 工作目录。账号、机器或挂载来源变动时需重新绑定。团队 Bot 的后台记忆整理会跳过沙箱对话，普通本机 Bot 可以继续自动整理。手动记忆仍可读写。[设置及增加共享目录](docs/user-guide.zh-CN.md#宿主账号清单) · [后台模型调用回归](test/team-runtime/sandbox-privacy.test.js)

该构建的真实 AGY 测试使用三个已登录账号。A、B 由原生 Agent 发送，C 经完整 Bot 团队发送。B、C 开始前已停机。每个账号都从自己的工作目录读取一个此前未提供给模型的随机值，其中 C 读取宿主共享项目的只读挂载。验收核对了三份不同的原生会话 ID、工作目录和 C 的持久化账号绑定，并等待后台记忆任务结束。测试对话没有进入宿主模型。三账号工作台 E2E（`~/.local/state/dsh-godbot/sandbox-install-e2e-y_w7vss4/verified-agy/report.json`）

沙箱 A 中，Claude Code 与 Codex 已经通过该构建的进程和原生协议验证。测试将宿主两类 CLI 替换为回退探针，实际命中次数为零。这份回执记录的是两者未登录时的行为。Claude Code 与 Codex 协议验收（`~/.local/state/dsh-godbot/sandbox-install-e2e-y_w7vss4/verified-protocols-diagnostics/report.json`）

浏览器全量回归 15/15 通过，包括开关默认关闭、开启后重启保留、在另一工作台关闭和包升级。单元及集成回归 265 项通过，1 项 Windows 专用测试在 macOS 跳过。全量浏览器验收（`~/.local/state/dsh-godbot/sandbox-install-e2e-y_w7vss4/verified-regression/report.json`） · 测试输出（`~/.local/state/dsh-godbot/sandbox-install-e2e-y_w7vss4/verified-unit.log`）

## AGY 三账号驱动级记录

2026-11-20 于 Apple Silicon Mac 执行。三个真实 Google 账号已完成授权并通过归属核验。三个原生会话并发执行，账号所有者在聊天中分别批准同一笔未完成的受限操作后，各槽成功取得一枚工具回执。三个原始访问令牌自然到期后均已刷新。随后三台 VM 全部冷启动，三个账号都在原会话成功答对工具回执。

本次使用三台独立的 Lima VZ 虚拟机。每台由 Apple Virtualization.framework 启动，分配 2 vCPU、2 GiB 内存，来宾系统为 Ubuntu，运行官方 AGY 1.5.13。本次 VM 配置使用 `vmType: vz` 和 `mountType: virtiofs`。宿主通过 SSH 启动 guest 内的 CLI，账号沙箱运行路径不依赖 Docker。测试调用仓库当前工作区的 Godbot 原生 AGY 驱动和团队 MCP。身份探测、账号登录和工具审批使用本机验收入口。本节为驱动级验收。后续本机安装版使用打包后的 DSH Web 和 Chromium 独立验证两个工作台入口。

| 项目 | 结果 | 证据边界 |
| --- | --- | --- |
| 隔离与冷启动 | 3/3 通过 | 初始配置为普通用户、私有 HOME、零宿主导出。三台机器均完成 ACP v1 握手。初次新建会话均返回要求登录。 |
| 空环境重启与密钥环 | 3/3 通过 | 三台的 Linux boot ID 全部改变。重启后每台仅在自己的 Secret Service 查询中读回本槽标记。各槽 SSH host key 校验和密钥环解锁成功。 |
| 网络与工作区 | 3/3 通过 | 每台向 Google 官方 OpenID 发现端点发出的 HTTPS 请求返回 200。各自的 Git worktree 基于同一个合成提交，分支为 acceptance-a、acceptance-b 和 acceptance-c。 |
| 三个真实账号 | 3/3 通过 | 三台均可创建真实原生会话。官方 AGY 状态栏报告的账号邮箱在 guest 内使用同一验收密钥生成 HMAC，结果三者各不相同。 |
| 并发回合 | 3/3 同时执行 | 三个不同的原生会话都在 UTC+8 16:14:44 开始，均观察到原生 CLI 对限定复制命令的一次性批准。 |
| 团队工具人工审批 | 三个申请抵达，无成功回执 | 在原生 CLI 的权限层，三槽都观察到允许该测试工具的回执。在宿主人工审批层，A、B 在取得允许前结束，C 收到拒绝，首轮实际完成次数均为 0。原记录按实际决定保留。 |
| 后续明确批准与实际交付 | 3/3 通过 | A、C 的两笔和 B 的一笔分别得到明确批准。原槽位、会话以及业务操作编号不变，在新回合中绑定一次有效的授权。三回合实际重叠。每槽宿主只执行一次，持久回读和模型最终回复都与该槽回执匹配。 |
| 工作区隔离与首次 A 重启 | 通过 | 三份复制结果均正确，六组跨槽文件均不存在。A 停机期间 B、C 保持原会话，A 重启后原会话可恢复。三个会话均无工具调用地答对各自历史中的用户随机标记。 |
| 工具回执的跨重启恢复 | 3/3 通过 | 16:28:24（UTC+8）确认 A 已停止，此时 B、C 在各自原会话准确回忆实际工具回执。随后仅 A 的 boot ID 改变，A 也按原会话 ID 返回正确回执。提示中没有回执，三次回答均没有调用工具。重启后再次测得三个账号的身份摘要分别与原值相同。 |
| 自然令牌续期 | 3/3 通过 | UTC+8 17:12:09、17:12:33、17:13:12，A、B、C 的初始令牌陆续到期。17:13:22 三份 AGY 主账号认证日志各自记录成功刷新，新到期时间均为 18:13:21。新进程中的三条原生会话均答对之前的工具回执，三份身份摘要各自匹配，无需重新登录。 |
| 刷新后的持久化与冷启动 | 3/3 通过 | 三台全部关机再从原盘启动，三个 boot ID 均改变。原生 CLI 重新启动后分别在原会话答对已交付的工具回执，身份摘要均与首次登录匹配。 |

## 默认本机模式与可选设置

产品要求为「沙箱多账号」默认关闭。单账号以现有本机 CLI 运行，使用宿主文件夹作为 cwd。启用开关仅增加可选的沙箱账号，虚拟机由明确选择它的成员按需启动。本报告的真实 Google 多账号和挂载实验均为主动选择隔离环境的验收。当前本机路径回归 3/3 通过。测试直接调用 Godbot 的原生 `openExternal` 入口，省略账号、配置和自定义启动器，仅在隔离 PATH 中以同名本地 CLI 夹具覆盖三个供应商程序。三个驱动都在宿主 cwd 完成建会话与一轮回复；测试中虚拟化命令均模拟为未安装，未观察到尝试调用。另有 3 个既有控制测试通过。本项没有使用个人宿主账户推理。正式开关的缺省状态、开启、重启保留及关闭已在后续打包浏览器用例 E13 覆盖，E12 单独覆盖升级。本机驱动回归回执（`~/.godbot-acceptance/agy-m_xscij5/receipts/local-default.json`） · [设置语义](MULTI_ACCOUNT_DESIGN.md#设置中的可选沙箱多账号)

## 宿主目录挂载验收

在三台已有登录的 VM 上增加宿主项目目录，原账号盘和原会话的 `/work` 都保留。A、B 以读写方式挂载同一宿主 checkout，C 对该目录只读。每台另有一份可写的宿主工作副本。每台只导出这两个叶目录，测试没有使用实际业务仓库。

| 检查 | 结果 |
| --- | --- |
| 同一份宿主文件 | 三台都读到宿主随机输入。A、B 依次覆盖同一文件后，Mac 和各 guest 的内容哈希最终一致。C 新建文件、写入已有文件均收到 `EROFS`。 |
| 并发处理同名文件 | A、B、C 在各自的独立 clone 及 linked worktree 并行写同名文件，宿主的六份 Git diff 均符合各自的标记。自包含的 clone 在 guest 内可直接执行 Git；linked worktree 的 Git 公共管理目录保留在宿主。 |
| 文件变化通知 | A fsync 后，C 某次预热读取在约 821 ms 后看到新值。Mac 原子替换另一个文件后，A、C 都能读到新内容；当前配置的 3 秒观察窗口内没有 inotify 通知。 |
| 跨 VM 写锁 | A 持有排他 `flock` 时，B 和宿主仍可获得各自的排他 `flock`。另用 Godbot 现有宿主锁判断核对六种情形，包括同一 checkout 的并发写、终端占用、上轮结果未知，以及独立 checkout 可并行。 |

**真实 AGY 驱动。** A 在共享宿主 checkout 工作，B 在自己的可写 checkout 工作，两者均使用新会话，原有三条续期会话独立保留。分别从宿主写入随机输入，AGY 在挂载目录内执行限定复制，Mac 直接读回输出。随后宿主原地修改输入，启动新的 AGY 进程并按刚才的会话 ID 恢复。两槽均得到新值，旧输出保持此前的哈希，四次成功操作均有各自的一次性原生批准。第一次 A/B 同时发起时，测试审批器拒绝了 B 的额外前台参数；纠正判定后只允许原命令和明确的前台执行，已拒记录独立保留。随后另发一轮并发请求，A 改共享 checkout、B 改自己的 checkout。两轮实际重叠至少 15.29 秒，两个宿主输出的哈希均匹配，分别只执行一次受限复制。

**挂载持久性。** C 单独重启后，共享目录仍为只读，自己的工作副本仍可写，三个文件的哈希及宿主 Git diff 均匹配。A、B 在 12 次 SSH 采样中可响应，boot ID 保持一致。原本未挂载的宿主目录和其他账号盘继续按各自授权隔离。

本次账号卷中，三个 guest HOME 权限均为 `0700`，AGY 创建的认证相关文件权限均为 `0600`。这里只读取文件元数据。密钥环标记的恢复记录无法单独确定 AGY 的供应商凭据具体存在哪个后端。

测试执行器已用离线夹具验证并发、审批与恢复判定。夹具结果只用于检查测试逻辑。[设计和验收标准](MULTI_ACCOUNT_DESIGN.md)


## 本机验收回执

验收结束后已正常关闭三台临时 VM，专属账号盘和宿主测试工作区均保留。回执保存在此次验收的私有运行目录。刷新日志的首版提取器仅接受 UTC 文本，漏掉了 guest 使用 +0800 输出的事件；按时区偏移重新解析原日志后，核对了三份主账号成功刷新事件。文件名带时间的记录对应独立尝试。账号邮箱与供应商令牌没有写入本报告。

| 可复核的结论 | 回执 |
| --- | --- |
| 初次授权、并发及后续一次性放行 | 首轮（`~/.godbot-acceptance/agy-m_xscij5/harness/live/receipts/seed-1795162796061.json`） · 三笔实际交付（`~/.godbot-acceptance/agy-m_xscij5/harness/live/receipts/chat-granted-delivery-1795163230288.json`） |
| A 停机时 B、C 可用，A 恢复后仍能回忆工具回执 | 跨重启恢复（`~/.godbot-acceptance/agy-m_xscij5/harness/live/receipts/receipt-restart-1795163327168.json`） |
| 宿主共享目录的读写、只读与持久性 | 挂载权限（`~/.godbot-acceptance/agy-m_xscij5/prep/virtiofs/mount-receipt.json`） · 文件与 Git diff（`~/.godbot-acceptance/agy-m_xscij5/shared-workspace/shared-file-receipt.json`） · C 重启（`~/.godbot-acceptance/agy-m_xscij5/shared-workspace/shared-restart-c.json`） |
| AGY 使用宿主文件、并行写不同 checkout | 宿主修改后恢复原会话（`~/.godbot-acceptance/agy-m_xscij5/harness/mount-receipts/mounted-project-1795164077267.json`） · 两个真实回合同时成功（`~/.godbot-acceptance/agy-m_xscij5/harness/mount-receipts/mounted-simultaneous-1795164244853.json`） |
| 文件通知与并发写入限制 | Mac 原子替换与 guest inotify（`~/.godbot-acceptance/agy-m_xscij5/receipts/host-atomic-save.json`） · flock 和独占创建（`~/.godbot-acceptance/agy-m_xscij5/prep/virtiofs/advisory-lock-receipt.json`） · 宿主写锁规则（`~/.godbot-acceptance/agy-m_xscij5/receipts/host-workspace-lock.json`） |
| 真实到期、官方刷新事件和到期后的原会话 | 三份脱敏认证事件（`~/.godbot-acceptance/agy-m_xscij5/identity/post-refresh-events.jsonl`） · 到期后模型回合（`~/.godbot-acceptance/agy-m_xscij5/harness/live/receipts/post-expiry-1795166017983.json`） |
| 刷新后的持久盘恢复与资源回收 | 三台冷启动后身份与会话核对（`~/.godbot-acceptance/agy-m_xscij5/receipts/cold-after-refresh.json`） · 最终停机状态（`~/.godbot-acceptance/agy-m_xscij5/receipts/final-machines.json`） |
