// Godbot owns the conversation, approvals, tool bridge and permissions. Its
// Claude 0.3.8 transport has no settings stream, and advertises four aliases.
// Attach the same native controls used by a direct Godbot session to its child.
import { claudeUsageFrame } from '../drivers/external/claude-usage-data.js'
import { randomUUID } from 'node:crypto'
import { ClaudeControlSession, configureClaude, describeClaude } from '../drivers/external/claude-settings.js'
import { claudeToolResult } from '../drivers/external/tool-results.js'
import { commandLabel, toolActivity } from './team-runtime/tool-activity.js'

import { ClaudeEngine } from './team-runtime/core/local-agents/claude.js'

class TeamClaudeControl extends ClaudeControlSession {
  constructor(session, options) {
    super()
    this.session = session
    this.launchModel = options.model
    this.resumeId = options.resumeId
    const receive = session.onLine.bind(session)
    const calls = new Map()
    const currentMessages = new Map()
    const streamed = new Map()
    let toolStarts
    const emit = session.emit.bind(session)
    session.emit = event => {
      const trace = event.type === 'activity' ? toolStarts?.shift() : undefined
      emit(trace ? { ...event, trace } : event)
    }
    session.onLine = (line) => {
      let event
      try { event = JSON.parse(line) } catch { return }
      if (event?.type === 'control_response' && this.controlRequests?.has(event.response?.request_id)) {
        this.receiveControl(event.response)
        return
      }
      const parentId = event?.parent_tool_use_id ?? ''
      if (event?.type === 'stream_event' && !this.usageDelivery) {
        const update = event.event
        if (update?.type === 'message_start') currentMessages.set(parentId, update.message?.id)
        else if (update?.type === 'content_block_delta' && update.delta?.type === 'text_delta') {
          const id = currentMessages.get(parentId)
          const text = update.delta.text
          if (typeof id !== 'string' || typeof text !== 'string' || !text) return
          const key = JSON.stringify([parentId, id])
          const blocks = streamed.get(key) ?? new Map()
          blocks.set(update.index, (blocks.get(update.index) ?? '') + text)
          streamed.set(key, blocks)
          session.emit({ type: 'text', text })
        }
        return
      }
      if (event?.type === 'assistant') {
        if (this.usageDelivery) {
          const report = claudeUsageFrame(event)
          if (report) this.usageDelivery.report = report
        }
        const content = event.message?.content
        const pendingText = streamed.get(JSON.stringify([parentId, event.message?.id]))
        if (Array.isArray(content) && (pendingText || content.some(block => block?.type === 'tool_use'))) {
          // The pinned transport already places tool names in the right order
          // alongside assistant text. Attach execution data to those same events.
          toolStarts = []
          for (const block of content) {
            if (block?.type === 'text' && typeof block.text === 'string' && pendingText) {
              const match = [...pendingText].find(([, sent]) => block.text.startsWith(sent))
              if (match) {
                pendingText.delete(match[0])
                block.text = block.text.slice(match[1].length)
              }
            }
            if (block?.type !== 'tool_use') continue
            const input = block.input
            const tool = {
              name: block.name,
              target: input?.file_path ?? input?.path ?? input?.description ?? commandLabel(input?.command),
            }
            const native = typeof block.id === 'string' && !block.name?.startsWith('mcp__godbot__')
            if (typeof block.id === 'string') calls.set(block.id, { ...tool, native, filePath: input?.file_path })
            // Godbot's own MCP bridge has exact DSH tool call/result receipts.
            toolStarts.push(native ? {
              type: 'tool', id: block.id, name: block.name, status: 'running', input,
              cwd: options.cwd, ...(parentId ? { parentId } : {}),
              ...(typeof tool.target === 'string' ? { text: tool.target } : {}),
            } : undefined)
            block.name = toolActivity(tool.name, tool.target, 'started').text.slice('▸ '.length)
          }
          try { return receive(JSON.stringify(event)) } finally { toolStarts = undefined }
        }
      } else if (event?.type === 'user' && Array.isArray(event.message?.content)) {
        const results = event.message.content.filter(block => block?.type === 'tool_result')
        for (const block of results) {
          const tool = calls.get(block.tool_use_id)
          if (!tool) continue
          calls.delete(block.tool_use_id)
          const details = results.length === 1 ? event.tool_use_result : undefined
          const { status, output, exitCode } = claudeToolResult(block, details)
          const filePath = details?.filePath ?? tool.filePath
          const changes = Array.isArray(details?.structuredPatch) ? [{ path: filePath, hunks: details.structuredPatch }] : undefined
          session.emit({ ...toolActivity(tool.name, tool.target, status), ...(tool.native ? { trace: {
            type: 'tool', id: block.tool_use_id, name: tool.name, status, output,
            changes,
            ...(exitCode !== undefined ? { exitCode } : {}),
            ...(Number.isFinite(details?.durationMs) && details.durationMs >= 0 ? { durationMs: details.durationMs } : {}),
          } } : {}) })
        }
      } else if (event?.type === 'result') {
        calls.clear()
        currentMessages.clear()
        streamed.clear()
      }
      receive(line)
    }
  }

