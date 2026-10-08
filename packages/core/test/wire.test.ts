import { describe, expect, it } from 'vitest'

import { parseInbound, parseModels } from '../src/pi/wire.js'

const line = (value: unknown): string => JSON.stringify(value)

const usage = {
  input: 10,
  output: 5,
  cacheRead: 2,
  cacheWrite: 1,
  totalTokens: 18,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.25 },
}

describe('parseInbound', () => {
  it('reads a response record', () => {
    expect(
      parseInbound(line({ type: 'response', id: 'dt-1', command: 'prompt', success: true })),
    ).toEqual({
      kind: 'response',
      record: { type: 'response', id: 'dt-1', command: 'prompt', success: true },
    })
  })

  it('flags dialog requests and ignores fire-and-forget UI', () => {
    expect(
      parseInbound(line({ type: 'extension_ui_request', id: 'u1', method: 'confirm', title: 'x' })),
    ).toEqual({ kind: 'dialog', id: 'u1' })
    expect(
      parseInbound(line({ type: 'extension_ui_request', id: 'u2', method: 'notify' })),
    ).toEqual({ kind: 'ignored' })
  })

  it('projects an assistant message_end to text and usage', () => {
    const record = {
      type: 'message_end',
      message: {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'hmm' },
          { type: 'text', text: 'Hello ' },
          { type: 'toolCall', id: 't', name: 'read', arguments: {} },
          { type: 'text', text: 'world' },
        ],
        usage,
        stopReason: 'stop',
        api: 'openai-codex-responses',
      },
    }
    expect(parseInbound(line(record))).toEqual({
      kind: 'event',
      event: {
        type: 'assistant-message',
        text: 'Hello world',
        stopReason: 'stop',
        usage: {
          inputTokens: 10,
          outputTokens: 5,
          cacheReadTokens: 2,
          cacheWriteTokens: 1,
          costUsd: 0.25,
        },
      },
    })
  })

  it('ignores non-assistant message_end and unknown events', () => {
    expect(
      parseInbound(line({ type: 'message_end', message: { role: 'user', content: 'hi' } })),
    ).toEqual({ kind: 'ignored' })
    expect(parseInbound(line({ type: 'compaction_start' }))).toEqual({ kind: 'ignored' })
  })

  it('projects tool and settle events', () => {
    expect(
      parseInbound(line({ type: 'tool_execution_start', toolName: 'read', args: {} })),
    ).toEqual({ kind: 'event', event: { type: 'tool-start', toolName: 'read' } })
    expect(parseInbound(line({ type: 'agent_settled', aborted: false }))).toEqual({
      kind: 'event',
      event: { type: 'settled', aborted: false },
    })
  })

  it('throws on a line that is not JSON', () => {
    expect(() => parseInbound('not json')).toThrow()
  })
})

describe('parseModels', () => {
  it('keeps provider and id', () => {
    expect(
      parseModels({ models: [{ provider: 'openai-codex', id: 'gpt-5.5', contextWindow: 1 }] }),
    ).toEqual([{ provider: 'openai-codex', id: 'gpt-5.5' }])
  })
})
