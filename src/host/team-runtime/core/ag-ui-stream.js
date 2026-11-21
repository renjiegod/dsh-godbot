import { lookup } from 'node:dns/promises'
import { BlockList, isIP } from 'node:net'
import { Agent, fetch } from 'undici'

const NEVER = new BlockList()
const PRIVATE = new BlockList()
for (const [address, bits] of [['0.0.0.0', 8], ['169.254.0.0', 16], ['224.0.0.0', 4], ['240.0.0.0', 4]]) NEVER.addSubnet(address, bits)
for (const [address, bits] of [['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['172.16.0.0', 12], ['192.168.0.0', 16]]) PRIVATE.addSubnet(address, bits)
for (const [address, bits] of [['::', 96], ['64:ff9b::', 96], ['64:ff9b:1::', 48], ['fe80::', 10], ['ff00::', 8]]) NEVER.addSubnet(address, bits, 'ipv6')
for (const [address, bits] of [['::1', 128], ['fc00::', 7]]) PRIVATE.addSubnet(address, bits, 'ipv6')
const METADATA = /(^|\.)metadata(\.google\.internal)?\.?$/i
const MAX_FRAME = 128 * 1024
const toolName = value => typeof value === 'string' && /^[\w.:/-]{1,96}$/.test(value) ? value : 'tool'

export function assessRemoteUrl(value, privateOrigins = []) {
  if (typeof value !== 'string' || value.length > 1000 || !URL.canParse(value)) throw new Error('请输入 AG-UI 执行地址')
  const url = new URL(value)
  const allowed = privateOrigins.includes(url.origin)
  if ((!['https:', 'http:'].includes(url.protocol)) || url.protocol === 'http:' && !allowed ||
      url.username || url.password || url.search || url.hash || METADATA.test(url.hostname)) {
    throw new Error('远程 Agent 须使用 HTTPS 地址。内网 HTTP 须由管理员配置允许的来源，凭据请单独填写。')
  }
  const host = url.hostname.replace(/^\[|\]$/g, '')
  if (isIP(host) && !remoteAddressAllowed(host, allowed)) throw new Error('远程 Agent 地址不在允许的网络范围')
  return { url, allowed }
}

export function remoteAddressAllowed(address, privateAllowed = false) {
  if (!isIP(address)) return false
  const family = isIP(address) === 6 ? 'ipv6' : 'ipv4'
  return !NEVER.check(address, family) && (privateAllowed || !PRIVATE.check(address, family))
}

export function remoteDispatcher(allowPrivate) {
  return new Agent({ connect: { lookup: (address, options, callback) => {
    lookup(address, { all: true, family: options.family ?? 0 }).then(rows => {
      if (!rows.length || rows.some(row => !remoteAddressAllowed(row.address, allowPrivate))) throw new Error('远程 Agent 解析到禁止访问的网络')
      if (options.all) callback(null, rows)
      else callback(null, rows[0].address, rows[0].family)
    }).catch(callback)
  } } })
}

export async function* readAgentEvents(body) {
  const decoder = new TextDecoder()
  let buffer = ''
  let data = []
  let id
  let size = 0
  const line = raw => {
    const value = raw.endsWith('\r') ? raw.slice(0, -1) : raw
    if (value === '') {
      const event = data.length > 0 ? { id, data: data.join('\n') } : undefined
      id = undefined
      data = []
      size = 0
      return event
    }
    if (value.startsWith('data:')) {
      const part = value.slice(5).replace(/^ /, '')
      size += part.length
      if (size > MAX_FRAME) throw new Error('远程 Agent 事件过大')
      data.push(part)
    } else if (value.startsWith('id:')) id = value.slice(3).trim().slice(0, 240)
  }
  for await (const bytes of body) {
    buffer += decoder.decode(bytes, { stream: true })
    let newline
    while ((newline = buffer.indexOf('\n')) !== -1) {
      if (newline > MAX_FRAME) throw new Error('远程 Agent 事件行过大')
      const event = line(buffer.slice(0, newline))
      buffer = buffer.slice(newline + 1)
      if (event) yield event
    }
    if (buffer.length > MAX_FRAME) throw new Error('远程 Agent 事件行过大')
  }
  if (buffer || data.length) throw new Error('远程 Agent 流在事件结束前断开')
}

export async function* runRemoteAgent({ endpoint, token, input, signal, allowPrivate = false, request = fetch }) {
  const dispatcher = remoteDispatcher(allowPrivate)
  try {
    const response = await request(endpoint, {
      method: 'POST',
      headers: { accept: 'text/event-stream', 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}) },
      redirect: 'error',
      body: JSON.stringify(input),
      signal,
      dispatcher,
    })
    if (!response.ok || !/^text\/event-stream\b/i.test(response.headers.get('content-type') ?? '') || !response.body) {
      await response.body?.cancel().catch(() => {})
      throw new Error('远程 Agent 须返回 AG-UI 事件流，HTTP ' + response.status)
    }
    let started = false
    let count = 0
    const seen = new Set()
    const tools = new Map()
    for await (const frame of readAgentEvents(response.body)) {
      signal.throwIfAborted()
      if (++count > 16_384) throw new Error('远程 Agent 事件数超过限制')
      if (frame.id) {
        if (seen.has(frame.id)) continue
        seen.add(frame.id)
      }
      const event = JSON.parse(frame.data)
      if (!event || typeof event.type !== 'string') throw new Error('远程 Agent 事件格式无效')
      if (event.type === 'RUN_ERROR') throw new Error(typeof event.message === 'string' ? event.message.slice(0, 400) : '远程 Agent 执行失败')
      if (event.type === 'RUN_STARTED') {
        if (started || event.threadId !== input.threadId || event.runId !== input.runId) throw new Error('远程 Agent 的运行标识不匹配')
        started = true
        yield { kind: 'running' }
        continue
      }
      if (!started) throw new Error('远程 Agent 未确认运行标识')
      if (event.type === 'RUN_FINISHED') {
        if (event.threadId !== input.threadId || event.runId !== input.runId) throw new Error('远程 Agent 的结束标识不匹配')
        if (event.outcome?.type === 'interrupt') throw new Error('远程 Agent 停在远端的人工交互，请在其服务继续处理')
        yield { kind: 'finished' }
        return
      }
      if ((event.type === 'TEXT_MESSAGE_CONTENT' || event.type === 'TEXT_MESSAGE_CHUNK') && typeof event.delta === 'string') {
        yield { kind: 'text', id: String(event.messageId ?? 'default').slice(0, 240), text: event.delta }
      }
      if ((event.type === 'TOOL_CALL_START' || event.type === 'TOOL_CALL_CHUNK') && typeof event.toolCallId === 'string' && typeof event.toolCallName === 'string') {
        const name = toolName(event.toolCallName)
        if (!tools.has(event.toolCallId)) {
          tools.set(event.toolCallId, name)
          yield { kind: 'tool-start', tool: name }
        }
      }
      if ((event.type === 'TOOL_CALL_END' || event.type === 'TOOL_CALL_RESULT') && tools.has(event.toolCallId)) {
        yield { kind: event.type === 'TOOL_CALL_RESULT' ? 'tool-result' : 'tool-end', tool: tools.get(event.toolCallId) }
        if (event.type === 'TOOL_CALL_RESULT') tools.delete(event.toolCallId)
      }
      if (event.type === 'STEP_STARTED' || event.type === 'STEP_FINISHED') {
        yield { kind: event.type === 'STEP_STARTED' ? 'step-start' : 'step-end', tool: toolName(event.stepName) }
      }
    }
    throw new Error('远程 Agent 流断开，远端执行结果待核对')
  } finally {
    await dispatcher.destroy().catch(() => {})
  }
}