  write(message) {
    const input = this.session.child?.stdin
    if (!input?.writable || this.session.dead) return Promise.reject(new Error('Claude input is closed'))
    return new Promise((resolve, reject) => {
      input.write(JSON.stringify(message) + '\n', (error) => (error ? reject(error) : resolve()))
    })
  }
}

class WorkspaceClaudeEngine extends ClaudeEngine {
  controls = new WeakMap()
  env = { CLAUDE_CODE_CHILD_SESSION: undefined }

  constructor(route, spec, dependencies) {
    super(route, { ...spec, args: [...(spec.args ?? []), '--include-partial-messages'] }, dependencies)
  }

  async open(id, options) {
    const session = await super.open(id, options)
    if (!this.controls.has(session)) this.controls.set(session, new TeamClaudeControl(session, options))
    return session
  }

  async listModels({ cwd }) {
    const id = randomUUID()
    try {
      const session = await this.open(id, { cwd })
      const metadata = await describeClaude(this.controls.get(session))
      const reasoning = (levels) =>
        metadata.canConfigureEffort && levels?.length ? { efforts: levels } : undefined
      this.defaultReasoning = reasoning(metadata.efforts)
      if (this.defaultReasoning && metadata.currentEffort)
        this.defaultReasoning.defaultEffort = metadata.currentEffort
      if (!metadata.models.length) return super.listModels()
      return metadata.models.map((model) => ({
        id: model.id,
        name: model.name,
        reasoning: reasoning(model.efforts),
      }))
    } finally {
      this.forget(id)
    }
  }

  async prompt(session, blocks, { effort, signal } = {}) {
    const control = this.controls.get(session)
    // A model or permission change reopens Godbot's CLI process. Clear a
    // previous override only on the process to which we actually applied it.
    const choice = effort ?? null
    if (choice !== (control.lastChoice ?? null)) {
      await configureClaude(control, { effort: choice })
      control.lastChoice = choice
      session.emit({
        type: 'effort',
        effort: control.currentEffort,
        defaultEffort: control.nativeDefaults.get(control.model),
      })
    }
    signal?.throwIfAborted()
    return super.prompt(session, blocks)
  }

  steer(session, input) {
    return session.prompt(Array.isArray(input) ? input : [{ type: 'text', text: input }])
  }

  cancel(session) {
    if (!session.running || session.dead) return
    // Claude requires an ID even if the adapter has already stopped reading.
    session.write({ type: 'control_request', request_id: randomUUID(), request: { subtype: 'interrupt' } })
  }
}

export function createWorkspaceClaudeEngine(route, spec, dependencies) {
  return new WorkspaceClaudeEngine(route, spec, dependencies)
}
