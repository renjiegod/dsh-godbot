import assert from 'node:assert/strict'
import { PassThrough } from 'node:stream'
import test from 'node:test'
import { geminiModelQuota, nativeUsageAdapters } from '../../src/host/native-provider-quota.js'

test('only the Gemini chooser quota table contributes percentages, with a local reset across midnight', () => {
  const now = new Date(2026, 10, 20, 23, 48, 20)
  const lines = [' Select Model ', 'Other  ▬▬▬ 40%', ' Model usage ', ' Pro   ▬▬▬▬▬ 0% Resets: 12:20 AM (32m)',
    ' Flash ▬▬▬▬▬ 100%', ' Other ▬▬▬ 150%', ' 55% memory']
  const windows = geminiModelQuota(lines, now.getTime())
  assert.deepEqual(windows, [
    { id:'Pro', label:'Pro', usedPercent:0, remainingPercent:100, resetsAt:new Date(2026,10,21,0,20).toISOString() },
    { id:'Flash', label:'Flash', usedPercent:100, remainingPercent:0, resetsAt:null },
  ])
  assert.deepEqual(geminiModelQuota(lines.slice(1)),[])
})

test('Gemini quota opens the built-in model chooser and closes the PTY without selecting a model', async () => {
  const output = new PassThrough(), done = Promise.withResolvers(), keys = []
  const engine = nativeUsageAdapters({
    async spawnTerminal(spec) {
      assert.equal(spec.env.NO_BROWSER, 'true')
      assert.equal(spec.argv.includes('--prompt'), false)
      output.write('Type your message or @path/to/file')
      return { output, done:done.promise,
        async write(key) {
          keys.push(key)
          if (key === '/model') output.write('\x1b[2J\x1b[H/model  Manage model configuration')
          if (key === '\r') output.write('\x1b[2J\x1b[HSelect Model\r\nModel usage\r\nPro ▬▬▬ 29%')
        },
        async terminate() { output.end(); done.resolve({ exitCode:0 }) },
      }
    },
  }).gemini
  const conf = {gemini:{command:process.execPath}}
  const result = await engine.read({program:process.execPath, email:'test@example.invalid'},conf)
  assert.equal(result.windows[0].usedPercent,29)
  assert.deepEqual(keys,['/model','\r'])
})
