import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

import type { ProviderStatus } from '../types.js'

/** Works from a clone and from an npm install alike, which `pnpm pi` does not. */
const PI_COMMAND = 'npx -y @deeptokens/mcp pi'

const LOGIN_HINTS: Readonly<Record<string, string>> = {
  openai: `Run \`${PI_COMMAND}\`, type \`/login openai\`, choose "Sign in with ChatGPT" and finish in the browser (headless: paste the final redirect URL back into pi). pi refreshes the token itself.`,
  'openai-codex': `Legacy provider. Prefer \`openai\` with Sign in with ChatGPT. Otherwise run \`${PI_COMMAND}\`, type \`/login openai-codex\`.`,
}

/** Env vars pi itself accepts as credentials for a provider. */
const ENV_KEYS: Readonly<Record<string, readonly string[]>> = {
  openai: ['OPENAI_API_KEY'],
}

/**
 * Providers whose credentials we know how to recognise. Anything else (other
 * env keys, models.json providers, local servers) is left to pi to accept or refuse.
 */
export function isCheckedProvider(provider: string): boolean {
  return provider in LOGIN_HINTS
}

export function defaultAgentDir(): string {
  return process.env['PI_CODING_AGENT_DIR'] ?? join(homedir(), '.pi', 'agent')
}

/**
 * Which providers pi holds credentials for: a key in auth.json, or an env var
 * pi reads for that provider. Reads only names, never token values.
 */
export async function providerStatus(
  agentDir: string,
  providers: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): Promise<readonly ProviderStatus[]> {
  const stored = await storedProviders(agentDir)
  return providers.map((provider) => {
    const isLoggedIn =
      stored.has(provider) || (ENV_KEYS[provider] ?? []).some((key) => (env[key] ?? '') !== '')
    const hint = LOGIN_HINTS[provider] ?? `Run \`${PI_COMMAND}\`, type \`/login ${provider}\`.`
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
