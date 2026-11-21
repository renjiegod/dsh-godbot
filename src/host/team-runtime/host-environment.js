// Older desktop launchers and service managers still supply the original keys.
// Both namespaces are private to this host and are stripped from agent processes.
export function hostSetting(key, env = process.env) {
  return env['GODBOT_' + key] ?? env['DS_BOT_' + key]
}

export const desktopProtocol = () =>
  process.env.GODBOT_APP === undefined && process.env.DS_BOT_APP === '1' ? 'ds-bot' : 'godbot'
