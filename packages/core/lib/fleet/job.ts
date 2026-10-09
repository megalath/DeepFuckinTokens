import type { PiEvent } from '../pi/transport.js'
import type { JobSnapshot, Usage } from '../types.js'

export const ZERO_USAGE: Usage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  costUsd: 0,
}

function addUsage(a: Usage, b: Usage): Usage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
    costUsd: a.costUsd + b.costUsd,
  }
}

const isFinal = (job: JobSnapshot): boolean =>
  job.state === 'settled' || job.state === 'failed' || job.state === 'killed'

/**
 * Folds one pi event into a job. Pure: the fleet owns time and identity, this
 * owns what an event means. A final state is never left.
 */
export function reduceJob(job: JobSnapshot, event: PiEvent, now: string): JobSnapshot {
  if (isFinal(job)) return job
  switch (event.type) {
    case 'turn-start':
      return { ...job, state: 'running', turns: job.turns + 1 }
    case 'tool-start':
      return { ...job, state: 'running', toolCalls: job.toolCalls + 1, lastTool: event.toolName }
    case 'tool-end':
      return job
    case 'assistant-message': {
      const { error: _previous, ...rest } = job
      const next: JobSnapshot = {
        ...rest,
        usage: addUsage(job.usage, event.usage),
        ...(event.text.length > 0 ? { lastText: event.text } : {}),
      }
      // A later good message (pi retried) clears an earlier error.
      return event.stopReason === 'error'
        ? { ...next, error: event.errorMessage ?? 'the model returned an error' }
        : next
    }
    case 'settled':
      if (event.aborted) return { ...job, state: 'killed', endedAt: now }
      return job.error === undefined
        ? { ...job, state: 'settled', endedAt: now }
        : { ...job, state: 'failed', endedAt: now }
    case 'exited':
      return {
        ...job,
        state: 'failed',
        endedAt: now,
        error: `pi exited before the job settled: ${event.stderrTail.trim().slice(-500)}`,
      }
  }
}

export { isFinal }
