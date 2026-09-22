/** Keyless real-profile Plugins navigation, install settlement and background-job withdrawal evidence. */

import { startMockLlmServer } from '@deepseek-ai/dsh-llm-mock-server'
import { resolveExampleLaunch } from '@deepseek-ai/dsh-loader-smoke'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { ScreenAtlas } from '../../../packages/tui/tui-render/src/screen-atlas.ts'
import { consumeCompletedTuiFrames } from './support/tui-completed-frames.ts'
import { runTuiPtyScenario, type TuiPtyAction } from './support/tui-pty-snapshot.ts'

const REPO_ROOT = resolve(fileURLToPath(new URL('../../..', import.meta.url)))
const EXPECTED = fileURLToPath(new URL('./snapshots/deepseek-tui-plugins/terminal.expected.txt', import.meta.url))
const READY = /agent · deepseek-flash[\s\S]{0,30000}>/u
const FINAL = 'PLUGINS_HUD_FINAL'
const DUMMY_KEY = 'plugins-keyless-dummy'
const check = (fn: () => void | Promise<void>): TuiPtyAction => ({ kind: 'release', after: READY, release: fn })
const waitForGrid = (grid: () => string) => (predicate: (text: string) => boolean): TuiPtyAction => check(async () => {
  await expect.poll(grid, { timeout: 15_000, message: predicate.toString() }).toSatisfy(predicate)
})

