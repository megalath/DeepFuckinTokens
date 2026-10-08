import type { ModelRef, ThinkingLevel, Usage } from '../types.js'

/**
 * The port between the fleet and pi. The fleet sees these few events and
 * methods, never pi's wire protocol, so a protocol change touches one adapter.
 */
export type PiEvent =
  | { readonly type: 'turn-start' }
  | { readonly type: 'tool-start'; readonly toolName: string }
  | { readonly type: 'tool-end'; readonly toolName: string; readonly isError: boolean }
  | {
      readonly type: 'assistant-message'
      readonly text: string
      readonly usage: Usage
      readonly stopReason: string
      readonly errorMessage?: string
    }
  | { readonly type: 'settled'; readonly aborted: boolean }
  | {
      readonly type: 'exited'
      readonly code: number | null
      readonly signal: string | null
      readonly stderrTail: string
    }

export interface PiSessionOptions {
  readonly cwd: string
  readonly model: ModelRef
  readonly thinking?: ThinkingLevel
  /** Exact tool names to declare to the model; everything else is off. */
  readonly tools: readonly string[]
}

export interface PiSession {
  prompt(text: string): Promise<void>
  /** Delivered after the current turn's tool calls, before the next model call. */
  steer(text: string): Promise<void>
  /** Delivered once the current run settles. */
  followUp(text: string): Promise<void>
  /** Aborts the run in flight and resolves once pi is idle. */
  abort(): Promise<void>
  /** Ends the process: stdin closed, then a kill after a grace period. Idempotent. */
  close(): Promise<void>
}

export type PiEventListener = (event: PiEvent) => void

export interface PiTransport {
  /** Starts a pi process. `onEvent` is attached before any command is sent. */
  open(options: PiSessionOptions, onEvent: PiEventListener): Promise<PiSession>
  listModels(): Promise<readonly ModelRef[]>
}
