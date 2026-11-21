import { workspaceHashes } from '../team/workspace-routes.js'
import { webIconUrl } from './web-icon.js'

// A hash is local to the browser. Mark a direct visit before DSH paints its
// shell. The router takes over once it can respond to in-app panel changes.
const deepLinks = JSON.stringify(workspaceHashes)
const bootScript = `{
  const routes = ${deepLinks};
  const root = document.documentElement;
  const sync = () => root.toggleAttribute('data-godbot-boot', routes.includes(location.hash));
  sync();
  addEventListener('hashchange', sync);
  addEventListener('godbot-router-ready', () => {
    removeEventListener('hashchange', sync);
    root.removeAttribute('data-godbot-boot');
  }, { once: true });
}`

// The team sidebar is a body portal mounted by a child of the DSH sidebar.
// Keep that child mounted and measurable while the workspace loads.
const waiting = 'html:is([data-godbot-boot],[data-godbot-workspace]) body:not(:has(.bt-leftcol,.bt-title-toggle))'
const column = `${waiting} [class*="_sidebarCol"]`
const styleId = 'godbot-sidebar-loading'
// DSH's own section headers set visibility: visible, which a hidden parent
// cannot override, so hide every descendant as well.
const sidebarStyle = `
${column} > *, ${column} > * *, ${waiting} [data-shell-leading], ${waiting} [data-shell-leading] * {
  visibility: hidden !important;
  opacity: 0 !important;
  pointer-events: none !important;
}
${column}::before {
  content: "";
  display: block;
  flex: none;
  height: 30px;
  margin: calc(var(--dsh-frame-top-clearance, 0px) + 8px) 12px 0;
  background: url("${webIconUrl}") left center / 24px 24px no-repeat;
}`

// An already-open DSH tab or a desktop shell may not have the current index.
export function installSidebarLoadingStyle(document) {
  if (document.getElementById(styleId)) return
  const style = document.createElement('style')
  style.id = styleId
  style.textContent = sidebarStyle
  document.head.appendChild(style)
  return () => style.remove()
}

export function prepareWorkspaceIndex(html) {
  return html
    .replace(/<link\b[^>]*\srel=(?:"icon"|'icon')[^>]*>/gi, '')
    .replace(/<\/head>/i, `<link rel="icon" type="image/png" href="${webIconUrl}">
<style id="${styleId}">${sidebarStyle}</style>
<script>${bootScript}</script>
</head>`)
}
