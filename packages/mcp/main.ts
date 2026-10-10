#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'

import { openFleet, runPi, type Fleet } from '@deeptokens/core'

import { createInterface } from 'node:readline/promises'

import { initRepo, initUser, USER_CONFIG_LABEL } from './init.js'
import { createServer } from './server.js'

const VERSION = '0.2.0'

const reason = (error: unknown): string => (error instanceof Error ? error.message : String(error))

// No arguments is the MCP server, which is how a host starts us. `pi` and `init` are what a person
// runs by hand: an npm install has no `pnpm pi`, workers cannot log themselves in, and a server
// the repo's CLAUDE.md does not mention goes unused (see init.ts).
const [command, ...rest] = process.argv.slice(2)
if (command === 'pi') {
  try {
    process.exit(await runPi(rest))
  } catch (error) {
    console.error(`deeptokens: cannot run pi: ${reason(error)}`)
    process.exit(1)
  }
}
if (command === 'init') {
  const scope = await chooseScope(rest)
  try {
    const report = scope === 'user' ? await initUser() : await initRepo(process.cwd())
    for (const { path, outcome } of [report.mcpConfig, report.claudeMd]) {
      console.log(`${outcome === 'added' ? 'wrote  ' : 'kept   '} ${path}`)
    }
    console.log(
      'Next: run `npx -y @deeptokens/mcp pi` and `/login openai` if you have not yet, then ' +
        (scope === 'user'
          ? 'restart Claude Code. The server is in every git repo you open, with nothing to approve.'
          : 'open Claude Code here and approve the deeptokens server.'),
    )
    process.exit(0)
  } catch (error) {
    console.error(
      `deeptokens: cannot set up: ${reason(error)}` +
        (scope === 'user'
          ? ''
          : '\nRun init in the directory you open Claude Code in, inside a git repository.'),
    )
    process.exit(1)
  }
}
if (command !== undefined) {
  // A typo must not start a server that then sits waiting on a terminal for MCP input.
  console.error(
    `deeptokens: unknown command "${command}"\n` +
      'Usage: deeptokens-mcp        start the MCP server on stdio (what Claude Code runs)\n' +
      '       deeptokens-mcp init   set Claude Code up; asks user level or project level\n' +
      '                             (--user or --project answers it up front)\n' +
      '       deeptokens-mcp pi     open pi, to /login openai',
  )
  process.exit(2)
}

// The two installs reach different people (see init.ts), and neither is a safe guess: a silent
// project default is what left the server unloaded for someone working across repos. So init
// asks, and where it cannot ask (a script, CI) it stops and names the flags.
async function chooseScope(args: readonly string[]): Promise<'user' | 'project'> {
  const flags = new Set(args)
  const known = args.every((arg) => arg === '--user' || arg === '--project')
  if (!known || flags.size > 1) {
    console.error('deeptokens: init takes --user or --project, and only one of them')
    process.exit(2)
  }
  if (flags.has('--user')) return 'user'
  if (flags.has('--project')) return 'project'
  if (!process.stdin.isTTY) {
    console.error(
      'deeptokens: init needs to know where to install, and there is no terminal to ask on.\n' +
        `  init --user      every repo you open (${USER_CONFIG_LABEL} and your own CLAUDE.md)\n` +
        '  init --project   this repo only (.mcp.json and CLAUDE.md here, for a team to commit)',
    )
    process.exit(2)
  }
  const prompt = createInterface({ input: process.stdin, output: process.stdout })
  try {
    console.log(
      'Do you want to install deeptokens at the user level or the project level?\n' +
        '  user     every repo you open, nothing to approve\n' +
        '  project  this repo only, in files a team can commit',
    )
    for (;;) {
      const answer = (await prompt.question('user or project: ')).trim().toLowerCase()
      if (answer === 'user' || answer === 'u') return 'user'
      if (answer === 'project' || answer === 'p') return 'project'
    }
  } catch {
    // Ctrl+D or Ctrl+C at the question: readline rejects, and a stack trace is no answer to that.
    console.error('\ndeeptokens: init cancelled, nothing was changed')
    process.exit(130)
  } finally {
    prompt.close()
  }
}

let fleet: Fleet
try {
  fleet = await openFleet()
} catch (error) {
  // The host only shows "failed to connect"; stderr is where the reason lands.
  console.error(
    `deeptokens: cannot start: ${reason(error)}\n` +
      'Run the server from inside a git repository, and check deeptokens.config.json if it has one.',
  )
  process.exit(1)
}
const server = createServer(fleet, VERSION)

let shuttingDown: Promise<never> | undefined
async function shutdown(code: number): Promise<never> {
  shuttingDown ??= (async () => {
    await fleet.close().catch((error: unknown) => {
      console.error('deeptokens: shutdown failed', error)
    })
    await server.close().catch(() => undefined)
    process.exit(code)
  })()
  return shuttingDown
}

// Whatever ends us, pi workers and worktrees must not outlive the server.
process.stdin.once('end', () => void shutdown(0))
process.once('SIGINT', () => void shutdown(130))
process.once('SIGTERM', () => void shutdown(143))
// The host closed our stdout (it quit mid-call): replies have nowhere to go, so stop cleanly.
process.stdout.on('error', (error: NodeJS.ErrnoException) => {
  if (error.code !== 'EPIPE') console.error('deeptokens: stdout error', error)
  void shutdown(0)
})
process.on('uncaughtException', (error) => {
  console.error('deeptokens: uncaught exception', error)
  void shutdown(1)
})
process.on('unhandledRejection', (reason) => {
  console.error('deeptokens: unhandled rejection', reason)
})

await server.connect(new StdioServerTransport())
console.error(`deeptokens MCP ${VERSION} ready`)
