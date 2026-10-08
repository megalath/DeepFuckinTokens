import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { CONFIG_FILE, loadConfig, parseConfig, resolveModel } from '../src/config/config.js'
import { DeepTokensError } from '../src/errors.js'

describe('config', () => {
  it('defaults to the Codex subscription', () => {
    const config = parseConfig({})
    expect(config.defaultModel).toBe('gpt')
    expect(resolveModel(config, 'gpt')?.provider).toBe('openai-codex')
    expect(config.tools.write).not.toContain('bash')
  })

  it('resolves aliases and raw provider/model ids', () => {
    const config = parseConfig({ aliases: { big: 'openai-codex/gpt-6-sol' }, defaultModel: 'big' })
    expect(resolveModel(config, 'big')).toEqual({ provider: 'openai-codex', id: 'gpt-6-sol' })
    expect(resolveModel(config, 'openai-codex/gpt-5.5')).toEqual({
      provider: 'openai-codex',
      id: 'gpt-5.5',
    })
    expect(resolveModel(config, 'nope')).toBeUndefined()
  })

  it('rejects unknown keys and a dangling default', () => {
    expect(() => parseConfig({ surprise: true })).toThrow(DeepTokensError)
    expect(() => parseConfig({ defaultModel: 'ghost' })).toThrow(/ghost/)
  })

  it('loads the file when present and defaults when not', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dt-config-'))
    expect((await loadConfig(dir)).maxConcurrent).toBe(3)
    await writeFile(join(dir, CONFIG_FILE), JSON.stringify({ maxConcurrent: 7 }))
    expect((await loadConfig(dir)).maxConcurrent).toBe(7)
    await writeFile(join(dir, CONFIG_FILE), '{oops')
    await expect(loadConfig(dir)).rejects.toMatchObject({ code: 'config-invalid' })
  })
})
