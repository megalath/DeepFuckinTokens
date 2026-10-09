import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { describe, expect, it, vi } from 'vitest'

import { parseConfig, type DeepTokensConfigInput } from '../src/config/config.js'
import { createFleet } from '../src/fleet/fleet.js'
import { git } from '../src/workspace/git.js'
import { createWorktrees, gitCommonDir, type Worktrees } from '../src/workspace/worktree.js'
import { fakeTransport, reply, type Script } from './helpers/fake-transport.js'
import { tmpRepo } from './helpers/repo.js'

async function setup(
  script: Script,
  config: DeepTokensConfigInput = {},
  wrap: (worktrees: Worktrees) => Worktrees = (worktrees) => worktrees,
) {
  const { root, agentDir } = await tmpRepo()
  const parsed = parseConfig(config)
  const transport = fakeTransport(script)
  const base = join(await gitCommonDir(root), 'deeptokens', 'worktrees')
  let ids = 0
  const fleet = createFleet({
    root,
    agentDir,
    config: parsed,
    transport,
    worktrees: wrap(createWorktrees(root, base, parsed.branchPrefix)),
    newId: () => `j${String(++ids)}`,
  })
  return { fleet, transport, root, agentDir }
}

const tick = async (): Promise<void> =>
  new Promise((resolve) => {
    setImmediate(resolve)
  })

const answers =
  (text: string): Script =>
  ({ emit }) => {
    for (const event of reply(text)) emit(event)
  }

const hangs: Script = ({ emit }) => {
  emit({ type: 'turn-start' })
}

