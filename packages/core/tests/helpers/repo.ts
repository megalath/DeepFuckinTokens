import { mkdir, mkdtemp, realpath, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { git } from './git.js'

/** A throwaway git repo (one commit unless `commit` is false), plus a pi agent dir logged in to OpenAI. */
export async function tmpRepo(
  options: { readonly commit?: boolean } = {},
): Promise<{ root: string; agentDir: string }> {
  // Resolved, because git reports the repo root without symlinks (macOS tmp is one).
  const base = await realpath(await mkdtemp(join(tmpdir(), 'dt-repo-')))
  const root = join(base, 'repo')
  const agentDir = join(base, 'agent')
  await mkdir(root)
  await mkdir(agentDir)
  await writeFile(join(agentDir, 'auth.json'), JSON.stringify({ openai: { type: 'oauth' } }))
  await git(root, ['init', '-q', '-b', 'main'])
  if (options.commit !== false) {
    await writeFile(join(root, 'README.md'), '# fixture\n')
    await git(root, ['add', '-A'])
    await git(root, ['commit', '-q', '-m', 'init'])
  }
  return { root, agentDir }
}
