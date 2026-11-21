# Godbot 本地 Agent 多账号与 microVM 方案

本文件记录 2026-11-20 的多账号设计，其中的独立成员入口和工作树锁属于初版方案。当前 Bot 的账号绑定、权限与原生面板操作见 [使用说明](README.md)。

调研日期为 2026-11-20。目标是在一台 Apple Silicon Mac 上，让三个 AGY 账号同时工作，Claude Code、Codex 也能使用同一套账号选择、登录、续聊和终端接管体验。

**默认沿用本机登录。** AGY、Claude Code 和 Codex 都直接启动已有的本机 CLI。只有一个账号时，用户继续在原工作目录聊天或接管终端，无需设置账号、安装虚拟化运行时或再次登录。

## 设置中的可选沙箱多账号

本机安装版已在「设置 → 本地 Agent」提供「启用沙箱多账号」，默认关闭。开关属于 Godbot 宿主配置，账号由宿主管理员登记，用户在成员或 Bot 中显式选择。发现多个登录不会自动打开开关。

| 用户操作 | 成员和会话如何运行 |
| --- | --- |
| 初次使用、从旧版本升级或保持关闭 | 配置中缺少该字段也等同关闭。原生驱动继续使用现有 CLI、登录、cwd 和会话 ID。启动 Godbot、打开聊天或终端都不需要探测或启动 VM，也不触发镜像下载和账号迁移。 |
| 打开功能 | 在成员设置中额外显示「沙箱账号」，「本机默认」仍可选。打开功能本身无需创建 VM。选中某个沙箱账号并首次登录或使用时，才准备那个账号的环境。已有成员和聊天保留原绑定。 |
| 指定沙箱账号 | 给需要隔离的账号一块持久盘，使用时启动一台 Linux microVM，空闲后关机。A、B、C 可并行。本机工作目录可按授权映射为 guest 挂载路径。沙箱启动失败时显示该账号的错误，避免以宿主另一个账号继续旧任务。 |
| 再次关闭 | 新任务可直接使用本机默认。已进行的沙箱回合、待审批调用与人工终端按原绑定完成或由用户结束。保留账号盘和会话关联。打开一个需要已停用沙箱的旧会话时提示重新启用，用户也可以另开本机会话。删除账号数据是独立操作。 |

沙箱运行后端建议采用 macOS 的 Virtualization.framework（VZ），原型使用 vfkit 和 Lima VZ。Godbot 负责选择账号并启动官方 CLI，供应商登录、刷新和模型连接都留在 CLI 内。以下虚拟机测试针对主动选择沙箱的场景。现有安装版使用 Lima VZ 账号清单。正式设置页可开关沙箱，并可给原生成员和团队 Bot 选择账号与已导出的项目。安装版本和浏览器结果见[本机验收记录](MULTI_ACCOUNT_ACCEPTANCE.md)。自动创建 VM 和空闲关机仍属于设计目标。

## 本机 microVM 实测

