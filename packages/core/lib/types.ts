/** Public vocabulary of @deeptokens/core. Everything a caller sees is declared here. */

declare const jobIdBrand: unique symbol
export type JobId = string & { readonly [jobIdBrand]: true }

export const THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const
export type ThinkingLevel = (typeof THINKING_LEVELS)[number]

/** `read` jobs inspect the repo in place. `write` jobs edit an isolated git worktree. */
export type JobMode = 'read' | 'write'

export interface TaskSpec {
  /** The full instruction. Workers start cold: name files, acceptance criteria, test commands. */
  readonly task: string
  /** An alias from config (`gpt`, `fast`) or a raw `provider/model-id`. Defaults to config. */
  readonly model?: string
  readonly mode?: JobMode
  readonly thinking?: ThinkingLevel
}

export interface ModelRef {
  readonly provider: string
  readonly id: string
}

export interface Usage {
  readonly inputTokens: number
  readonly outputTokens: number
  readonly cacheReadTokens: number
  readonly cacheWriteTokens: number
  /** pi's estimate at API list prices. On a subscription login nothing is billed per call. */
  readonly costUsd: number
}

export type JobState = 'starting' | 'running' | 'settled' | 'failed' | 'killed'

export type Workspace =
  | { readonly kind: 'shared'; readonly path: string }
  | { readonly kind: 'worktree'; readonly path: string; readonly branch: string }

export interface JobSnapshot {
  readonly id: JobId
  readonly state: JobState
  readonly task: string
  readonly mode: JobMode
  readonly model: ModelRef
  readonly workspace: Workspace
  readonly startedAt: string
  readonly endedAt?: string
  readonly turns: number
  readonly toolCalls: number
  readonly lastTool?: string
  readonly usage: Usage
  /** The latest assistant text, complete once the job has settled. */
  readonly lastText?: string
  readonly error?: string
}

export interface Changes {
  /** Branch holding the worker's commit. Merge, cherry-pick or delete it. */
  readonly branch: string
  readonly commit: string
  readonly stat: string
  readonly patch: string
  readonly isPatchTruncated: boolean
}

export interface JobResult {
  readonly job: JobSnapshot
  readonly text: string
  /** Present for `write` jobs that changed something. */
  readonly changes?: Changes
}

export interface ProviderStatus {
  readonly provider: string
  readonly isLoggedIn: boolean
  readonly loginHint?: string
}

/** A named model choice: what it runs, what it is for, and its default effort. */
export interface ModelRoute {
  readonly alias: string
  readonly target: ModelRef
  /** One line telling the lead when to pick this alias. */
  readonly useFor?: string
  /** Effort used when a job names this alias and no `thinking`. pi clamps it per model. */
  readonly thinking?: ThinkingLevel
}

export interface ModelReport {
  readonly aliases: readonly (ModelRoute & { readonly isAvailable: boolean })[]
  readonly defaultModel: string
  readonly defaultThinking: ThinkingLevel
  readonly providers: readonly ProviderStatus[]
  /** Models pi holds credentials for, among the aliased providers. */
  readonly available: readonly ModelRef[]
}
