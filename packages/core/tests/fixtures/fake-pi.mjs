// A stand-in for `pi --mode rpc`: speaks enough of the protocol to exercise the pi adapter
// end to end. Behaviour comes from FAKE_PI_MODE:
//   normal (default)         one tool call, one answer, settles
//   dialog                   asks an extension dialog and settles once it is answered
//   crash-on-prompt          dies with exit code 3 when prompted
//   garbage-crash-on-prompt  prints a non-JSON line on boot, then crash-on-prompt
//   mute                     never answers anything
//   hang                     starts a turn and never settles; echoes steer and follow-up messages
//   wire                     every record shape the adapter must classify, then settles
//   model-error              the model's last message is an error
//   refuse-prompt            answers the prompt with success: false
//   framing                  awkward JSONL framing, then exits with code 4
//   unterminated-models      answers get_available_models without a final LF and closes stdout
import { closeSync } from 'node:fs'

const mode = process.env.FAKE_PI_MODE ?? 'normal'
const raw = (text) => process.stdout.write(text)
const out = (record) => raw(`${JSON.stringify(record)}\n`)
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const usage = {
  input: 1,
  output: 1,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 2,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
}
const assistant = (content, extra = {}) => ({
  type: 'message_end',
  message: { role: 'assistant', content, usage, stopReason: 'stop', ...extra },
})

process.stderr.write(`argv: ${process.argv.slice(2).join(' ')}\n`)
if (mode === 'garbage-crash-on-prompt') raw('not json\n')

let buffered = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  buffered += chunk
  let newline
  while ((newline = buffered.indexOf('\n')) !== -1) {
    void handle(JSON.parse(buffered.slice(0, newline)))
    buffered = buffered.slice(newline + 1)
  }
})
process.stdin.on('end', () => process.exit(0))

async function handle(command) {
  if (mode === 'mute') return
  const respond = (data) =>
    out({ type: 'response', id: command.id, command: command.type, success: true, data })
  switch (command.type) {
    case 'get_state':
      return respond({})
    case 'get_available_models': {
      const data = { models: [{ provider: 'openai', id: 'gpt-5.5', contextWindow: 1 }] }
      if (mode !== 'unterminated-models') return respond(data)
      // The last record before stdout ends carries no LF; the reader must still deliver it.
      raw(
        JSON.stringify({
          type: 'response',
          id: command.id,
          command: command.type,
          success: true,
          data,
        }),
      )
      return closeSync(1)
    }
    case 'prompt':
      return prompt(command, respond)
    case 'steer':
    case 'follow_up':
      respond(undefined)
      return out(assistant([{ type: 'text', text: `${command.type}: ${command.message}` }]))
    case 'extension_ui_response':
      return out({ type: 'agent_settled', aborted: command.cancelled === true })
    default:
      return respond(undefined)
  }
}

async function prompt(command, respond) {
  if (mode.endsWith('crash-on-prompt')) {
    process.stderr.write('fatal: out of tokens\n')
    process.exit(3)
  }
  if (mode === 'refuse-prompt') {
    return out({ type: 'response', id: command.id, command: 'prompt', success: false, error: 'no' })
  }
  respond({ disposition: 'started' })
  switch (mode) {
    case 'dialog':
      return out({ type: 'extension_ui_request', id: 'ui-1', method: 'confirm', title: 'Allow?' })
    case 'hang':
      return out({ type: 'turn_start' })
    case 'model-error':
      out(assistant([], { stopReason: 'error', errorMessage: 'rate limited' }))
      return out({ type: 'agent_settled', aborted: false })
    case 'wire':
      // Fire-and-forget UI: answering it would settle this run as aborted (see above).
      out({ type: 'extension_ui_request', id: 'ui-2', method: 'notify', message: 'fyi' })
      out({ type: 'message_end', message: { role: 'user', content: 'hi' } })
      out({ type: 'compaction_start' })
      out({ type: 'turn_start' })
      out({ type: 'tool_execution_start', toolName: 'read', toolCallId: 't1', args: {} })
      out({ type: 'tool_execution_end', toolName: 'read', toolCallId: 't1', isError: false })
      out(
        assistant(
          [
            { type: 'thinking', thinking: 'hmm' },
            { type: 'text', text: 'Hello ' },
            { type: 'toolCall', id: 't', name: 'read', arguments: {} },
            { type: 'text', text: 'world' },
          ],
          {
            api: 'openai-codex-responses',
            usage: {
              input: 10,
              output: 5,
              cacheRead: 2,
              cacheWrite: 1,
              totalTokens: 18,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.25 },
            },
          },
        ),
      )
      return out({ type: 'agent_settled', aborted: false })
    case 'framing': {
      // One record split across writes, CRLF endings, blank lines, and the two Unicode
      // line separators that JSON allows inside a string.
      raw('{"type":"turn_')
      await pause(20)
      raw('start"}\r\n\r\n\n')
      const message = JSON.stringify(assistant([{ type: 'text', text: 'a\u2028b\u2029c' }]))
      raw(message.slice(0, 30))
      await pause(20)
      raw(`${message.slice(30)}\r\n`)
      // Long enough for the reader to drain stdout before the exit is reported.
      await pause(150)
      process.stderr.write('bye\n')
      return process.exit(4)
    }
    default:
      out({ type: 'turn_start' })
      out({ type: 'tool_execution_start', toolName: 'read', toolCallId: 't1', args: {} })
      out({ type: 'tool_execution_end', toolName: 'read', toolCallId: 't1', isError: false })
      out(assistant([{ type: 'text', text: `echo: ${command.message}\u2028ok` }]))
      return out({ type: 'agent_settled', aborted: false })
  }
}
