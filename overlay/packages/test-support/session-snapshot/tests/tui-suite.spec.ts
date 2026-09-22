/** Shared comparisons and fixture guards exercised through the TUI adapter in every snapshot mode. */

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe } from 'vitest'
import { SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import { defineTuiSnapshotSuite } from '../src/tui.ts'
import { redactSessionSnapshotIds } from '../src/identity.ts'
import { normalizeSessionSnapshot } from '../src/normalize.ts'
import { sessionFixtureName } from '../src/session-files.ts'
import { formatSystemPromptSnapshot, formatToolSchemasSnapshot } from '../src/suite.ts'

const roots: string[] = []
const prompt = 'TUI suite system prompt'
const task = 'Read the terminal state.'
const schemas = [{ name: 'echo', description: 'Echo input.', parameters: { type: 'object' } }]
const evidence = 'The submitted task and assistant response are visible.\n'

function rawLog(cwd: string): string {
  const events = [
    { type: 'turn/start', data: { turn: 1 } },
    { type: 'step/start', data: { turn: 1, step: 1 } },
    { type: 'system/message', surfaceOp: 'append', data: { turn: 1, step: 1, message: {
      id: 'system-message', role: 'system', content: [{ type: 'text', text: prompt }],
      source: { kind: 'plugin', plugin: '@deepseek-ai/dsh-system-prompt' },
    } } },
    { type: 'user/message', surfaceOp: 'append', data: {
      id: 'user-message', role: 'user', content: [{ type: 'text', text: task }], source: { kind: 'user' },
    } },
    { type: 'request/header', data: { header: { config: { provider: 'fixture', model: 'fixture' }, tools: schemas }, reason: 'initial' } },
    { type: 'step/end', data: { turn: 1, step: 1 } },
    { type: 'turn/end', data: { turn: 1, reason: { kind: 'idle' } } },
  ]
  return [
    { type: 'session', version: SESSION_FORMAT_VERSION, id: 'tui-session', cwd, createdAt: 10, isSeeded: false, delegationDepth: 0 },
    ...events.map((event, seq) => ({ ...event, seq, time: 10 + seq })),
  ].map(row => JSON.stringify(row)).join('\n') + '\n'
}

afterAll(async () => {
  await Promise.all(roots.map(root => rm(root, { recursive: true, force: true })))
})

for (const mode of ['replay', 'record', 'refresh'] as const) {
  const root = mkdtempSync(join(tmpdir(), `tui-suite-${mode}-`))
  roots.push(root)
  const snapshotsDir = join(root, 'snapshots')
  const directory = join(snapshotsDir, 'terminal-turn')
  mkdirSync(directory, { recursive: true })
  const configPath = join(root, 'cordis.yml')
  writeFileSync(configPath, '[]\n')
  writeFileSync(join(root, 'cordis.snapshot.yml'), '[]\n')
  writeFileSync(join(directory, 'snapshot.yml'), 'version: 1\nprofile: deepseek-tui\n')
  writeFileSync(join(directory, sessionFixtureName(0, SESSION_FORMAT_VERSION)), redactSessionSnapshotIds([normalizeSessionSnapshot(rawLog('/fixture/cwd'), {
    sessionIds: ['tui-session'], cwd: '/fixture/cwd',
  })])[0] as string)
  writeFileSync(join(directory, 'terminal.expected.txt'), mode === 'refresh' ? 'obsolete evidence\n' : evidence)
  writeFileSync(join(directory, 'system-prompt.expected.md'), formatSystemPromptSnapshot(prompt))
  writeFileSync(join(directory, 'tool-schemas.expected.json'), formatToolSchemasSnapshot(schemas))

  describe(`TUI suite ${mode}`, () => {
    defineTuiSnapshotSuite({
      agent: {
        binScript: fileURLToPath(new URL('../../../../apps/cli/src/bin.ts', import.meta.url)),
        configPath,
        profile: 'deepseek-tui',
        tsconfigPath: fileURLToPath(new URL('../../../../tsconfig.tsx.json', import.meta.url)),
      },
      snapshotsDir,
      scenarios: [{ name: 'terminal-turn', recorded: true, hasModelTurn: true, pinsHeader: true }],
      mode,
      drive: async (launch) => {
        const sessionDirectory = join(launch.sessionsRoot, 'project', 'tui-session')
        await mkdir(sessionDirectory, { recursive: true })
        await writeFile(join(sessionDirectory, sessionFixtureName(0, SESSION_FORMAT_VERSION)), rawLog(launch.cwd))
        return { evidence, outcome: { exitCode: 0, signal: null } }
      },
    })
  })
}
