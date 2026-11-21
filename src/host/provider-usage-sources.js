import { readFileSync } from 'node:fs'

export function usageProbeSources(kind) {
  if (kind === 'claude') return [readFileSync(new URL('./provider-usage-claude.py', import.meta.url), 'utf8')]
  if (kind !== 'antigravity' && kind !== 'codex') throw new Error('Unsupported provider quota source')
  return [readFileSync(new URL('./provider-usage-probe.py', import.meta.url), 'utf8'),
    readFileSync(new URL('./provider-accounts-probe.py', import.meta.url), 'utf8')]
}
