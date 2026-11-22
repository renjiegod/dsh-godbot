// Claude Code runs shells, Monitors and subagents in the background, inside its own
// process, so they end with it: a process closed while one runs kills it, and the
// next process only reports that it did not finish. After each change to them (one
// starts, ends or is killed, or a foreground one moves to the background) the CLI
// sends `system/background_tasks_changed` with every one still live, which replaces
// what it said before. A new process has none until it says otherwise. Two kinds do
// not need the process: an `off_host` task works outside it, and an `ambient` one
// (the CLI's own housekeeping, a live-update watcher) is not activity.

// The tasks of a `background_tasks_changed` that need the CLI's process to stay up.
export function tasksNeedingProcess(tasks) {
  if (!Array.isArray(tasks)) return []
  return tasks.filter(task => task != null && task.off_host !== true && task.ambient !== true)
}
