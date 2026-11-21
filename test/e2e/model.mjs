import { createServer } from 'node:http'
import { randomUUID } from 'node:crypto'

/** An isolated Messages endpoint. Scenarios can substitute a callback returning text or tool blocks. */
export async function startModel() {
  const model = { calls: [], reply: () => 'Fixture model acknowledged the request.' }
  const server = createServer(async (req, res) => {
    try {
      if (req.method === 'GET' && req.url?.split('?')[0].endsWith('/models')) {
        res.writeHead(200, { 'content-type': 'application/json' })
        return res.end(JSON.stringify({ data: (model.models ?? ['deepseek-flash']).map(id => ({ id, type:'model' })) }))
      }
      if (req.method !== 'POST' || !req.url?.split('?')[0].endsWith('/messages')) {
        res.writeHead(404)
        return res.end()
      }
      const parts = []
      for await (const chunk of req) parts.push(chunk)
      const body = JSON.parse(Buffer.concat(parts))
      const call = { id: randomUUID(), sessionId: req.headers['x-deepseek-harness-session-id'], body }
      model.calls.push(call)
      const output = await model.reply(body, call)
      if (output?.failure) {
        const { status, message, retryAfter } = output.failure
        res.writeHead(status, { 'content-type':'application/json', ...(retryAfter ? { 'retry-after': String(retryAfter) } : {}) })
        return res.end(JSON.stringify({type:'error',error:{type:'api_error',message}}))
      }
      const blocks = typeof output === 'string' ? [{ type: 'text', text: output }] : output
      const usage = { input_tokens: Math.ceil(JSON.stringify(body.messages).length / 4), output_tokens: Math.ceil(JSON.stringify(blocks).length / 4) }
      const message = { id: call.id, type: 'message', model: body.model, role: 'assistant' }
      const stop_reason = blocks.some(block => block.type === 'tool_use') ? 'tool_use' : 'end_turn'
      if (!body.stream) {
        res.writeHead(200, { 'content-type': 'application/json' })
        return res.end(JSON.stringify({ ...message, content: blocks, usage, stop_reason, stop_sequence: null }))
      }
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
      const send = event => res.write('event: ' + event.type + '\ndata: ' + JSON.stringify(event) + '\n\n')
      send({ type: 'message_start', message: { ...message, content: [], usage: { ...usage, output_tokens: 0 } } })
      for (const [index, block] of blocks.entries()) {
        if (block.type === 'text') {
          send({ type: 'content_block_start', index, content_block: { type: 'text', text: '' } })
          send({ type: 'content_block_delta', index, delta: { type: 'text_delta', text: block.text } })
        } else if (block.type === 'tool_use') {
          send({ type: 'content_block_start', index, content_block: { type: 'tool_use', id: block.id ?? randomUUID(), name: block.name, input: {} } })
          send({ type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(block.input) } })
        } else {
          throw new Error('Unsupported fixture block ' + block.type)
        }
        send({ type: 'content_block_stop', index })
      }
      send({ type: 'message_delta', delta: { stop_reason, stop_sequence: null }, usage: { output_tokens: usage.output_tokens } })
      send({ type: 'message_stop' })
      res.end()
    } catch (error) {
      model.error = error
      if (!res.headersSent) res.writeHead(500)
      res.end()
    }
  })
  await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve))
  model.url = 'http://127.0.0.1:' + server.address().port + '/v1'
  model.close = () => new Promise(resolve => {
    server.close(resolve)
    server.closeAllConnections()
  })
  return model
}
