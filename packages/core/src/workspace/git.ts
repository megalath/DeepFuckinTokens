import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'

import { DeepTokensError } from '../errors.js'

const run = promisify(execFile)

/** Repo hooks off, a fixed identity, no signing: worker commits never trigger the user's setup. */
const BASE_ARGS = [
  '-c',
  'core.hooksPath=/dev/null',
  '-c',
  'user.name=deeptokens',
  '-c',
  'user.email=deeptokens@localhost',
  '-c',
  'commit.gpgsign=false',
] as const

export async function git(cwd: string, args: readonly string[]): Promise<string> {
  try {
    const { stdout } = await run('git', [...BASE_ARGS, ...args], {
      cwd,
      maxBuffer: 64 * 1024 * 1024,
    })
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

export interface CappedOutput {
  readonly text: string
  readonly isTruncated: boolean
}

/**
 * Runs git and keeps at most `limitBytes` of its stdout, stopping git once the
 * limit is reached. For output that can be arbitrarily large (patches).
 */
export async function gitCapped(
  cwd: string,
  args: readonly string[],
  limitBytes: number,
): Promise<CappedOutput> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', [...BASE_ARGS, ...args], { cwd, stdio: ['ignore', 'pipe', 'pipe'] })
    const chunks: Buffer[] = []
    let size = 0
    let isTruncated = false
    let stderr = ''
    child.stdout.on('data', (chunk: Buffer) => {
      if (isTruncated) return
      const room = limitBytes - size
      if (chunk.length > room) {
        chunks.push(chunk.subarray(0, room))
        size = limitBytes
        isTruncated = true
        child.kill()
        return
      }
      chunks.push(chunk)
      size += chunk.length
    })
    child.stderr.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString('utf8')).slice(-4_096)
    })
    child.once('error', (error) => {
      reject(new DeepTokensError('git-failed', `git did not start: ${error.message}`))
    })
    child.once('close', (code) => {
      if (code !== 0 && !isTruncated) {
        reject(new DeepTokensError('git-failed', `git ${args.join(' ')} failed: ${stderr.trim()}`))
        return
      }
      // Cutting mid-character is fine for a preview; the decoder marks it.
      resolve({ text: Buffer.concat(chunks).toString('utf8'), isTruncated })
    })
  })
}
