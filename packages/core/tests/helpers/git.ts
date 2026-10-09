import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const run = promisify(execFile)

/** Plain git for arranging and inspecting fixture repos, with an identity so commits work anywhere. */
export async function git(cwd: string, args: readonly string[]): Promise<string> {
  const { stdout } = await run(
    'git',
    [
      '-c',
      'user.name=test',
      '-c',
      'user.email=test@localhost',
      '-c',
      'commit.gpgsign=false',
      ...args,
    ],
    { cwd },
  )
  return stdout
}
