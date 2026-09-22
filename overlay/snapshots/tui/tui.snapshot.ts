/** Recorded-session replay through the shipped deepseek-tui profile. */

import { readFileSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect } from 'vitest'
import {
  defineTuiSnapshotSuite,
  parseSnapshotManifest,
  type Scenario,
  type SnapshotSuiteOptions,
  type TuiSnapshotLaunch,
} from '@deepseek-ai/dsh-session-snapshot'
import { ScreenAtlas } from '../../packages/tui/tui-render/src/screen-atlas.ts'
import { consumeCompletedTuiFrames } from '../../apps/cli/tests/support/tui-completed-frames.ts'
import { runTuiPtyScenario, type TuiPtyAction } from '../../apps/cli/tests/support/tui-pty-snapshot.ts'

const repoRoot = fileURLToPath(new URL('../../', import.meta.url))
const snapshotsDir = fileURLToPath(new URL('./', import.meta.url))
const scenarioName = 'plugins-hud'
const scenarioDir = join(snapshotsDir, scenarioName)
const manifest = parseSnapshotManifest(
  readFileSync(join(scenarioDir, 'snapshot.yml'), 'utf8'),
  join(scenarioDir, 'snapshot.yml'),
)
if (manifest.recording === undefined || manifest.header === undefined) {
  throw new Error(`${scenarioName}: TUI snapshot manifest lacks recording or header metadata`)
}

function snapshotMode(value: string | undefined): SnapshotSuiteOptions['mode'] {
  switch (value) {
    case undefined:
    case '':
    case 'replay': return 'replay'
    case 'record': return 'record'
    case 'refresh': return 'refresh'
    default: throw new Error(`unknown DSH_SNAPSHOT mode: ${value}`)
  }
}

const scenario: Scenario = {
  name: scenarioName,
  hasModelTurn: true,
  recorded: manifest.recording === 'live',
  pinsHeader: manifest.header.pin === true,
  headerClass: manifest.header.class,
  prepareWorkspace: async cwd => {
    const home = join(cwd, '.dsh')
    await mkdir(home, { recursive: true })
    await writeFile(join(home, '.credentials.yaml'),
      'version: 1\nrefs:\n  DEEPSEEK_API_KEY: tui-snapshot-placeholder\n', { mode: 0o600 })
  },
  ...(manifest.header.changes === undefined ? {} : { expectedHeaderChanges: manifest.header.changes }),
  ...(manifest.header.promptChanges === undefined ? {} : { expectedPromptChanges: manifest.header.promptChanges }),
  ...manifest.permission === undefined && manifest.environment === undefined
    ? {}
    : {
        env: {
          ...manifest.environment,
          ...(manifest.permission === undefined ? {} : { DSH_PERMISSION_MODE: manifest.permission }),
        },
      },
}

const READY = /agent · deepseek-v4-flash[\s\S]{0,30000}>/u

function environmentFor(launch: TuiSnapshotLaunch): { name: string; value: string }[] {
  const environment = Object.entries(launch.env).flatMap(([name, value]) =>
    value === undefined ? [] : [{ name, value }])
  environment.push(
    { name: 'TERM', value: 'xterm-256color' },
    { name: 'NO_COLOR', value: '1' },
    { name: 'LC_ALL', value: 'C' },
    { name: 'LANG', value: 'C' },
  )
  return environment
}

async function drive(launch: TuiSnapshotLaunch, selected: Scenario) {
  expect(selected.name).toBe(scenarioName)
  const atlas = new ScreenAtlas(120, 40)
  let fed = 0
  const grid = (): string => atlas.extract({ col: 1, row: 1 }, { col: atlas.width, row: atlas.height })
  const evidence: string[] = []
  const waitForGrid = (predicate: (text: string) => boolean): TuiPtyAction => ({
    kind: 'release',
    after: READY,
    release: async () => {
      await expect.poll(grid, { timeout: 15_000, message: predicate.toString() }).toSatisfy(predicate)
    },
  })
  const check = (run: () => void): TuiPtyAction => ({ kind: 'release', after: READY, release: run })
  const send = (data: string): TuiPtyAction => ({ kind: 'send', after: READY, data })
  const openPlugins: TuiPtyAction[] = [
    send('/plugins'),
    waitForGrid(text => text.includes('/plugins')),
    send('\r'),
    waitForGrid(text => text.includes('安装供给') && text.includes('@deepseek-ai/dsh-base')),
  ]
  const closePlugins: TuiPtyAction[] = [
    send('\x1b'),
    waitForGrid(text => text.includes('› 输入消息') && !text.includes('Space 启停')),
  ]

  const result = await runTuiPtyScenario({
    argv: launch.argv,
    cwd: launch.cwd,
    environment: environmentFor(launch),
    rows: 40,
    cols: 120,
    graceMs: 2_000,
    timeoutMs: 60_000,
    maxOutputBytes: 8 * 1024 * 1024,
    diagnosticTailBytes: 12 * 1024,
    onOutput: raw => { fed = consumeCompletedTuiFrames(raw, fed, chunk => { atlas.feed(chunk) }) },
    actions: [
      send(launch.task),
      send('\r'),
      waitForGrid(text => text.includes('DONE') && text.includes('任务计划')),
      check(() => {
        expect(grid()).toContain('read the code')
        expect(grid()).toContain('watch the background build')
        expect(grid()).toContain('write the fix')
        evidence.push('Session replay: the terminal profile records the todo plan.')
      }),
      ...openPlugins,
      check(() => { evidence.push('Plugins: `/plugins` opens the live inventory.') }),
      ...closePlugins,
      check(() => {
        expect(grid()).toContain('任务计划')
        expect(grid()).toContain('read the code')
        evidence.push('Close: the composer and current Todo HUD return.')
      }),
      { kind: 'signal', after: READY, signal: 'SIGTERM' },
    ],
  })
  return { evidence: `${evidence.join('\n')}\n`, outcome: result.outcome }
}

defineTuiSnapshotSuite({
  agent: {
    binScript: join(repoRoot, 'apps/cli/src/bin.ts'),
    configPath: join(snapshotsDir, 'cordis.yml'),
    profile: 'deepseek-tui',
    tsconfigPath: join(repoRoot, 'tsconfig.tsx.json'),
  },
  snapshotsDir,
  scenarios: [scenario],
  mode: snapshotMode(process.env.DSH_SNAPSHOT),
  drive,
})
