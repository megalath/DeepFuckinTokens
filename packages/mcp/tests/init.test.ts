import { execFile } from 'node:child_process'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

import { describe, expect, it } from 'vitest'

import { initRepo, initUser, type ClaudeResult } from '../init.js'

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

/** Stands in for the `claude` CLI: records what init asked of it and answers as scripted. */
function fakeClaude(result: ClaudeResult): {
  readonly calls: (readonly string[])[]
  readonly runClaude: (args: readonly string[]) => Promise<ClaudeResult>
} {
  const calls: (readonly string[])[] = []
  return {
    calls,
    runClaude: async (args) => {
      calls.push(args)
      return Promise.resolve(result)
    },
  }
}

const ADDED = { code: 0, output: 'Added stdio MCP server deeptokens to user config' }
const EXISTS = { code: 1, output: 'MCP server deeptokens already exists in user config' }

describe('setting every repo up at the user level', () => {
  it('registers the server with Claude Code and writes the note it loads everywhere', async () => {
    const claudeDir = await tmpDir({ git: false })
    const claude = fakeClaude(ADDED)

    const report = await initUser({ claudeDir, runClaude: claude.runClaude })

    expect(claude.calls).toEqual([
      ['mcp', 'add', '--scope', 'user', 'deeptokens', '--', 'npx', '-y', '@deeptokens/mcp@latest'],
    ])
    expect(report).toEqual({
      mcpConfig: { path: 'Claude Code user config', outcome: 'added' },
      claudeMd: { path: join(claudeDir, 'CLAUDE.md'), outcome: 'added' },
    })
    expect(await read(claudeDir, 'CLAUDE.md')).toMatch(
      /^<!-- deeptokens:start -->\n## deeptokens\n/,
    )
  })

  it('changes nothing the second time', async () => {
    const claudeDir = await tmpDir({ git: false })
    await initUser({ claudeDir, runClaude: fakeClaude(ADDED).runClaude })
    const before = await read(claudeDir, 'CLAUDE.md')

    const report = await initUser({ claudeDir, runClaude: fakeClaude(EXISTS).runClaude })

    expect([report.mcpConfig.outcome, report.claudeMd.outcome]).toEqual(['present', 'present'])
    expect(await read(claudeDir, 'CLAUDE.md')).toBe(before)
  })

  it('keeps what the user CLAUDE.md already holds', async () => {
    const claudeDir = await tmpDir({ git: false })
    await writeFile(join(claudeDir, 'CLAUDE.md'), '# mine\n')

    await initUser({ claudeDir, runClaude: fakeClaude(ADDED).runClaude })

    expect(await read(claudeDir, 'CLAUDE.md')).toMatch(/^# mine\n\n<!-- deeptokens:start -->\n/)
  })

  it('creates the config directory on a machine that has none yet', async () => {
    const claudeDir = join(await tmpDir({ git: false }), 'nested', '.claude')

    await initUser({ claudeDir, runClaude: fakeClaude(ADDED).runClaude })

    expect(await read(claudeDir, 'CLAUDE.md')).toContain('pi_spawn')
  })

  it('writes no note when Claude Code refuses the server', async () => {
    const claudeDir = await tmpDir({ git: false })
    const refused = fakeClaude({ code: 1, output: 'error: unknown option --scope' })

    await expect(initUser({ claudeDir, runClaude: refused.runClaude })).rejects.toThrow(
      /`claude mcp add` failed \(exit 1\): error: unknown option --scope/,
    )
    await expect(read(claudeDir, 'CLAUDE.md')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('writes no note when claude cannot be run at all', async () => {
    const claudeDir = await tmpDir({ git: false })
    const missing = async (): Promise<ClaudeResult> =>
      Promise.reject(new Error('spawn claude ENOENT'))

    await expect(initUser({ claudeDir, runClaude: missing })).rejects.toThrow('spawn claude ENOENT')
    await expect(read(claudeDir, 'CLAUDE.md')).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
