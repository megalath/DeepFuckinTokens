import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'

import { DeepTokensError } from '../errors.js'
import type { Changes, JobId } from '../types.js'
import { git, gitCapped } from './git.js'

const PATCH_LIMIT_BYTES = 200_000
const STAT_LIMIT_BYTES = 50_000

export interface Worktree {
  readonly path: string
  readonly branch: string
}

/** Isolated checkouts for write jobs: one branch and directory per job, off the repo's HEAD. */
export interface Worktrees {
  /** Where a job's worktree goes. Pure, so a job can be registered before git runs. */
  plan(id: JobId): Worktree
  create(worktree: Worktree): Promise<void>
  /**
   * Commits everything the worker changed and removes the directory; the branch
   * stays. Once the commit exists nothing here deletes it, whatever fails after.
   */
  harvest(worktree: Worktree, message: string): Promise<Changes | undefined>
  /** Removes the directory and the branch. Safe on a half-made or already-removed worktree. */
  discard(worktree: Worktree): Promise<void>
}

export async function repoRoot(cwd: string): Promise<string> {
  return (await git(cwd, ['rev-parse', '--show-toplevel'])).trim()
}

/** The repo's shared .git directory, absolute, even from inside a linked worktree. */
export async function gitCommonDir(cwd: string): Promise<string> {
  return (await git(cwd, ['rev-parse', '--path-format=absolute', '--git-common-dir'])).trim()
}

/**
 * `base` should sit outside the work tree (the default is inside .git), so a
 * running job never shows up in `git status` or gets staged by `git add -A`.
 */
export function createWorktrees(root: string, base: string, branchPrefix: string): Worktrees {
  const discard = async (worktree: Worktree): Promise<void> => {
    await git(root, ['worktree', 'remove', '--force', worktree.path]).catch(() => undefined)
    await git(root, ['worktree', 'prune']).catch(() => undefined)
    await git(root, ['branch', '-D', worktree.branch]).catch(() => undefined)
  }

  return {
    discard,

    plan: (id) => ({ path: join(base, id), branch: `${branchPrefix}${id}` }),

    async create(worktree) {
      const head = await git(root, ['rev-parse', '--verify', '--quiet', 'HEAD']).catch(() => '')
      if (head.trim() === '') {
        throw new DeepTokensError(
          'git-failed',
          'Write jobs branch off HEAD, and this repo has no commits yet. Commit once, then retry.',
        )
      }
      await mkdir(base, { recursive: true })
      await git(root, ['worktree', 'add', '-b', worktree.branch, worktree.path, 'HEAD'])
    },

    async harvest(worktree, message) {
      await git(worktree.path, ['add', '-A'])
      const staged = await git(worktree.path, ['diff', '--cached', '--name-only'])
      if (staged.trim() === '') {
        await discard(worktree)
        return undefined
      }
      await git(worktree.path, ['commit', '--no-verify', '-m', message])
      const commit = (await git(worktree.path, ['rev-parse', 'HEAD'])).trim()

      // From here on the work is safe on its branch: report what we can, never discard.
      const stat = await gitCapped(
        worktree.path,
        ['show', '--stat', '--format=', 'HEAD'],
        STAT_LIMIT_BYTES,
      ).catch(() => ({ text: '(diffstat unavailable)', isTruncated: true }))
      const patch = await gitCapped(
        worktree.path,
        ['show', '--format=', 'HEAD'],
        PATCH_LIMIT_BYTES,
      ).catch(() => ({ text: '', isTruncated: true }))
      await git(root, ['worktree', 'remove', '--force', worktree.path]).catch(() => undefined)
      return {
        branch: worktree.branch,
        commit,
        stat: stat.text.trim(),
        patch: patch.text,
        isPatchTruncated: patch.isTruncated,
      }
    },
  }
}
