import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

import { DeepTokensError } from '../errors.js'

const run = promisify(execFile)

/** Runs git with repo hooks off and a fixed identity, so worker commits never trigger user hooks. */
export async function git(cwd: string, args: readonly string[]): Promise<string> {
  try {
    const { stdout } = await run(
      'git',
      [
        '-c',
        'core.hooksPath=/dev/null',
        '-c',
        'user.name=deeptokens',
        '-c',
        'user.email=deeptokens@localhost',
        '-c',
        'commit.gpgsign=false',
        ...args,
      ],
      { cwd, maxBuffer: 64 * 1024 * 1024 },
    )
    return stdout
  } catch (error) {
    const stderr =
      typeof error === 'object' && error !== null && 'stderr' in error
        ? String(error.stderr).trim()
        : ''
    throw new DeepTokensError('git-failed', `git ${args.join(' ')} failed: ${stderr}`, {
      cause: error,
    })
  }
}