宿主为 M5 Max、128 GiB、macOS 27.2。实验使用 vfkit 0.6.4、Alpine 3.24 ARM64 内核 6.18.64、最小 initramfs。每台 VM 有自己的 ext4 盘和临时工作目录，共享原版 CLI 文件。宿主经私有 Unix socket 接入 virtio-vsock，guest 以 UID 1000 启动 CLI。三台 vfkit VM 均未配网卡。测试没有使用真实账号或消耗模型额度。[vfkit 启动与设备](https://github.com/crc-org/vfkit/blob/v0.6.4/doc/usage.md)

| 实验 | 实测结果 | 适用范围 |
| --- | --- | --- |
| 三台 VM 并行运行 AGY 1.5.13 | 每台 1 vCPU、512 MiB，平行启动两轮。启动 vfkit 到 guest 控制通道可用为 0.300–0.314 秒，到 ACP v1 握手为 1.50–1.77 秒。六次新会话请求均明确返回需要授权。 | 已有内核、镜像与二进制时的开机样本，宿主文件缓存可能已热。计时截至本地握手，首个模型回复另测。 |
| 三台待命时的宿主内存 | 读取 macOS 三个 VZ 服务进程与三个 vfkit 进程的 `ri_phys_footprint`，两轮合计约 985 和 989 MiB。 | 握手和空账号检查后采样。镜像未运行完整登录服务、语言服务器或项目构建，不据此将生产实例限制在 512 MiB。没有在同一负载下测 Docker 的增量。 |
| 账号盘与停止隔离 | A、B、C 各自向盘内相同路径写入不同标记。关 A 后 B、C 的通道和标记仍可读。全部关掉再从各自原盘启动，三个标记都正确。 | 验证盘与 VM 生命周期分离。这里的标记并非 OAuth 凭据。 |
| 三种 CLI 同时运行 | 三台独立 VM 分别完成 AGY ACP、Claude Code 2.1.329 stream-json、Codex 0.170.0 app-server 初始化。 | 验证同一种 VM 执行方式能保留三套原生协议。仅握手。Claude 分配 4 GiB，Codex 分配 1 GiB。 |
| OpenSandbox execd 驱动真实 AGY | 从本次核对的 OpenSandbox 源码编译 Linux ARM64 execd，在独立离线 vfkit VM 中以普通用户运行。私有通道连接 guest 回环 execd。未授权请求返回 401，授权后以 `pty=0` 双向传输，AGY 返回 ACP v1，stderr 测试标记只出现在 stderr 通道。发 SIGTERM 后收到 exit 事件，WebSocket 正常关闭。 | 对另一个合成命令断线重连，历史回放混含 stdout 和 stderr，随后收到预设退出码 23。进程树清理和正式终端交接仍需验证。 |
| guest 调用宿主 Godbot MCP | 独立的离线 vfkit VM 从 guest 经另一条 vsock 连接到宿主私有 Unix socket，转发至该会话真实的 `LoopbackMcp`。错误 bearer 收到 401，正确 bearer 收到 200 及 SSE 回显，宿主工具总共只执行一次。 | 证明同机 guest→host 工具链可行。模型触发、人工审批及长任务取消属于后续端到端验收。 |
| 一台较完整的 VM、三个用户 | 另用 Lima VZ 启动 Ubuntu 24.04（2 vCPU、2 GiB），为三个非特权 UID 配置私有 HOME、D-Bus 和 GNOME Keyring。三个 AGY 通过无 TTY 的 SSH 并行握手。同名密钥项各自保存不同合成值，重启解锁后 3/3 读回正确。B 持有 A 的总线地址也无法连接。 | 缓存镜像首次建机到 SSH 就绪 14.67 秒，保留磁盘重启 6.66 秒。三个空 AGY 的 guest PSS 合计约 393 MiB。该数字仅覆盖 guest 内三个 CLI。与上面的宿主六进程内存采样口径不同。 |

上一版 Docker 实验在三个 Ubuntu 容器中验证过 ACP 握手、独立 Secret Service 卷重建，以及容器到宿主 Godbot 团队工具的短调用和 bearer 拒绝。仓库还记录了同一实际登录的两个 AGY 在不同工作目录并发执行。上述结果为早期机制对照。后续在三台独立联网的 Lima VZ 上，三个真实账号的并发、批准后工具交付、持久会话恢复和自然令牌续期已完成验收。宿主共享目录也已通过真实 AGY 读写回合。[真实账号与挂载验收](MULTI_ACCOUNT_ACCEPTANCE.md)[历史运行记录](test/external/fixtures/recorded/godbot-live-control-2026-11-19.json)

## 从 Magpie 和 OpenSandbox 采用哪些设计

核对的本地版本为 Magpie `3e3196222` 和 OpenSandbox `97031ea8`。两者分别解决“该用哪个身份”和“该在哪里运行”，Godbot 已有的三个驱动负责与原生 CLI 对话。

| 可借鉴的实现 | 在 Godbot 中的用法 |
| --- | --- |
| Magpie 有稳定账号标识，界面能区分已启用、失效等状态。有独立于账号显示名的并发槽和可取消队列。 | 每个账号有不可变的 `accountProfileId`。成员可以指定 A，A 忙时就在 A 的队列等待，B、C 继续执行。账号登录状态、当前在跑几个任务、最近一次可用性检查分别显示。[账号结构](https://github.com/yetone/magpie/blob/3e31962225063827e1e440d5951dcef13ea60045/internal/provider/logins.go#L41) · [并发控制](https://github.com/yetone/magpie/blob/3e31962225063827e1e440d5951dcef13ea60045/internal/gateway/concurrency.go#L147) |
| Magpie 能跟踪会话上次命中的账号，并保留有时间依据的最近有效额度。Claude 账号使用不同的配置目录，由 CLI 刷新登录。 | 如果显式指定沙箱账号，在新对话创建时固定一次；已有会话严格回到原账号。用户改用 B 时创建新会话。额度有供应商回执才显示数值，过期数据标注时间。用户在账号环境里直接官方登录，Godbot 的账号表只存引用和元数据。Magpie 的 AGY 网关模式会注入模型端点和 key，这条模型请求路径不进入设计。[会话亲和性](https://github.com/yetone/magpie/blob/3e31962225063827e1e440d5951dcef13ea60045/internal/gateway/affinity.go#L433) · [上次有效读数](https://github.com/yetone/magpie/blob/3e31962225063827e1e440d5951dcef13ea60045/internal/provider/quota_last.go#L60) · [Claude 目录](https://github.com/yetone/magpie/blob/3e31962225063827e1e440d5951dcef13ea60045/internal/provider/claude_dirs.go#L3) · [AGY 启动](https://github.com/yetone/magpie/blob/3e31962225063827e1e440d5951dcef13ea60045/internal/agent/agy.go#L70) |
| OpenSandbox 把沙箱实例、有效期、客户端连接和持久卷分开管理。 | Godbot 只要本地的创建、连接、续租、停止和回收。空闲时停止 VM，保留账号盘。挂盘成功、密钥服务可用、CLI 已登录分别检查。实际账号盘始终有一个写入者。此版本上游服务工厂只列 Docker/Kubernetes，本机 vfkit 是 Godbot 要接入的运行后端。[运行时工厂](https://github.com/opensandbox-group/OpenSandbox/blob/97031ea81fee1b853e4cd89e5490b1be9f5ead55/server/opensandbox_server/services/factory.py#L59) · [生命周期与卷](https://github.com/opensandbox-group/OpenSandbox/blob/97031ea81fee1b853e4cd89e5490b1be9f5ead55/specs/sandbox-lifecycle.yml#L3040) |
| OpenSandbox 的 guest 执行服务 execd 支持交互 PTY，也支持 WebSocket 上无 TTY 的双向管道。后者有独立的 stdin、stdout、stderr 和退出事件。 | 原生协议可接私有通道内的 `pty=0`，登录、resize 和人工终端用 PTY。Host 固定可执行入口，由 guest 启动指定 CLI，限定账号、cwd 和参数。execd 的回放可能混有历史 stdout/stderr，协议断线后按原生会话 ID 重新握手。部署时将 execd 管理令牌留在 Host 的执行层，仅经私有通道连接。多 UID 模式要限制服务进程或启动器的账号权限。账号 VM 可复用这一组件。本地无需引入整套 OpenSandbox 服务。[管道与 PTY 协议](https://github.com/opensandbox-group/OpenSandbox/blob/97031ea81fee1b853e4cd89e5490b1be9f5ead55/components/execd/PTY.md#L24) · [服务端实现](https://github.com/opensandbox-group/OpenSandbox/blob/97031ea81fee1b853e4cd89e5490b1be9f5ead55/components/execd/pkg/web/controller/pty_ws.go#L136) |

## 选择沙箱账号后一次任务如何运行

1. **确定本机或沙箱。** 未设置账号 ID 的成员直接进入当前宿主驱动。以下步骤用于显式绑定沙箱账号的成员。对话创建时记录后端、账号、稳定工作区 ID 和 guest cwd，CLI 回传后再记录 nativeSessionId。机器重启后，磁盘仍属原账号。本次 VM 的实例 ID、启动代次和进程号可以变化。旧成员映射到宿主默认账号。
2. **取账号并发槽和工作区写锁。** 等待可取消。写锁按宿主真实 checkout/worktree 标识计算。两个账号写同一个 checkout 仍需排队。三个独立 worktree 即使在各自 VM 内都叫 `/work`，也可同时写。挂载前核对工作树的 Git common dir，仓库元数据也要隔离时使用独立 clone。[工作区并发规则](test/fixtures/member-workspace.js)
3. **启动并连接。** 没有可用实例时从只读基础镜像启动，附加当前账号可写盘，挂载已批准工作目录。AGY 先在该用户实际使用的 D-Bus 会话里解锁 keyring。登录回调、模型 HTTPS 出站单独配置。Host↔guest 的控制通道使用 vsock。活动回合、工具审批、登录或人工终端持有租约。全部释放后才进入空闲关机计时。冷停后由持久盘恢复，下次唤醒重建管道，首版无需内存快照。
4. **运行原生驱动。** AGY 说 ACP，Claude Code 说 stream-json，Codex 说 app-server。三者复用账号运行环境解析。模型发现、Slash 菜单、登录探测、历史用量和终端接管也用它。特别要修正服务里 Claude 报表按默认目录读历史的入口。开启交互终端时沿用独占控制，只读成员保留现有终端限制。[驱动入口](src/drivers/external/index.js) · [历史用量](src/host/service.js) · [终端接管](src/host/terminal-launch.js)
5. **团队工具与中断。** guest 内的会话回环地址经独立私有通道指向宿主对应的 MCP，保留每会话 bearer、回合审批和 Codex 的 origin 检查。先发原生协议取消，必要时由 guest 收掉进程组，收到终态才释放独占权。VM 意外断开时将正在执行的回合标为结果未知。对可能已经改文件或发起工具调用的请求，核对状态后再决定是否重做。[团队工具](src/team/mcp.js) · [Codex 校验](src/drivers/external/codex.js) · [进程归属](src/drivers/external/owned-process.js)
6. **恢复与迁移。** 同一账号原盘、工作区和原生会话 ID 全部匹配才继续旧聊天。账号失效时提示重登。另选账号则开新聊天。备份仅带逻辑账号引用。迁入新机器后需要重新绑定身份，并检查 CLI 历史是否可用。[已有团队恢复](src/host/team-runtime/local-agents.js) · [备份过滤](src/host/workspace-archive.js)

## 在宿主机选定的共享目录工作

账号和工作区是两个独立选择。例如，A 可以使用自己的 Google 登录修改 Mac 上已存在的项目，B 可以打开同一目录继续工作，C 可以只读审查。普通文件夹也可使用，无需初始化 Git。宿主编辑后 guest 可以读取新内容，guest 对读写挂载的修改直接出现在原目录，包括尚未提交的文件。

建议在成员设置中提供「选择宿主文件夹」与「只读 / 读写」，显示宿主绝对路径和对应的 guest 路径。Host 解析所选目录的真实路径，保存工作区 ID、导出范围、权限与稳定的 guest 挂载点，并用这个 guest 路径启动原生 CLI 和终端。项目从宿主目录挂载，账号 HOME、会话历史和密钥环留在 VM 的持久盘。多个会话共用一个账号时按已批准的挂载集合复用运行环境。若新任务需要换挂载，先等原回合、审批和终端释放，避免后台会话突然多出可见目录。恢复旧会话时重新校验宿主目录和原挂载点，目录丢失时提示重新绑定。

本机运行时采用 VZ 的 VirtioFS 共享设备，Lima 的配置可以按以下形式生成。示例路径由用户选择器提供，`writable` 随该成员的权限确定。[Lima VirtioFS 配置](https://lima-vm.io/docs/config/mount/)

```yaml
vmType: vz
mountType: virtiofs
mounts:
  - location: "/Users/you/code/example"
    mountPoint: "/mnt/godbot-shared/project"
    writable: true
```

| 用法 | 文件和 Git 的归属 | 并发规则 |
| --- | --- | --- |
| 多个账号处理同一个文件夹或 checkout | 各 guest 挂载同一宿主目录。宿主编辑器与 Agent 使用同一份文件。 | Godbot 按真实宿主工作区加锁。在同一目录或重叠子目录安排写任务时串行。宿主编辑器等外部进程不受这把锁约束。 |
| 多个账号同时改同一项目的不同任务 | 给每个成员在宿主分配自己的工作副本，guest 只挂自己的目录，路径在不同 VM 中可以相同。若要在 guest 执行 Git，独立 clone 自带对象库、refs 和 index。 | 独立工作副本可并行修改同名文件。各自的分支由宿主审查与合并。 |
| 使用真正的 Git linked worktree | 宿主创建 worktree、持有共同 Git 元数据；guest 只改被挂载的文件，宿主执行 diff、提交和合并。若需由 guest 自行执行 Git，还要明确提供其所需的 Git 管理目录和路径映射。 | 不同工作树可并行。只挂 worktree 目录时，其中的 `.git` 指针可能指向 guest 看不见的宿主路径。[Git worktree 元数据](https://git-scm.com/docs/git-worktree#_details) |

读写挂载本身允许改动所选项目里的文件，因此账号隔离与项目文件权限应分别展示。只读用导出设备的只读设置并以实际写入测试核对。一个目录只读也不能直接推导整个 Agent 只读，Godbot 仍需独立控制可写的其他目录、团队工具和原生终端。当前调度器按宿主工作树处理写冲突，现有原生工作台只将经过强制只读验证的 Codex 路径视为可同时读取；VM 后端应提供同等的权限证据再放宽调度。[Godbot 写锁](test/fixtures/member-workspace.js) · [原生入口](src/host/service.js)

**共享文件的可见性和锁需要分开验收。** 本机实测，A 对共享文件原地覆写并 fsync 后，宿主立即读到新内容，另一台已经读过该文件的 guest 有一次约 0.82 秒后才看到新值。宿主进行原子替换时，A 和只读 C 都读到了新内容；未启用 Lima 事件转发时，两者在 3 秒窗口内均未观察到 inotify 事件。依赖固定文件版本的任务可以在交接时核对哈希，依赖热更新的开发服务器需单独验证 watcher 或启用轮询。该延时是单次观察值。[共享目录验收](MULTI_ACCOUNT_ACCEPTANCE.md) · [Lima 文件事件](https://lima-vm.io/docs/config/mount/#mount-inotify)

在这组 VZ 设备上，A 对测试文件持有排他 `flock` 时，B 和宿主仍各自取得了同一文件的非阻塞排他锁。调度应由一个宿主进程统一持有工作区写租约，并计入人工终端和未确认退出的任务。这个实验只覆盖 `flock`；Git 自身的 lockfile 协议是另一种机制。[工作区锁判断](test/fixtures/member-workspace.js)

## 选择多账号时各 Agent 如何分开登录

| Agent | 显式配置多账号时的隔离方式 | 登录与恢复 |
| --- | --- | --- |
| AGY 1.5.13 | 每账号一台按需启动的 Linux microVM。使用非 root 用户、专属持久磁盘、私有 D-Bus 会话和可解锁的 Secret Service 密钥环。只读基础镜像可以共用。 | 在该账号的 Linux 交互终端运行 `agy acp --login` 或 `agy`。聊天在同一环境启动 `agy acp`。Google 文档说明真实 SSH 会话支持浏览器授权后回填授权码，本次已通过真实 SSH 终端完成三个不同账号的官方授权。 |
| Claude Code 2.1.329 | 每个 claude.ai 账号独占一个绝对路径 `CLAUDE_CONFIG_DIR`。macOS Keychain 条目按目录区分，Linux 凭据及 macOS 文件回退也遵循该目录。 | 在对应环境运行 `claude auth login --claudeai`，之后用同一目录运行 stream-json 或接管原生终端。Claude Console 的免 API key 登录还涉及独立的 Anthropic profile，需单独配置。 |
| Codex CLI 0.170.0 | 每账号一个固定的绝对路径 `CODEX_HOME`。在 Mac 上可选 `cli_auth_credentials_store = "keyring"`，该版本的直接 Keychain 后端按规范化目录计算条目标识。官方也支持 `file`，此时目录内的 `auth.json` 含明文凭据，应限制权限并遵守受管设备策略。 | 在对应环境运行 `codex login`。已启用设备码登录时可用 `codex login --device-auth`。聊天启动 `codex app-server --listen stdio://`，用该实例的 `account/read` 核对账号，按原 thread ID 恢复。 |

AGY 会尝试复用操作系统密钥环里的登录。1.5.13 帮助列出了 `--app-data-dir`、`--gemini-dir`、`--process-per-session` 和限制终端命令的 `--sandbox`。这些选项说明可以改变数据路径、进程或工具权限，Google 未承诺它们会为同一 macOS 用户创建独立的订阅凭据空间。每账号一台 VM 可独享密钥服务。若共用一台 Linux VM，则要给每个 UID 建立独立会话总线和 HOME。另一个可行候选是每账号一个操作系统用户，但在 Mac 上要维护三个钥匙串登录会话和跨用户工作目录权限。[Google 认证](https://antigravity.google/docs/install?tab=cli) · [Google 密钥环排障](https://antigravity.google/docs/cli/troubleshooting/) · [Google ACP](https://antigravity.google/docs/cli/acp)

Claude 官方明确支持用独立目录同时登录工作和个人账号。在非交互运行中，继承的 API key 可能覆盖订阅。Codex 的 `--profile` 用来选择配置，账号目录仍应显式指定。两者的本机方案适合隔开日常登录和历史。同一系统用户下，有权执行任意本机命令的 Agent 仍可能读取其他可访问目录。需要阻止这种读取时，可将同一原生 CLI 放入只挂载该账号工作区的 microVM。[Claude 多账号与凭据](https://code.claude.com/docs/en/authentication) · [Anthropic 配置目录](https://platform.claude.com/docs/en/manage-claude/wif-reference#configuration-directory) · [Codex 认证](https://developers.openai.com/codex/auth) · [Codex 0.170.0 凭据实现](https://github.com/openai/codex/blob/rust-v0.170.0/codex-rs/login/src/auth/storage.rs)

## 平台和运维取舍

- **每账号独立 VZ microVM**适合分别启动、停止和升级三个账号，也方便确保 guest 看不到别的账号盘。镜像可共用，只把指定 worktree 挂进 guest。Godbot 需要管理基础镜像更新、CLI 版本、密钥环解锁及 guest 进程退出。测试的最小镜像尚不代表完整开发环境，例如 Codex 会探测 bubblewrap。每次升级应复测命令执行和只读模式。
- **一台 Lima VZ、三个普通用户**适合同一人重视部署简单、希望共用系统依赖的情况。每个账号使用独立 UID、私有 HOME 和用户密钥环，去掉 sudo 及宿主 HOME 默认挂载。重启和内核在三者间共享。这条路可以先用 `ssh -T` 跑协议、分配 PTY 办登录，官方文档已有 AGY、Claude 和 Codex 示例。[Lima AI 示例](https://lima-vm.io/docs/examples/ai/) · [Lima VZ](https://lima-vm.io/docs/config/vmtype/vz/) · [默认挂载](https://github.com/lima-vm/lima/blob/master/templates/_default/mounts.yaml)
- **Apple container** 是另一条可复用 OCI 镜像的 macOS 原生方案。普通容器各自运行在独立 Linux VM。如果决定采用其镜像和进程生命周期，可省掉部分 guest 打包工作。其 container machine 默认共享宿主 HOME 并转发 SSH agent，需单独评估。**Firecracker** 的常规运行环境是 Linux/KVM，未来接 Linux 节点时再引入。Mac 本地直接用 VZ，省去嵌套虚拟化。[Apple 架构](https://github.com/apple/container/blob/main/docs/technical-overview.md) · [Apple machine 默认行为](https://github.com/apple/container/blob/main/docs/container-machine.md) · [Firecracker 运行条件](https://github.com/firecracker-microvm/firecracker/blob/main/docs/getting-started.md)

## 首版验收

先从新装与升级配置分别核对默认关闭：在没有 Lima、vfkit 和 Docker 的环境中，直接用单账号登录的三个原生 CLI 打开聊天、恢复原会话和接管可用终端。开关 UI 落地后，再验证打开功能但成员仍选本机、指定沙箱账号后按需创建，以及关闭后既有会话的归属。

在沙箱验收中，让用户创建 AGY-A、B、C 并分别在官方终端登录，显示或人工确认每个账号的脱敏身份。三个成员同时在独立 worktree 提交带不同标记的小任务，各实际调用一次需要审批的团队工具。观察一个账号限额、登出或任务取消时，另外两个任务能否继续。重新登录后核对原账号与原会话 ID。

再覆盖 Claude Code、Codex 的登录、聊天、原生终端接管、交还和历史用量归属。分别重启 Host、单台 VM 和整机，跨过一次凭据续期。用真实任务测完整镜像冷启动、首回复、三个账号稳态和峰值内存、仓库 I/O、停止后内存回收，再设置生产规格与空闲回收时间。首次下载镜像和模型首回复单独计时。
