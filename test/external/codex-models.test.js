import assert from 'node:assert/strict'
import test from 'node:test'
import { CodexEngine as NativeCodexEngine } from '../../src/drivers/external/codex.js'
import { CodexEngine as TeamCodexEngine } from '../../src/host/team-runtime/core/local-agents/codex.js'

const catalog = [
  { id: 'vision', inputModalities: ['text', 'image', 'audio'] },
  { id: 'text-only', inputModalities: ['text'] },
  { id: 'audio-only', inputModalities: ['audio'] },
  { id: 'old-server' },
  { id: 'empty', inputModalities: [] },
  { id: 'invalid', inputModalities: [null, 'unrecognized'] },
]

for (const [name, Engine, vision, audioOnly] of [
  ['native', NativeCodexEngine, ['text', 'image', 'audio'], ['audio']],
  ['team', TeamCodexEngine, ['text', 'image'], []],
]) {
  test(`${name} Codex catalog preserves explicit image support and leaves missing metadata unknown`, async () => {
    const engine = new Engine('test', {}, {})
    engine.peer = { request(method) {
      assert.equal(method, 'model/list')
      return { data: catalog }
    } }

    const models = await engine.listModels()
    assert.deepEqual(models.map(({ id, inputModalities }) => [id, inputModalities]), [
      ['vision', vision],
      ['text-only', ['text']],
      ['audio-only', audioOnly],
      ['old-server', undefined],
      ['empty', undefined],
      ['invalid', undefined],
    ])
  })
}
