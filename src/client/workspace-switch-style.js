// The workspace selector is mounted in both navigation columns.
export const switchStyle = `
.gb-switch {
  display: flex;
  align-items: center;
  gap: 4px;
  margin: 10px 0 6px;
  padding-block: 8px;
  flex: none;
  border-block: 1px solid var(--bt-line);
  font-family: var(--bt-font);
  color: var(--bt-ink);
}
.gb-switch-seg {
  display: flex;
  flex: 1;
  min-width: 0;
  gap: 2px;
  container-type: inline-size;
}
.gb-switch button { box-sizing: border-box; }
.gb-switch .gb-switch-seg > button, .gb-switch .gb-switch-back {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 5px;
  height: 34px;
  min-height: 0;
  margin: 0;
  padding: 0 6px;
  border: 0;
  border-radius: 7px;
  background: transparent;
  color: var(--bt-ink-2);
  font: 500 12px/1.4 var(--bt-font);
  white-space: nowrap;
  cursor: pointer;
}
.gb-switch .gb-switch-seg > button { flex: 1 1 0; min-width: 0; }
.gb-switch .gb-switch-back { flex: none; width: 30px; padding: 0; }
.gb-switch .gb-switch-seg > button:hover, .gb-switch .gb-switch-back:hover { background: var(--bt-hover); color: var(--bt-ink); }
.gb-switch .gb-switch-seg > button[aria-current=page] {
  background: var(--bt-accent);
  color: var(--bt-accent-ink);
  font-weight: 650;
  cursor: default;
}
.gb-switch button:focus-visible { outline: 2px solid var(--bt-accent); outline-offset: 1px; }
.gb-switch-seg > button > span { overflow: hidden; text-overflow: ellipsis; }
.gb-switch .gb-icon { display: block; flex: none; }
.gb-switch-short { display: none; }
@container (max-width: 195px) {
  .gb-switch-long { display: none; }
  .gb-switch-short { display: inline; }
}
@container (max-width: 112px) {
  .gb-switch .gb-switch-seg > button > .gb-icon { display: none; }
}
.gb-switch[data-rail] { flex-direction: column; gap: 4px; margin: 0; padding-block: 6px; }
.gb-switch[data-rail] .gb-switch-seg { flex: none; flex-direction: column; container-type: normal; }
.gb-switch[data-rail] .gb-switch-seg > button { flex: none; width: 34px; height: 34px; padding: 0; }
`
