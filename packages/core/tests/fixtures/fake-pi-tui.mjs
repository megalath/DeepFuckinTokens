// A stand-in for pi's interactive TUI: records how it was started in the file FAKE_PI_TUI_OUT
// names, then exits with FAKE_PI_TUI_EXIT. It reads no input, so a test never waits on a terminal.
import { writeFileSync } from 'node:fs'

writeFileSync(
  process.env.FAKE_PI_TUI_OUT,
  JSON.stringify({ argv: process.argv.slice(2), agentDir: process.env.PI_CODING_AGENT_DIR }),
)
process.exit(Number(process.env.FAKE_PI_TUI_EXIT ?? 0))
