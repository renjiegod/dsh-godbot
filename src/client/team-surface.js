import { createElement as h, useEffect, useState } from 'react'
import { apply as applyBot, inject as botServices } from './team-ui/index.js'
import { earlierReports, reportSessionUsage, turnReport } from './team-report.js'
import { NativeCommandReport } from './native-command-report.js'
import { TerminalPanel } from './terminal-panel.js'
import { botNativeTarget, nativeTabs } from './native-agent-target.js'
import { PanelMenu } from './team-ui/browser-pane.js'
import { AgentLogo } from './team-ui/agent-cards.js'
import { AgentForm } from './team-ui/agent-form.js'
import { LocalSignInPanel } from './team-ui/local-sign-in.js'
import { call } from './team-ui/api.js'
import { ENGINES } from '../host/team-runtime/core/local-agents/engines.js'
import { ChatsIcon, GoalIcon, TerminalIcon } from './team-ui/icons.js'
import { language, t } from './team-ui/i18n.js'
import { installStyles } from './team-ui/styles.js'
import { SandboxBinding } from './sandbox-settings.js'
import { SandboxSetupPage } from './sandbox-setup-page.js'
import { ProviderAgentsPage } from './provider-agents.js'
import { BotAgentUsage } from './provider-agents-usage.js'
import { useProviderChoices } from './provider-agents-hook.js'
import { sandboxSettingsStyle } from './bot-settings-style.js'
import { AgentSetup } from './agent-setup.js'
import { ConnectorToolsPanel } from './connector-tools.js'
import { executionStyle, ExecutionProcess, InlineExecution, useExecutionTools } from './execution-history.js'
import { openWorkspace } from './workspace-entry.js'
import { botHome } from './session-links.js'
import { Icon } from './chat-ui.js'
import { WorkspaceActions } from './workspace-actions.js'
import { TaskSettings } from './task-settings.js'
import { WebBrowserButton, BrowserDrawerPane } from './browser-viewer.js'
import { ComputerHeaderButton } from './team-ui/computer.js'
import { mainSession, sessionSelection } from './navigation.js'
import { bindTeamSlashSource, teamSlashSource } from './team-slash.js'
import { AutomationSetupPage } from './automation-setup.js'
import { ComponentSettings, GovernanceSettings, RemoteAgentSettings } from './platform-settings.js'

