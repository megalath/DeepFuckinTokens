import { z } from 'zod'

import type { ModelRef, Usage } from '../types.js'
import type { PiEvent } from './transport.js'

/**
 * Pi's stdout records, validated only as deep as the fleet reads them. Unknown
 * record types and extra fields pass through untouched, so pi adding events
 * never breaks a worker.
 */

const responseRecord = z.object({
  type: z.literal('response'),
  id: z.string().optional(),
  command: z.string(),
  success: z.boolean(),
  error: z.string().optional(),
  data: z.unknown().optional(),
})
export type ResponseRecord = z.infer<typeof responseRecord>

const dialogRequestRecord = z.object({
  type: z.literal('extension_ui_request'),
  id: z.string(),
  method: z.enum(['select', 'confirm', 'input', 'editor']),
})

const piUsage = z.object({
  input: z.number(),
  output: z.number(),
  cacheRead: z.number(),
  cacheWrite: z.number(),
  cost: z.object({ total: z.number() }),
})

const assistantMessage = z.object({
  role: z.literal('assistant'),
  content: z.array(z.looseObject({ type: z.string(), text: z.string().optional() })),
  usage: piUsage,
  stopReason: z.string(),
  errorMessage: z.string().optional(),
})

const eventRecord = z.discriminatedUnion('type', [
  z.object({ type: z.literal('turn_start') }),
  z.object({ type: z.literal('tool_execution_start'), toolName: z.string() }),
  z.object({
    type: z.literal('tool_execution_end'),
    toolName: z.string(),
    isError: z.boolean(),
  }),
  z.object({ type: z.literal('message_end'), message: z.looseObject({ role: z.string() }) }),
  z.object({ type: z.literal('agent_settled'), aborted: z.boolean() }),
])

const modelsData = z.object({
  models: z.array(z.looseObject({ provider: z.string(), id: z.string() })),
})

export type InboundRecord =
  | { readonly kind: 'response'; readonly record: ResponseRecord }
  | { readonly kind: 'dialog'; readonly id: string }
  | { readonly kind: 'event'; readonly event: PiEvent }
  | { readonly kind: 'ignored' }

/** Classifies one stdout line. Throws only on a line that is not JSON. */
export function parseInbound(line: string): InboundRecord {
  const json: unknown = JSON.parse(line)

  const response = responseRecord.safeParse(json)
  if (response.success) return { kind: 'response', record: response.data }

  const dialog = dialogRequestRecord.safeParse(json)
  if (dialog.success) return { kind: 'dialog', id: dialog.data.id }

  const event = eventRecord.safeParse(json)
  if (!event.success) return { kind: 'ignored' }
  const projected = projectEvent(event.data)
  return projected === undefined ? { kind: 'ignored' } : { kind: 'event', event: projected }
}

function projectEvent(record: z.infer<typeof eventRecord>): PiEvent | undefined {
  switch (record.type) {
    case 'turn_start':
      return { type: 'turn-start' }
    case 'tool_execution_start':
      return { type: 'tool-start', toolName: record.toolName }
    case 'tool_execution_end':
      return { type: 'tool-end', toolName: record.toolName, isError: record.isError }
    case 'agent_settled':
      return { type: 'settled', aborted: record.aborted }
    case 'message_end': {
      const message = assistantMessage.safeParse(record.message)
      if (!message.success) return undefined
      const { content, usage, stopReason, errorMessage } = message.data
      const text = content
        .filter((block) => block.type === 'text')
        .map((block) => block.text ?? '')
        .join('')
      return {
        type: 'assistant-message',
        text,
        usage: toUsage(usage),
        stopReason,
        ...(errorMessage === undefined ? {} : { errorMessage }),
      }
    }
  }
}

function toUsage(usage: z.infer<typeof piUsage>): Usage {
  return {
    inputTokens: usage.input,
    outputTokens: usage.output,
    cacheReadTokens: usage.cacheRead,
    cacheWriteTokens: usage.cacheWrite,
    costUsd: usage.cost.total,
  }
}

export function parseModels(data: unknown): readonly ModelRef[] {
  return modelsData.parse(data).models.map(({ provider, id }) => ({ provider, id }))
}
