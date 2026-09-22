/** State-driven real-PTY test driver backed by the maintained local subprocess provider. */

import { Buffer } from 'node:buffer'
import { stripVTControlCharacters } from 'node:util'
import { Context } from '@deepseek-ai/cordis'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import { LocalTerminalHandle } from '@deepseek-ai/dsh-subprocess-local/src/terminal.ts'

/** A terminal state matched against the unmodified PTY byte stream. */
export type TuiPtyState = string | RegExp

/** Signals supported by the subprocess terminal capability. */
type TuiPtySignal = 'SIGINT' | 'SIGTERM' | 'SIGKILL' | 'SIGTSTP' | 'SIGHUP'

/** One explicitly allowlisted child environment entry. */
export interface TuiPtyEnvironmentEntry {
  /** Environment variable name. */
  readonly name: string
  /** Exact value supplied to the child. */
  readonly value: string
}

/** One state-driven interaction with the PTY child. */
export type TuiPtyAction =
  | { readonly kind: 'waitFor'; readonly state: TuiPtyState }
  | { readonly kind: 'send'; readonly after: TuiPtyState; readonly data: string }
  | {
    readonly kind: 'release'
    readonly after: TuiPtyState
    readonly release: (state: { readonly rawOutput: () => string }) => void | Promise<void>
  }
  | { readonly kind: 'signal'; readonly after: TuiPtyState; readonly signal: TuiPtySignal }
  | { readonly kind: 'sleep'; readonly after: TuiPtyState; readonly ms: number }
  | {
    readonly kind: 'resize'
    readonly after: TuiPtyState
    readonly rows: number
    readonly cols: number
  }
  | { readonly kind: 'pauseOutput'; readonly after: TuiPtyState; readonly ms: number }

/** Narrow post-assertion normalizers for stable terminal snapshots. */
interface TuiPtyNormalizers {
  /** Remove terminal control sequences with Node's standard utility. */
  readonly ansi?: boolean
  /** Replace only these caller-declared loopback port occurrences. */
  readonly loopbackPorts?: readonly number[]
  /** Replace only these caller-declared temporary path occurrences. */
  readonly tempPaths?: readonly string[]
}

/** Fully specified real-PTY scenario input. */
export interface TuiPtyScenario {
  /** Executable and arguments, without shell interpretation. */
  readonly argv: readonly string[]
  /** Child working directory. */
  readonly cwd: string
  /** Explicit environment allowlist merged after the provider's ambient scrub. */
  readonly environment: readonly TuiPtyEnvironmentEntry[]
  /** Initial terminal rows. */
  readonly rows: number
  /** Initial terminal columns. */
  readonly cols: number
  /** Provider cleanup grace in milliseconds. */
  readonly graceMs: number
  /** Bound applied independently to every observed-state and exit wait. */
  readonly timeoutMs: number
  /** Maximum raw terminal bytes retained by the scenario. */
  readonly maxOutputBytes: number
  /** Maximum raw tail bytes included in timeout diagnostics. */
  readonly diagnosticTailBytes: number
  /** Ordered state-driven interactions. */
  readonly actions: readonly TuiPtyAction[]
  /** Optional fixture-owned interaction after static setup; never receives model-authored keys. */
  readonly interaction?: {
    /** Total callback deadline, including observation and decision waits. */
    readonly timeoutMs: number
    /** Execute bounded interactions; cancellation revokes all terminal controls. */
    readonly run: (controls: TuiPtyControls, signal: AbortSignal) => Promise<void>
  }
  /** Observe each cumulative retained-output value synchronously. */
  readonly onOutput?: ((raw: string) => void) | undefined
  /** Observe the published PTY leader identity before output admission begins. */
  readonly onSpawn?: ((pid: number) => void) | undefined
  /** Optional safe normalization applied after raw actions and exit complete. */
  readonly normalizers?: TuiPtyNormalizers
}

/** Terminal controls available only to fixture code mapping validated action IDs. */
export interface TuiPtyControls {
  /** Write fixture-declared bytes. @param data - fixed key sequence. */
  send(data: string): Promise<void>
  /** Wait for a current-screen predicate. @param predicate - synchronous screen observation. */
  waitFor(predicate: () => boolean): Promise<void>
  /** Signal the foreground process. @param signal - fixture-declared signal. */
  signal(signal: TuiPtySignal): Promise<void>
}

/** The fixture interaction exceeded its total deadline; cleanup still runs before rejection. */
export class TuiPtyInteractionTimeoutError extends Error {}

