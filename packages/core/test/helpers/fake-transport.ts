import type {
  PiEvent,
  PiEventListener,
  PiSession,
  PiSessionOptions,
  PiTransport,
} from '../../src/pi/transport.js'
import type { ModelRef } from '../../src/types.js'
import { ZERO_USAGE } from '../../src/fleet/job.js'

export interface ScriptContext {
  readonly options: PiSessionOptions
  readonly task: string
  readonly emit: (event: PiEvent) => void
}

/** What a fake worker does once prompted. It owns when (or whether) it settles. */
export type Script = (context: ScriptContext) => Promise<void> | void

export interface FakeTransport extends PiTransport {
  readonly opened: PiSessionOptions[]
  readonly sent: { readonly delivery: 'steer' | 'followUp'; readonly text: string }[]
  readonly closed: number
}

export const reply = (text: string): PiEvent[] => [
  { type: 'turn-start' },
  { type: 'assistant-message', text, usage: ZERO_USAGE, stopReason: 'stop' },
  { type: 'settled', aborted: false },
]

export function fakeTransport(
  script: Script,
  models: readonly ModelRef[] = [{ provider: 'openai', id: 'gpt-6.1-sol' }],
): FakeTransport {
  const opened: PiSessionOptions[] = []
  const sent: FakeTransport['sent'][number][] = []
  let closed = 0

  return {
    opened,
    sent,
    get closed() {
      return closed
    },
    async open(options: PiSessionOptions, onEvent: PiEventListener): Promise<PiSession> {
      opened.push(options)
      let isOpen = true
      const emit = (event: PiEvent): void => {
        if (isOpen) onEvent(event)
      }
      return Promise.resolve({
        async prompt(task) {
          setImmediate(() => void script({ options, task, emit }))
          return Promise.resolve()
        },
        async steer(text) {
          sent.push({ delivery: 'steer', text })
          return Promise.resolve()
        },
        async followUp(text) {
          sent.push({ delivery: 'followUp', text })
          return Promise.resolve()
        },
        async abort() {
          emit({ type: 'settled', aborted: true })
          return Promise.resolve()
        },
        async close() {
          if (isOpen) closed += 1
          isOpen = false
          return Promise.resolve()
        },
      })
    },
    async listModels() {
      return Promise.resolve(models)
    },
  }
}
