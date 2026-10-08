import { mkdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'

import type { Changes, JobId } from '../types.js'
import { git } from './git.js'

const PATCH_LIMIT_BYTES = 200_000

export interface Worktree {
  readonly path: string
  readonly branch: string
}

/** Isolated checkouts for write jobs: one branch and directory per job, off the repo's HEAD. */
export interface Worktrees {
  create(id: JobId): Promise<Worktree>
  /** Commits everything the worker changed and removes the directory; the branch stays. */
  harvest(worktree: Worktree, message: string): Promise<Changes | undefined>
  /** Removes the directory and the branch. Safe to call on a half-made worktree. */
  discard(worktree: Worktree): Promise<void>
}

export async function repoRoot(cwd: string): Promise<string> {
  return (await git(cwd, ['rev-parse', '--show-toplevel'])).trim()
}

export function createWorktrees(root: string, dir: string, branchPrefix: string): Worktrees {
  const base = resolve(root, dir)

  return {
    async create(id) {
      const worktree = { path: join(base, id), branch: `${branchPrefix}${id}` }
      await mkdir(base, { recursive: true })
      await git(root, ['worktree', 'add', '-b', worktree.branch, worktree.path, 'HEAD'])
      return worktree
    },

    async harvest(worktree, message) {
      await git(worktree.path, ['add', '-A'])
      const staged = await git(worktree.path, ['diff', '--cached', '--name-only'])
      if (staged.trim() === '') {
        await this.discard(worktree)
        return undefined
      }
      await git(worktree.path, ['commit', '--no-verify', '-m', message])
      const commit = (await git(worktree.path, ['rev-parse', 'HEAD'])).trim()
      const stat = (await git(worktree.path, ['show', '--stat', '--format=', 'HEAD'])).trim()
      const fullPatch = await git(worktree.path, ['show', '--format=', 'HEAD'])
      await git(root, ['worktree', 'remove', '--force', worktree.path])
      const isPatchTruncated = fullPatch.length > PATCH_LIMIT_BYTES
      return {
        branch: worktree.branch,
        commit,
        stat,
        patch: isPatchTruncated ? fullPatch.slice(0, PATCH_LIMIT_BYTES) : fullPatch,
        isPatchTruncated,
      }
    },

    async discard(worktree) {
      await git(root, ['worktree', 'remove', '--force', worktree.path]).catch(() => undefined)
      await git(root, ['worktree', 'prune']).catch(() => undefined)
      await git(root, ['branch', '-D', worktree.branch]).catch(() => undefined)
    },
  }
}
