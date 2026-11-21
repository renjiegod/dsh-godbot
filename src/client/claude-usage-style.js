// Shared by both chat surfaces. Both carry the same --bt-* palette, so the
// report follows the DSH light/dark theme identically in each workspace.
export const usageStyle = `
.gb-claude-usage {
  --cu-fg: var(--bt-ink, #22222c);
  --cu-muted: var(--bt-ink-2, #61616f);
  --cu-card: var(--bt-card, #fafafa);
  --cu-line: var(--bt-line-2, #d1d0d9);
  --cu-label: #79501b;
  --cu-track: #dedfe9;
  --cu-fill: #7168a8;
  --cu-tab: #eeedf8;
  --cu-mono: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  display: block;
  box-sizing: border-box;
  inline-size: min(40rem, 100%);
  min-inline-size: 0;
  max-inline-size: 100%;
  padding: clamp(12px, 2.5vw, 20px);
  border: 1px solid var(--cu-line);
  border-block-start: 3px solid var(--cu-fill);
  border-radius: 10px;
  color: var(--cu-fg);
  background: var(--cu-card);
  text-align: start;
  font: normal 14px/1.42 var(--bt-font, Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif);
  white-space: normal;
  overflow-wrap: anywhere;
}
body[data-ds-dark-theme] .gb-claude-usage {
  --cu-label: #f4c470;
  --cu-track: #43465b;
  --cu-fill: #b5b8f7;
  --cu-tab: #393b50;
}
.gb-claude-usage *, .gb-claude-usage *::before { box-sizing: border-box; }
.gb-claude-usage :is(h3, h4, p, ul, li, table, pre) { margin: 0; }
.gb-claude-usage .gb-usage-heading h3 { font-size: 18px; line-height: 1.2; font-weight: 650; letter-spacing: -.02em; }
.gb-claude-usage .gb-usage-note, .gb-claude-usage .gb-usage-reset, .gb-claude-usage .gb-usage-detail {
  color: var(--cu-muted);
}
.gb-claude-usage .gb-usage-note, .gb-claude-usage .gb-usage-reset { font-size: 12px; line-height: 1.45; }
.gb-usage-heading .gb-usage-note { margin-block-start: 3px; }
.gb-usage-quotas { display: grid; gap: 13px; margin-block: 15px; }
.gb-usage-limit { display: flex; flex-wrap: wrap; align-items: baseline; justify-content: space-between; gap: 1px 8px; }
.gb-usage-limit strong, .gb-usage-value, .gb-usage-share { color: var(--cu-label); }
.gb-usage-limit strong { font-weight: 630; }
.gb-usage-value, .gb-usage-share, .gb-usage-table td, .gb-usage-reset, .gb-usage-totals {
  font-family: var(--cu-mono); font-variant-numeric: tabular-nums;
}
.gb-usage-value { flex: 0 0 auto; font-size: 13px; }
.gb-usage-quota meter { display: block; appearance: none; inline-size: 100%; block-size: 12px; margin-block: 5px 3px; border: 0; border-radius: 2px; background: linear-gradient(to right, var(--cu-fill) var(--cu-used), var(--cu-track) var(--cu-used)); overflow: hidden; }
.gb-usage-quota meter::-webkit-meter-inner-element { display: block; }
.gb-usage-quota meter::-webkit-meter-bar { block-size: 12px; border: 0; border-radius: 0; background: transparent; box-shadow: none; }
.gb-usage-quota meter::-webkit-meter-optimum-value { background: transparent; }
.gb-usage-quota meter::-moz-meter-bar { background: transparent; }
.gb-usage-breakdown { padding-block-start: 12px; margin-block-start: 12px; border-block-start: 1px solid var(--cu-line); }
.gb-usage-breakdown h4 { color: var(--cu-fg); font-size: 14px; line-height: 1.4; font-weight: 650; }
.gb-usage-periods { display: flex; flex-wrap: wrap; gap: 3px; margin-block: 7px 3px; }
.gb-claude-usage .gb-usage-periods button {
  display: inline-block; min-height: 28px; color: var(--cu-muted); appearance: none; background: transparent;
  border: 1px solid transparent; border-radius: 4px; padding: 3px 8px; font: 600 12px/1.4 var(--cu-mono); cursor: pointer;
}
.gb-claude-usage .gb-usage-periods button:is([aria-selected=true],[aria-pressed=true]) { background: var(--cu-tab); color: var(--cu-fg); border-color: var(--cu-line); }
.gb-claude-usage :is(button, summary, [role=tabpanel]):focus-visible { outline: 2px solid var(--cu-fill); outline-offset: 1px; }
.gb-usage-period {
  max-block-size: min(19rem, 32vh); max-block-size: min(19rem, 32dvh); overflow-y: auto;
  scrollbar-width: thin; padding: 5px 3px 5px 0; line-height: 1.4;
}
.gb-usage-period[hidden] { display: none; }
.gb-claude-usage .gb-usage-verbatim { white-space: pre-wrap; overflow-wrap: anywhere; }
.gb-usage-period .gb-usage-totals { margin-block-end: 7px; color: var(--cu-muted); font-size: 12px; }
.gb-usage-period .gb-usage-advice { padding: 0; display: grid; gap: 5px; list-style: none; font-size: 13px; }
.gb-usage-advice li { display: grid; grid-template-columns: minmax(3ch, auto) minmax(0, 1fr); align-items: baseline; gap: 8px; }
.gb-usage-share { font-size: 12px; font-weight: 600; text-align: end; }
.gb-usage-period .gb-usage-table { inline-size: 100%; border-collapse: collapse; margin-block-start: 10px; color: var(--cu-fg); font-size: 12px; }
.gb-usage-table :is(td, th) { border: 0; padding: 3px 0; background: transparent; text-align: start; }
.gb-usage-table th { font-weight: 600; color: var(--cu-label); }
.gb-usage-table th:last-child, .gb-usage-table td:nth-child(2) { text-align: end; white-space: nowrap; padding-inline-start: 8px; }
.gb-usage-table .gb-usage-more { color: var(--cu-muted); }
.gb-usage-source { border-block-start: 1px solid var(--cu-line); margin-block-start: 10px; padding-block-start: 6px; color: var(--cu-muted); }
.gb-claude-usage .gb-usage-source summary { display: list-item; cursor: pointer; width: fit-content; font-family: inherit; font-size: 12px; line-height: 1.6; font-weight: 500; }
.gb-claude-usage .gb-usage-source summary:hover { color: var(--cu-fg); background: transparent; }
.gb-claude-usage .gb-usage-source pre {
  max-block-size: 16rem; overflow: auto; white-space: pre-wrap; overflow-wrap: anywhere; margin-block-start: 6px;
  padding: 8px; color: var(--cu-fg); border: 1px solid var(--cu-line); border-radius: 4px; background: transparent; font: 12px/1.4 var(--cu-mono);
}
.gb-usage-nav { display: flex; align-items: baseline; gap: 4px; margin-block: 0 10px; border-bottom: 1px solid var(--cu-line); }
.gb-claude-usage .gb-usage-nav button {
  appearance: none; cursor: pointer; background: transparent; color: var(--cu-muted); min-height: 30px;
  font: 600 14px/1.2 var(--cu-mono); border: 0; padding: 4px 9px 7px; border-radius: 0; border-block-end: 2px solid transparent;
}
.gb-claude-usage .gb-usage-nav button[aria-selected=true] { color: var(--cu-fg); border-block-end-color: var(--cu-fill); }
.gb-claude-usage [hidden] { display: none; }
.gb-stats-content { min-inline-size: 0; }
.gb-claude-usage .gb-stats-metrics { margin: 12px 0; display: grid; grid-template-columns: repeat(auto-fit,minmax(min(7.5rem,100%),1fr)); gap: 10px; }
.gb-stats-metrics dt { font-size: 12px; color: var(--cu-muted); }
.gb-stats-metrics dd { margin: 2px 0; font: 600 16px/1.25 var(--cu-mono); color: var(--cu-label); }
.gb-stats-table-section { margin-block-start: 10px; }
.gb-stats-table-section h4 { color: var(--cu-fg); margin: 0 0 4px; font-family: inherit; font-size: 13px; font-weight: 630; }
.gb-stats-table-scroll { max-block-size: min(10rem,19dvh); overflow: auto; scrollbar-width: thin; }
.gb-stats-table-scroll:focus-visible { outline: 2px solid var(--cu-fill); outline-offset: 1px; }
.gb-stats-table { inline-size: 100%; border-collapse: collapse; font: normal 12px/1.35 var(--cu-mono); color: var(--cu-fg); font-variant-numeric: tabular-nums; }
.gb-stats-table :is(th,td) { padding: 4px 5px; border: 0; border-bottom: 1px solid var(--cu-line); text-align: end; }
.gb-stats-table :is(th,td):first-child { text-align: start; padding-inline-start: 0; }
.gb-stats-table td, .gb-stats-table thead th { white-space: nowrap; }
.gb-stats-table tbody th { font-weight: 400; min-width: 8ch; }
.gb-stats-table th[scope=col] { position: sticky; top: 0; background: var(--cu-card); color: var(--cu-label); font-weight: 600; }
.gb-usage-session { border-block-start: 1px solid var(--cu-line); margin-block-start: 10px; padding-block-start: 6px; }
.gb-claude-usage .gb-usage-session summary { display: list-item; cursor: pointer; inline-size: fit-content; font: 600 13px/1.6 var(--cu-mono); color: var(--cu-label); }
.gb-stats-error { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
.gb-claude-usage .gb-stats-error button { cursor: pointer; background: transparent; color: inherit; border: 0; text-decoration: underline; font: inherit; padding: 2px; }
@media (max-width: 560px) {
  .gb-stats-table[data-stats-models], .gb-stats-table[data-stats-models] tbody { display: block; }
  .gb-stats-table[data-stats-models] thead { position: absolute; inline-size: 1px; block-size: 1px; overflow: hidden; clip-path: inset(50%); }
  .gb-stats-table[data-stats-models] tbody tr { display: grid; grid-template-columns: repeat(2,minmax(0,1fr)); gap: 2px 8px; padding-block: 5px; border-block-end: 1px solid var(--cu-line); }
  .gb-stats-table[data-stats-models] tbody :is(th,td) { display: block; text-align: start; border: 0; padding: 2px 0; }
  .gb-stats-table[data-stats-models] tbody th { grid-column: 1/-1; color: var(--cu-label); font-weight: 600; }
  .gb-stats-table[data-stats-models] td::before { content: attr(data-label); display: block; color: var(--cu-muted); font-family: var(--bt-font,system-ui,sans-serif); }
  .gb-usage-period { max-block-size: min(14rem, 23dvh); }
  .gb-usage-quotas { gap: 9px; }
}
`
