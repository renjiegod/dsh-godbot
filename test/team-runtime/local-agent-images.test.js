import assert from 'node:assert/strict'
import test from 'node:test'
import { LocalAgentAdapter } from '../../src/host/team-runtime/core/local-agents/adapter.js'
import { fakeAttachments } from './fake-ctx.js'

for (const canSteer of [true, false]) {
  const delivery = canSteer ? 'steer' : 'prompt'
  test(`a user reply to a bridged call forwards its image through ${delivery}`, async () => {
    const attachments = fakeAttachments()
    const data = Buffer.from('fixture image bytes')
    const mediaType = 'image/png'
    const attachment = await attachments.saveImage({ data, mediaType, width: 1, height: 1 })
    const reply = Promise.withResolvers()
    const sent = []
    const live = {
      route: 'local-codex-cli', spec: { kind: 'codex' }, cwd: '/fixture',
      handed: 'opening', cliSessionId: 'native-session', engineSession: {}, state: 'suspended',
      mcp: {}, events: [], queue: [], pending: new Map([['call', { name: 'ask_user', resolve: reply.resolve }]]),
      waiters: [], next: () => adapter.take(live),
    }
    function send(kind, blocks) {
      sent.push({ kind, blocks })
      live.events.push({ type: 'text', text: 'Read the reply' }, { type: 'done' })
      return 'turn'
    }
    live.engine = {
      canSteer: () => canSteer,
      steer: (_session, blocks) => send('steer', blocks),
      prompt: (_session, blocks) => send('prompt', blocks),
    }
    const adapter = new LocalAgentAdapter({ attachments, presetFor() {}, record() {}, saveRecord() {} })
    adapter.live.set('bot-session', live)

    const chunks = await Array.fromAsync(adapter.stream({
      sessionId: 'bot-session', provider: live.route, model: 'default',
      messages: [
        { id: 'opening', role: 'user', content: [{ type: 'text', text: 'Original prompt' }] },
        { id: 'reply', role: 'user', content: [{ type: 'text', text: 'Here it is' }, { type: 'image', attachment }] },
      ],
    }))

    assert.deepEqual(await reply.promise, { text: 'Here it is' })
    assert.equal(live.pending.size, 0)
    assert.deepEqual(chunks.at(-1).reason, { kind: 'stop' })
    assert.equal(sent.length, 1)
    assert.equal(sent[0].kind, delivery)
    const image = { type: 'image', mediaType, data: data.toString('base64') }
    if (canSteer) {
      assert.deepEqual(sent[0].blocks, [image])
    } else {
      assert.match(sent[0].blocks[0].text, /ask_user → Here it is/)
      assert.deepEqual(sent[0].blocks.slice(1), [image])
    }
  })
}
