// Opt-in: makes two paid native-model turns using the locally signed-in agy.
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openExternal } from '../../src/drivers/external/index.js'

const source = 'godbot-source.txt',
  result = 'godbot-result.txt'
const jobs = await Promise.all(
  ['a', 'b'].map(async (memberId) => {
    const cwd = await mkdtemp(join(tmpdir(), 'godbot-agy-concurrent-'))
    const marker = randomUUID()
    await writeFile(join(cwd, source), marker)
    const ended = Promise.withResolvers()
    const logs = []
    let handle
    try {
      handle = await openExternal({
        kind: 'antigravity',
        memberId,
        cwd,
        onEvent(event) {
          if (event.type === 'permission') {
            const details = [event.text, event.details].filter(Boolean).join('\n')
            const command =
              details.match(/(?:CommandLine|command): ([^\n]+)/i)?.[1] ?? details.match(/`([^`]+)`/)?.[1]
            const allow = [
              '/bin/cp godbot-source.txt godbot-result.txt',
              'cp godbot-source.txt godbot-result.txt',
            ].includes(command?.trim())
            logs.push({ permission: allow ? 'allow' : 'deny' })
            void handle
              .respond({ requestId: event.requestId, decision: allow ? 'allow' : 'deny' })
              .catch(() => {})
          }
          if (event.type === 'tool') logs.push({ tool: event.name, status: event.status })
          if (event.type === 'done' || event.type === 'error')
            ended.resolve({ type: event.type, status: event.status })
        },
      })
      return { memberId, cwd, marker, handle, ended, logs }
    } catch (error) {
      await rm(cwd, { recursive: true, force: true })
      throw error
    }
  }),
)
let timer
try {
  assert.notEqual(jobs[0].handle.nativeId, jobs[1].handle.nativeId)
  await Promise.all(
    jobs.map(({ memberId, handle }) =>
      handle.start({
        turnId: memberId,
        text: 'Run exactly the shell command /bin/cp godbot-source.txt godbot-result.txt in the current session workspace. Keep the file arguments relative. Do not use other commands or tools. Reply DONE once finished.',
      }),
    ),
  )
  const terminal = await Promise.race([
    Promise.all(jobs.map((j) => j.ended.promise)),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('native turn timeout')), 90000)
    }),
  ])
  const checks = await Promise.all(
    jobs.map(async ({ cwd, marker, logs }) => ({
      matchesOwnMarker: (await readFile(join(cwd, result), 'utf8').catch(() => '')) === marker,
      logs,
    })),
  )
  console.log(JSON.stringify({ terminal, separateSessionIds: true, checks }, null, 2))
  assert.ok(checks.every((item) => item.matchesOwnMarker))
} finally {
  clearTimeout(timer)
  await Promise.all(
    jobs.map(async ({ handle, cwd }) => {
      await handle.close()
      await rm(cwd, { recursive: true, force: true })
    }),
  )
}