describe('fleet', () => {
  it('runs a read job in place with read-only tools', async () => {
    const { fleet, transport, root } = await setup(answers('looks fine'))
    const result = await fleet.run({ task: 'review README' }, 5_000)

    expect(result.text).toBe('looks fine')
    expect(result.changes).toBeUndefined()
    expect(result.job).toMatchObject({ state: 'settled', mode: 'read', turns: 1 })
    expect(transport.opened[0]).toMatchObject({
      cwd: root,
      model: { provider: 'openai', id: 'gpt-6.1-sol' },
      thinking: 'medium',
      tools: ['read', 'grep', 'find', 'ls'],
    })
    expect(transport.closed).toBe(1)
  })

  it('commits a write job to its own branch and leaves main untouched', async () => {
    const { fleet, root } = await setup(async ({ options, emit }) => {
      await writeFile(join(options.cwd, 'NEW.md'), 'from the worker\n')
      for (const event of reply('added NEW.md')) emit(event)
    })
    const result = await fleet.run({ task: 'add NEW.md', mode: 'write', model: 'fast' }, 5_000)

    expect(result.changes).toMatchObject({ branch: 'dt/j1', isPatchTruncated: false })
    expect(result.changes?.patch).toContain('+from the worker')
    expect(result.changes?.stat).toContain('NEW.md')
    expect(await git(root, ['show', 'dt/j1:NEW.md'])).toBe('from the worker\n')
    expect(await git(root, ['status', '--porcelain'])).toBe('')
    expect(await git(root, ['worktree', 'list'])).not.toContain('j1')
  })

  it('drops the branch of a write job that changed nothing', async () => {
    const { fleet, root } = await setup(answers('nothing to do'))
    const result = await fleet.run({ task: 'noop', mode: 'write' }, 5_000)
    expect(result.changes).toBeUndefined()
    expect(await git(root, ['branch', '--list', 'dt/*'])).toBe('')
  })

  it('kills a job, its worktree and its branch', async () => {
    const { fleet, root } = await setup(hangs)
    const job = await fleet.spawn({ task: 'forever', mode: 'write' })
    expect((await fleet.wait(job.id, 50)).state).not.toBe('settled')

    expect((await fleet.kill(job.id)).state).toBe('killed')
    expect(await git(root, ['branch', '--list', 'dt/*'])).toBe('')
    await expect(fleet.send(job.id, 'more', 'steer')).rejects.toMatchObject({
      code: 'job-not-running',
    })
  })

  it('run() kills a job that outlives its timeout', async () => {
    const { fleet } = await setup(hangs)
    const result = await fleet.run({ task: 'slow' }, 30)
    expect(result.job.state).toBe('killed')
  })

  it('forwards steer and followUp to a running job', async () => {
    const { fleet, transport } = await setup(hangs)
    const job = await fleet.spawn({ task: 'go' })
    await fleet.send(job.id, 'focus on tests', 'steer')
    await fleet.send(job.id, 'then lint', 'followUp')
    expect(transport.sent).toEqual([
      { delivery: 'steer', text: 'focus on tests' },
      { delivery: 'followUp', text: 'then lint' },
    ])
    await fleet.close()
  })

  it('refuses work past maxConcurrent, then after close', async () => {
    const { fleet } = await setup(hangs, { maxConcurrent: 1 })
    await fleet.spawn({ task: 'one' })
    await expect(fleet.spawn({ task: 'two' })).rejects.toMatchObject({ code: 'fleet-full' })
    await fleet.close()
    expect(fleet.list().map((job) => job.state)).toEqual(['killed'])
    await expect(fleet.spawn({ task: 'three' })).rejects.toMatchObject({ code: 'fleet-closed' })
  })

  it('names the fix when a model is unknown or pi is not logged in', async () => {
    const { fleet, agentDir } = await setup(hangs)
    await expect(fleet.spawn({ task: 'x', model: 'ghost' })).rejects.toMatchObject({
      code: 'unknown-model',
    })
    await writeFile(join(agentDir, 'auth.json'), '{}')
    vi.stubEnv('OPENAI_API_KEY', '')
    await expect(fleet.spawn({ task: 'x' })).rejects.toMatchObject({
      code: 'not-logged-in',
      message: expect.stringContaining('/login') as unknown,
    })
  })

  it('fails a job whose pi process dies, and refuses to collect a live one', async () => {
    const { fleet } = await setup(({ emit }) => {
      emit({ type: 'exited', code: 1, signal: null, stderrTail: 'segfault' })
    })
    const job = await fleet.spawn({ task: 'x' })
    await expect(fleet.collect(job.id)).rejects.toMatchObject({ code: 'job-not-settled' })
    const done = await fleet.wait(job.id, 5_000)
    expect(done).toMatchObject({
      state: 'failed',
      error: expect.stringContaining('segfault') as unknown,
    })
  })

  it('reports routes against available models and logins', async () => {
    const { fleet } = await setup(hangs)
    const report = await fleet.models()
    expect(report.defaultModel).toBe('gpt')
    expect(report.defaultThinking).toBe('medium')
    expect(
      report.aliases.map(({ alias, isAvailable, thinking }) => [alias, isAvailable, thinking]),
    ).toEqual([
      ['gpt', true, 'medium'],
      ['fast', false, 'low'],
      ['deep', true, 'xhigh'],
    ])
    expect(report.aliases.every((route) => (route.useFor ?? '').length > 0)).toBe(true)
    expect(report.providers).toEqual([{ provider: 'openai', isLoggedIn: true }])
    expect(fleet.routes()).toHaveLength(3)
  })

  it('picks effort from the job, then the alias, then the config default', async () => {
    const { fleet, transport } = await setup(answers('ok'), {
      defaultThinking: 'minimal',
      aliases: {
        tuned: { model: 'openai/gpt-5.5', thinking: 'high' },
        bare: 'openai/gpt-5.5',
      },
      defaultModel: 'tuned',
    })
    await fleet.run({ task: 'a', thinking: 'off' }, 5_000)
    await fleet.run({ task: 'b' }, 5_000)
    await fleet.run({ task: 'c', model: 'bare' }, 5_000)
    expect(transport.opened.map((options) => options.thinking)).toEqual(['off', 'high', 'minimal'])
  })

  it('keeps a running write job out of the main tree: git status stays clean', async () => {
    const { fleet, root } = await setup(hangs)
    const job = await fleet.spawn({ task: 'x', mode: 'write' })
    expect(job.workspace.path).toContain(join('.git', 'deeptokens', 'worktrees'))
    expect(await git(root, ['status', '--porcelain'])).toBe('')
    await git(root, ['add', '-A'])
    expect(await git(root, ['diff', '--cached', '--name-only'])).toBe('')
    await fleet.close()
  })

  it('holds maxConcurrent for spawns made in parallel', async () => {
    const { fleet } = await setup(hangs, { maxConcurrent: 2 })
    const results = await Promise.allSettled(
      Array.from({ length: 6 }, async (_, i) => fleet.spawn({ task: String(i), mode: 'write' })),
    )
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(2)
    for (const result of results.filter((r) => r.status === 'rejected')) {
      expect(result.reason).toMatchObject({ code: 'fleet-full' })
    }
    await fleet.close()
  })

  it('leaves no branch or worktree when closed mid-spawn', async () => {
    let release = (): void => undefined
    const { fleet, root } = await setup(hangs, {}, (worktrees) => ({
      ...worktrees,
      create: async (worktree) => {
        await new Promise<void>((resolve) => {
          release = resolve
        })
        return worktrees.create(worktree)
      },
    }))
    const spawning = fleet.spawn({ task: 'x', mode: 'write' })
    while (fleet.list().length === 0) await tick()
    const closing = fleet.close()
    release()
    await closing
    expect((await spawning).state).toBe('killed')
    expect(await git(root, ['branch', '--list', 'dt/*'])).toBe('')
    expect(await git(root, ['worktree', 'list'])).not.toContain('j1')
  })

  it('kill on a finished write job deletes its branch; close keeps finished branches', async () => {
    const { fleet, root } = await setup(async ({ options, emit }) => {
      await writeFile(join(options.cwd, 'NEW.md'), 'x\n')
      for (const event of reply('done')) emit(event)
    })
    const first = await fleet.run({ task: 'a', mode: 'write' }, 5_000)
    const second = await fleet.run({ task: 'b', mode: 'write' }, 5_000)
    await fleet.kill(first.job.id)
    await fleet.close()
    expect(await git(root, ['branch', '--list', 'dt/*'])).toBe(
      `  ${second.changes?.branch ?? ''}\n`,
    )
    expect((await fleet.collect(first.job.id)).changes).toBeUndefined()
  })

  it('kills a run whose caller aborted', async () => {
    const { fleet } = await setup(hangs)
    const controller = new AbortController()
    const running = fleet.run({ task: 'x' }, 60_000, controller.signal)
    while (fleet.list().length === 0) await tick()
    controller.abort()
    expect((await running).job.state).toBe('killed')
  })

  it('honors the wait timeout while a kill is still cleaning up', async () => {
    const { fleet } = await setup(hangs, {}, (worktrees) => ({
      ...worktrees,
      discard: async (worktree) => {
        await new Promise((resolve) => setTimeout(resolve, 500))
        return worktrees.discard(worktree)
      },
    }))
    const job = await fleet.spawn({ task: 'x', mode: 'write' })
    const killing = fleet.kill(job.id)
    const started = Date.now()
    await fleet.wait(job.id, 20)
    expect(Date.now() - started).toBeLessThan(300)
    await killing
  })

  it('leaves providers it cannot check to pi', async () => {
    const { fleet, transport } = await setup(answers('ok'))
    const result = await fleet.run({ task: 'x', model: 'anthropic/claude-x' }, 5_000)
    expect(result.job.state).toBe('settled')
    expect(transport.opened[0]?.model).toEqual({ provider: 'anthropic', id: 'claude-x' })
  })

  it('rejects unknown job ids', async () => {
    const { fleet } = await setup(hangs)
    expect(() => fleet.status('nope')).toThrow(/nope/)
  })
})