it('opens Plugins through both entries and retracts a job settled while the page is open', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-tui-plugins-'))
  let server: Awaited<ReturnType<typeof startMockLlmServer>> | undefined
  try {
    const home = join(root, 'home')
    const project = join(root, 'project')
    await mkdir(home)
    await mkdir(project)
    await writeFile(join(home, '.credentials.yaml'), `version: 1\nrefs:\n  DEEPSEEK_API_KEY: ${DUMMY_KEY}\n`, { mode: 0o600 })
    const ordinaryPackage = join(project, 'ordinary-package')
    await mkdir(ordinaryPackage)
    await writeFile(join(ordinaryPackage, 'package.json'), JSON.stringify({ name: 'plugins-pty-ordinary', version: '1.0.0' }))
    await writeFile(join(project, 'hud-job.cjs'), [
      "const fs = require('node:fs')",
      "fs.writeFileSync('ready', 'ready')",
      "const timer = setInterval(() => { if (fs.existsSync('release')) { clearInterval(timer); fs.writeFileSync('done', 'done'); } }, 25)",
      '',
    ].join('\n'))
    const packageProbe = join(root, 'package-probe')
    const packageInvocation = join(root, 'package-invoked')
    await writeFile(packageProbe, `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(packageInvocation)}, 'unexpected'); process.exit(99)\n`, { mode: 0o700 })
    const overlay = join(root, 'overlay.yml')
    // The optional path runs exactly the release runtime artifact through the same profile.
    const bundle = process.env.DSH_TUI_PLUGINS_BUNDLE
    await writeFile(overlay, [
      '- id: session-title-llm', '  disabled: true',
      '- id: zen-proxy', '  disabled: true',
      '- id: approval', '  config:', '    policy: never',
      '- id: plugin-manager', '  config:', `    pnpmCommand: ${JSON.stringify(packageProbe)}`,
      ...(bundle === undefined ? [] : ['- id: tui-runtime', `  name: ${JSON.stringify(resolve(bundle))}`]),
      '',
    ].join('\n'), { mode: 0o600 })
    const preload = join(root, 'terminal-env.cjs')
    await writeFile(preload, "process.env.TERM = 'xterm-256color'\n", { mode: 0o600 })
    server = await startMockLlmServer({
      host: '127.0.0.1', port: 0, apiKey: DUMMY_KEY,
      sequence: ['tool_call_success', 'tool_call_success', 'success'], repeatLast: true,
      toolCallId: ({ attempt }) => `plugins-hud-${attempt}`,
      toolName: ({ attempt }) => attempt === 1 ? 'todo_write' : 'bash',
      toolArguments: ({ attempt }) => JSON.stringify(attempt === 1
        ? { todos: [{ content: 'PLUGINS_PLAN_ACTIVE', status: 'in_progress' }, { content: 'PLUGINS_PLAN_PENDING', status: 'pending' }] }
        : { command: 'node hud-job.cjs', description: 'Wait for the Plugins page to open', workdir: project, run_in_background: true }),
      successText: FINAL, chunkSize: 100,
    })
    const atlas = new ScreenAtlas(120, 40)
    let fed = 0
    const grid = () => atlas.extract({ col: 1, row: 1 }, { col: atlas.width, row: atlas.height })
    const evidence: string[] = []
    const wait = waitForGrid(grid)
    const send = (data: string): TuiPtyAction => ({ kind: 'send', after: READY, data })
    const open: TuiPtyAction[] = [send('/plugins'), wait(text => text.includes('/plugins')), send('\r'),
      wait(text => text.includes('安装供给') && text.includes('@deepseek-ai/dsh-base'))]
    const close: TuiPtyAction[] = [send('\x1b'), wait(text => text.includes('› 输入消息') && !text.includes('Space 启停'))]
    const launch = resolveExampleLaunch({
      srcBin: join(REPO_ROOT, 'apps/cli/src/bin.ts'),
      tsconfigPath: join(REPO_ROOT, 'tsconfig.tsx.json'), sourceImport: 'tsx/esm',
      configArgs: ['--profile', 'deepseek-tui', '--patch', overlay, '--cwd', project],
    })
    const result = await runTuiPtyScenario({
      // A Node child inside the sandbox cannot read a preload outside its workspace.
      argv: [launch.command, '--require', preload, ...launch.args], cwd: REPO_ROOT,
      environment: [
        { name: 'DSH_HOME', value: home }, { name: 'DSH_AGENTS_HOME', value: join(home, 'agents') },
        { name: 'DEEPSEEK_BASE_URL', value: server.baseURL },
        { name: 'DSH_TELEMETRY_MODE', value: 'DISABLED' }, { name: 'DSH_TELEMETRY_DISABLED', value: '1' },
        { name: 'TERM', value: 'xterm-256color' }, { name: 'NO_COLOR', value: '1' },
        { name: 'LC_ALL', value: 'C' }, { name: 'LANG', value: 'C' },
        ...Object.entries(launch.env).flatMap(([name, value]) => value === undefined ? [] : [{ name, value }]),
      ],
      rows: 40, cols: 120, graceMs: 2_000, timeoutMs: 30_000,
      maxOutputBytes: 8 * 1024 * 1024, diagnosticTailBytes: 12 * 1024,
      onOutput: (raw) => { fed = consumeCompletedTuiFrames(raw, fed, (chunk) => { atlas.feed(chunk) }) },
      actions: [
        ...open,
        check(() => { expect(grid()).toContain('变更影响此 profile 的所有会话'); evidence.push('/plugins: live installation inventory; profile-wide scope') }),
        send('\x1b[B'), wait(text => text.includes('›   tool-plugin-manager') && text.includes('Space 启停')),
        send(' '), wait(text => text.includes('已保存 · 需要重启')),
        check(async () => {
          expect(grid()).toContain('/reload')
          expect(grid()).toContain('tool-plugin-manager · 已禁用')
          const patch = await readFile(join(home, 'profiles', 'deepseek-tui', 'cordis.patch.yml'), 'utf8')
          expect(patch).toContain('tool-plugin-manager')
          expect(patch).toContain('disabled: false')
          evidence.push('toggle: real profile write; restart required; live row remains disabled; /reload offered')
        }),
        ...close,
        send('g'), wait(text => /[│>]\s*>?\s*g/u.test(text)), send('p'),
        wait(text => text.includes('安装供给') && text.includes('@deepseek-ai/dsh-base')),
        check(() => { evidence.push('g p: same live inventory after close/reopen') }),
        ...close,
        send('Show a plan and start the background job.'), wait(text => text.includes('Show a plan')),
        send('\r'), wait(text => text.includes(FINAL) && text.includes('bash-1 · 运行中') && text.includes('任务计划')),
        check(async () => {
          await expect.poll(() => readFile(join(project, 'ready'), 'utf8'), { timeout: 15_000 }).toBe('ready')
          expect(grid()).toContain('后台执行')
          expect(grid()).toContain('PLUGINS_PLAN_ACTIVE')
          evidence.push('HUD: titled plan and execution; active background job survives turn end')
        }),
        ...open,
        check(async () => {
          await writeFile(join(project, 'release'), 'release')
          await expect.poll(async () => readFile(join(project, 'done'), 'utf8'), { timeout: 15_000 }).toBe('done')
        }),
        ...close,
        wait(text => !text.includes('bash-1 · 运行中') && !text.includes('后台执行')),
        check(() => { expect(grid()).not.toContain('bash-1 · completed'); evidence.push('HUD: job settled during overlay; closing shows no stale execution section') }),
        ...open, ...close,
        check(() => { expect(grid()).not.toContain('后台执行'); evidence.push('reopen: settled job stays absent; composer restored') }),
        ...open,
        send('i'), wait(text => text.includes('Enter 预检')),
        send(`\x1b[200~${ordinaryPackage}\x1b[201~`), wait(text => text.includes('ordinary-package')),
        send('\r'), wait(text => text.includes('该包不是 bundle')),
        check(async () => {
          expect(grid()).toContain('ordinary-package')
          await expect(readFile(packageInvocation)).rejects.toMatchObject({ code: 'ENOENT' })
          evidence.push('inspect: real local non-bundle refused; spec retained; no package operation')
        }),
        ...close,
        { kind: 'signal', after: READY, signal: 'SIGTERM' },
      ],
    })
    expect(result.outcome).toEqual({ exitCode: 0, signal: null })
    await expect(readFile(packageInvocation)).rejects.toMatchObject({ code: 'ENOENT' })
    evidence.push('exit: 0; no package operation')
    const actual = `${evidence.join('\n')}\n`
    if (process.env.DSH_SNAPSHOT === 'refresh') {
      await mkdir(resolve(EXPECTED, '..'), { recursive: true })
      await writeFile(EXPECTED, actual)
    }
    expect(actual).toBe(await readFile(EXPECTED, 'utf8'))
  } finally {
    await server?.close()
    await rm(root, { recursive: true, force: true })
  }
})

