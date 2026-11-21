// Modified for Godbot. See THIRD_PARTY_NOTICES.
// Settings → About Godbot: the version, updates for Godbot and DSH, and the links to
// the repository. The sidebar's cloud button shows the same update state.
import { version } from '../../../package.json'
import { webIconUrl } from '../../host/web-icon.js'
import { createElement as h, useState } from 'react'
import { GitHubMark } from './connector-marks.js'
import { whenText } from './feedback.js'
import { hostText, t } from './i18n.js'
import { showsDshRow } from './dsh-offer.js'

function botHint(update) {
  if (update.phase === 'installing') return t('Updating Godbot…')
  if (update.phase === 'installed') return t('Restart DSH to start using Godbot {version}.', { version: update.installed ?? update.latest })
  if (update.phase === 'updated') return t('Godbot {version} is installed.', { version: update.installed ?? update.latest })
  if (update.phase === 'failed') return t('The update did not finish: {reason}', { reason: hostText(update.error ?? '') })
  if (update.available) return t('Godbot {version} is available', { version: update.latest })
  if (update.source === 'app') return t('Updates are managed by the desktop host that installed this workspace.')
  if (update.enabled === false) return t('Update checks are off.')
  if (update.source === 'path') return t('Installed from a local folder; update it there.')
  if (!update.checkedAt) return null
  if (!update.latest && update.source !== 'registry') return t('Updates are not offered for this install.')
  const checked = t('Checked {time}', { time: whenText(update.checkedAt) })
  return `${update.latest ? t('Up to date') : t('Could not check for updates.')} · ${checked}`
}

// A desktop host can supply its packaged update state through the Godbot bridge.
export function ownAppRow(ownApp) {
  if (ownApp === null || typeof ownApp !== 'object') return null
  const version = typeof ownApp.version === 'string' ? ownApp.version : ''
  switch (ownApp.phase) {
    case 'checking': return { hint: t('Checking for updates…'), button: null }
    case 'current': return { hint: t('Up to date'), button: 'check' }
    case 'downloading': return { hint: t('Downloading {version}…', { version }), button: null }
    case 'downloaded': return { hint: t('{version} is ready; it installs when you restart', { version }), button: 'restart' }
    case 'available': return { hint: t('{version} is available', { version }), button: 'open' }
    case 'failed': return { hint: t('Could not check for updates.'), button: 'check' }
    default: return null
  }
}

function dshHint(dsh, shown) {
  if (dsh.phase === 'installing') return t('Updating DSH…')
  if (dsh.phase === 'installed') return t('Restart DSH to start using DSH {version}.', { version: dsh.installed ?? dsh.verified })
  if (dsh.phase === 'failed') return t('The update did not finish: {reason}', { reason: hostText(dsh.error ?? '') })
  if (dsh.available === false && dsh.blockedBy) return t('Update Godbot {version} first.', { version: dsh.blockedBy })
  if (shown) return t('DSH {version} is available', { version: dsh.verified })
  return t('Version {version}', { version: dsh.current })
}

const linkProps = href => ({ className: 'bt-soft bt-soft-sm bt-about-link', href, target: '_blank', rel: 'noopener noreferrer' })

