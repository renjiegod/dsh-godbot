// The local date and wall-clock time are stored alongside the IANA zone.
// The host's own timezone never influences a team's daily or weekly plan.
export function normalizeRoutineTiming(input) {
  if (input?.kind === 'once') {
    const at = input.at
    const instant = typeof at === 'string' && /^(\d{4}-\d\d-\d\d)T(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d{1,3})?)?(?:Z|[+-]\d\d:\d\d)$/.exec(at)
    if (!instant || !Number.isFinite(Date.parse(at)) || new Date(instant[1] + 'T00:00Z').toISOString().slice(0, 10) !== instant[1]) {
      throw new Error('请选择含时区的一次性执行时间。')
    }
    return { kind: 'once', at: new Date(at).toISOString() }
  }
  if (input?.kind === 'interval') {
    if (!Number.isSafeInteger(input.minutes) || input.minutes < 1 || input.minutes > 525600)
      throw new Error('间隔必须为 1 到 525600 分钟的整数。')
    return { kind: 'interval', minutes: input.minutes }
  }
  if (input?.kind !== 'daily' && input?.kind !== 'weekly') throw new Error('请选择有效的执行周期。')
  if (typeof input.time !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(input.time)) throw new Error('请输入 24 小时制的执行时间。')
  if (typeof input.timeZone !== 'string' || !input.timeZone || input.timeZone.startsWith('+') || input.timeZone.startsWith('-')) throw new Error('请选择有效的 IANA 时区。')
  let timeZone
  try { timeZone = new Intl.DateTimeFormat('en', { timeZone: input.timeZone }).resolvedOptions().timeZone }
  catch { throw new Error('请选择有效的 IANA 时区。') }
  const timing = { kind: input.kind, time: input.time, timeZone }
  if (input.kind === 'weekly') {
    if (!Array.isArray(input.weekdays) || !input.weekdays.length || input.weekdays.some(d => !Number.isInteger(d) || d < 1 || d > 7))
      throw new Error('每周计划至少需要一个有效的星期。')
    timing.weekdays = [...new Set(input.weekdays)].sort()
  }
  return timing
}

const dayMs = 86400000

export function nextRoutineTime(schedule, after, anchor = after) {
  if (schedule.kind === 'once') {
    const at = Date.parse(schedule.at)
    return at > after ? at : null
  }
  if (schedule.kind === 'interval') {
    const period = schedule.minutes * 60000
    return anchor + (Math.floor((after - anchor) / period) + 1) * period
  }

  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: schedule.timeZone, year: 'numeric', month: 'numeric', day: 'numeric',
    hour: 'numeric', minute: 'numeric', hourCycle: 'h23',
  })
  // Represent the wall clock as a UTC number so calendar arithmetic is independent
  // of the process timezone. Convert back using the offsets on each side of the date.
  const wallClock = instant => {
    const parts = Object.fromEntries(formatter.formatToParts(instant).map(p => [p.type, Number(p.value)]))
    return Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute)
  }
  const today = Math.floor(wallClock(after) / dayMs) * dayMs
  const [hour, minute] = schedule.time.split(':').map(Number)
  // Two weeks covers a weekly occurrence skipped during a spring-forward gap.
  for (let day = today; day <= today + 14 * dayMs; day += dayMs) {
    if (schedule.kind === 'weekly' && !schedule.weekdays.includes(new Date(day).getUTCDay() || 7)) continue
    const wall = day + (hour * 60 + minute) * 60000
    const offsets = [wall - dayMs, wall + dayMs].map(epoch => wallClock(epoch) - epoch)
    const candidates = offsets.map(offset => wall - offset).filter(epoch => wallClock(epoch) === wall)
    // A missing local time is skipped. During a repeated hour use the earlier
    // instant consistently, including when the host resumes after that instant.
    const first = Math.min(...candidates)
    if (Number.isFinite(first) && first > after) return first
  }
  throw new Error('无法计算下一次本地执行时间。')
}
