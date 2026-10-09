#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'

import { openFleet, runPi, type Fleet } from '@deeptokens/core'

import { createServer } from './server.js'

const VERSION = '0.1.0'

const reason = (error: unknown): string => (error instanceof Error ? error.message : String(error))

// No arguments is the MCP server, which is how a host starts us. `pi` is the one thing a person
// runs by hand: an npm install has no `pnpm pi`, and workers cannot log themselves in.
const [command, ...rest] = process.argv.slice(2)
if (command === 'pi') {
  try {
    process.exit(await runPi(rest))
  } catch (error) {
    console.error(`deeptokens: cannot run pi: ${reason(error)}`)
    process.exit(1)
  }
}
if (command !== undefined) {
  // A typo must not start a server that then sits waiting on a terminal for MCP input.
  console.error(
    `deeptokens: unknown command "${command}"\n` +
      'Usage: deeptokens-mcp        start the MCP server on stdio (what Claude Code runs)\n' +
      '       deeptokens-mcp pi     open pi, to /login openai',
  )
  process.exit(2)
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
