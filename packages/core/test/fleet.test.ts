import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { parseConfig, type DeepTokensConfigInput } from '../src/config/config.js'
import { createFleet } from '../src/fleet/fleet.js'
import { git } from '../src/workspace/git.js'
import { createWorktrees } from '../src/workspace/worktree.js'
import { fakeTransport, reply, type Script } from './helpers/fake-transport.js'
import { tmpRepo } from './helpers/repo.js'

async function setup(script: Script, config: DeepTokensConfigInput = {}) {
  const { root, agentDir } = await tmpRepo()
  const parsed = parseConfig(config)
  const transport = fakeTransport(script)
  let ids = 0
  const fleet = createFleet({
    root,
    agentDir,
    config: parsed,
    transport,
    worktrees: createWorktrees(root, parsed.worktreeDir, parsed.branchPrefix),
    newId: () => `j${String(++ids)}`,
  })
  return { fleet, transport, root, agentDir }
}

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
      model: { provider: 'openai-codex', id: 'gpt-6.1-sol' },
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

  it('reports aliases against available models and logins', async () => {
    const { fleet } = await setup(hangs)
    const report = await fleet.models()
    expect(report.defaultModel).toBe('gpt')
    expect(report.aliases).toEqual([
      { alias: 'gpt', target: { provider: 'openai-codex', id: 'gpt-6.1-sol' }, isAvailable: true },
      {
        alias: 'fast',
        target: { provider: 'openai-codex', id: 'gpt-5.3-codex-spark' },
        isAvailable: false,
      },
    ])
    expect(report.providers).toEqual([{ provider: 'openai-codex', isLoggedIn: true }])
  })

  it('closes a pi process that finishes booting after its job was killed', async () => {
    const { fleet, transport } = await setup(answers('too late'))
    const open = transport.open.bind(transport)
    let release = (): void => undefined
    transport.open = async (options, onEvent) => {
      await new Promise<void>((resolve) => {
        release = resolve
      })
      return open(options, onEvent)
    }
    const spawning = fleet.spawn({ task: 'x' })
    while (fleet.list().length === 0) await new Promise((resolve) => setImmediate(resolve))
    await fleet.kill(fleet.list()[0]!.id)
    release()

    expect((await spawning).state).toBe('killed')
    expect(transport.closed).toBe(1)
  })

  it('rejects unknown job ids', async () => {
    const { fleet } = await setup(hangs)
    expect(() => fleet.status('nope')).toThrow(/nope/)
  })
})