const lastSessionKey = 'dsh.godbot.bot-session.v1'
const builtins = Object.entries(ENGINES).map(([route, { name, command }]) => ({ route, name, command }))
const controlsStyle = `
.bt-side .bt-side-top { flex-wrap: wrap; gap: 2px; padding: 3px 0; }
.bt-side-top > .bt-round {
  width: 30px;
  height: 32px;
  border: 1px solid transparent;
  border-radius: 8px;
  background: transparent;
}
.bt-side .bt-tile-wrap { padding: 6px 0 9px; }
.bt-side .bt-tile {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  column-gap: 10px;
  row-gap: 1px;
  align-content: center;
  align-items: center;
  width: 100%;
  padding: 10px;
  border: 1px solid var(--bt-line);
  border-radius: 10px;
  background: var(--bt-card);
  text-align: start;
}
.bt-side .bt-tile:has(.bt-chip) > .bt-mark { grid-row: span 2; }
.bt-side .bt-tile-name { max-width: none; font-size: 14px; font-weight: 650; }
.bt-side .bt-tile .bt-chip {
  justify-self: start;
  max-width: 100%;
  padding: 0;
  border: 0;
  background: transparent;
  color: var(--bt-ink-2);
}
.bt-side .bt-tile[aria-current=page] { border-color: var(--bt-accent); }
.bt-side .bt-row[aria-current=page] { box-shadow: inset 3px 0 var(--bt-accent); }
.bt-side:not(.bt-rail) .bt-row { border-radius: 8px; }

.bt-msg[data-gb-command-report]{width:min(42rem,100%)}
.bt-msg[data-gb-command-report]>.bt-msg-line{width:100%}
.bt-msg[data-gb-command-report]>.bt-msg-line>.bt-bubble{width:100%;background:transparent;padding:0}
.bt-head:has(> .gb-chat-bar) {
  justify-content: flex-end;
  min-width: 0;
  padding-inline: 12px;
  box-sizing: border-box;
  container-type: inline-size;
}
/* A phone-width column keeps the avatar, the model and the tools; a name cut
   to a letter or two says less than the avatar does. */
@container (max-width: 480px) {
  .gb-chat-heading:has(> .gb-bot-model) > .bt-pill { flex: none; padding-inline: 4px; }
  .gb-chat-heading:has(> .gb-bot-model) > .bt-pill > .bt-pill-name { display: none; }
}
/* One floating glass bar at the top-right: the conversation (name, then the
   Bot's model) and its tools, split by a hairline. Segments are flat inside it. */
.gb-chat-bar {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  min-width: 0;
  max-width: min(100%, 46rem);
  height: 40px;
  padding: 3px;
  box-sizing: border-box;
  border: 0.5px solid var(--bt-glass-rim);
  border-radius: 12px;
  background: var(--bt-glass-bg);
  -webkit-backdrop-filter: blur(20px) saturate(180%);
  backdrop-filter: blur(20px) saturate(180%);
  box-shadow: var(--bt-glass-shadow);
  pointer-events: auto;
}
.gb-chat-heading {
  display: inline-flex;
  align-items: center;
  flex: 0 1 auto;
  gap: 2px;
  min-width: 0;
  height: 100%;
}
.gb-chat-heading > .bt-pill {
  /* In a narrow bar the name yields first, keeping its avatar and the model. */
  flex: 0 2 auto;
  min-width: 34px;
  max-width: none;
  height: 100%;
  gap: 7px;
  padding: 0 10px 0 4px;
  border: 0;
  border-radius: 9px;
  background: transparent;
  box-shadow: none;
  -webkit-backdrop-filter: none;
  backdrop-filter: none;
}
.gb-chat-heading:has(> .gb-bot-model) > .bt-pill > .bt-pill-go { display: none; }
.gb-chat-heading > .bt-pill:active { transform: none; }
.gb-bot-model {
  flex: 0 1 auto;
  position: relative;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  max-width: 16rem;
  height: 100%;
  padding: 0 8px 0 10px;
  border: 0;
  border-radius: 9px;
  background: transparent;
  color: var(--bt-ink);
  font: inherit;
  text-align: start;
  pointer-events: auto;
}
.gb-bot-model::before,
.gb-chat-heading + .gb-chat-tools:not(:empty)::before,
.gb-chat-title::before,
.gb-chat-title + .gb-chat-tools:not(:empty)::before {
  content: '';
  flex: none;
  width: 1px;
  height: 18px;
  background: var(--bt-line-2);
}
.gb-bot-model::before {
  position: absolute;
  inset-inline-start: -1px;
  inset-block-start: 8px;
}
.gb-chat-heading + .gb-chat-tools:not(:empty)::before { margin-inline: 3px 1px; }
.gb-chat-title::before { margin-inline: 3px 0; }
.gb-chat-title + .gb-chat-tools:not(:empty)::before { margin-inline: 3px 1px; }
.gb-chat-title {
  display: inline-flex;
  align-items: center;
  flex: 0 6 auto;
  min-width: 0;
  max-width: 14rem;
  height: 100%;
  pointer-events: auto;
}
.gb-chat-title-text {
  display: block;
  min-width: 0;
  padding-inline: 10px;
  font-size: 13px;
  font-weight: 500;
  line-height: 20px;
  color: var(--bt-ink);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
@container (max-width: 640px) {
  .gb-chat-title { display: none; }
}
.gb-chat-heading > .bt-pill:hover,
.gb-chat-heading > .bt-pill[aria-expanded=true],
button.gb-bot-model:hover { background: var(--bt-hover); }
button.gb-bot-model { cursor: pointer; }
.gb-chat-heading > .bt-pill:focus-visible,
button.gb-bot-model:focus-visible,
.gb-chat-tools > .bt-icon-btn:focus-visible,
.gb-chat-tools .gb-native-button:focus-visible { outline: 2px solid var(--bt-accent); outline-offset: -2px; }
.gb-bot-model-copy { display: grid; min-width: 0; }
.gb-bot-model-name, .gb-bot-model-effort { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.gb-bot-model-name { font-size: 12px; font-weight: 500; line-height: 16px; }
.gb-bot-model-effort { color: var(--bt-ink-2); font-size: 11px; line-height: 13px; }
.gb-chat-tools { display: inline-flex; align-items: center; flex: none; gap: 2px; height: 100%; }
.gb-chat-tools:empty { display: none; }
.gb-chat-tools > .bt-icon-btn, .gb-chat-tools .gb-native-button {
  position: relative;
  display: inline-grid;
  place-items: center;
  width: 32px;
  height: 32px;
  margin: 0;
  padding: 0;
  border: 0;
  border-radius: 9px;
  background: transparent;
  color: var(--bt-ink-2);
  cursor: pointer;
  pointer-events: auto;
}
.gb-chat-tools > .bt-icon-btn svg, .gb-chat-tools .gb-native-button svg { width: 17px; height: 17px; }
.gb-usage-label { display: none; }
@container (width > 560px) {
  .gb-chat-tools > .gb-usage-button {
    display: inline-flex;
    width: auto;
    gap: 5px;
    padding-inline: 8px;
    font: 500 12px/16px var(--bt-font);
    white-space: nowrap;
  }
  .gb-usage-label { display: inline; }
}
.gb-chat-tools .bt-pmenu-pop { pointer-events: auto; }
.gb-chat-tools > .bt-icon-btn:hover, .gb-chat-tools .gb-native-button:hover,
.gb-chat-tools .gb-native-button[aria-expanded=true] { background: var(--bt-hover); color: var(--bt-ink); }
.gb-chat-tools .gb-native-button[data-active] { color: var(--bt-accent); }
.gb-chat-tools .gb-native-button[data-active]::after {
  content: '';
  position: absolute;
  inset-block-start: 5px;
  inset-inline-end: 5px;
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: currentColor;
  box-shadow: 0 0 0 1.5px var(--bt-card);
}
`

