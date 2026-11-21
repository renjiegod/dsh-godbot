// Same card, row and control language as the Bot workspace's settings panel.
export const settingsStyle = `
.gb-bot-settings{display:flex;flex-direction:column;min-width:0;min-height:0;height:100%;color:var(--bt-ink);background:var(--bt-main);text-align:start}
.gb-bot-settings .gb-setting-header{flex:none;display:flex;align-items:center;justify-content:space-between;gap:12px;padding:18px 16px 14px;border-bottom:.5px solid var(--bt-line)}
.gb-setting-who{min-width:0;flex:1}.gb-setting-who small{display:block;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}
.gb-bot-settings .gb-setting-header h2{font-size:17px;font-weight:600;letter-spacing:-.01em;line-height:1.4}
.gb-bot-settings .gb-setting-header small{font-size:12px;color:var(--bt-ink-2)}
.gb-setting-scroll{min-height:0;flex:1;overflow:auto;overscroll-behavior:contain;padding:14px 14px 28px;scrollbar-width:thin}
.gb-setting-group+.gb-setting-group{margin-top:20px}
.gb-setting-title{display:flex;align-items:center;justify-content:space-between;margin:0 4px 8px;min-height:22px}
.gb-bot-settings .gb-setting-title h3{font-size:12px;letter-spacing:0;font-weight:600;color:var(--bt-ink-2)}
.gb-bot-settings .gb-setting-card{border:.5px solid var(--bt-glass-rim);border-radius:12px;background:var(--bt-card);box-shadow:var(--bt-card-shadow);overflow:hidden}
.gb-setting-row{display:flex;align-items:center;justify-content:space-between;gap:12px;min-height:48px;padding:12px 14px;min-width:0}
.gb-setting-row+.gb-setting-row{border-top:.5px solid var(--bt-line)}
.gb-setting-copy{display:flex;flex-direction:column;gap:3px;min-width:0}
.gb-bot-settings .gb-setting-copy strong{font-size:13px;line-height:18px;font-weight:500}
.gb-bot-settings .gb-setting-copy small,.gb-bot-settings .gb-setting-footnote,.gb-bot-settings .gb-setting-note{font-size:12px;line-height:1.5;font-weight:400;color:var(--bt-ink-2);overflow-wrap:anywhere}
.gb-bot-settings .gb-setting-row select{min-width:80px;max-width:59%;width:auto;text-overflow:ellipsis;cursor:pointer;background-color:var(--bt-hover);height:34px;min-height:0}
.gb-bot-settings .gb-setting-editor{display:flex;flex-direction:column;gap:9px;padding:12px 14px}
.gb-bot-settings :is(.gb-setting-editor input,.gb-setting-editor textarea,.gb-setting-row select){font-size:13px;line-height:1.45}
.gb-bot-settings .gb-setting-editor :is(input,textarea){width:100%}
.gb-bot-settings .gb-setting-editor textarea{min-height:73px;resize:vertical}
.gb-bot-settings :is(select,input,textarea):disabled{opacity:.6;cursor:default}
.gb-bot-settings .gb-setting-icon{display:grid;place-items:center;flex:none;width:28px;height:28px;min-height:unset;background:none;border:0;border-radius:50%;color:var(--bt-ink-2);padding:0}
.gb-bot-settings .gb-setting-icon:enabled:hover{color:var(--bt-ink);background:var(--bt-hover)}
.gb-bot-settings .gb-retry-route{display:flex;font-size:12px;margin-top:6px}
.gb-bot-settings .gb-folder-reset{margin:0 14px 10px;font-size:12px;min-height:24px;background:none;color:var(--bt-ink-2);border:0;padding:0}
.gb-setting-apply{display:flex;flex-wrap:wrap;justify-content:flex-end;gap:6px;padding:0 14px 12px}
.gb-setting-row+.gb-setting-apply{padding-top:4px}
.gb-bot-settings .gb-setting-apply button{font-size:12px;min-height:28px;padding:0 12px;font-weight:500}
.gb-bot-settings .gb-setting-save{background:var(--bt-accent);color:var(--bt-accent-ink)}
.gb-bot-settings .gb-setting-save:enabled:hover{background:color-mix(in srgb,var(--bt-accent) 88%,#000)}
.gb-bot-settings .gb-setting-note{padding:10px 14px}
.gb-bot-settings .gb-setting-state,.gb-bot-settings .gb-setting-error{background:var(--bt-hover);border-radius:10px;margin:0 0 12px}
.gb-bot-settings .gb-setting-error{color:var(--bt-ink);border-inline-start:2px solid var(--bt-danger);white-space:pre-wrap}
.gb-bot-settings .gb-setting-footnote{padding:0 14px 12px}
`

export const sandboxSettingsStyle = `
.gb-sandbox-binding{display:grid;gap:10px;min-width:0}
.gb-sandbox-binding h3{margin:0;color:var(--bt-ink);font-size:14px}
.gb-sandbox-fields{display:grid;gap:9px;min-width:0}
.gb-sandbox-fields .gb-field,.gb-sandbox-binding>.gb-field{display:grid;gap:5px;min-width:0;font-size:13px}
.gb-sandbox-fields select,.gb-sandbox-binding select{box-sizing:border-box;width:100%;min-width:0;min-height:32px;color:var(--bt-ink);background:var(--bt-main);border:1px solid var(--bt-line-2);border-radius:7px;padding:4px 7px;font:inherit}
.gb-sandbox-binding{padding:12px;border:1px solid var(--bt-line-2);border-radius:10px}
.gb-sandbox-binding>button{justify-self:start}
`
