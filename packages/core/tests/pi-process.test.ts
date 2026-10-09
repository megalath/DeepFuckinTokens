import { describe, expect, it, vi } from 'vitest'

import { fakePiFleet, tick } from './helpers/fleet.js'

/** One job against the fake pi in `mode`, run to its end. */
async function jobIn(mode: string, task = 'hi') {
  vi.stubEnv('FAKE_PI_MODE', mode)
  const { fleet } = await fakePiFleet()
  const started = await fleet.spawn({ task, model: 'fast' })
  return fleet.wait(started.id, 10_000)
}

describe('a worker that is a real pi process', () => {
  it('passes the worker flags and streams a run to settled', async () => {
    const job = await jobIn('normal')
    expect(job).toMatchObject({ state: 'settled', turns: 1, toolCalls: 1, lastTool: 'read' })
    // U+2028 sits inside the record; a reader that split on it would have lost the message.
    expect(job.lastText).toMatch(/^echo: [^]*Task:\nhi\u2028ok$/)
  })

  it('dismisses extension dialogs instead of hanging', async () => {
    expect((await jobIn('dialog')).state).toBe('killed')
  })

  it('reports a crash with its flags and stderr, and takes no more instructions', async () => {
    vi.stubEnv('FAKE_PI_MODE', 'garbage-crash-on-prompt')
    const { fleet } = await fakePiFleet()
    const started = await fleet.spawn({ task: 'hi', model: 'fast', thinking: 'high' })
    const job = await fleet.wait(started.id, 10_000)

    expect(job.state).toBe('failed')
    expect(job.error).toContain('out of tokens')
    expect(job.error).toContain(
      '--mode rpc --no-session --no-mcp --provider openai --model gpt-6-luna --tools read,grep,find,ls --thinking high',
    )
    // A stdout line that is not JSON is kept for the crash report, not thrown.
    expect(job.error).toContain('[non-JSON stdout]')
    await expect(fleet.send(job.id, 'more', 'steer')).rejects.toMatchObject({
      code: 'job-not-running',
    })
  })

  it('delivers steer and follow-up messages to the running process', async () => {
    vi.stubEnv('FAKE_PI_MODE', 'hang')
    const { fleet } = await fakePiFleet()
    const job = await fleet.spawn({ task: 'hi' })
    const heard = async (text: string): Promise<void> => {
      while (fleet.status(job.id).lastText !== text) await tick()
    }
    await fleet.send(job.id, 'focus on tests', 'steer')
    await heard('steer: focus on tests')
    await fleet.send(job.id, 'then lint', 'followUp')
    await heard('follow_up: then lint')
    expect((await fleet.kill(job.id)).state).toBe('killed')
  })

  it('fails a job whose prompt pi refuses', async () => {
    expect(await jobIn('refuse-prompt')).toMatchObject({
      state: 'failed',
      error: 'pi refused prompt: no',
    })
  })

  it('fails a job whose model ended on an error', async () => {
    expect(await jobIn('model-error')).toMatchObject({ state: 'failed', error: 'rate limited' })
  })

  it('gives up on a pi that never finishes booting', async () => {
    vi.stubEnv('FAKE_PI_MODE', 'mute')
    const { fleet } = await fakePiFleet()
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      const spawning = fleet.spawn({ task: 'hi' })
      // Real I/O first: the process starts and the first command's timeout is armed.
      while (vi.getTimerCount() === 0) await tick()
      await vi.advanceTimersByTimeAsync(60_000)
      expect(await spawning).toMatchObject({
        state: 'failed',
        error: expect.stringContaining('did not answer get_state') as unknown,
      })
    } finally {
      vi.useRealTimers()
    }
  })

  it('reads every record shape pi sends and ignores the ones it does not use', async () => {
    const job = await jobIn('wire')
    // 'settled', not 'killed': the notify request was not answered as if it were a dialog.
    expect(job).toMatchObject({
      state: 'settled',
      turns: 1,
      toolCalls: 1,
      lastTool: 'read',
      lastText: 'Hello world',
      usage: {
        inputTokens: 10,
        outputTokens: 5,
        cacheReadTokens: 2,
        cacheWriteTokens: 1,
        costUsd: 0.25,
      },
    })
  })

  it('frames records on LF only: split writes, CRLF, blank lines, U+2028 and U+2029', async () => {
    const job = await jobIn('framing')
    expect(job).toMatchObject({ state: 'failed', turns: 1, lastText: 'a\u2028b\u2029c' })
    expect(job.error).toContain('bye')
    expect(job.error).not.toContain('[non-JSON stdout]')
  })

  it('lists models through a short-lived process, keeping provider and id', async () => {
    const { fleet } = await fakePiFleet()
    const report = await fleet.models()
    expect(report.available).toEqual([{ provider: 'openai', id: 'gpt-5.5' }])
    expect(report.aliases.map((route) => route.isAvailable)).toEqual([false, false, false])
  })

  it('delivers a final record that has no trailing LF', async () => {
    vi.stubEnv('FAKE_PI_MODE', 'unterminated-models')
    const { fleet } = await fakePiFleet()
    expect((await fleet.models()).available).toEqual([{ provider: 'openai', id: 'gpt-5.5' }])
  })
})
