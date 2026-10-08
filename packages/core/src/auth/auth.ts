import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

import type { ProviderStatus } from '../types.js'

const LOGIN_HINTS: Readonly<Record<string, string>> = {
  'openai-codex':
    'Run `pi`, type `/login`, choose OpenAI ChatGPT Plus/Pro (Codex), and finish in the browser. pi refreshes the token itself.',
}

export function defaultAgentDir(): string {
  return process.env['PI_CODING_AGENT_DIR'] ?? join(homedir(), '.pi', 'agent')
}

/**
 * Which providers pi holds credentials for. Reads only the key names of
 * auth.json; token values never leave pi's file.
 */
export async function providerStatus(
  agentDir: string,
  providers: readonly string[],
): Promise<readonly ProviderStatus[]> {
  const stored = await storedProviders(agentDir)
  return providers.map((provider) => {
    const isLoggedIn = stored.has(provider)
    const hint = LOGIN_HINTS[provider] ?? `Run \`pi\`, type \`/login ${provider}\`.`
    return isLoggedIn ? { provider, isLoggedIn } : { provider, isLoggedIn, loginHint: hint }
  })
}

async function storedProviders(agentDir: string): Promise<ReadonlySet<string>> {
  try {
    const json: unknown = JSON.parse(await readFile(join(agentDir, 'auth.json'), 'utf8'))
    return typeof json === 'object' && json !== null ? new Set(Object.keys(json)) : new Set()
  } catch {
    return new Set()
  }
}
