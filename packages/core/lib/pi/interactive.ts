import { spawn } from 'node:child_process'

import { DeepTokensError } from '../errors.js'

export interface InteractivePiOptions {
  readonly cliPath: string
  readonly agentDir: string
  readonly args: readonly string[]
}

/**
 * Hands the terminal to pi's own TUI and resolves with its exit code. Called by `runPi`, which the
 * MCP package's `pi` subcommand fronts.
 *
 * It exists so a person can `/login` to the same pi, with the same agent dir, that the workers
 * use. Telling them to install and run their own pi was the alternative, but a second copy can be
 * a different version and reads its own agent dir, so a login made there may not be the one a
 * worker finds.
 */
export async function runInteractivePi(options: InteractivePiOptions): Promise<number> {
  const child = spawn(process.execPath, [options.cliPath, ...options.args], {
    env: { ...process.env, PI_CODING_AGENT_DIR: options.agentDir },
    stdio: 'inherit',
  })
  // Ctrl-C belongs to pi while it holds the terminal; dying first would orphan it mid-draw.
  const ignore = (): void => undefined
  process.on('SIGINT', ignore)
  try {
    return await new Promise<number>((resolve, reject) => {
      child.once('error', (error) => {
        reject(new DeepTokensError('pi-failed', `pi did not start: ${error.message}`))
      })
      // A pi that died on a signal has no code; report that as a failure, not as success.
      child.once('exit', (code) => {
        resolve(code ?? 1)
      })
    })
  } finally {
    process.off('SIGINT', ignore)
  }
}
