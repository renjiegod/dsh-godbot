export const dshShellToolNames = Object.freeze(['bash', 'pwsh'])
const shellTools = new Set(dshShellToolNames)
const foregroundExit = /\n\[exit code: (\d+)\]$/u
const persistentExit = /(?:^|\n)\[Command finished with exit code (\d+)\]$/u
const killed = /\n\[killed by signal: [^\]\n]+\]$/u

// DSH serializes a foreground command's nonzero exit as a final text marker.
// Its tool-level isError flag is reserved for failures invoking the tool.
export function dshShellOutcome(name, status, output, exitCode) {
  if (!shellTools.has(name) || !['completed', 'failed'].includes(status)) return
  if (!Number.isSafeInteger(exitCode)) {
    const block = Array.isArray(output) && output.length === 1 ? output[0] : undefined
    const text = block?.type === 'text' && typeof block.text === 'string' ? block.text : undefined
    if (text === undefined) return
    const code = foregroundExit.exec(text)?.[1] ?? persistentExit.exec(text)?.[1]
    if (code === undefined) return killed.test(text) ? { status: 'failed' } : undefined
    exitCode = Number(code)
    if (!Number.isSafeInteger(exitCode)) return
  }
  return { exitCode, status: exitCode === 0 ? status : 'failed' }
}
