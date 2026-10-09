import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { providerStatus } from '../src/auth/auth.js'

describe('providerStatus', () => {
  it('counts an auth.json entry or an env key pi accepts, and says how to log in otherwise', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dt-auth-'))
    await writeFile(join(dir, 'auth.json'), JSON.stringify({ openai: { type: 'oauth' } }))
    expect(await providerStatus(dir, ['openai'], {})).toEqual([
      { provider: 'openai', isLoggedIn: true },
    ])

    const empty = await mkdtemp(join(tmpdir(), 'dt-auth-'))
    expect(await providerStatus(empty, ['openai'], { OPENAI_API_KEY: 'sk-test' })).toEqual([
      { provider: 'openai', isLoggedIn: true },
    ])
    const [missing] = await providerStatus(empty, ['openai'], { OPENAI_API_KEY: '' })
    expect(missing).toMatchObject({ isLoggedIn: false })
    expect(missing?.loginHint).toContain('/login openai')
  })
})