/** Captured process outcome and raw/normalized terminal text. */
export interface TuiPtyScenarioResult {
  /** Raw terminal output used for semantic waits. */
  readonly rawOutput: string
  /** Snapshot output after the declared safe normalizers. */
  readonly output: string
  /** Top-level process exit facts. */
  readonly outcome: { readonly exitCode: number | null; readonly signal: NodeJS.Signals | null }
}

type TerminalHandle = LocalTerminalHandle
type TerminalOutcome = Awaited<TerminalHandle['done']>

interface OutputCapture {
  rawOutput(): string
  waitFor(state: TuiPtyState | (() => boolean), signal?: AbortSignal): Promise<void>
  waitForExit(): Promise<TerminalOutcome>
  dispose(): void
}

const SENSITIVE_ENV_NAME = /KEY|PASSWORD|SECRET|TOKEN/i
const ENVIRONMENT_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/

function positiveInteger(name: string, value: number, maximum = Number.MAX_SAFE_INTEGER): void {
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) {
    throw new Error(`${name} must be a positive integer no greater than ${String(maximum)}`)
  }
}

function environmentRecord(entries: readonly TuiPtyEnvironmentEntry[]): Record<string, string> {
  const environment: Record<string, string> = {}
  const names = new Set<string>()
  for (const entry of entries) {
    if (!ENVIRONMENT_NAME.test(entry.name)) {
      throw new Error(`PTY environment name is invalid: ${JSON.stringify(entry.name)}`)
    }
    const identity = process.platform === 'win32' ? entry.name.toUpperCase() : entry.name
    if (names.has(identity)) throw new Error(`PTY environment name is duplicated: ${entry.name}`)
    names.add(identity)
    environment[entry.name] = entry.value
  }
  if (environment.DSH_LLM_PROTOCOL === undefined) {
    environment.DSH_LLM_PROTOCOL = 'chat-completions'
  }
  return environment
}

function sensitiveValues(entries: readonly TuiPtyEnvironmentEntry[]): string[] {
  const ambient = Object.entries(process.env)
    .filter(([name, value]) => value !== undefined && SENSITIVE_ENV_NAME.test(name))
    .map(([, value]) => value as string)
  const explicit = entries
    .filter(entry => SENSITIVE_ENV_NAME.test(entry.name))
    .map(entry => entry.value)
  return [...new Set([...ambient, ...explicit].filter(value => value.length > 0))]
    .sort((left, right) => right.length - left.length)
}

function redact(text: string, values: readonly string[]): string {
  let redacted = text
  for (const value of values) redacted = redacted.replaceAll(value, '<redacted>')
  return redacted
}

function stateMatches(output: string, state: TuiPtyState): boolean {
  if (typeof state === 'string') return output.includes(state)
  state.lastIndex = 0
  const matches = state.test(output)
  state.lastIndex = 0
  return matches
}

function stateDescription(state: TuiPtyState): string {
  return typeof state === 'string' ? JSON.stringify(state) : state.toString()
}

function rawTail(output: string, maximumBytes: number): string {
  const bytes = Buffer.from(output)
  return bytes.subarray(Math.max(0, bytes.length - maximumBytes)).toString('utf8')
}