// Whether a native terminal holds this chat. A host that names its terminals in the team's
// live state answers here without a request; an older one is asked on a clock.
function useNativeTerminalActive(client, target, running, known) {
  const { botId, sessionId } = target ?? {}
  const [activePart, setActivePart] = useState()
  useEffect(() => {
    if (!botId || !sessionId || known) return
    let timer, mounted = true, busy = false
    async function update() {
      if (busy) return
      busy = true
      clearTimeout(timer)
      try {
        const value = await client.terminalStatus({ botId, sessionId })
        if (mounted) setActivePart(value.active ? sessionId : undefined)
      } catch { /* The opener can show a connection error on demand. */ }
      busy = false
      // A window in the background reads rarely and catches up when it comes back.
      if (mounted) timer = setTimeout(update, document.hidden ? 10_000 : running ? 2000 : 4000)
    }
    const wake = () => { if (!document.hidden) void update() }
    document.addEventListener('visibilitychange', wake)
    void update()
    return () => { mounted = false; clearTimeout(timer); document.removeEventListener('visibilitychange', wake) }
  }, [client, botId, sessionId, running, Boolean(known)])
  if (known) return target != null && known[sessionId] === true
  return target != null && activePart === sessionId
}

function NativeAgentButton({ target, active, actions }) {
  const { sessionId, agent } = target
  const title = agent === 'local-claude-code' ? '打开原生会话并信任此 Bot 的工作目录' : undefined
  return h(PanelMenu, { className: 'gb-native-button', 'aria-label': '原生 Agent', active,
    title: active ? '原生 Agent 控制中，聊天消息等待交还' : '原生 Agent',
    items: [
      { key: 'terminal', icon: TerminalIcon, label: '原生终端', title, onPick: () => actions.showDetails(sessionId, nativeTabs.terminal) },
      { key: 'conversation', icon: ChatsIcon, label: '原生对话', title, onPick: () => actions.showDetails(sessionId, nativeTabs.conversation) },
    ] }, h(TerminalIcon))
}

function readLast() {
  try {
    return sessionStorage.getItem(lastSessionKey)
  } catch {
    return null
  }
}
function remember(id) {
  if (id)
    try {
      sessionStorage.setItem(lastSessionKey, id)
    } catch {
      /* Storage is optional. */
    }
}

function TeamCommandReport({ ctx, client, report, text, bot, sessionId }) {
  const part = report.partId ?? sessionId
  const { seq, messageId } = report
  const entries = part && ctx.sessions.binding(part)?.eventSource?.getSnapshot().entries
  const current = reportSessionUsage(entries, seq, messageId)
  const botId = bot?.id
  const receiptKey = JSON.stringify([botId, part, seq, messageId])
  const loadSession = botId && part && Number.isInteger(seq)
    ? () => client.claudeReportSession({ botId, sessionId: part, seq, messageId }) : undefined
  const isCurrentClaude = bot && (bot.sessionId ?? bot.id) === sessionId &&
    (bot.model ?? bot.appliedModel)?.split('/')[0] === 'local-claude-code'
  const loadStats = isCurrentClaude ? () => client.claudeStats({ botId, sessionId }) : undefined
  return h(NativeCommandReport, { ...report, text, loadStats, sessionUsage: current, loadSession, receiptKey })
}

