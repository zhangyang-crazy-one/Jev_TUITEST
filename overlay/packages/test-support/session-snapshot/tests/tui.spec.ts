/** TUI adapter input, lifecycle, isolation, and launch evidence independent of terminal rendering. */

import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import { parseSnapshotManifest } from '../src/manifest.ts'
import { sessionFixtureName } from '../src/session-files.ts'
import { runTuiSnapshotScenario, tuiTaskFromSession, type TuiSnapshotLaunch } from '../src/tui.ts'
import type { RunOptions } from '../src/harness.ts'

const roots: string[] = []
const scenario = { name: 'terminal-turn', hasModelTurn: true, recorded: true, pinsHeader: true }
const user = (text: string, id = 'message-1') => ({ id, role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } })
const fixture = (events: unknown[]) => [
  { type: 'session', version: SESSION_FORMAT_VERSION, id: 'session-1', createdAt: 0, cwd: '{{cwd}}', isSeeded: false, delegationDepth: 0 },
  ...events,
].map(value => JSON.stringify(value)).join('\n') + '\n'
const userEvent = (text: string) => ({ type: 'user/message', surfaceOp: 'append', data: user(text) })

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function options(): Promise<RunOptions> {
  const root = await mkdtemp(join(tmpdir(), 'tui-adapter-spec-'))
  roots.push(root)
  const configPath = join(root, 'cordis.yml')
  const fixtureFile = join(root, sessionFixtureName(0, SESSION_FORMAT_VERSION))
  await writeFile(configPath, '[]\n')
  await writeFile(join(root, 'cordis.snapshot.yml'), '[]\n')
  await writeFile(fixtureFile, fixture([userEvent('canonical task')]))
  return {
    agent: {
      binScript: fileURLToPath(new URL('../../../../apps/cli/src/bin.ts', import.meta.url)),
      configPath,
      profile: 'deepseek-tui',
      tsconfigPath: fileURLToPath(new URL('../../../../tsconfig.tsx.json', import.meta.url)),
    },
    fixtureFile,
    mode: 'replay',
  }
}

async function persist(launch: TuiSnapshotLaunch): Promise<void> {
  const directory = join(launch.sessionsRoot, 'project', 'session-1')
  await mkdir(directory, { recursive: true })
  await writeFile(join(directory, sessionFixtureName(0, SESSION_FORMAT_VERSION)), fixture([userEvent(launch.task)]))
}

describe('TUI recorded-session adapter', () => {
  it('accepts the shipped profile in the closed manifest', () => {
    expect(parseSnapshotManifest('version: 1\nprofile: deepseek-tui\n').profile).toBe('deepseek-tui')
  })

  it('derives the original inbox submission and ignores rewritten and plugin-authored input', () => {
    const log = fixture([
      { type: 'agent/inbox/spliced', data: { target: 'next-turn', start: 0, inserted: [user('original')] } },
      userEvent('rewritten'),
      { type: 'user/message', surfaceOp: 'append', data: { ...user('runtime', 'message-2'), source: { kind: 'plugin', plugin: 'runtime' } } },
    ])
    expect(tuiTaskFromSession(log)).toBe('original')
    expect(tuiTaskFromSession(fixture([userEvent('admitted')]))).toBe('admitted')
  })

  it('rejects missing, ambiguous, and non-text user submissions', () => {
    expect(() => tuiTaskFromSession(fixture([]))).toThrow('found 0')
    expect(() => tuiTaskFromSession(fixture([userEvent('one'), { ...userEvent('two'), data: user('two', 'message-2') }]))).toThrow('found 2')
    expect(() => tuiTaskFromSession(fixture([userEvent('')]))).toThrow('non-empty text block')
    expect(() => tuiTaskFromSession(fixture([{ ...userEvent('one'), data: { ...user('one'), content: [{ type: 'text', text: 'one' }, { type: 'text', text: 'two' }] } }]))).toThrow('one non-empty text block')
  })

  it('launches the shipped profile with selected replay input and harvests only after controller completion', async () => {
    const opts = await options()
    let launchSeen: TuiSnapshotLaunch | undefined
    const result = await runTuiSnapshotScenario(opts, scenario, async (launch) => {
      launchSeen = launch
      expect(launch.task).toBe('canonical task')
      expect(launch.argv).toContain('--profile')
      expect(launch.argv).toContain('deepseek-tui')
      expect(launch.env.DSH_SNAPSHOT_FILE).toBe(opts.fixtureFile)
      expect(launch.env.DSH_HOME).toBe(join(launch.cwd, '.dsh'))
      expect(launch.env.DSH_SNAPSHOT_SESSIONS_ROOT).toBe(launch.sessionsRoot)
      expect(existsSync(launch.sessionsRoot)).toBe(true)
      await persist(launch)
      return { evidence: 'observed terminal state\n', outcome: { exitCode: 0, signal: null } }
    })
    expect(result.rawStdout).toBe('observed terminal state\n')
    expect(result.sessionLogs).toHaveLength(1)
    expect(result.sessionId).toBe('session-1')
    expect(result.initialWorkspace).toEqual([])
    expect(result.finalWorkspace).toEqual([])
    expect(existsSync(launchSeen!.cwd)).toBe(false)
    expect(existsSync(launchSeen!.sessionsRoot)).toBe(false)
    expect(await readFile(opts.fixtureFile, 'utf8')).toBe(fixture([userEvent('canonical task')]))
  })

  it('isolates concurrent launches and preserves caller-owned workspace parents', async () => {
    const opts = await options()
    const parent = dirname(opts.fixtureFile)
    const cwds: string[] = []
    const results = await Promise.all([0, 1].map(async () => runTuiSnapshotScenario({
      ...opts, mode: 'record', workspaceParent: parent,
      prepareWorkspace: cwd => writeFile(join(cwd, 'seed'), 'initial'),
    }, scenario, async (launch) => {
      cwds.push(launch.cwd)
      expect(launch.env.DSH_SNAPSHOT).toBe('record')
      await persist(launch)
      await writeFile(join(launch.cwd, 'seed'), 'final')
      return { evidence: 'done\n', outcome: { exitCode: 0, signal: null } }
    })))
    expect(new Set(cwds).size).toBe(2)
    expect(cwds.every(cwd => !existsSync(cwd))).toBe(true)
    expect(existsSync(parent)).toBe(true)
    for (const result of results) {
      expect(result.initialWorkspace).toEqual([{ path: 'seed', kind: 'text', content: 'initial' }])
      expect(result.finalWorkspace).toEqual([{ path: 'seed', kind: 'text', content: 'final' }])
    }
  })

  it('rejects signal exits and missing logs and cleans up after controller failure', async () => {
    const opts = await options()
    const launches: TuiSnapshotLaunch[] = []
    await expect(runTuiSnapshotScenario(opts, scenario, async (launch) => {
      launches.push(launch)
      await persist(launch)
      return { evidence: '', outcome: { exitCode: 0, signal: 'SIGTERM' } }
    })).rejects.toThrow('did not exit gracefully')
    await expect(runTuiSnapshotScenario(opts, scenario, async (launch) => {
      launches.push(launch)
      return { evidence: '', outcome: { exitCode: 0, signal: null } }
    })).rejects.toThrow('one fresh parent Session')
    const failure = new Error('controller failed')
    await expect(runTuiSnapshotScenario(opts, scenario, async (launch) => {
      launches.push(launch)
      throw failure
    })).rejects.toBe(failure)
    for (const launch of launches) {
      expect(existsSync(launch.cwd)).toBe(false)
      expect(existsSync(launch.sessionsRoot)).toBe(false)
    }
  })
})
