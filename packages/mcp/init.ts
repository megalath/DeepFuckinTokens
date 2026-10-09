import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { z } from 'zod'

import { DeepTokensError, findRepoRoot } from '@deeptokens/core'

/*
 * Sets a repo up for deeptokens in one step. `main.ts` calls it for the `init` subcommand, which a
 * person runs once in the directory they open Claude Code in.
 *
 * Registering the server is not enough for the lead to use it. In sandbox runs of the same task
 * (2026-10-09), a lead with only the MCP server never delegated, whether the server's instructions
 * described delegation or ordered it (0 of 3 runs), and neither did one offered the workers as
 * plugin agents (0 of 2). With one imperative line in the repo's CLAUDE.md it delegated every time
 * (2 of 2). So setup has to write that line, and leaving it as a README step would mean a user who
 * skips it gets a server the lead ignores.
 *
 * It writes `.mcp.json` rather than shelling out to `claude mcp add`: the file is the same on every
 * machine, a team can commit it, and setup does not depend on the `claude` binary being on PATH.
 * This is the one place in the package that is not a face over a Fleet, because the files it
 * writes belong to the host (Claude Code), which core knows nothing about.
 */

const SERVER_NAME = 'deeptokens'

/** `@latest` so a restart of the host picks up a new release; a bare name would pin npx's cache. */
const SERVER_ENTRY = { type: 'stdio', command: 'npx', args: ['-y', '@deeptokens/mcp@latest'] }

const NOTE_START = '<!-- deeptokens:start -->'
const NOTE_END = '<!-- deeptokens:end -->'

/** The sentence is the one the sandbox runs proved; reword it only with a fresh run to back it. */
const DELEGATION_NOTE = `${NOTE_START}
## deeptokens

Hand self-contained, well-specified work (mechanical edits, test scaffolding, bulk reading) to deeptokens workers with \`pi_spawn\` or \`pi_run\` instead of doing it yourself. Keep planning and the review of every worker diff.
${NOTE_END}
`

const mcpFile = z.looseObject({ mcpServers: z.record(z.string(), z.unknown()).optional() })

export interface InitStep {
  readonly path: string
  /** `present` means the file already had our entry and was left exactly as it was. */
  readonly outcome: 'added' | 'present'
}

export interface InitReport {
  readonly mcpConfig: InitStep
  readonly claudeMd: InitStep
}

/** Safe to run twice: each file is changed only if it lacks the deeptokens entry. */
export async function initRepo(dir: string): Promise<InitReport> {
  // The server refuses to start outside a git repository, so setting one up there helps nobody.
  await findRepoRoot(dir)
  const mcpPath = join(dir, '.mcp.json')
  const claudePath = join(dir, 'CLAUDE.md')

  // Both files are read and checked before either is written: a broken .mcp.json must not leave
  // a CLAUDE.md that tells the lead to use a server it was never given.
  const mcpText = await readOptional(mcpPath)
  const config = mcpText === undefined ? {} : parseMcpFile(mcpText)
  const claudeText = (await readOptional(claudePath)) ?? ''

  let mcpOutcome: InitStep['outcome'] = 'present'
  if (config.mcpServers?.[SERVER_NAME] === undefined) {
    const merged = { ...config, mcpServers: { ...config.mcpServers, [SERVER_NAME]: SERVER_ENTRY } }
    await writeFile(mcpPath, `${JSON.stringify(merged, null, 2)}\n`)
    mcpOutcome = 'added'
  }

  let claudeOutcome: InitStep['outcome'] = 'present'
  if (!claudeText.includes(NOTE_START)) {
    const gap = claudeText === '' ? '' : claudeText.endsWith('\n') ? '\n' : '\n\n'
    await writeFile(claudePath, `${claudeText}${gap}${DELEGATION_NOTE}`)
    claudeOutcome = 'added'
  }

  return {
    mcpConfig: { path: mcpPath, outcome: mcpOutcome },
    claudeMd: { path: claudePath, outcome: claudeOutcome },
  }
}

function parseMcpFile(text: string): z.output<typeof mcpFile> {
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch (error) {
    throw new DeepTokensError('config-invalid', '.mcp.json is not valid JSON', { cause: error })
  }
  const parsed = mcpFile.safeParse(json)
  if (!parsed.success) {
    throw new DeepTokensError('config-invalid', `.mcp.json: ${z.prettifyError(parsed.error)}`)
  }
  return parsed.data
}

async function readOptional(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8')
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined
    throw error
  }
}
