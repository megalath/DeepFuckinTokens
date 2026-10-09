import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { git } from '../../src/workspace/git.js'

/** A throwaway git repo with one commit, plus a pi agent dir logged in to Codex. */
export async function tmpRepo(): Promise<{ root: string; agentDir: string }> {
  const base = await mkdtemp(join(tmpdir(), 'dt-repo-'))
  const root = join(base, 'repo')
  const agentDir = join(base, 'agent')
  await mkdir(root)
  await mkdir(agentDir)
  await writeFile(join(agentDir, 'auth.json'), JSON.stringify({ openai: { type: 'oauth' } }))
  await git(root, ['init', '-q', '-b', 'main'])
  await writeFile(join(root, 'README.md'), '# fixture\n')
  await git(root, ['add', '-A'])
  await git(root, ['commit', '-q', '-m', 'init'])
  return { root, agentDir }
}