/** Mount the team UI in its own Cordis lifetime. Outside this route its
 * slots, styles, keyboard handlers, dialogs, and background polls are withdrawn. */
export function mountTeamSurface(ctx, client, navigation, target) {
  return openWorkspace(ctx, client, navigation, (ready) => mountProduct(ctx, client, navigation, target, ready))
}
function mountProduct(ctx, client, navigation, target, ready) {
  const landing = botHome(typeof target === 'string' ? target : undefined, readLast())
  let initialSettings = target?.settings
  let initialBoard = target?.workBoard
  let active = true,
    roster
  const idOf = (session) => roster?.byId[session]?.id ?? roster?.roomsById[session]?.id
  const priorSidebar = document.querySelector('[class*="_sidebarCol"]')?.parentElement
  const wasCollapsed = priorSidebar?.hasAttribute('data-sidebar-collapsed')
  const teamControls = {
    active: () => active,
    sessionSelection,
    back: navigation.back,
    turnReport, earlierReports,
    renderReport: (report, text, bot, sessionId) => h(TeamCommandReport, { ctx, client, report, text, bot, sessionId }),
    computerButton(bot, id, state, actions, useComputer) {
      return bot && !state.readOnly && state.computer?.enabled === true && (bot.sessionId ?? bot.id) === id
        ? h(ComputerHeaderButton, { key: 'computer:' + bot.id, bot, sessionId: id, roster: state, actions, useComputer }) : null
    },
    browserButton(bot, id, state) {
      return bot && !state.readOnly && (bot.sessionId ?? bot.id) === id
        ? h(WebBrowserButton, { key: 'web-browser-' + bot.id, client, bot, sessionId: id }) : null
    },
    browserDrawerPane(bot, id, state, actions) {
      return h(BrowserDrawerPane, { client, bot, sessionId: id, roster: state, actions })
    },
    useNativeTerminalActive: (bot, id, state, running) =>
      useNativeTerminalActive(client, botNativeTarget(bot, id, state), running, state?.nativeTerminals),
    nativeButton(bot, id, state, actions, terminalActive) {
      const target = botNativeTarget(bot, id, state)
      return target && h(NativeAgentButton, { key: 'native:' + id, target, active: terminalActive, actions })
    },
    nativePane(bot, id, state, close, mode, actions, workItemId) {
      const target = botNativeTarget(bot, id, state)
      return target ? h(TerminalPanel, { client, target: { ...target, workItemId }, close, mode,
        onModeChange: next => actions.showDetails(id, nativeTabs[next], workItemId),
        openWork: id => actions.openWorkBoard({ id }) }) : h('p', { role: 'status' }, '请选择当前 Bot 的 CLI 会话。')
    },
    useExecutionTools: (botId, sessionId, turn, enabled) => useExecutionTools(client, botId, sessionId, turn, enabled),
    inlineExecution: (key, botId, sessionId, turn, running, events) => h(InlineExecution, {
      key, client, botId, sessionId, turn, running, events,
    }),
    // One turn of a group member's work, for the group's member work panel.
    memberProcess: ({ key, botId, sessionId, turn, running }) => h(ExecutionProcess, {
      key, client, botId, sessionId, turn, running,
    }),
    providerAgents: ({ readOnly, ...props }) => h(ProviderAgentsPage, {
      client, call, builtins, AgentLogo, AgentForm, readOnly,
      SignIn: readOnly ? undefined : LocalSignInPanel, ...props,
    }),
    // One Bot's own local agent usage, for its conversation header.
    botAgentUsage: props => h(BotAgentUsage, { client, call, AgentLogo, ...props }),
    sandboxSettings: props => h(SandboxSetupPage, { client, builtins, ...props }),
    taskSettings: (page, focus, actions, readOnly) => h(TaskSettings, { client, actions, page, focus, readOnly }),
    automations: () => client.dispatch({ action: 'automation.setup.view' }),
    platformSettings(page, roster, actions, initial, ui = {}) {
      if (page === 'automation') return h(AutomationSetupPage, { key: JSON.stringify(initial), client, roster, actions, initial })
      const pages = { components: ComponentSettings, governance: GovernanceSettings, 'remote-agents': RemoteAgentSettings }
      return h('div', { className: 'gb-platform' }, h(pages[page], { client, roster, actions, initial, ...ui }))
    },
    useProviderChoices: (wanted, call) => useProviderChoices(wanted, call, client),
    async changeProvider(bot, agent, target, actions, avatarAfter) {
      if (agent?.disabled || (!agent && target.startsWith('local-')))
        throw new Error('运行账号已变化，请重新选择提供商。')
      const hostKind = { 'local-antigravity':'antigravity', 'local-claude-code':'claude', 'local-codex-cli':'codex' }[agent?.route]
      if (agent?.accountId || (bot.accountProfileId && hostKind)) {
        return actions.afterSandboxBinding(client.dispatch({
          action:'sandbox-bot-bind', botId:bot.id, kind:agent.kind ?? hostKind,
          accountProfileId:agent.accountId ?? null, ...(agent.cwd ? { cwd:agent.cwd } : {}),
        }))
      }
      return actions.updateBot(bot.id, { model:target,changeEngine:true,...avatarAfter(bot,target) })
    },
    openInitialSettings(actions) {
      if (initialBoard) {
        const board = initialBoard
        initialBoard = null
        actions.openWorkBoard(board)
      }
      if (!initialSettings) return
      const page = initialSettings
      initialSettings = null
      actions.openSettings(page)
    },
    sandboxBinding(bot, roster, actions) {
      if (roster.readOnly) return null
      const route = (bot.appliedModel ?? bot.model ?? '').split('/')[0]
      const kind = bot.sandboxKind ?? ({ 'local-antigravity': 'antigravity', 'local-claude-code': 'claude', 'local-codex-cli': 'codex' })[route]
      return h(SandboxBinding, { key: 'sandbox-'+bot.id, client, subject: bot, kind, fullTeam: true,
        onSave: patch => actions.afterSandboxBinding(client.dispatch({ action: 'sandbox-bot-bind', botId: bot.id, ...patch })) })
    },
    connectorTools: bot => h(ConnectorToolsPanel, { key: 'connector-tools-' + bot.id, client, bot, sessionId: bot.sessionId ?? bot.id }),
    startCli: (props) => h(AgentSetup, { ...props, key: props.bot.id }),
    installSlash(triggers, roster, actions, controllerOf) {
      const source = teamSlashSource(roster, actions, client, {
        goalFace: () => ({
          label: t('Goal'), description: t('Set a goal. The Bot keeps working until it is done'), icon: GoalIcon,
          token: language().toLowerCase().startsWith('zh') ? '目标' : 'goal',
        }),
      })
      const unregister = triggers.registerSource(source)
      actions.bindGodbotSlash = (sessionId) => bindTeamSlashSource(controllerOf(sessionId), source, sessionId)
      return () => {
        delete actions.bindGodbotSlash
        unregister()
      }
    },
    home(snapshot, main) {
      roster = snapshot
      return landing(snapshot, main)
    },
    navigation(wide, latest, actions) {
      roster = latest
      return h(WorkspaceActions, { client, wide, onAutomation: () => actions.openSettings('automation'), onBack: navigation.back,
        onWork:()=>actions.openWorkBoard({filters:{tab:'mine'}}) })
    },
  }
  const fiber = ctx.plugin({
    inject: botServices,
    apply(child) {
      if (!active) return
      try {
        applyBot(child, teamControls)
        child.effect(() => {
          const style = installStyles(controlsStyle + executionStyle + sandboxSettingsStyle, 'team-controls')
          return () => style.remove()
        }, 'Godbot team styles')
        ready()
      } catch (error) {
        ready(error)
        throw error
      }
    },
  })
  const off = ctx.sessions.list.subscribe(() => {
    const id = mainSession(ctx)
    if (idOf(id) || roster?.agentOf[id]) remember(id)
  })
  return () => {
    active = false
    off()
    const selected = mainSession(ctx)
    if (idOf(selected) || roster?.agentOf[selected]) remember(selected)
    void fiber.dispose()
    const frame = document.querySelector('[class*="_sidebarCol"]')?.parentElement
    if (
      frame &&
      wasCollapsed != null &&
      !frame.hasAttribute('data-sidebar-drawer') &&
      frame.hasAttribute('data-sidebar-collapsed') !== wasCollapsed
    )
      ctx.layout.toggleSidebar()
  }
}