function outputCapture(
  handle: TerminalHandle,
  timeoutMs: number,
  maxOutputBytes: number,
  diagnosticTailBytes: number,
  redactions: readonly string[],
  onOutput: ((raw: string) => void) | undefined,
): OutputCapture {
  let raw = ''
  let retainedBytes = 0
  let outputFailure: Error | undefined
  let terminalFailure: Error | undefined
  let outcome: TerminalOutcome | undefined
  const waiters = new Set<() => void>()
  const notify = (): void => { for (const waiter of waiters) waiter() }
  const diagnostic = (): string => redact(rawTail(raw, diagnosticTailBytes), redactions)
  const onData = (chunk: Buffer | string): void => {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    const available = Math.max(0, maxOutputBytes - retainedBytes)
    if (available > 0) {
      const retained = bytes.subarray(0, available)
      raw += retained.toString('utf8')
      retainedBytes += retained.length
    }
    if (bytes.length > available && outputFailure === undefined) {
      outputFailure = new Error(
        `PTY output exceeded ${String(maxOutputBytes)} bytes; raw output tail:\n${diagnostic()}`,
      )
    }
    if (outputFailure === undefined && onOutput !== undefined) {
      try {
        onOutput(raw)
      } catch (error) {
        outputFailure = error instanceof Error ? error : new Error(String(error))
      }
    }
    notify()
  }
  const onError = (error: Error): void => { terminalFailure = error; notify() }
  handle.output.on('data', onData)
  handle.output.on('error', onError)
  void handle.done.then(
    (result) => { outcome = result; notify() },
    (error: unknown) => {
      terminalFailure = error instanceof Error ? error : new Error(String(error))
      notify()
    },
  )

  const waitFor = (state: TuiPtyState | (() => boolean), signal?: AbortSignal): Promise<void> => new Promise((resolve, reject) => {
    let settled = false
    const finish = (error?: Error): void => {
      if (settled) return
      settled = true
      waiters.delete(check)
      signal?.removeEventListener('abort', abort)
      clearTimeout(timer)
      if (error === undefined) resolve()
      else reject(error)
    }
    const abort = (): void => { finish(new Error('PTY interaction cancelled')) }
    const description = typeof state === 'function' ? 'current-screen predicate' : stateDescription(state)
    const check = (): void => {
      try {
        if (signal?.aborted) abort()
        else if (outputFailure !== undefined) finish(outputFailure)
        else if (typeof state === 'function' ? state() : stateMatches(raw, state)) finish()
        else if (terminalFailure !== undefined) finish(terminalFailure)
        else if (outcome !== undefined) finish(new Error(
          `PTY exited before state ${description}; raw output tail:\n${diagnostic()}`,
        ))
      } catch (error) { finish(error instanceof Error ? error : new Error(String(error))) }
    }
    const timer = setTimeout(() => {
      finish(new Error(
        `PTY state ${description} was not observed within ${String(timeoutMs)}ms; raw output tail:\n${diagnostic()}`,
      ))
    }, timeoutMs)
    waiters.add(check)
    signal?.addEventListener('abort', abort, { once: true })
    check()
  })

  const waitForExit = (): Promise<TerminalOutcome> => new Promise((resolve, reject) => {
    let settled = false
    const finish = (result?: TerminalOutcome, error?: Error): void => {
      if (settled) return
      settled = true
      waiters.delete(check)
      clearTimeout(timer)
      if (error === undefined) resolve(result!)
      else reject(error)
    }
    const check = (): void => {
      if (outputFailure !== undefined) finish(undefined, outputFailure)
      else if (terminalFailure !== undefined) finish(undefined, terminalFailure)
      else if (outcome !== undefined) finish(outcome)
    }
    const timer = setTimeout(() => {
      finish(undefined, new Error(
        `PTY process did not exit within ${String(timeoutMs)}ms; raw output tail:\n${diagnostic()}`,
      ))
    }, timeoutMs)
    waiters.add(check)
    check()
  })

  return {
    rawOutput: () => raw,
    waitFor,
    waitForExit,
    dispose: () => {
      waiters.clear()
      handle.output.off('data', onData)
      handle.output.off('error', onError)
    },
  }
}

function normalizeOutput(output: string, normalizers: TuiPtyNormalizers | undefined): string {
  if (normalizers === undefined) return output
  let normalized = normalizers.ansi === true ? stripVTControlCharacters(output) : output
  for (const port of normalizers.loopbackPorts ?? []) {
    positiveInteger('loopback port', port, 65_535)
    for (const host of ['127.0.0.1', 'localhost', '[::1]']) {
      normalized = normalized.replaceAll(`${host}:${String(port)}`, `${host}:{{port}}`)
    }
  }
  const paths = (normalizers.tempPaths ?? []).map((path, index) => ({ path, index }))
  for (const { path, index } of paths.sort((left, right) => right.path.length - left.path.length)) {
    if (path.length === 0) throw new Error('temporary normalization path must be non-empty')
    normalized = normalized.replaceAll(path, `{{temp-path-${String(index + 1)}}}`)
  }
  return normalized
}

function assertNever(value: never): never {
  throw new Error(`unknown PTY scenario action: ${JSON.stringify(value)}`)
}

/**
 * Run one state-driven scenario through the repository-owned PTY provider.
 * @param scenario - fully specified terminal process, interactions, bounds, and normalization.
 * @returns captured exit facts plus raw and normalized terminal output.
 */