export function AboutPage({ useUpdate, actions, run, Section, Row }) {
  const update = useUpdate(value => value) ?? {}
  const [checking, setChecking] = useState(false)
  const check = async () => {
    setChecking(true)
    try { await run(actions.checkUpdate()) } finally { setChecking(false) }
  }
  const phase = update.phase ?? 'idle'
  const dsh = update.dsh
  const dshPhase = dsh?.phase ?? 'idle'
  // Same rule as the sidebar card.
  const dshNew = showsDshRow(dsh, update.app)
  const dshShown = dshNew && dsh.available
  const ownRow = update.source === 'app' ? ownAppRow(update.ownApp) : null
  const ownControl = ownRow?.button === 'restart'
    ? h('button', { type: 'button', className: 'bt-fb-primary', onClick: () => run(actions.installOwnApp()) }, t('Restart to update'))
    : ownRow?.button === 'check'
      ? h('button', { type: 'button', className: 'bt-soft bt-soft-sm', onClick: () => run(actions.checkOwnApp()) }, t('Check for updates'))
      : ownRow?.button === 'open'
        ? h('button', { type: 'button', className: 'bt-soft bt-soft-sm', onClick: () => run(actions.openOwnApp()) }, t('Download'))
        : null
  const botControl = ownRow !== null ? ownControl
    : phase === 'installed' || phase === 'updated' || update.source === 'app' ? null
    : update.available || phase === 'installing'
      ? h('button', { type: 'button', className: 'bt-fb-primary', disabled: phase === 'installing', onClick: () => run(actions.installUpdate()) },
          phase === 'installing' ? t('Updating…') : phase === 'failed' ? t('Try again') : t('Update'))
      : h('button', { type: 'button', className: 'bt-soft bt-soft-sm', disabled: checking || update.enabled === false, onClick: check }, checking ? t('Checking…') : t('Check for updates'))
  const dshControl = !dshNew || dshPhase === 'installed' ? null
    : dsh.kind === 'app'
      ? dsh.available ? h('button', { type: 'button', className: 'bt-soft bt-soft-sm', onClick: () => run(actions.openAppUpdates(dsh.verified)) }, t('Open updates')) : null
      : dsh.available || dshPhase !== 'idle'
        ? h('button', { type: 'button', className: 'bt-fb-primary', disabled: dshPhase === 'installing', onClick: () => run(actions.installDshUpdate()) },
            dshPhase === 'installing' ? t('Updating…') : dshPhase === 'failed' ? t('Try again') : t('Update'))
        : null
  const repo = update.repoUrl
  return [
    h('div', { key: 'hero', className: 'bt-about-hero' },
      h('img', { className: 'bt-about-mark', src: webIconUrl, width: 48, height: 48, alt: '' }),
      h('div', { className: 'bt-about-copy' },
        h('span', { className: 'bt-about-name' }, 'Godbot'),
        h('span', { className: 'bt-about-version' }, t('Version {version}', { version })))),
    h(Section, { key: 'updates', title: t('Updates') },
      h(Row, { label: 'Godbot', hint: ownRow?.hint ?? botHint(update) }, botControl, update.available && update.notesUrl ? h('a', linkProps(update.notesUrl), t("What's new")) : null),
      dsh?.current ? h(Row, { label: 'DeepSeek Harness', hint: dshHint(dsh, dshShown) }, dshControl) : null),
    h(Section, { key: 'links', title: t('Links') },
      repo ? h(Row, { label: t('Source code'), hint: repo.replace(/^https:\/\//, '') }, h('a', linkProps(repo), h(GitHubMark), t('Open'))) : null,
      update.notesUrl ? h(Row, { label: t('Release notes') }, h('a', linkProps(update.notesUrl), t('Open'))) : null,
      h(Row, { label: t('Report a problem') }, h('button', { type: 'button', className: 'bt-soft bt-soft-sm', onClick: () => actions.openSettings('feedback') }, t('Open')))),
  ]
}

export const ABOUT_CSS = `
.bt-about-hero{display:flex;align-items:center;gap:14px;padding:16px;border:1px solid var(--bt-line);border-radius:12px;background:var(--bt-card)}
.bt-about-mark{display:block;flex:none;border-radius:12px}
.bt-about-copy{flex:1;min-width:0;display:flex;flex-direction:column;gap:2px}
.bt-about-name{font-size:16px;line-height:22px;font-weight:600}
.bt-about-version{font-size:12px;line-height:16px;color:var(--bt-ink-2);font-variant-numeric:tabular-nums}
.bt-about-link{display:inline-flex;align-items:center;gap:6px;text-decoration:none}
.bt-about-link svg{width:14px;height:14px}
.bt-fb-primary:disabled{opacity:.6;cursor:default;filter:none}
`
