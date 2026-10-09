import { rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { describe, expect, it, vi } from 'vitest'

import { CONFIG_FILE, DeepTokensError, openFleet, parseConfig } from '../index.js'
import { answers, fakeTransport, hangs } from './helpers/fake-transport.js'
import { scriptedFleet } from './helpers/fleet.js'
import { tmpRepo } from './helpers/repo.js'

describe('config', () => {
  it('defaults to OpenAI routes that each say what they are for', () => {
    const config = parseConfig({})
    expect(config.defaultModel).toBe('gpt')
    expect(Object.keys(config.aliases)).toEqual(['gpt', 'fast', 'deep'])
    for (const route of Object.values(config.aliases)) {
      expect(route.target.provider).toBe('openai')
      expect(route.useFor).toBeTruthy()
      expect(route.thinking).toBeDefined()
    }
    expect(config.tools.write).not.toContain('bash')
  })

  it('takes full alias objects and bare provider/model-id shorthand', async () => {
    const { fleet, transport } = await scriptedFleet(answers('ok'), {
      defaultModel: 'big',
      aliases: {
        big: { model: 'openai/gpt-6-sol', useFor: 'big jobs', thinking: 'high' },
        plain: 'openai/gpt-5.5',
      },
    })
    expect(fleet.routes()).toEqual([
      {
        alias: 'big',
        target: { provider: 'openai', id: 'gpt-6-sol' },
        useFor: 'big jobs',
        thinking: 'high',
      },
      { alias: 'plain', target: { provider: 'openai', id: 'gpt-5.5' } },
    ])
    // A raw provider/model-id is a route with no defaults of its own.
    await fleet.run({ task: 'x', model: 'openai/gpt-6-luna' }, 5_000)
    expect(transport.opened[0]?.model).toEqual({ provider: 'openai', id: 'gpt-6-luna' })
    await expect(fleet.spawn({ task: 'x', model: 'nope' })).rejects.toMatchObject({
      code: 'unknown-model',
    })
  })

  it('rejects a malformed alias', () => {
    expect(() => parseConfig({ aliases: { x: { model: 'no-slash' } } })).toThrow(DeepTokensError)
    expect(() => parseConfig({ aliases: { x: { model: 'a/b', thinking: 'ludicrous' } } })).toThrow(
      DeepTokensError,
    )
    expect(() => parseConfig({ aliases: { x: { model: 'a/b', extra: 1 } } })).toThrow(
      DeepTokensError,
    )
  })

  it('rejects unknown keys and a dangling default', () => {
    expect(() => parseConfig({ surprise: true })).toThrow(DeepTokensError)
    expect(() => parseConfig({ defaultModel: 'ghost' })).toThrow(/ghost/)
  })

  it('loads the repo file when present and defaults when not', async () => {
    const { root } = await tmpRepo()
    const open = async () => openFleet({ cwd: root, transport: fakeTransport(hangs) })

    expect((await open()).routes().map((route) => route.alias)).toEqual(['gpt', 'fast', 'deep'])
    await writeFile(
      join(root, CONFIG_FILE),
      JSON.stringify({ defaultModel: 'solo', aliases: { solo: 'openai/gpt-5.5' } }),
    )
    expect((await open()).routes().map((route) => route.alias)).toEqual(['solo'])
    await writeFile(join(root, CONFIG_FILE), '{oops')
    await expect(open()).rejects.toMatchObject({ code: 'config-invalid' })
  })
})

describe('logins', () => {
  it('counts an auth.json entry or an env key pi accepts, and says how to log in otherwise', async () => {
    const { fleet, agentDir } = await scriptedFleet(hangs)
    vi.stubEnv('OPENAI_API_KEY', '')
    expect((await fleet.models()).providers).toEqual([{ provider: 'openai', isLoggedIn: true }])

    await rm(join(agentDir, 'auth.json'))
    vi.stubEnv('OPENAI_API_KEY', 'sk-test')
    expect((await fleet.models()).providers).toEqual([{ provider: 'openai', isLoggedIn: true }])

    vi.stubEnv('OPENAI_API_KEY', '')
    const [missing] = (await fleet.models()).providers
    expect(missing).toMatchObject({ isLoggedIn: false })
    expect(missing?.loginHint).toContain('/login openai')
  })

  it("reads pi's agent dir from PI_CODING_AGENT_DIR when the config names none", async () => {
    const { root, agentDir } = await tmpRepo()
    vi.stubEnv('OPENAI_API_KEY', '')
    vi.stubEnv('PI_CODING_AGENT_DIR', agentDir)
    const fleet = await openFleet({ cwd: root, transport: fakeTransport(hangs) })
    expect((await fleet.models()).providers).toEqual([{ provider: 'openai', isLoggedIn: true }])
  })
})
