/** Every failure the core reports carries a stable code a caller can branch on. */
export type DeepTokensErrorCode =
  | 'unknown-job'
  | 'unknown-model'
  | 'not-logged-in'
  | 'job-not-settled'
  | 'job-not-running'
  | 'fleet-full'
  | 'fleet-closed'
  | 'pi-failed'
  | 'git-failed'
  | 'config-invalid'

export class DeepTokensError extends Error {
  override readonly name = 'DeepTokensError'
  readonly code: DeepTokensErrorCode

  constructor(code: DeepTokensErrorCode, message: string, options?: ErrorOptions) {
    super(message, options)
    this.code = code
  }
}

export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
