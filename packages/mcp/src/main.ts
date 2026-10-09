#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'

import { openFleet, type Fleet } from '@deeptokens/core'

import { createServer } from './server.js'

const VERSION = '0.1.0'

let fleet: Fleet
try {
  fleet = await openFleet()
} catch (error) {
  // The host only shows "failed to connect"; stderr is where the reason lands.
  console.error(
    `deeptokens: cannot start: ${error instanceof Error ? error.message : String(error)}\n` +
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