export async function runTuiPtyScenario(scenario: TuiPtyScenario): Promise<TuiPtyScenarioResult> {
  positiveInteger('PTY rows', scenario.rows)
  positiveInteger('PTY columns', scenario.cols)
  positiveInteger('PTY cleanup grace', scenario.graceMs)
  positiveInteger('PTY wait timeout', scenario.timeoutMs)
  positiveInteger('PTY output limit', scenario.maxOutputBytes)
  positiveInteger('PTY diagnostic tail', scenario.diagnosticTailBytes, scenario.maxOutputBytes)
  if (scenario.interaction !== undefined) positiveInteger('PTY interaction deadline', scenario.interaction.timeoutMs)
  const environment = environmentRecord(scenario.environment)
  const redactions = sensitiveValues(scenario.environment)
  const ctx = new Context()
  const fiber = await ctx.plugin(LocalSubprocessRuntime)
  let handle: TerminalHandle | undefined
  let capture: OutputCapture | undefined
  let result: TuiPtyScenarioResult | undefined
  let primaryFailure: unknown
  let failed = false

  try {
    handle = await ctx.subprocess.spawnTerminal({
      argv: scenario.argv,
      cwd: scenario.cwd,
      env: environment,
      rows: scenario.rows,
      cols: scenario.cols,
      graceMs: scenario.graceMs,
      terminalType: 'xterm-256color',
    }) as LocalTerminalHandle
    scenario.onSpawn?.(handle.pid)
    const activeCapture = outputCapture(
      handle,
      scenario.timeoutMs,
      scenario.maxOutputBytes,
      scenario.diagnosticTailBytes,
      redactions,
      scenario.onOutput,
    )
    capture = activeCapture
    for (const action of scenario.actions) {
      switch (action.kind) {
        case 'waitFor':
          await activeCapture.waitFor(action.state)
          break
        case 'send':
          await activeCapture.waitFor(action.after)
          await handle.write(action.data)
          break
        case 'release':
          await activeCapture.waitFor(action.after)
          await action.release({ rawOutput: () => activeCapture.rawOutput() })
          break
        case 'signal':
          await activeCapture.waitFor(action.after)
          await handle.signalForeground(action.signal)
          break
        case 'sleep':
          // Real-time separation between two keys: one stdin chunk of `gs`
          // would reach Ink as a single text commit, and the chord timer
          // still bounds the pair.
          await activeCapture.waitFor(action.after)
          await new Promise<void>(resolve => setTimeout(resolve, action.ms))
          break
        case 'resize':
          await activeCapture.waitFor(action.after)
          positiveInteger('PTY resize rows', action.rows)
          positiveInteger('PTY resize columns', action.cols)
          await handle.resize(action.cols, action.rows)
          break
        case 'pauseOutput':
          await activeCapture.waitFor(action.after)
          positiveInteger('PTY output pause', action.ms)
          handle.output.pause()
          try {
            await new Promise<void>(resolve => setTimeout(resolve, action.ms))
          } finally {
            handle.output.resume()
          }
          break
        default:
          assertNever(action)
      }
    }
    if (scenario.interaction !== undefined) {
      const controller = new AbortController()
      const terminal = handle
      let timer: ReturnType<typeof setTimeout> | undefined
      const checkActive = (): void => { controller.signal.throwIfAborted() }
      try {
        await Promise.race([
          scenario.interaction.run({
            send: async (data) => { checkActive(); await terminal.write(data) },
            waitFor: async (predicate) => { checkActive(); await activeCapture.waitFor(predicate, controller.signal) },
            signal: async (signal) => { checkActive(); await terminal.signalForeground(signal) },
          }, controller.signal),
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(() => {
              reject(new TuiPtyInteractionTimeoutError('PTY interaction deadline exceeded'))
              controller.abort()
            }, scenario.interaction!.timeoutMs)
          }),
        ])
      } finally {
        clearTimeout(timer)
        controller.abort()
      }
    }
    const outcome = await activeCapture.waitForExit()
    const rawOutput = activeCapture.rawOutput()
    result = {
      rawOutput,
      output: normalizeOutput(rawOutput, scenario.normalizers),
      outcome,
    }
  } catch (error: unknown) {
    failed = true
    primaryFailure = error
  }

  const cleanupFailures: unknown[] = []
  capture?.dispose()
  if (handle !== undefined) {
    try {
      await handle.terminate()
    } catch (error: unknown) {
      cleanupFailures.push(error)
    }
    try {
      await handle.done
    } catch (error: unknown) {
      cleanupFailures.push(error)
    }
  }
  try {
    await fiber.dispose()
  } catch (error: unknown) {
    cleanupFailures.push(error)
  }

  if (failed) {
    if (cleanupFailures.length > 0) {
      throw new AggregateError([primaryFailure, ...cleanupFailures], 'PTY scenario and cleanup failed')
    }
    throw primaryFailure
  }
  if (cleanupFailures.length === 1) throw cleanupFailures[0]
  if (cleanupFailures.length > 1) throw new AggregateError(cleanupFailures, 'PTY scenario cleanup failed')
  return result!
}
