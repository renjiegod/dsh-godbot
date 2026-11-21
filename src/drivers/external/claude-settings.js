// Claude's session-scoped stream-json settings. Both the team and direct-chat
// transports use the same protocol and verify the setting the CLI applied.
import { randomUUID } from 'node:crypto'
import { effortOptions, requireEffort } from './effort.js'
export async function describeClaude(session) {
  await session.readMetadata()
  await session.readApplied()
  const models = session.modelOptions ?? []
  const current =
    models.find((m) => m.id === session.model) ?? models.find((m) => m.resolvedModel === session.model)
  const efforts = current?.efforts ?? []
  return {
    models,
    modes: [],
    commands: session.commands ?? [],
    currentModel: session.model,
    currentMode: session.permissionMode,
    canSetModel: models.length > 0,
    canSetMode: false,
    canResetModel: models.length > 0 && session.canReadApplied,
    efforts,
    currentEffort: session.currentEffort ?? null,
    canConfigureEffort: session.canReadApplied === true,
    canSetEffort: session.canReadApplied && efforts.length > 0,
    canResetEffort: session.canReadApplied && efforts.length > 0,
    defaultEffort: session.nativeDefaults.get(session.model),
    defaultModel: session.defaultModel,
    effortSource: session.canReadApplied ? 'native' : undefined,
  }
}

export async function configureClaude(session, { model, effort }) {
  const current = await describeClaude(session)
  const chosen =
    model === null
      ? current.models.find((m) => m.id === 'default')
      : (current.models.find((m) => m.id === (model ?? session.model)) ??
        current.models.find((m) => m.resolvedModel === (model ?? session.model)))
  requireEffort(chosen?.efforts, effort)
  const switching =
    model !== undefined && (model === null || (chosen?.resolvedModel ?? chosen?.id) !== session.model)
  if (switching) {
    const reply = await session.control({ subtype: 'set_model', ...(model === null ? {} : { model }) })
    if (!reply?.model || (model !== null && reply.model !== model && reply.model !== chosen?.resolvedModel))
      throw new Error('Claude did not confirm the selected model')
    session.model = reply.model
    if (model === null) session.defaultModel = reply.model
  }
  if (effort !== undefined || (switching && session.canReadApplied)) {
    await session.readApplied()
    const desired = effort ?? null
    // This SDK control changes the session flag overlay only. Persisting
    // settings via update_settings would change the user's own CLI defaults.
    const settings = { effortLevel: desired }
    if (session.ultracodeRequested === true) settings.ultracode = true
    await session.control({ subtype: 'apply_flag_settings', settings })
    await session.readApplied()
    if (!session.canReadApplied) throw new Error('Claude did not report the applied effort')
    if (desired !== null && session.currentEffort !== desired)
      throw new Error('Claude applied a different effort (model, environment or organization constraint)')
    if (desired === null) {
      // Claude 2.1.328 can clear the overlay but leave applied.effort on a
      // built-in fallback, even while its effective per-model settings say
      // otherwise. Restore that native setting in this process only, then
      // verify the resulting level (the CLI can cap it by policy).
      const baseline = session.configuredEffort ?? session.nativeDefaults.get(session.model)
      if (
        baseline &&
        session.currentEffort !== baseline &&
        (await describeClaude(session)).efforts.some((e) => e.id === baseline)
      ) {
        await session.control({
          subtype: 'apply_flag_settings',
          settings: { ...settings, effortLevel: baseline },
        })
        await session.readApplied()
      }
      session.nativeDefaults.set(session.model, session.currentEffort)
    }
  }
}

export class ClaudeControlSession {
  constructor() {
    this.nativeDefaults = new Map()
  }
  async control(request) {
    const id = randomUUID()
    const result = Promise.withResolvers()
    const pending = (this.controlRequests ??= new Map())
    result.controlType = request.subtype
    pending.set(id, result)
    const timer = setTimeout(() => result.reject(new Error('Claude control request timed out')), 3000)
    try {
      const [response] = await Promise.all([
        result.promise,
        this.write({ type: 'control_request', request_id: id, request }),
      ])
      return response
    } finally {
      clearTimeout(timer)
      pending.delete(id)
    }
  }

  async readMetadata() {
    this.metadata ??= this.control({ subtype: 'initialize' })
      .then((reply) => {
        // The native reply also contains account and local-directory fields.
        // Only session settings and user-visible command metadata are retained.
        this.modelOptions = (reply?.models ?? []).flatMap((item) =>
          item?.value
            ? [
                {
                  id: item.value,
                  name: item.displayName ?? item.value,
                  ...(item.resolvedModel ? { resolvedModel: item.resolvedModel } : {}),
                  ...(item.supportsEffort !== undefined || Array.isArray(item.supportedEffortLevels)
                    ? {
                        efforts: effortOptions(
                          item.supportsEffort === false ? [] : (item.supportedEffortLevels ?? []),
                        ),
                      }
                    : {}),
                },
              ]
            : [],
        )
        if (typeof reply?.current_permission_mode === 'string')
          this.permissionMode = reply.current_permission_mode
        if (Array.isArray(reply?.commands))
          this.commands = reply.commands
            .filter((c) => c?.name)
            .map((c) => ({
              name: c.name,
              description: c.description ?? '',
              ...(c.argumentHint ? { argumentHint: c.argumentHint } : {}),
            }))
      })
      .catch(() => {})
    return this.metadata
  }

  async readApplied() {
    if (this.canReadApplied === false) return
    const applied = await this.control({ subtype: 'get_settings' }).catch((error) => {
      if (/unsupported|not found|unknown|timed out/i.test(error.message)) return undefined
      throw error
    })
    this.canReadApplied = typeof applied?.model === 'string' && Object.hasOwn(applied, 'effort')
    if (!this.canReadApplied) return
    this.model = applied.model
    this.currentEffort = applied.effort
    this.ultracodeRequested = applied.ultracodeRequested
    this.configuredEffort = applied.configuredEffort
    if (!this.firstRead) {
      this.firstRead = true
      if (!this.resumeId) {
        this.nativeDefaults.set(this.model, this.currentEffort)
        if (!this.launchModel) this.defaultModel = this.model
      }
    }
  }

  receiveControl(response) {
    const request = this.controlRequests?.get(response?.request_id)
    if (request) {
      if (response.subtype === 'success') {
        if (request.controlType === 'get_settings') {
          // Project at the wire boundary: never forward raw settings sources,
          // environment entries, authentication fields or hook configuration.
          const a = response.response?.applied
          request.resolve(
            a
              ? {
                  model: a.model,
                  ...(Object.hasOwn(a, 'effort') ? { effort: a.effort } : {}),
                  ultracodeRequested: a.ultracodeRequested,
                  configuredEffort:
                    response.response.effective?.modelSettings?.[a.model]?.effortLevel ??
                    response.response.effective?.effortLevel,
                }
              : undefined,
          )
        } else request.resolve(response.response)
      } else request.reject(new Error(response.error ?? 'Claude rejected the control request'))
    }
  }
}
