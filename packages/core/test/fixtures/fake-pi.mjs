// A stand-in for `pi --mode rpc`: speaks enough of the protocol to exercise the transport.
// Behaviour comes from FAKE_PI_MODE: "normal" (default), "dialog", "crash-on-prompt".
const mode = process.env.FAKE_PI_MODE ?? 'normal'
const out = (record) => process.stdout.write(`${JSON.stringify(record)}\n`)
const usage = {
  input: 1,
  output: 1,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 2,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
}

process.stderr.write(`argv: ${process.argv.slice(2).join(' ')}\n`)

let buffered = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  buffered += chunk
  let newline
  while ((newline = buffered.indexOf('\n')) !== -1) {
    handle(JSON.parse(buffered.slice(0, newline)))
    buffered = buffered.slice(newline + 1)
  }
})
process.stdin.on('end', () => process.exit(0))

function handle(command) {
  const respond = (data) =>
    out({ type: 'response', id: command.id, command: command.type, success: true, data })
  switch (command.type) {
    case 'get_state':
      return respond({})
    case 'get_available_models':
      return respond({ models: [{ provider: 'openai-codex', id: 'gpt-5.5', contextWindow: 1 }] })
    case 'prompt':
      if (mode === 'crash-on-prompt') {
        process.stderr.write('fatal: out of tokens\n')
        process.exit(3)
      }
      respond({ disposition: 'started' })
      if (mode === 'dialog') {
        out({ type: 'extension_ui_request', id: 'ui-1', method: 'confirm', title: 'Allow?' })
        return
      }
      out({ type: 'turn_start' })
      out({ type: 'tool_execution_start', toolName: 'read', toolCallId: 't1', args: {} })
      out({ type: 'tool_execution_end', toolName: 'read', toolCallId: 't1', isError: false })
      out({
        type: 'message_end',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: `echo: ${command.message}\u2028ok` }],
          usage,
          stopReason: 'stop',
        },
      })
      return out({ type: 'agent_settled', aborted: false })
    case 'extension_ui_response':
      return out({ type: 'agent_settled', aborted: command.cancelled === true })
    case 'refuse':
      return out({
        type: 'response',
        id: command.id,
        command: 'refuse',
        success: false,
        error: 'no',
      })
    default:
      return respond(undefined)
  }
}