// The executable fixture uses a POSIX shebang and observes SIGTERM cancellation.
it.skipIf(process.platform === 'win32')('restores profile files after a failed install and an explicitly cancelled retry', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-tui-plugins-install-'))
  let server: Awaited<ReturnType<typeof startMockLlmServer>> | undefined
  try {
    const home = join(root, 'home')
    const project = join(root, 'project')
    const bundle = join(root, 'local-bundle')
    const profile = join(home, 'profiles', 'deepseek-tui')
    await mkdir(home)
    await mkdir(project)
    await mkdir(bundle)
    await writeFile(join(home, '.credentials.yaml'), `version: 1\nrefs:\n  DEEPSEEK_API_KEY: ${DUMMY_KEY}\n`, { mode: 0o600 })
    await writeFile(join(bundle, 'package.json'), JSON.stringify({
      name: 'plugins-pty-local-bundle', version: '1.0.0', description: 'Local install transaction fixture',
      dsh: { bundle: { patch: 'cordis.patch.yml' } },
    }))
    await writeFile(join(bundle, 'cordis.patch.yml'), '[]\n')
    const invocations = join(root, 'invocations.jsonl')
    const release = join(root, 'release-failure')
    const executable = join(root, 'package-process')
    // Only the external executable is scripted. The real manager owns classification,
    // progress, cancellation, file restoration and the result consumed by the TUI.
    await writeFile(executable, [
      `#!${process.execPath}`,
      "const fs = require('node:fs')",
      `const root = ${JSON.stringify(root)}`,
      `const invocations = ${JSON.stringify(invocations)}`,
      "const attempt = fs.existsSync(invocations) ? fs.readFileSync(invocations, 'utf8').trim().split('\\n').length + 1 : 1",
      "fs.appendFileSync(invocations, JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd(), pid: process.pid }) + '\\n')",
      "const manifest = JSON.parse(fs.readFileSync('package.json', 'utf8'))",
      "manifest.dependencies = { ...manifest.dependencies, 'plugins-pty-partial': 'file:partial' }",
      "fs.writeFileSync('package.json', JSON.stringify(manifest))",
      "fs.writeFileSync('pnpm-lock.yaml', 'partial package operation\\n')",
      "process.on('SIGTERM', () => { fs.writeFileSync(root + '/cancelled-' + attempt, 'SIGTERM'); process.exit(143) })",
      "fs.writeFileSync(root + '/ready-' + attempt, 'ready')",
      "process.stdout.write('PACKAGE_PROCESS_READY_' + attempt + '\\n')",
      `const timer = setInterval(() => { if (attempt === 1 && fs.existsSync(${JSON.stringify(release)})) {`,
      '  clearInterval(timer)',
      "  process.stderr.write('ERR_PNPM_NO_MATCHING_VERSION: local fixture failure\\n', () => process.exit(1))",
      '} }, 25)',
      '',
    ].join('\n'), { mode: 0o700 })
    const overlay = join(root, 'overlay.yml')
    await writeFile(overlay, [
      '- id: session-title-llm', '  disabled: true',
      '- id: zen-proxy', '  disabled: true',
      '- id: plugin-manager', '  config:', `    pnpmCommand: ${JSON.stringify(executable)}`,
      '',
    ].join('\n'), { mode: 0o600 })
    const preload = join(root, 'terminal-env.cjs')
    await writeFile(preload, "process.env.TERM = 'xterm-256color'\n", { mode: 0o600 })
    server = await startMockLlmServer({ host: '127.0.0.1', port: 0, apiKey: DUMMY_KEY, sequence: ['success'] })
    const atlas = new ScreenAtlas(120, 40)
    let fed = 0
    const grid = () => atlas.extract({ col: 1, row: 1 }, { col: atlas.width, row: atlas.height })
    const evidence: string[] = []
    const before = new Map<string, string>()
    const wait = waitForGrid(grid)
    const send = (data: string): TuiPtyAction => ({ kind: 'send', after: READY, data })
    const open: TuiPtyAction[] = [send('/plugins'), wait(text => text.includes('/plugins')), send('\r'),
      wait(text => text.includes('安装供给') && text.includes('@deepseek-ai/dsh-base'))]
    const close: TuiPtyAction[] = [send('\x1b'), wait(text => text.includes('› 输入消息') && !text.includes('Esc 关闭'))]
    const restored = async () => {
      for (const [file, content] of before) expect(await readFile(join(profile, file), 'utf8'), file).toBe(content)
      expect(grid()).not.toContain('/reload')
      expect(grid()).not.toContain('已保存 · 需要重启')
    }
    const invocationRows = async () => (await readFile(invocations, 'utf8')).trim().split('\n')
      .map(line => JSON.parse(line) as { args: string[]; cwd: string; pid: number })
    const running = (attempt: number): TuiPtyAction => check(async () => {
      await expect.poll(() => readFile(join(root, `ready-${attempt}`), 'utf8'), { timeout: 15_000 }).toBe('ready')
      const rows = await invocationRows()
      expect(rows).toHaveLength(attempt)
      expect(rows[attempt - 1]).toMatchObject({ args: ['add', bundle], cwd: profile })
      expect(await readFile(join(profile, 'pnpm-lock.yaml'), 'utf8')).toBe('partial package operation\n')
      expect(await readFile(join(profile, 'package.json'), 'utf8')).toContain('plugins-pty-partial')
      process.kill(rows[attempt - 1]!.pid, 0)
    })
    const exited = async (attempt: number) => {
      const row = (await invocationRows())[attempt - 1]!
      expect(() => process.kill(row.pid, 0)).toThrow(expect.objectContaining({ code: 'ESRCH' }))
    }
    const launch = resolveExampleLaunch({
      srcBin: join(REPO_ROOT, 'apps/cli/src/bin.ts'),
      tsconfigPath: join(REPO_ROOT, 'tsconfig.tsx.json'), sourceImport: 'tsx/esm',
      configArgs: ['--profile', 'deepseek-tui', '--patch', overlay, '--cwd', project],
    })
    const result = await runTuiPtyScenario({
      argv: [launch.command, '--require', preload, ...launch.args], cwd: REPO_ROOT,
      environment: [
        { name: 'DSH_HOME', value: home }, { name: 'DSH_AGENTS_HOME', value: join(home, 'agents') },
        { name: 'DEEPSEEK_BASE_URL', value: server.baseURL },
        { name: 'DSH_TELEMETRY_MODE', value: 'DISABLED' }, { name: 'DSH_TELEMETRY_DISABLED', value: '1' },
        { name: 'TERM', value: 'xterm-256color' }, { name: 'NO_COLOR', value: '1' },
        { name: 'LC_ALL', value: 'C' }, { name: 'LANG', value: 'C' },
        ...Object.entries(launch.env).flatMap(([name, value]) => value === undefined ? [] : [{ name, value }]),
      ],
      rows: 40, cols: 120, graceMs: 2_000, timeoutMs: 30_000,
      maxOutputBytes: 8 * 1024 * 1024, diagnosticTailBytes: 12 * 1024,
      onOutput: (raw) => { fed = consumeCompletedTuiFrames(raw, fed, (chunk) => { atlas.feed(chunk) }) },
      actions: [
        ...open,
        check(async () => {
          await writeFile(join(profile, 'pnpm-lock.yaml'), 'lockfileVersion: \'9.0\'\nimporters: {}\n')
          for (const file of ['package.json', 'pnpm-lock.yaml', 'cordis.patch.yml']) {
            before.set(file, await readFile(join(profile, file), 'utf8'))
          }
        }),
        send('i'), wait(text => text.includes('Enter 预检')),
        send(`\x1b[200~${bundle}\x1b[201~`), wait(text => text.includes('local-bundle')),
        send('\r'), wait(text => text.includes('声明 bundle') && text.includes('Enter 安装')),
        check(async () => {
          await expect(readFile(invocations)).rejects.toMatchObject({ code: 'ENOENT' })
          evidence.push('inspect: real local bundle accepted; confirmation required; no package process yet')
        }),
        send('\r'), wait(text => text.includes('PACKAGE_PROCESS_READY_1') && text.includes('c 显式取消安装')),
        running(1),
        ...close, ...open,
        wait(text => text.includes('PACKAGE_PROCESS_READY_1') && text.includes('正在安装')),
        running(1),
        check(() => { evidence.push('install: real manager invokes controlled executable; progress survives close/reopen; pnpm itself not executed') }),
        ...close,
        check(async () => { await writeFile(release, 'release') }),
        ...open,
        wait(text => text.includes('插件操作失败') && text.includes('找不到匹配版本') && text.includes('r 重试')),
        check(async () => {
          await restored()
          await exited(1)
          evidence.push('failed: exit 1 classified as no-matching-version; profile files restored; retry offered; no restart handoff')
        }),
        send('r'), wait(text => text.includes('PACKAGE_PROCESS_READY_2') && text.includes('正在安装')),
        running(2),
        ...close, ...open,
        wait(text => text.includes('PACKAGE_PROCESS_READY_2') && text.includes('c 显式取消安装')),
        running(2),
        send('c'), wait(text => text.includes('已确认取消并恢复文件') && !text.includes('c 显式取消安装')),
        check(async () => {
          expect(await readFile(join(root, 'cancelled-2'), 'utf8')).toBe('SIGTERM')
          await restored()
          await exited(2)
          expect(await invocationRows()).toHaveLength(2)
          evidence.push('cancelled: explicit c reaches package process; real manager waits for exit and restores profile files')
        }),
        ...close, ...open,
        wait(text => text.includes('已确认取消并恢复文件')),
        check(() => { evidence.push('reopen: settled cancellation retained; no running install or restart handoff') }),
        ...close,
        { kind: 'signal', after: READY, signal: 'SIGTERM' },
      ],
    })
    expect(result.outcome).toEqual({ exitCode: 0, signal: null })
    expect(await invocationRows()).toHaveLength(2)
    evidence.push('exit: 0; both controlled package processes exited')
    const expected = fileURLToPath(new URL('./snapshots/deepseek-tui-plugins/install.expected.txt', import.meta.url))
    const actual = `${evidence.join('\n')}\n`
    if (process.env.DSH_SNAPSHOT === 'refresh') await writeFile(expected, actual)
    expect(actual).toBe(await readFile(expected, 'utf8'))
  } finally {
    try { await server?.close() }
    finally { await rm(root, { recursive: true, force: true }) }
  }
})
