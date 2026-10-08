import { describe, expect, it } from 'vitest'

import { reduceJob, ZERO_USAGE } from '../src/fleet/job.js'
import type { PiEvent } from '../src/pi/transport.js'
import type { JobId, JobSnapshot } from '../src/types.js'

const T = '2026-10-08T00:00:00.000Z'

const fresh: JobSnapshot = {
  id: 'j1' as JobId,
  state: 'starting',
  task: 't',
  mode: 'read',
  model: { provider: 'openai-codex', id: 'gpt-5.5' },
  workspace: { kind: 'shared', path: '/repo' },
  startedAt: T,
  turns: 0,
  toolCalls: 0,
  usage: ZERO_USAGE,
}

const fold = (events: readonly PiEvent[], from: JobSnapshot = fresh): JobSnapshot =>
  events.reduce((job, event) => reduceJob(job, event, T), from)

const usage = { ...ZERO_USAGE, inputTokens: 3, outputTokens: 2, costUsd: 0.5 }

describe('reduceJob', () => {
  it('runs, counts, and settles', () => {
    const job = fold([
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
      endedAt: T,
      usage: { inputTokens: 6, outputTokens: 4, costUsd: 1 },
    })
  })

  it('fails when the last model message was an error', () => {
    const job = fold([
      { type: 'assistant-message', text: '', usage, stopReason: 'error', errorMessage: '429' },
      { type: 'settled', aborted: false },
    ])
    expect(job).toMatchObject({ state: 'failed', error: '429' })
  })

  it('clears an error that a retry recovered from', () => {
    const job = fold([
      { type: 'assistant-message', text: '', usage, stopReason: 'error', errorMessage: '429' },
      { type: 'assistant-message', text: 'ok', usage, stopReason: 'stop' },
      { type: 'settled', aborted: false },
    ])
    expect(job.state).toBe('settled')
    expect(job.error).toBeUndefined()
  })

  it('treats an aborted settle as killed and an exit as failed', () => {
    expect(fold([{ type: 'settled', aborted: true }]).state).toBe('killed')
    expect(fold([{ type: 'exited', code: 1, signal: null, stderrTail: 'boom' }])).toMatchObject({
      state: 'failed',
      error: expect.stringContaining('boom') as unknown,
    })
  })

  it('never leaves a final state', () => {
    const settled = fold([{ type: 'settled', aborted: false }])
    expect(fold([{ type: 'turn-start' }, { type: 'settled', aborted: true }], settled)).toBe(
      settled,
    )
  })
})
