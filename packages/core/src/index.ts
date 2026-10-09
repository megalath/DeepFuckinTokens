import { join, resolve } from 'node:path'

import { defaultAgentDir } from './auth/auth.js'
import { loadConfig, type DeepTokensConfig } from './config/config.js'
import { createFleet, type Fleet } from './fleet/fleet.js'
import { createRpcTransport } from './pi/rpc-transport.js'
import type { PiTransport } from './pi/transport.js'
import { createWorktrees, gitCommonDir, repoRoot } from './workspace/worktree.js'

export type * from './types.js'
export { THINKING_LEVELS } from './types.js'
export { DeepTokensError, type DeepTokensErrorCode } from './errors.js'
export type { Fleet } from './fleet/fleet.js'
export type { AliasTarget, DeepTokensConfig, DeepTokensConfigInput } from './config/config.js'
export { CONFIG_FILE, parseConfig } from './config/config.js'
export type { PiEvent, PiSession, PiSessionOptions, PiTransport } from './pi/transport.js'

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
  // Paths in the config mean the repo root, not whatever cwd a worker runs in.
  const agentDir =
    config.agentDir === undefined ? defaultAgentDir() : resolve(root, config.agentDir)
  const transport =
    options.transport ??
    createRpcTransport({
      agentDir,
      ...(config.piCliPath === undefined ? {} : { cliPath: resolve(root, config.piCliPath) }),
    })
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
