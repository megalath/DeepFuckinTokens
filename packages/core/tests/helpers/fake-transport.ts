import type {
  ModelRef,
  PiEvent,
  PiSession,
  PiSessionOptions,
  PiTransport,
  Usage,
} from '../../index.js'

export const ZERO_USAGE: Usage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  costUsd: 0,
}

export interface ScriptContext {
  readonly options: PiSessionOptions
  readonly task: string
  /** Delivers an event while the session is open, as a well-behaved pi does. */
  readonly emit: (event: PiEvent) => void
  /** Delivers an event even after the fleet closed the session: a pi that talks past its end. */
  readonly emitLate: (event: PiEvent) => void
}

/** What a fake worker does once prompted. It owns when (or whether) it settles. */
export type Script = (context: ScriptContext) => Promise<void> | void

export interface FakeTransportOptions {
  readonly models?: readonly ModelRef[]
  /** How long `close()` takes, to hold a job in its cleanup. */
  readonly closeDelayMs?: number
}

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

export const answers =
  (text: string): Script =>
  ({ emit }) => {
    for (const event of reply(text)) emit(event)
  }

export const hangs: Script = ({ emit }) => {
  emit({ type: 'turn-start' })
}

export function fakeTransport(script: Script, options: FakeTransportOptions = {}): FakeTransport {
  const models = options.models ?? [{ provider: 'openai', id: 'gpt-6.1-sol' }]
  const opened: PiSessionOptions[] = []
  const sent: FakeTransport['sent'][number][] = []
  let closed = 0

  return {
    opened,
    sent,
    get closed() {
      return closed
    },
    async open(session, onEvent): Promise<PiSession> {
      opened.push(session)
      let isOpen = true
      const emit = (event: PiEvent): void => {
        if (isOpen) onEvent(event)
      }
      return Promise.resolve({
        async prompt(task) {
          setImmediate(() => void script({ options: session, task, emit, emitLate: onEvent }))
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
          if (options.closeDelayMs !== undefined) {
            await new Promise((resolve) => setTimeout(resolve, options.closeDelayMs))
          }
        },
      })
    },
    async listModels() {
      return Promise.resolve(models)
    },
  }
}
