#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'

import { openFleet } from '@deeptokens/core'

import { createServer } from './server.js'

const VERSION = '0.1.0'

const fleet = await openFleet()
const server = createServer(fleet, VERSION)

let isShuttingDown = false
async function shutdown(code: number): Promise<never> {
  if (!isShuttingDown) {
    isShuttingDown = true
    await fleet.close().catch((error: unknown) => {
      console.error('deeptokens: shutdown failed', error)
    })
    await server.close().catch(() => undefined)
  }
  process.exit(code)
}

// The host closing our stdin, or signalling us, must never orphan pi workers.
process.stdin.once('end', () => void shutdown(0))
process.once('SIGINT', () => void shutdown(130))
process.once('SIGTERM', () => void shutdown(143))

await server.connect(new StdioServerTransport())
console.error(`deeptokens MCP ${VERSION} ready`)
