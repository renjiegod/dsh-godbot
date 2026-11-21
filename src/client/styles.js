import { sandboxSettingsStyle } from './bot-settings-style.js'

// The palette itself (themeStyle) is installed globally by index.js.
export const styles =
  sandboxSettingsStyle +
  `
/* Our own header has navigation controls in dsh's web drawer. The desktop window
   still reserves its native titlebar and traffic-light area. */
html:not([data-platform]):not([data-windows-titlebar]) [data-sidebar-drawer] [data-global-panel]:has(.gb-workspace) {
  padding-top: 0;
  --dsh-frame-leading-clearance: 0px;
}
.gb-root {
  color: var(--bt-ink);
  background: var(--bt-main);
  font: 14px/1.5 var(--bt-font);
  height: 100%;
  width: 100%;
  min-height: 0;
  min-width: 0;
  overflow: hidden;
  text-align: start;
  box-sizing: border-box;
  -webkit-tap-highlight-color: transparent;
}
.gb-root *,
.gb-root *::before,
.gb-root *::after {
  box-sizing: border-box;
}

/* Navigation controls. */
.gb-root .gb-round {
  flex: none;
  width: 36px;
  height: 36px;
  min-height: 0;
  padding: 0;
  border-radius: 8px;
  border: 1px solid transparent;
  background: transparent;
  color: var(--bt-ink);
  display: inline-flex;
  align-items: center;
  justify-content: center;
}
.gb-root .gb-round:hover,
.gb-root .gb-round[aria-expanded='true'],
.gb-pop[open] > .gb-round {
  background: var(--bt-hover);
}
.gb-root .gb-round:active {
  transform: scale(0.94);
}
.gb-root .gb-iconbutton {
  flex: none;
  width: 32px;
  height: 32px;
  min-height: 0;
  padding: 0;
  border: 0;
  border-radius: 8px;
  background: none;
  color: var(--bt-ink-2);
  display: inline-flex;
  align-items: center;
  justify-content: center;
}
.gb-root .gb-iconbutton:hover,
.gb-root .gb-iconbutton[aria-expanded='true'],
.gb-pop[open] > .gb-iconbutton {
  background: var(--bt-hover);
  color: var(--bt-ink);
}
.gb-pop > summary::-webkit-details-marker {
  display: none;
}
.gb-pop > summary::marker {
  content: '';
}
.gb-pop {
  position: relative;
  flex: none;
}
.gb-pop > summary {
  list-style: none;
}

/* Context menus. */
.gb-popbody {
  position: absolute;
  z-index: 30;
  inset-inline-end: 0;
  top: calc(100% + 6px);
  display: flex;
  flex-direction: column;
  min-width: 180px;
  max-width: min(290px, 78vw);
  max-height: 300px;
  overflow: auto;
  padding: 6px;
  border-radius: 12px;
  background: var(--bt-glass-bg);
  -webkit-backdrop-filter: blur(24px) saturate(180%);
  backdrop-filter: blur(24px) saturate(180%);
  border: 0.5px solid var(--bt-glass-rim);
  box-shadow: var(--bt-glass-shadow);
  color: var(--bt-ink);
}
.gb-pop[data-align='start'] > .gb-popbody {
  inset-inline-start: 0;
  inset-inline-end: auto;
}
.gb-side .gb-popbody {
  max-width: 220px;
}
.gb-root .gb-popbody button,
.gb-popbody label {
  display: flex;
  align-items: center;
  justify-content: flex-start;
  gap: 6px;
  width: 100%;
  min-height: 30px;
  padding: 6px 8px;
  border: 0;
  border-radius: 6px;
  background: none;
  color: var(--bt-ink);
  text-align: start;
  font-size: 13px;
  line-height: 18px;
  font-weight: 400;
  white-space: normal;
}
.gb-root .gb-popbody button:enabled:hover,
.gb-popbody label:hover {
  background: var(--bt-hover);
}
.gb-root .gb-popbody button[aria-current] {
  font-weight: 500;
  background: var(--bt-hover);
}
.gb-popbody small {
  display: block;
  padding: 4px 8px;
}

/* Agent and coordinator identities. */
.gb-avatar {
  --gb-ring: var(--bt-main);
  position: relative;
  display: inline-grid;
  place-items: center;
  width: var(--avatar-size);
  height: var(--avatar-size);
  flex: none;
  border-radius: 30%;
  background: var(--bt-card);
  box-shadow: inset 0 0 0 0.5px var(--bt-line-2);
  color: var(--bt-ink-2);
  line-height: 1;
  vertical-align: middle;
}
.gb-avatar img {
  display: block;
  width: 72%;
  height: 72%;
  object-fit: contain;
}
.gb-avatar[data-kind='dsh'] {
  background: transparent;
  box-shadow: none;
}
.gb-avatar[data-kind='dsh'] img {
  width: 100%;
  height: 100%;
  border-radius: 26%;
}
.gb-avatar > i {
  position: absolute;
  inset: auto -2px -2px auto;
  width: 11px;
  height: 11px;
  border: 2px solid var(--gb-ring);
  border-radius: 50%;
  background: var(--bt-ink-3);
}
.gb-avatar > i:is([data-activity='active'], [data-activity='ready']) {
  background: var(--bt-green);
}
.gb-avatar > i[data-activity='waiting'] {
  background: var(--bt-star);
}
.gb-star {
  position: absolute;
  right: -3px;
  bottom: -1px;
  font-size: 16px;
  line-height: 1;
  color: var(--bt-star);
}
.gb-avatar-featured > i {
  inset: auto auto -2px -2px;
}

/* Navigation column. */
.gb-root.gb-sidebar-shell {
  background: var(--bt-sidebar);
  border-inline-end: 0.5px solid var(--bt-line);
}
.gb-side .gb-avatar {
  --gb-ring: var(--bt-sidebar);
}
.gb-side {
  height: 100%;
  min-height: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: calc(var(--dsh-frame-top-clearance, var(--dsh-windows-titlebar-height, 0px)) + 8px) 12px max(8px, env(safe-area-inset-bottom));
  color: var(--bt-ink);
}
.gb-side-top {
  display: flex;
  justify-content: flex-end;
  align-items: center;
  flex-wrap: wrap;
  gap: 2px;
  padding: 3px 0;
  flex: none;
}
.gb-brand {
  display: inline-flex;
  align-items: center;
  margin-inline-end: auto;
  padding: 2px 3px;
  gap: 7px;
  font-size: 15px;
  line-height: 20px;
  font-weight: 700;
  letter-spacing: -0.025em;
  white-space: nowrap;
}
.gb-brand img { border-radius: 7px; }
.gb-root .gb-side-top .gb-round { width: 30px; height: 32px; }
.gb-side-search {
  display: flex;
  align-items: center;
  gap: 6px;
  flex: none;
  height: 36px;
  margin: 0 0 6px;
  padding: 0 10px;
  border: 0.5px solid var(--bt-line-2);
  border-radius: 8px;
  background: var(--bt-card);
  color: var(--bt-ink-2);
}
.gb-side-search:focus-within {
  border-color: var(--bt-accent);
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--bt-accent) 22%, transparent);
}
.gb-root .gb-side-search input {
  flex: 1;
  width: 100%;
  min-height: 0;
  padding: 0;
  border: 0;
  background: none;
  box-shadow: none;
  color: var(--bt-ink);
}
.gb-list {
  display: flex;
  flex-direction: column;
  gap: 3px;
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  margin-inline-end: -12px;
  scrollbar-gutter: stable;
}
.gb-list::-webkit-scrollbar {
  width: 12px;
}
.gb-list::-webkit-scrollbar-thumb {
  border: 4px solid transparent;
  border-radius: 6px;
  background: color-mix(in srgb, var(--bt-ink) 16%, transparent) padding-box;
}
.gb-tile-wrap { padding: 6px 0 9px; }
.gb-root .gb-tile {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  column-gap: 10px;
  row-gap: 1px;
  width: 100%;
  padding: 10px;
  border: 1px solid var(--bt-line);
  border-radius: 10px;
  background: var(--bt-card);
  color: var(--bt-ink);
  text-align: start;
}
.gb-tile > .gb-avatar { grid-row: span 2; }
.gb-root .gb-tile:enabled:hover { border-color: var(--bt-line-2); }
.gb-root .gb-tile[aria-current='page'] { border-color: var(--bt-accent); }
.gb-tile-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 14px;
  line-height: 18px;
  font-weight: 650;
}
.gb-chip {
  color: var(--bt-ink-2);
  font-size: 11px;
  line-height: 15px;
}
.gb-root .gb-navrow {
  display: flex;
  align-items: center;
  justify-content: flex-start;
  gap: 10px;
  width: 100%;
  min-height: 54px;
  padding: 7px 10px;
  border-radius: 8px;
  background: transparent;
  color: var(--bt-ink);
  text-align: start;
  font-weight: 400;
  white-space: normal;
}
.gb-root .gb-navrow:enabled:hover {
  background: var(--bt-hover);
}
.gb-root .gb-navrow[aria-current='page'] {
  background: var(--bt-active);
  box-shadow: inset 3px 0 var(--bt-accent);
}
.gb-root .gb-navrow:focus-visible {
  outline-offset: -2px;
}
.gb-navrow-body {
  display: flex;
  flex-direction: column;
  flex: 1 1 auto;
  min-width: 0;
}
.gb-navrow-name,
.gb-navrow-preview {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.gb-navrow-name {
  font-size: 14px;
  line-height: 20px;
}
.gb-navrow[aria-current='page'] .gb-navrow-name {
  font-weight: 500;
}
.gb-navrow-preview {
  font-size: 13px;
  line-height: 18px;
  color: var(--bt-ink-2);
}
.gb-app-icon {
  flex: none;
  display: inline-grid;
  place-items: center;
  width: 36px;
  height: 36px;
  border-radius: 10px;
  background: var(--bt-card);
  box-shadow: inset 0 0 0 0.5px var(--bt-line-2);
  color: var(--bt-ink-2);
}
.gb-room-art {
  position: relative;
  flex: none;
  width: 36px;
  height: 36px;
}
.gb-room-art > .gb-avatar {
  position: absolute;
  inset: 0 auto auto 8px;
}
.gb-room-art > .gb-avatar:nth-child(2) {
  inset: 15px auto auto 0;
}
.gb-room-art > .gb-avatar:nth-child(3) {
  inset: 15px auto auto 16px;
}
.gb-sec-head {
  display: flex;
  align-items: center;
  height: 30px;
  margin-top: 6px;
  padding: 0 8px 0 6px;
  color: var(--bt-ink-2);
  font-size: 12px;
  line-height: 16px;
  font-weight: 600;
}
.gb-hint {
  padding: 14px;
  text-align: center;
  font-size: 13px;
  color: var(--bt-ink-2);
}
.gb-root .gb-empty-add {
  align-self: center;
  margin: 12px 0;
}
.gb-side-rail {
  align-items: center;
  gap: 6px;
  padding: calc(var(--dsh-frame-top-clearance, var(--dsh-windows-titlebar-height, 0px)) + 8px) 0 8px;
}
.gb-rail-top {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  padding-bottom: 8px;
}
.gb-rail-sep {
  width: 24px;
  height: 1px;
  flex: none;
  background: var(--bt-line);
}
.gb-side-rail .gb-list {
  align-self: stretch;
  align-items: center;
  gap: 8px;
  margin: 0;
  scrollbar-gutter: auto;
}
/* The collapsed DSH column reserves 44px per navigation item. */
.gb-root .gb-side-rail .gb-navrow {
  flex: none;
  justify-content: center;
  width: 44px;
  height: 44px;
  min-height: 44px;
  padding: 0;
  border-radius: 14px;
}

/* Workspace column. */
.gb-workspace {
  container-type: inline-size;
  position: relative;
}
.gb-panels,
.gb-pane,
.gb-chat {
  height: 100%;
  min-width: 0;
  min-height: 0;
}
.gb-panels {
  display: flex;
  overflow: hidden;
  position: relative;
}
.gb-pane {
  display: flex;
  flex: 1 1 0;
  flex-direction: column;
  overflow: hidden;
}
.gb-drawer {
  flex: 0 0 clamp(300px, 31%, 340px);
  min-width: 0;
  min-height: 0;
  height: 100%;
  overflow: auto;
  border-inline-start: 0.5px solid var(--bt-line-2);
  background: var(--bt-main);
}
.gb-terminal-seat {
  flex: 0 0 49%;
  min-width: 0;
  min-height: 0;
}
@media (max-width: 820px) {
  .gb-terminal-seat { position: absolute; inset: 0; z-index: 10; }
}
.gb-root .gb-drawer-scrim {
  display: none;
}
.gb-chat-header {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  align-items: center;
  gap: 6px;
  min-height: 64px;
  padding: 10px clamp(12px, 3cqw, 28px);
  border-bottom: 1px solid var(--bt-line);
  background: var(--bt-card);
  flex: none;
}
.gb-chat-header h1 {
  display: flex;
  align-items: center;
  justify-content: flex-start;
  font-size: 17px;
  font-weight: 650;
  max-width: 100%;
  min-width: 0;
  outline: none;
}
.gb-header-start,
.gb-header-end {
  display: flex;
  align-items: center;
  gap: 4px;
}
.gb-header-start:empty { display: none; }
.gb-chat-header:has(.gb-header-start:empty) { grid-template-columns: minmax(0, 1fr) auto; }
.gb-header-end { justify-content: flex-end; }
.gb-chat-header .gb-iconbutton {
  width: 36px;
  height: 36px;
}
/* Current conversation and its settings action. */
.gb-root .gb-identity {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  max-width: 100%;
  height: 40px;
  min-height: 0;
  padding: 4px 8px;
  border: 0;
  border-radius: 8px;
  background: transparent;
  color: var(--bt-ink);
  font-size: 14px;
  font-weight: 500;
}
.gb-root .gb-identity:enabled:hover {
  background: color-mix(in srgb, var(--bt-main), #777 9%);
}
.gb-root .gb-identity:active {
  transform: scale(0.965);
}
.gb-identity > span:not(.gb-avatar) {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.gb-identity > .gb-icon {
  color: var(--bt-ink-3);
}
.gb-chat {
  display: flex;
  flex-direction: column;
  flex: 1 1 0;
}
.gb-chat-scroll {
  flex: 1;
  min-height: 0;
  overflow: auto;
  overscroll-behavior: contain;
  scrollbar-width: thin;
  scrollbar-color: color-mix(in srgb, var(--bt-ink) 16%, transparent) transparent;
}
.gb-transcript,
.gb-compose-zone {
  width: 100%;
  max-width: calc(var(--dsh-chat-content-width, 748px) + 48px);
  margin: 0 auto;
}
.gb-transcript {
  padding: 4px 24px 24px;
}
.gb-chat-entry + .gb-chat-entry {
  margin-top: 10px;
}
.gb-timebreak {
  display: block;
  text-align: center;
  margin: 16px auto 18px;
  font-size: 12px;
  color: var(--bt-ink-3);
}
.gb-welcome {
  min-height: 42vh;
  display: flex;
  justify-content: center;
  align-items: center;
  flex-direction: column;
  gap: 6px;
  max-width: 420px;
  margin: 0 auto;
  text-align: center;
}
.gb-welcome strong {
  margin-top: 6px;
  font-size: 17px;
  font-weight: 600;
}
.gb-welcome > span:not(.gb-avatar) {
  color: var(--bt-ink-2);
  font-size: 13px;
}
/* Conversation transcript. */
.gb-message {
  display: flex;
  gap: 8px;
  align-items: flex-end;
}
.gb-message[data-human='true'] {
  justify-content: flex-end;
}
.gb-message-body {
  max-width: min(80%, calc(100% - 82px));
  min-width: 0;
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 4px;
}
.gb-message[data-cli-report] .gb-message-body {
  width: min(100%, 760px);
  max-width: calc(100% - 35px);
}
.gb-message[data-human='true'] .gb-message-body {
  align-items: flex-end;
}
.gb-message-author {
  font-size: 12px;
  line-height: 16px;
  margin: 0 4px;
}
.gb-msgmark {
  padding-bottom: 2px;
  line-height: 1;
}
.gb-root .gb-avatarbutton {
  min-height: 0;
  padding: 0;
  border-radius: 30%;
  background: transparent;
}
.gb-root .gb-avatarbutton:enabled:hover {
  background: transparent;
  transform: scale(1.04);
}
.gb-bubble {
  min-width: 0;
  max-width: 100%;
  padding: 9px 13px;
  border-radius: 12px 12px 12px 4px;
  background: var(--bt-bubble);
  color: var(--bt-ink);
  font-size: var(--dsh-content-font-size, 14px);
  line-height: calc(var(--dsh-content-font-size, 14px) + 10px);
  overflow-wrap: anywhere;
  text-wrap: pretty;
}
.gb-message[data-human='true'] .gb-bubble {
  border-radius: 12px 12px 4px 12px;
  background: var(--bt-user);
  color: var(--bt-user-ink);
  white-space: pre-wrap;
}
.gb-bubble [data-markdown-variant],
.gb-bubble [class*='_markdown'] {
  color: inherit !important;
  font-size: inherit !important;
  line-height: inherit !important;
}
.gb-bubble [class*='_markdown'] > * + * {
  margin-top: 10px;
}
.gb-bubble p {
  margin: 0;
}
.gb-bubble ul,
.gb-bubble ol {
  margin: 4px 0;
  padding-left: 20px;
}
.gb-bubble pre {
  overflow: auto;
  white-space: pre;
}
.gb-bubble :is(img, video) {
  max-width: 100%;
  height: auto;
}
.gb-bubble [data-code-block-banner] button {
  min-height: 0;
  padding: 2px 6px;
  border-radius: 6px;
  background: transparent;
  color: var(--bt-ink-2);
}
.gb-bubble a {
  color: var(--bt-accent);
}
.gb-activity {
  margin-inline-start: 35px;
  font-size: 12px;
  color: var(--bt-ink-2);
}
.gb-activity summary {
  display: inline-flex;
  gap: 6px;
  align-items: center;
  max-width: 100%;
  padding: 3px 8px 3px 6px;
  border-radius: 8px;
  list-style: none;
}
.gb-activity summary:hover {
  background: var(--bt-hover);
  color: var(--bt-ink);
}
.gb-activity summary::-webkit-details-marker {
  display: none;
}
.gb-activity summary > span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.gb-activity pre {
  max-height: 180px;
  overflow: auto;
  margin-top: 5px;
  padding: 8px 10px;
  border-radius: 10px;
  background: var(--bt-tag-bg);
  color: var(--bt-ink);
}
.gb-activity[data-status='error'],
.gb-activity[data-status='failed'] {
  color: var(--bt-danger);
}
.gb-live-activity {
  display: flex;
  align-items: center;
  gap: 9px;
  margin-top: 16px !important;
  color: var(--bt-ink-2);
  font-size: 13px;
}
.gb-root .gb-older {
  display: flex;
  margin: 0 auto 8px;
  min-height: 28px;
  background: transparent;
  color: var(--bt-ink-2);
  font-size: 12px;
}
.gb-root .gb-older:enabled:hover {
  background: var(--bt-hover);
  color: var(--bt-ink);
}

/* Composer — the DSH chat input card. */
.gb-compose-zone {
  flex: none;
  padding: 4px 24px max(16px, env(safe-area-inset-bottom));
}
.gb-composer {
  display: grid;
  gap: 6px;
}
.gb-composer > small {
  padding: 0 10px;
}
.gb-composer-box {
  position: relative;
  display: flex;
  align-items: flex-end;
  gap: 8px;
  padding: 8px 8px 8px 10px;
  border-radius: 12px;
  border: 1px solid var(--bt-line-2);
  background: var(--bt-card);
  box-shadow: 0 4px 18px -6px rgba(0, 0, 0, 0.08), 0 1px 2px rgba(0, 0, 0, 0.03);
  transition: border-color 0.14s ease;
}
.gb-composer-box:focus-within {
  border-color: var(--bt-accent);
  box-shadow: 0 0 0 2px var(--bt-accent-soft);
}
.gb-root .gb-composer-box textarea {
  display: block;
  flex: 1;
  min-width: 0;
  min-height: 0;
  resize: none;
  border: 0;
  border-radius: 0;
  background: transparent;
  box-shadow: none;
  font-size: 14px;
  line-height: 22px;
  padding: 5px 2px;
  outline: none;
}
.gb-composer-box .gb-popbody {
  top: auto;
  bottom: calc(100% + 8px);
  inset-inline-start: -2px;
  inset-inline-end: auto;
  min-width: 200px;
}
.gb-root .gb-composer-box .gb-pop > summary {
  width: 28px;
  height: 28px;
  margin-bottom: 3px;
  background: color-mix(in srgb, var(--bt-ink) 5%, transparent);
  box-shadow: inset 0 0 0 0.5px var(--bt-line);
  color: var(--bt-ink-2);
}
.gb-root .gb-composer-box .gb-pop > summary:hover,
.gb-root .gb-composer-box .gb-pop[open] > summary {
  background: color-mix(in srgb, var(--bt-ink) 10%, transparent);
  color: var(--bt-ink);
}
.gb-composer-box .gb-pop > summary .gb-icon {
  width: 14px;
  height: 14px;
  transition: rotate 0.18s ease;
}
.gb-composer-box .gb-pop[open] > summary .gb-icon {
  rotate: 45deg;
}
.gb-root .gb-composer-box .gb-send,
.gb-root .gb-composer-box .gb-composer-stop {
  flex: none;
  width: 32px;
  height: 32px;
  min-height: 0;
  padding: 0;
  border-radius: 8px;
}
.gb-root .gb-composer-box .gb-send {
  background: var(--bt-accent);
  color: var(--bt-accent-ink);
}
.gb-root .gb-composer-box .gb-send:enabled:hover {
  background: color-mix(in srgb, var(--bt-accent) 88%, #000);
}
.gb-root .gb-composer-box .gb-send:disabled {
  opacity: 0.35;
}
.gb-root .gb-composer-box .gb-composer-stop {
  background: var(--bt-ink);
  color: var(--bt-main);
}
.gb-root .gb-delivery-mode {
  flex: none;
  max-width: 120px;
  min-height: 28px;
  height: 28px;
  margin-bottom: 2px;
  padding: 0 26px 0 10px;
  border: 0;
  border-radius: 999px;
  background-color: var(--bt-hover);
  background-position: right 8px center;
  font-size: 12px;
  line-height: 28px;
}
.gb-composer-recipients {
  padding: 0 10px;
  font-size: 12px;
}
.gb-pending {
  display: grid;
  gap: 8px;
  max-height: 30vh;
  overflow: auto;
  margin: 0 0 8px;
}
.gb-last-error {
  margin-bottom: 6px;
  padding: 0 10px;
  font-size: 12px;
  color: var(--bt-danger);
}

/* Pages, forms and settings cards. */
.gb-page,
.gb-session-inspector {
  min-width: 0;
  min-height: 0;
  overflow: auto;
  padding: 16px clamp(16px, 4cqw, 40px) 28px;
}
.gb-page {
  flex: 1;
  align-content: start;
}
.gb-session-inspector {
  flex: 1;
  display: grid;
  gap: 12px;
  align-content: start;
  width: 100%;
  max-width: calc(var(--dsh-chat-content-width, 748px) + 80px);
  margin: 0 auto;
}
.gb-session-inspector > .gb-row:first-child {
  justify-content: space-between;
}
.gb-form,
.gb-create {
  max-width: 600px;
}
.gb-create {
  width: 100%;
  margin: 0 auto;
}
.gb-create > .gb-form {
  gap: 18px;
  margin-top: clamp(4px, 5cqw, 54px);
  padding: clamp(16px, 4cqw, 30px);
  border: 1px solid var(--bt-line);
  border-top: 3px solid var(--bt-accent);
  border-radius: 12px;
  background: var(--bt-card);
  box-shadow: var(--bt-card-shadow);
}
.gb-create > button {
  margin-top: 12px;
}
.gb-meta dt {
  color: var(--bt-ink-2);
  font-size: 12px;
  font-weight: 500;
}
.gb-root .gb-danger {
  background: var(--bt-danger-soft);
  color: var(--bt-danger);
}
.gb-root .gb-danger:enabled:hover {
  background: color-mix(in srgb, var(--bt-danger) 22%, transparent);
}
.gb-meta {
  display: grid;
  grid-template-columns: max-content minmax(0, 1fr);
  gap: 6px 14px;
  font-size: 13px;
}
.gb-meta dd,
.gb-text,
.gb-event,
.gb-alert {
  overflow-wrap: anywhere;
}
.gb-text {
  white-space: pre-wrap;
}
.gb-alert {
  flex: none;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin: 0 16px 8px;
  padding: 8px 12px;
  border-radius: 10px;
  background: color-mix(in srgb, var(--bt-warn) 12%, transparent);
  color: var(--bt-ink);
  font-size: 13px;
}
ul.gb-alert {
  display: block;
  margin: 0;
  padding-inline-start: 28px;
}
.gb-feed {
  max-height: 340px;
  overflow: auto;
}
.gb-event {
  padding: 8px 0;
}
.gb-event + .gb-event,
.gb-queue + .gb-queue {
  border-top: 0.5px solid var(--bt-line);
}
.gb-event time {
  margin-inline-start: auto;
}
.gb-root .gb-link {
  min-height: 0;
  padding: 1px 6px;
  background: transparent;
  color: var(--bt-accent);
  font-size: 12px;
}
.gb-evidence {
  min-width: 0;
  overflow-wrap: anywhere;
}
.gb-evidence summary {
  font-size: 13px;
}
.gb-evidence pre {
  max-height: 240px;
  overflow: auto;
}
@container (max-width:700px) {
  .gb-panels > .gb-drawer {
    position: absolute;
    z-index: 9;
    inset: 0 0 0 auto;
    width: min(340px, 92%);
    box-shadow: -8px 0 24px rgba(0, 0, 0, 0.14);
  }
  .gb-root .gb-drawer-scrim {
    position: absolute;
    display: block;
    z-index: 8;
    inset: 0;
    width: 100%;
    height: 100%;
    min-height: 0;
    border-radius: 0;
    background: color-mix(in srgb, #000 28%, transparent);
  }
  .gb-chat-header {
    min-height: 56px;
    padding: 8px 10px;
  }
  .gb-transcript {
    padding: 2px 12px 18px;
  }
  .gb-compose-zone {
    padding-inline: 10px;
  }
  .gb-message-body {
    max-width: min(88%, calc(100% - 40px));
  }
}
@container (max-width:420px) {
  .gb-chat-header { gap: 2px; }
  .gb-chat-header .gb-iconbutton {
    width: 36px;
    height: 40px;
  }
  .gb-root .gb-delivery-mode {
    max-width: 88px;
    font-size: 11px;
  }
  .gb-activity {
    margin-inline-start: 6px;
  }
}
`
