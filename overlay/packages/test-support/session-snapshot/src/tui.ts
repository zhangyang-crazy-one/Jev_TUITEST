/** Recorded-session adapter for fixed PTY scripts driving the shipped TUI profile. */

import { cp, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { parseSessionLog } from '@deepseek-ai/dsh-llm-replay'
import { resolveExampleLaunch } from '@deepseek-ai/dsh-loader-smoke'
import { harvestSessionLogs, snapshotSpillRoot, type RunOptions, type RunResult } from './harness.ts'
import { profileArgs } from './launcher.ts'
import { captureWorkspaceSnapshot } from './workspace.ts'
import { defineSessionSnapshotSuite, type Scenario, type SnapshotSuiteOptions } from './suite.ts'

/** Isolated launch and log-derived task supplied to a fixed PTY controller. */
export interface TuiSnapshotLaunch {
  /** Complete executable and argument vector for the shipped profile. */
  readonly argv: readonly string[]
  /** Process and session workspace directory. */
  readonly cwd: string
  /** Environment additions; undefined entries remove inherited variables. */
  readonly env: NodeJS.ProcessEnv
  /** User task reconstructed from the selected canonical Session. */
  readonly task: string
  /** Fresh raw JSONL root available for durable-state waits. */
  readonly sessionsRoot: string
}

/** Evidence returned only after graceful shutdown and PTY cleanup have completed. */
export interface TuiSnapshotEvidence {
  /** Deterministic terminal observations asserted by the controller. */
  readonly evidence: string
  /** Process exit facts; a signal or nonzero exit rejects the recording. */
  readonly outcome: { readonly exitCode: number | null; readonly signal: NodeJS.Signals | null }
}

/**
 * Fixed scenario controller; owns the PTY and awaits its exit on success and failure.
 * @param launch - Isolated dsh invocation and canonical user task.
 * @param scenario - Scenario metadata selecting fixed interactions.
 * @returns Asserted terminal evidence and settled process exit facts.
 */
export type TuiSnapshotDriver = (launch: TuiSnapshotLaunch, scenario: Scenario) => Promise<TuiSnapshotEvidence>

/** TUI suite configuration sharing the Session runner's scenario and pin declarations. */
export interface TuiSnapshotSuiteOptions extends SnapshotSuiteOptions {
  /** Fixed PTY interactions; model output never supplies executable control instructions. */
  drive: TuiSnapshotDriver
}

/**
 * Extract the single plain-text user submission from a canonical Session.
 * Inbox entries retain the original text before pre-step rewriting; older logs
 * without inbox events use their admitted user messages. Ambiguous input rejects.
 * @param log - Selected canonical Session JSONL, including its format header.
 * @returns The one user task to submit through the terminal.
 */
export function tuiTaskFromSession(log: string): string {
  const events: readonly { type: string; data: unknown }[] = parseSessionLog(log)
  const userMessage = (value: unknown): Record<string, unknown>[] => {
    if (value === null || typeof value !== 'object') return []
    const message = value as Record<string, unknown>
    const source = message.source as { kind?: unknown } | undefined
    return source?.kind === 'user' ? [message] : []
  }
  const inbox = events.flatMap((event) => {
    if (event.type !== 'agent/inbox/spliced') return []
    const data = event.data as { inserted: unknown[] }
    return data.inserted.flatMap(userMessage)
  })
  const messages = inbox.length > 0 ? inbox : events.flatMap(event => event.type === 'user/message'
    ? userMessage(event.data) : [])
  const message = messages[0]
  if (messages.length !== 1 || message === undefined) throw new Error(`tui-snapshot: expected one user submission, found ${messages.length}`)
  const content = message.content as { type: string; text?: string }[]
  if (content.length !== 1 || content[0]?.type !== 'text' || !content[0].text?.trim()) {
    throw new Error('tui-snapshot: user submission must contain one non-empty text block')
  }
  return content[0].text
}

const WORKSPACE_OPTIONS = { ignoredRootEntries: ['.agents', '.dsh', '.dsh-profile-patches', '.dsh-snapshot-stream-ready'] }

/**
 * Run a fixed PTY controller and harvest fresh logs only after its process exits.
 * The controller must release its PTY even when it rejects; this runner owns and
 * removes every generated filesystem root after capture or failure.
 * @param options - Selected fixture, source/built CLI paths, patches, and workspace preparation.
 * @param scenario - Scenario metadata supplied to the fixed controller.
 * @param drive - PTY controller that resolves after graceful exit and cleanup.
 * @returns Terminal evidence, workspace captures, and selected raw Session logs.
 */
export async function runTuiSnapshotScenario(
  options: RunOptions,
  scenario: Scenario,
  drive: TuiSnapshotDriver,
): Promise<RunResult> {
  if (options.agent.profile !== 'deepseek-tui') throw new Error('tui-snapshot: agent.profile must be deepseek-tui')
  const task = tuiTaskFromSession(await readFile(options.fixtureFile, 'utf8'))
  const root = await mkdtemp(join(tmpdir(), 'dsh-tui-snapshot-'))
  let externalCwd: string | undefined
  let failure: unknown
  let failed = false
  let result: RunResult | undefined
  try {
    const cwd = options.workspaceParent === undefined
      ? join(root, 'workspace')
      : (externalCwd = await mkdtemp(join(options.workspaceParent, 'dsh-tui-snapshot-cwd-')))
    await mkdir(cwd, { recursive: true })
    const sessionsRoot = join(root, 'sessions')
    const spillRoot = join(root, 'spill')
    await mkdir(sessionsRoot)
    await mkdir(spillRoot)
    if (options.workspaceDir !== undefined) await cp(options.workspaceDir, cwd, { recursive: true })
    await options.prepareWorkspace?.(cwd)
    const initialWorkspace = await captureWorkspaceSnapshot(cwd, WORKSPACE_OPTIONS)
    const launch = resolveExampleLaunch({
      srcBin: options.agent.binScript,
      libBin: options.agent.libBinScript,
      tsconfigPath: options.agent.tsconfigPath,
      sourceImport: 'tsx/esm',
      configArgs: [...profileArgs(
        'deepseek-tui', options.agent.configPath, options.configPath ?? options.agent.configPath, options.mode, cwd,
      ), '--cwd', cwd],
      env: {
        ...options.env,
        DSH_HOME: join(cwd, '.dsh'),
        DSH_AGENTS_HOME: join(cwd, '.agents'),
        DSH_SNAPSHOT: options.mode,
        DSH_SNAPSHOT_FILE: options.fixtureFile,
        DSH_SNAPSHOT_OVERRIDE: options.overrideFile,
        DSH_SNAPSHOT_CHILD_FILES: options.childFiles?.join(delimiter),
        DSH_SNAPSHOT_SESSIONS_ROOT: sessionsRoot,
        DSH_SNAPSHOT_SPILL_ROOT: spillRoot,
        DSH_SNAPSHOT_SPILL_LOCATOR_ROOT: snapshotSpillRoot(options.fixtureFile),
        DSH_TELEMETRY_MODE: 'DISABLED',
        DSH_TELEMETRY_DISABLED: '1',
      },
    })
    const evidence = await drive({ argv: [launch.command, ...launch.args], cwd, env: launch.env, task, sessionsRoot }, scenario)
    if (evidence.outcome.signal !== null || evidence.outcome.exitCode !== 0) {
      throw new Error(`tui-snapshot: profile did not exit gracefully: ${JSON.stringify(evidence.outcome)}`)
    }
    const sessionLogs = await harvestSessionLogs(sessionsRoot)
    const primary = sessionLogs[0]
    if (primary === undefined || sessionLogs.filter(log => log.parentSession === undefined).length !== 1) {
      throw new Error('tui-snapshot: expected exactly one fresh parent Session after graceful exit')
    }
    result = {
      rawStdout: evidence.evidence,
      stderr: '',
      cwd,
      cwdAliases: [...new Set([realpathSync(cwd), realpathSync.native(cwd)])],
      sessionId: primary.id,
      sessionLogs,
      initialWorkspace,
      finalWorkspace: await captureWorkspaceSnapshot(cwd, WORKSPACE_OPTIONS),
    }
  } catch (error: unknown) {
    failure = error
    failed = true
  }
  const cleanupErrors: unknown[] = []
  for (const directory of [externalCwd, root]) {
    if (directory === undefined) continue
    try {
      await rm(directory, { recursive: true, force: true })
    } catch (error: unknown) { cleanupErrors.push(error) }
  }
  if (failed && cleanupErrors.length === 0) throw failure
  if (cleanupErrors.length > 0) {
    throw new AggregateError([...failed ? [failure] : [], ...cleanupErrors], 'TUI snapshot cleanup failed')
  }
  return result as RunResult
}

/**
 * Register TUI terminal evidence, Session, header-pin, workspace, and fixture checks.
 * Every mode derives its task from the selected Session; record requires a seed
 * Session, and replay/refresh use that same file for model responses.
 * @param options - Profile paths, scenarios, mode, and fixed PTY controller.
 */
export function defineTuiSnapshotSuite(options: TuiSnapshotSuiteOptions): void {
  if (options.agent.profile !== 'deepseek-tui') throw new Error('tui-snapshot: agent.profile must be deepseek-tui')
  defineSessionSnapshotSuite(options, {
    outputFile: 'terminal.expected.txt',
    run: (runOptions, scenario) => runTuiSnapshotScenario(runOptions, scenario, options.drive),
  })
}
