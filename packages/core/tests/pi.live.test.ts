import { describe, expect, it } from 'vitest'

import { openFleet } from '../index.js'

// DEEPTOKENS_LIVE=1 only. Starts the real pi; the paid test needs `pnpm pi` → `/login openai` first.
describe('live pi', () => {
  it('boots pi in RPC mode and lists the models it holds credentials for', async () => {
    const fleet = await openFleet()
    try {
      const report = await fleet.models()
      expect(Array.isArray(report.available)).toBe(true)
      // pi lists only models it can call, so OpenAI models appear once logged in.
      if (
        report.providers.some(({ provider, isLoggedIn }) => provider === 'openai' && isLoggedIn)
      ) {
        expect(report.available.some((model) => model.provider === 'openai')).toBe(true)
      }
    } finally {
      await fleet.close()
    }
  })

  it('answers a read job on the ChatGPT subscription', async (context) => {
    const fleet = await openFleet()
    try {
      const { providers } = await fleet.models()
      if (!providers.some(({ provider, isLoggedIn }) => provider === 'openai' && isLoggedIn)) {
        context.skip()
        return
      }
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
