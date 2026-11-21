export function toolStatusWithExitCode(status, exitCode) {
  return status === 'completed' && Number.isSafeInteger(exitCode) && exitCode !== 0 ? 'failed' : status
}

export function acpToolExitCode(call) {
  return [call.exitCode, call.rawOutput?.exit_code, call.rawOutput?.exitCode].find(Number.isSafeInteger)
}

export function acpToolStatus(call, exitCode) {
  if (call.status === 'in_progress') return 'running'
  return toolStatusWithExitCode(call.status ?? 'pending', exitCode)
}

export function claudeToolResult(block, details) {
  const exitCode = [details?.exitCode, details?.exit_code].find(Number.isSafeInteger)
  const status = details?.interrupted === true ? 'interrupted' : toolStatusWithExitCode(block.is_error === true ? 'failed' : 'completed', exitCode)
  const feedback = {}
  for (const field of ['stdout', 'stderr']) {
    if (typeof details?.[field] === 'string') feedback[field] = details[field]
  }
  return { status, output: Object.keys(feedback).length ? feedback : block.content, exitCode }
}
