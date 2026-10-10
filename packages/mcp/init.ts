import { execFile } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { z } from 'zod'

import { DeepTokensError, findRepoRoot } from '@deeptokens/core'

/*
 * Sets Claude Code up for deeptokens in one step. `main.ts` calls it for the `init` subcommand,
 * which a person runs once: `initRepo` for one repo, `initUser` for every repo they open.
 *
 * Registering the server is not enough for the lead to use it. In sandbox runs of the same task
 * (2026-10-09), a lead with only the MCP server never delegated, whether the server's instructions
 * described delegation or ordered it (0 of 3 runs), and neither did one offered the workers as
 * plugin agents (0 of 2). With one imperative line in the repo's CLAUDE.md it delegated every time
 * (2 of 2). So setup has to write that line, and leaving it as a README step would mean a user who
 * skips it gets a server the lead ignores.
 *
 * The project install writes `.mcp.json` rather than shelling out to `claude mcp add`: the file is
 * the same on every machine, a team can commit it, and setup does not depend on the `claude` binary
 * being on PATH.
 *
 * The user install exists because the project one does not reach a person who works across many
 * repos or in git worktrees: Claude Code holds a `.mcp.json` server back until it is approved per
 * directory, and an uncommitted `.mcp.json` is absent from every worktree, so the server silently
 * never loaded there. A user-scope server needs no approval and is in every directory. That one
 * does go through `claude mcp add`, because the user config is a file Claude Code owns and rewrites
 * while it runs, and its format is not ours to depend on.
 *
 * This is the one place in the package that is not a face over a Fleet, because the files it
 * writes belong to the host (Claude Code), which core knows nothing about.
 */

const SERVER_NAME = 'deeptokens'

/** `@latest` so a restart of the host picks up a new release; a bare name would pin npx's cache. */
const SERVER_COMMAND = ['npx', '-y', '@deeptokens/mcp@latest'] as const
const [SERVER_BIN, ...SERVER_ARGS] = SERVER_COMMAND
const SERVER_ENTRY = { type: 'stdio', command: SERVER_BIN, args: SERVER_ARGS }

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
  /** A file path, or for the user install's server a name for Claude Code's own user config. */
  readonly path: string
  /** `present` means our entry was already there and it was left exactly as it was. */
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

  return {
    mcpConfig: { path: mcpPath, outcome: mcpOutcome },
    claudeMd: { path: claudePath, outcome: await addNote(claudePath, claudeText) },
  }
}

/** What `claude` did with one invocation; stdout and stderr together, since it reports on either. */
export interface ClaudeResult {
  readonly code: number
  readonly output: string
}

export interface InitUserOptions {
  /** Claude Code's config directory, which holds the CLAUDE.md it loads in every repo. */
  readonly claudeDir?: string
  /** The seam tests replace, so `pnpm test` never runs the real `claude` or edits a real config. */
  readonly runClaude?: (args: readonly string[]) => Promise<ClaudeResult>
}

export const USER_CONFIG_LABEL = 'Claude Code user config'

/** Safe to run twice: a server Claude Code already has, and a note already written, are left. */
export async function initUser(options: InitUserOptions = {}): Promise<InitReport> {
  const claudeDir = options.claudeDir ?? defaultClaudeDir()
  const runClaude = options.runClaude ?? runClaudeCli
  const claudePath = join(claudeDir, 'CLAUDE.md')

  // Read before registering, for the same reason initRepo does: an unreadable CLAUDE.md must
  // fail before the server is added, not after.
  const claudeText = (await readOptional(claudePath)) ?? ''

  const { code, output } = await runClaude([
    'mcp',
    'add',
    '--scope',
    'user',
    SERVER_NAME,
    '--',
    ...SERVER_COMMAND,
  ])
  let mcpOutcome: InitStep['outcome'] = 'added'
  if (code !== 0) {
    // `claude mcp add` has no "if absent" flag and exits 1 on a name it already holds. Asking
    // first with `claude mcp get` would start the server just to check, so the refusal is read
    // instead; any other wording, including a reworded refusal, fails loudly with claude's text.
    if (!/already exists/i.test(output)) {
      throw new Error(`\`claude mcp add\` failed (exit ${String(code)}): ${output.trim()}`)
    }
    mcpOutcome = 'present'
  }

  await mkdir(claudeDir, { recursive: true })
  return {
    mcpConfig: { path: USER_CONFIG_LABEL, outcome: mcpOutcome },
    claudeMd: { path: claudePath, outcome: await addNote(claudePath, claudeText) },
  }
}

async function addNote(path: string, text: string): Promise<InitStep['outcome']> {
  if (text.includes(NOTE_START)) return 'present'
  const gap = text === '' ? '' : text.endsWith('\n') ? '\n' : '\n\n'
  await writeFile(path, `${text}${gap}${DELEGATION_NOTE}`)
  return 'added'
}

/** CLAUDE_CONFIG_DIR is Claude Code's own override; ignoring it would write a note it never loads. */
function defaultClaudeDir(): string {
  const override = process.env['CLAUDE_CONFIG_DIR']
  return override === undefined || override === '' ? join(homedir(), '.claude') : override
}

async function runClaudeCli(args: readonly string[]): Promise<ClaudeResult> {
  return new Promise((resolve, reject) => {
    execFile('claude', [...args], (error, stdout, stderr) => {
      const output = `${stdout}${stderr}`
      if (error === null) {
        resolve({ code: 0, output })
      } else if (typeof error.code === 'number') {
        resolve({ code: error.code, output })
      } else {
        // No exit code means claude never ran (not installed, not on PATH, killed).
        reject(
          new Error(
            `could not run \`claude\` (${error.message}). ` +
              'The user install needs Claude Code on PATH; use `init --project` without it.',
            { cause: error },
          ),
        )
      }
    })
  })
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
