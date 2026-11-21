const agents = {
  claude: 'local-claude-code',
  codex: 'local-codex-cli',
  antigravity: 'local-antigravity',
}

export function botNativeTarget(bot, sessionId, roster) {
  if (!bot || roster.readOnly || (bot.sessionId ?? bot.id) !== sessionId) return null
  const agent = bot.accountProfileId
    ? agents[bot.sandboxKind]
    : (bot.model ?? bot.appliedModel)?.split('/')[0]
  if (!Object.values(agents).includes(agent)) return null
  return { botId: bot.id, sessionId, agent, label: bot.name }
}

export const nativeTabs = { terminal: 'godbot-terminal', conversation: 'godbot-native-chat' }
export function nativeMode(tab) {
  if (tab === nativeTabs.terminal) return 'terminal'
  if (tab === nativeTabs.conversation) return 'conversation'
}
