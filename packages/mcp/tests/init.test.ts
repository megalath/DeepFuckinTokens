import { execFile } from 'node:child_process'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

import { describe, expect, it } from 'vitest'

import { initRepo } from '../init.js'

const run = promisify(execFile)

async function tmpDir(options: { readonly git: boolean }): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dt-init-'))
  if (options.git) await run('git', ['init', '-q'], { cwd: dir })
  return dir
}

const read = async (dir: string, file: string): Promise<string> => readFile(join(dir, file), 'utf8')

describe('setting a repo up', () => {
  it('registers the server and tells the lead to delegate', async () => {
    const dir = await tmpDir({ git: true })
    const report = await initRepo(dir)

    expect(report).toEqual({
      mcpConfig: { path: join(dir, '.mcp.json'), outcome: 'added' },
      claudeMd: { path: join(dir, 'CLAUDE.md'), outcome: 'added' },
    })
    expect(JSON.parse(await read(dir, '.mcp.json'))).toEqual({
      mcpServers: {
        deeptokens: { type: 'stdio', command: 'npx', args: ['-y', '@deeptokens/mcp@latest'] },
      },
    })
    expect(await read(dir, 'CLAUDE.md')).toMatch(
      /^<!-- deeptokens:start -->\n## deeptokens\n\nHand self-contained, well-specified work .* to deeptokens workers with `pi_spawn` or `pi_run` instead of doing it yourself\..*\n<!-- deeptokens:end -->\n$/,
    )
  })

  it('changes nothing the second time', async () => {
    const dir = await tmpDir({ git: true })
    await initRepo(dir)
    const before = [await read(dir, '.mcp.json'), await read(dir, 'CLAUDE.md')]

    const report = await initRepo(dir)

    expect([report.mcpConfig.outcome, report.claudeMd.outcome]).toEqual(['present', 'present'])
    expect([await read(dir, '.mcp.json'), await read(dir, 'CLAUDE.md')]).toEqual(before)
  })

  it('keeps what both files already hold', async () => {
    const dir = await tmpDir({ git: true })
    await writeFile(
      join(dir, '.mcp.json'),
      JSON.stringify({ note: 'ours', mcpServers: { other: { command: 'x' } } }),
    )
    await writeFile(join(dir, 'CLAUDE.md'), '# shop-kit\n\nUse tabs.')

    await initRepo(dir)

    expect(JSON.parse(await read(dir, '.mcp.json'))).toMatchObject({
      note: 'ours',
      mcpServers: { other: { command: 'x' }, deeptokens: { command: 'npx' } },
    })
    expect(await read(dir, 'CLAUDE.md')).toMatch(
      /^# shop-kit\n\nUse tabs\.\n\n<!-- deeptokens:start -->\n/,
    )
  })

  it("leaves a server entry the repo already has, such as a team's pinned version", async () => {
    const dir = await tmpDir({ git: true })
    const pinned = { mcpServers: { deeptokens: { command: 'node', args: ['local.js'] } } }
    await writeFile(join(dir, '.mcp.json'), JSON.stringify(pinned))

    expect((await initRepo(dir)).mcpConfig.outcome).toBe('present')
    expect(JSON.parse(await read(dir, '.mcp.json'))).toEqual(pinned)
  })

  it('writes nothing when .mcp.json cannot be read as a config', async () => {
    const dir = await tmpDir({ git: true })
    await writeFile(join(dir, '.mcp.json'), '{ not json')

    await expect(initRepo(dir)).rejects.toMatchObject({ code: 'config-invalid' })
    await expect(read(dir, 'CLAUDE.md')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('refuses a directory outside a git repository, where the server cannot start', async () => {
    const dir = await tmpDir({ git: false })
    await expect(initRepo(dir)).rejects.toMatchObject({ code: 'git-failed' })
    await expect(read(dir, '.mcp.json')).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
