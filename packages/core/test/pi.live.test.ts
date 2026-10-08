import { describe, expect, it } from 'vitest'

import { defaultAgentDir, providerStatus } from '../src/auth/auth.js'
import { openFleet } from '../src/index.js'
import { createRpcTransport } from '../src/pi/rpc-transport.js'

// DEEPTOKENS_LIVE=1 only. Starts the real pi; the Codex tests need `pi` → `/login` first.
const codexLoggedIn = async (): Promise<boolean> =>
  (await providerStatus(defaultAgentDir(), ['openai-codex']))[0]?.isLoggedIn === true

describe('live pi', () => {
  it('boots pi in RPC mode and lists the models it holds credentials for', async () => {
    const models = await createRpcTransport().listModels()
    expect(Array.isArray(models)).toBe(true)
    // pi lists only models it can call, so Codex appears once logged in.
    if (await codexLoggedIn()) {
      expect(models.some((model) => model.provider === 'openai-codex')).toBe(true)
    }
  })

  it('answers a read job on the Codex subscription', async (context) => {
    if (!(await codexLoggedIn())) {
      context.skip()
      return
    }
    const fleet = await openFleet()
    try {
      const result = await fleet.run(
        { task: 'Reply with exactly the word pong and nothing else.', model: 'fast' },
        120_000,
      )
      expect(result.job.state).toBe('settled')
      expect(result.text.toLowerCase()).toContain('pong')
    } finally {
      await fleet.close()
    }
  })
})
