import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import { DeepTokensError, messageOf } from '../errors.js'
import type { ModelRef } from '../types.js'
import { createLineSplitter } from './jsonl.js'
import type { PiEventListener, PiSession, PiSessionOptions, PiTransport } from './transport.js'
import { parseInbound, parseModels, type ResponseRecord } from './wire.js'

export interface RpcTransportOptions {
  /** pi's CLI entry. Defaults to the one bundled with @earendil-works/pi-coding-agent. */
  readonly cliPath?: string
  /** pi's agent dir (auth.json, settings). Defaults to pi's own `~/.pi/agent`. */
  readonly agentDir?: string
  /** Extra flags for every worker, after ours. */
  readonly extraArgs?: readonly string[]
  /** How long `close()` waits for a clean exit before SIGKILL. */
  readonly closeGraceMs?: number
}

const STDERR_TAIL_BYTES = 8_192
const COMMAND_TIMEOUT_MS = 60_000

export function defaultPiCliPath(): string {
  // The package's main is dist/index.js; its CLI bundle sits beside it.
  const main = import.meta.resolve('@earendil-works/pi-coding-agent')
  return fileURLToPath(new URL('./bundle/cli.js', main))
}

/** Drives pi over its RPC protocol, one child process per session. */
export function createRpcTransport(options: RpcTransportOptions = {}): PiTransport {
  const cliPath = options.cliPath ?? defaultPiCliPath()
  const env: NodeJS.ProcessEnv =
    options.agentDir === undefined
      ? process.env
      : { ...process.env, PI_CODING_AGENT_DIR: options.agentDir }
  const graceMs = options.closeGraceMs ?? 5_000

  const start = (args: readonly string[], cwd: string, onEvent: PiEventListener): RpcChild =>
    new RpcChild(
      spawn(process.execPath, [cliPath, '--mode', 'rpc', ...args, ...(options.extraArgs ?? [])], {
        cwd,
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
      }),
      onEvent,
      graceMs,
    )

  return {
    async open(session: PiSessionOptions, onEvent: PiEventListener): Promise<PiSession> {
      const args = [
        '--no-session',
        '--no-mcp',
        '--provider',
        session.model.provider,
        '--model',
        session.model.id,
        '--tools',
        session.tools.join(','),
        ...(session.thinking === undefined ? [] : ['--thinking', session.thinking]),
      ]
      const child = start(args, session.cwd, onEvent)
      await child.ready()
      return {
        prompt: async (text) => {
          await child.command({ type: 'prompt', message: text })
        },
        steer: async (text) => {
          await child.command({ type: 'steer', message: text })
        },
        followUp: async (text) => {
          await child.command({ type: 'follow_up', message: text })
        },
        abort: async () => {
          await child.command({ type: 'abort' })
        },
        close: async () => child.close(),
      }
    },

    async listModels(): Promise<readonly ModelRef[]> {
      const child = start(['--no-session', '--no-mcp'], process.cwd(), () => undefined)
      try {
        await child.ready()
        return parseModels(await child.command({ type: 'get_available_models' }))
      } finally {
        await child.close()
      }
    },
  }
}

interface Pending {
  readonly resolve: (data: unknown) => void
  readonly reject: (error: Error) => void
  readonly timer: NodeJS.Timeout
}

/** One pi process: request/response correlation, event fan-out, lifecycle. */
class RpcChild {
  readonly #child: ChildProcessWithoutNullStreams
  readonly #onEvent: PiEventListener
  readonly #graceMs: number
  readonly #pending = new Map<string, Pending>()
  readonly #exited: Promise<void>
  #nextId = 0
  #stderrTail = ''
  #exitError: Error | undefined

  constructor(child: ChildProcessWithoutNullStreams, onEvent: PiEventListener, graceMs: number) {
    this.#child = child
    this.#onEvent = onEvent
    this.#graceMs = graceMs

    const splitter = createLineSplitter((line) => {
      this.#handleLine(line)
    })
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      splitter.push(chunk)
    })
    child.stdout.on('end', () => {
      splitter.end()
    })
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => {
      this.#stderrTail = (this.#stderrTail + chunk).slice(-STDERR_TAIL_BYTES)
    })
    child.stdin.on('error', () => {
      // A write after exit; the exit handler reports it.
    })

    this.#exited = new Promise((resolve) => {
      child.once('error', (error) => {
        this.#fail(new DeepTokensError('pi-failed', `pi did not start: ${error.message}`))
        resolve()
      })
      child.once('exit', (code, signal) => {
        this.#fail(
          new DeepTokensError(
            'pi-failed',
            `pi exited (code ${String(code)}, signal ${String(signal)}): ${this.#stderrTail.trim()}`,
          ),
        )
        this.#onEvent({ type: 'exited', code, signal, stderrTail: this.#stderrTail })
        resolve()
      })
    })
  }

  /** Resolves once pi answers a command, which means its runtime is up. */
  async ready(): Promise<void> {
    await this.command({ type: 'get_state' })
  }

  async command(command: { readonly type: string } & Record<string, unknown>): Promise<unknown> {
    if (this.#exitError !== undefined) throw this.#exitError
    const id = `dt-${String(++this.#nextId)}`
    const answer = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id)
        reject(new DeepTokensError('pi-failed', `pi did not answer ${command.type} in time`))
      }, COMMAND_TIMEOUT_MS)
      this.#pending.set(id, { resolve, reject, timer })
    })
    this.#write({ ...command, id })
    return answer
  }

  async close(): Promise<void> {
    if (this.#child.exitCode === null && this.#child.signalCode === null) {
      this.#child.stdin.end()
      const killer = setTimeout(() => this.#child.kill('SIGKILL'), this.#graceMs)
      await this.#exited
      clearTimeout(killer)
    }
  }

  #write(record: object): void {
    this.#child.stdin.write(`${JSON.stringify(record)}\n`)
  }

  #handleLine(line: string): void {
    let inbound: ReturnType<typeof parseInbound>
    try {
      inbound = parseInbound(line)
    } catch (error) {
      this.#stderrTail = `${this.#stderrTail}\n[non-JSON stdout] ${messageOf(error)}`.slice(
        -STDERR_TAIL_BYTES,
      )
      return
    }
    switch (inbound.kind) {
      case 'response':
        this.#settle(inbound.record)
        return
      case 'dialog':
        // Workers run unattended: any extension dialog is dismissed, never left hanging.
        this.#write({ type: 'extension_ui_response', id: inbound.id, cancelled: true })
        return
      case 'event':
        this.#onEvent(inbound.event)
        return
      case 'ignored':
        return
    }
  }

  #settle(record: ResponseRecord): void {
    if (record.id === undefined) return
    const pending = this.#pending.get(record.id)
    if (pending === undefined) return
    this.#pending.delete(record.id)
    clearTimeout(pending.timer)
    if (record.success) pending.resolve(record.data)
    else
      pending.reject(
        new DeepTokensError('pi-failed', `pi refused ${record.command}: ${record.error ?? ''}`),
      )
  }

  #fail(error: Error): void {
    this.#exitError ??= error
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(error)
    }
    this.#pending.clear()
  }
}
