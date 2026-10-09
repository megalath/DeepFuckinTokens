import { describe, expect, it } from 'vitest'

import type { PiEvent, Usage } from '../index.js'
import { ZERO_USAGE, type Script } from './helpers/fake-transport.js'
import { scriptedFleet, tick } from './helpers/fleet.js'

const usage: Usage = { ...ZERO_USAGE, inputTokens: 3, outputTokens: 2, costUsd: 0.5 }

const emits =
  (events: readonly PiEvent[]): Script =>
  ({ emit }) => {
    for (const event of events) emit(event)
  }

/** Runs one job whose worker emits exactly these events, and returns how the job ended. */
async function jobAfter(events: readonly PiEvent[]) {
  const { fleet } = await scriptedFleet(emits(events))
  const started = await fleet.spawn({ task: 't' })
  return fleet.wait(started.id, 5_000)
}

describe('a job, as pi events arrive', () => {
  it('runs, counts, and settles', async () => {
    const job = await jobAfter([
      { type: 'turn-start' },
      { type: 'tool-start', toolName: 'read' },
      { type: 'tool-end', toolName: 'read', isError: false },
      { type: 'assistant-message', text: 'done', usage, stopReason: 'stop' },
      { type: 'assistant-message', text: '', usage, stopReason: 'stop' },
      { type: 'settled', aborted: false },
    ])
    expect(job).toMatchObject({
      state: 'settled',
      turns: 1,
      toolCalls: 1,
      lastTool: 'read',
      lastText: 'done',
      usage: { inputTokens: 6, outputTokens: 4, costUsd: 1 },
    })
    expect(Date.parse(job.endedAt ?? '')).toBeGreaterThanOrEqual(Date.parse(job.startedAt))
  })

  it('fails when the last model message was an error', async () => {
    const job = await jobAfter([
      { type: 'assistant-message', text: '', usage, stopReason: 'error', errorMessage: '429' },
      { type: 'settled', aborted: false },
    ])
    expect(job).toMatchObject({ state: 'failed', error: '429' })
  })

  it('says so when the model errored without a message', async () => {
    const job = await jobAfter([
      { type: 'assistant-message', text: '', usage, stopReason: 'error' },
      { type: 'settled', aborted: false },
    ])
    expect(job).toMatchObject({ state: 'failed', error: 'the model returned an error' })
  })

  it('clears an error that a retry recovered from', async () => {
    const job = await jobAfter([
      { type: 'assistant-message', text: '', usage, stopReason: 'error', errorMessage: '429' },
      { type: 'assistant-message', text: 'ok', usage, stopReason: 'stop' },
      { type: 'settled', aborted: false },
    ])
    expect(job.state).toBe('settled')
    expect(job.error).toBeUndefined()
  })

  it('treats an aborted settle as killed and an exit as failed', async () => {
    expect((await jobAfter([{ type: 'settled', aborted: true }])).state).toBe('killed')
    expect(
      await jobAfter([{ type: 'exited', code: 1, signal: null, stderrTail: 'boom' }]),
    ).toMatchObject({ state: 'failed', error: expect.stringContaining('boom') as unknown })
  })

  it('never leaves a final state', async () => {
    const { fleet } = await scriptedFleet(({ emit, emitLate }) => {
      emit({ type: 'settled', aborted: false })
      emitLate({ type: 'turn-start' })
      emitLate({ type: 'settled', aborted: true })
    })
    const started = await fleet.spawn({ task: 't' })
    const settled = await fleet.wait(started.id, 5_000)
    await tick()
    expect(settled).toMatchObject({ state: 'settled', turns: 0 })
    expect(fleet.status(started.id)).toBe(settled)
  })
})
