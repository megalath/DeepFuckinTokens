import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it, vi } from 'vitest'

import { CONFIG_FILE, runPi } from '../index.js'
import { tmpRepo } from './helpers/repo.js'

const FAKE_TUI = fileURLToPath(new URL('./fixtures/fake-pi-tui.mjs', import.meta.url))

describe('running pi by hand', () => {
  it("starts the repo's pi against the repo's agent dir and reports its exit code", async () => {
    const { root, agentDir } = await tmpRepo()
    await writeFile(join(root, CONFIG_FILE), JSON.stringify({ agentDir, piCliPath: FAKE_TUI }))
    const out = join(agentDir, 'started.json')
    vi.stubEnv('FAKE_PI_TUI_OUT', out)
    vi.stubEnv('FAKE_PI_TUI_EXIT', '7')

    expect(await runPi(['--version'], { cwd: root })).toBe(7)
    // The same agent dir a worker of this repo reads, so a login made here is the one it finds.
    expect(JSON.parse(await readFile(out, 'utf8'))).toEqual({ argv: ['--version'], agentDir })
  })

  it("refuses a repo whose config is invalid instead of falling back to the user's own pi", async () => {
    const { root } = await tmpRepo()
    await writeFile(join(root, CONFIG_FILE), '{ "maxConcurrent": 0 }')
    await expect(runPi([], { cwd: root })).rejects.toMatchObject({ code: 'config-invalid' })
  })
})
