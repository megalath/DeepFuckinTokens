import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { createRpcTransport } from '../src/pi/rpc-transport.js'
import type { PiEvent } from '../src/pi/transport.js'

const fakePi = fileURLToPath(new URL('./fixtures/fake-pi.mjs', import.meta.url))

function transportIn(mode: string) {
  process.env['FAKE_PI_MODE'] = mode
  return createRpcTransport({ cliPath: fakePi, closeGraceMs: 1_000 })
}

async function untilEvent(events: PiEvent[], type: PiEvent['type']): Promise<PiEvent> {
  for (let i = 0; i < 200; i += 1) {
    const found = events.find((event) => event.type === type)
    if (found !== undefined) return found
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error(`no ${type} event`)
}

const session = { cwd: process.cwd(), model: { provider: 'openai', id: 'gpt-5.5' } }

describe('rpc transport against a fake pi', () => {
  it('passes the worker flags and streams a run to settled', async () => {
    const events: PiEvent[] = []
    const pi = await transportIn('normal').open(
      { ...session, thinking: 'low', tools: ['read', 'ls'] },
      (event) => events.push(event),
    )
    await pi.prompt('hi')
    await untilEvent(events, 'settled')
    await pi.close()

    expect(events.map((event) => event.type)).toEqual([
      'turn-start',
      'tool-start',
      'tool-end',
      'assistant-message',
      'settled',
      'exited',
    ])
    expect(events[3]).toMatchObject({ text: 'echo: hi ok' })
  })

  it('dismisses extension dialogs instead of hanging', async () => {
    const events: PiEvent[] = []
    const pi = await transportIn('dialog').open({ ...session, tools: ['read'] }, (event) =>
      events.push(event),
    )
    await pi.prompt('hi')
    expect(await untilEvent(events, 'settled')).toEqual({ type: 'settled', aborted: true })
    await pi.close()
  })

  it('reports a crash as exited with stderr, and rejects later commands', async () => {
    const events: PiEvent[] = []
    const pi = await transportIn('crash-on-prompt').open({ ...session, tools: ['read'] }, (event) =>
      events.push(event),
    )
    await expect(pi.prompt('hi')).rejects.toMatchObject({ code: 'pi-failed' })
    expect(await untilEvent(events, 'exited')).toMatchObject({
      code: 3,
      stderrTail: expect.stringContaining('out of tokens') as unknown,
    })
    await expect(pi.steer('more')).rejects.toMatchObject({ code: 'pi-failed' })
  })

  it('lists models through a short-lived process', async () => {
    expect(await transportIn('normal').listModels()).toEqual([
      { provider: 'openai', id: 'gpt-5.5' },
    ])
  })
})
