import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import type { JobId } from '../src/types.js'
import { git } from '../src/workspace/git.js'
import { createWorktrees, gitCommonDir } from '../src/workspace/worktree.js'
import { tmpRepo } from './helpers/repo.js'

const id = (value: string): JobId => value as JobId

describe('worktrees', () => {
  it('keeps the commit when the patch is too big to return whole', async () => {
    const { root } = await tmpRepo()
    const worktrees = createWorktrees(root, join(await gitCommonDir(root), 'wt'), 'dt/')
    const worktree = worktrees.plan(id('big'))
    await worktrees.create(worktree)
    await writeFile(join(worktree.path, 'big.txt'), 'line of text\n'.repeat(40_000))

    const changes = await worktrees.harvest(worktree, 'big change')

    expect(changes?.isPatchTruncated).toBe(true)
    expect(Buffer.byteLength(changes?.patch ?? '')).toBeLessThanOrEqual(200_000)
    expect(changes?.stat).toContain('big.txt')
    expect((await git(root, ['rev-parse', 'dt/big'])).trim()).toBe(changes?.commit)
  })

  it('explains that write jobs need a first commit', async () => {
    const root = join(await mkdtemp(join(tmpdir(), 'dt-empty-')), 'repo')
    await mkdir(root)
    await git(root, ['init', '-q', '-b', 'main'])
    const worktrees = createWorktrees(root, join(root, '.git', 'wt'), 'dt/')
    await expect(worktrees.create(worktrees.plan(id('x')))).rejects.toMatchObject({
      code: 'git-failed',
      message: expect.stringContaining('no commits yet') as unknown,
    })
  })
})
