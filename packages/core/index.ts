import { join, resolve } from 'node:path'

import { defaultAgentDir } from './lib/auth/auth.js'
import { loadConfig, type DeepTokensConfig } from './lib/config/config.js'
import { createFleet, type Fleet } from './lib/fleet/fleet.js'
import { DeepTokensError } from './lib/errors.js'
import { runInteractivePi } from './lib/pi/interactive.js'
import { createRpcTransport, defaultPiCliPath } from './lib/pi/rpc-transport.js'
import type { PiTransport } from './lib/pi/transport.js'
import { createWorktrees, gitCommonDir, repoRoot } from './lib/workspace/worktree.js'

export type * from './lib/types.js'
export { THINKING_LEVELS } from './lib/types.js'
export { DeepTokensError, type DeepTokensErrorCode } from './lib/errors.js'
export type { Fleet } from './lib/fleet/fleet.js'
export type { AliasTarget, DeepTokensConfig, DeepTokensConfigInput } from './lib/config/config.js'
export { CONFIG_FILE, parseConfig } from './lib/config/config.js'
export type { PiEvent, PiSession, PiSessionOptions, PiTransport } from './lib/pi/transport.js'
/** The root of the git repository holding a directory; rejects with `git-failed` outside one. */
export { repoRoot as findRepoRoot } from './lib/workspace/worktree.js'

export interface OpenFleetOptions {
  /** Any directory inside the git repo the workers serve. Defaults to the process cwd. */
  readonly cwd?: string
  /** Overrides `deeptokens.config.json`. */
  readonly config?: DeepTokensConfig
  /** Swaps the pi process transport, for tests or other hosts. */
  readonly transport?: PiTransport
}

/** The one way in: finds the repo, loads its config, and wires a fleet to pi. */
export async function openFleet(options: OpenFleetOptions = {}): Promise<Fleet> {
  const root = await repoRoot(resolve(options.cwd ?? process.cwd()))
  const config = options.config ?? (await loadConfig(root))
  const { agentDir, cliPath } = piLocation(root, config)
  const transport =
    options.transport ??
    createRpcTransport({ agentDir, ...(cliPath === undefined ? {} : { cliPath }) })
  const worktreeBase =
    config.worktreeDir === undefined
      ? join(await gitCommonDir(root), 'deeptokens', 'worktrees')
      : resolve(root, config.worktreeDir)
  return createFleet({
    root,
    config,
    agentDir,
    transport,
    worktrees: createWorktrees(root, worktreeBase, config.branchPrefix),
  })
}

export interface RunPiOptions {
  /** A directory inside the repo whose config applies. Defaults to the process cwd. */
  readonly cwd?: string
}

/**
 * Runs pi's own TUI in this terminal and resolves with its exit code. The MCP package's `pi`
 * subcommand calls it; people use it to `/login`.
 *
 * It resolves the pi script and the agent dir exactly as `openFleet` does, so a login made here is
 * the one the workers of that repo find. Outside a git repository there is no config to honour,
 * and it runs the bundled pi against the default agent dir: logging in must work before the first
 * repo is set up.
 */
export async function runPi(args: readonly string[], options: RunPiOptions = {}): Promise<number> {
  const cwd = resolve(options.cwd ?? process.cwd())
  const root = await repoRoot(cwd).catch((error: unknown) => {
    if (error instanceof DeepTokensError && error.code === 'git-failed') return undefined
    throw error
  })
  const { agentDir, cliPath } =
    root === undefined ? { agentDir: defaultAgentDir() } : piLocation(root, await loadConfig(root))
  return runInteractivePi({ cliPath: cliPath ?? defaultPiCliPath(), agentDir, args })
}

/** Paths in the config mean the repo root, not whatever cwd pi runs in. */
function piLocation(
  root: string,
  config: DeepTokensConfig,
): { readonly agentDir: string; readonly cliPath?: string } {
  return {
    agentDir: config.agentDir === undefined ? defaultAgentDir() : resolve(root, config.agentDir),
    ...(config.piCliPath === undefined ? {} : { cliPath: resolve(root, config.piCliPath) }),
  }
}
