import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { z } from 'zod'

import { DeepTokensError } from '../errors.js'
import { THINKING_LEVELS, type ModelRef, type ThinkingLevel } from '../types.js'

export const CONFIG_FILE = 'deeptokens.config.json'

const modelRef = z
  .string()
  .regex(/^[^/\s]+\/\S+$/, 'expected provider/model-id')
  .transform((value): ModelRef => {
    const slash = value.indexOf('/')
    return { provider: value.slice(0, slash), id: value.slice(slash + 1) }
  })

const toolList = z.array(z.string().min(1)).min(1).readonly()

/** What an alias resolves to. A bare `provider/model-id` string is shorthand for `{ model }`. */
export interface AliasTarget {
  readonly target: ModelRef
  readonly useFor?: string
  readonly thinking?: ThinkingLevel
}

const aliasTarget = z.union([
  modelRef.transform((target): AliasTarget => ({ target })),
  z
    .object({
      model: modelRef,
      useFor: z.string().min(1).max(200).optional(),
      thinking: z.enum(THINKING_LEVELS).optional(),
    })
    .strict()
    .transform(({ model, useFor, thinking }): AliasTarget => ({
      target: model,
      ...(useFor === undefined ? {} : { useFor }),
      ...(thinking === undefined ? {} : { thinking }),
    })),
])

const DEFAULT_ALIASES = {
  gpt: {
    model: 'openai/gpt-6.1-sol',
    useFor: 'Default for real coding: multi-file changes, features, refactors, code review.',
    thinking: 'medium',
  },
  fast: {
    model: 'openai/gpt-5.3-codex-spark',
    useFor:
      'Mechanical, fully specified work: renames, boilerplate, test scaffolding, summarizing files.',
    thinking: 'low',
  },
  deep: {
    model: 'openai/gpt-6.1-sol',
    useFor:
      'Hard problems: stubborn bugs, concurrency, security-sensitive logic, a second opinion on a design.',
    thinking: 'xhigh',
  },
} as const

export const configSchema = z
  .object({
    defaultModel: z.string().min(1).default('gpt'),
    aliases: z.record(z.string().regex(/^[a-z][a-z0-9-]*$/), aliasTarget).prefault(DEFAULT_ALIASES),
    defaultThinking: z.enum(THINKING_LEVELS).default('medium'),
    maxConcurrent: z.number().int().min(1).max(32).default(3),
    worktreeDir: z.string().min(1).default('.deeptokens/worktrees'),
    branchPrefix: z.string().min(1).default('dt/'),
    /** pi's agent dir; defaults to PI_CODING_AGENT_DIR, then ~/.pi/agent. */
    agentDir: z.string().min(1).optional(),
    piCliPath: z.string().min(1).optional(),
    tools: z
      .object({
        read: toolList.default(['read', 'grep', 'find', 'ls']),
        // No bash until the pi guard extension lands: pi has no permission prompts,
        // and a worktree fences file edits, not shell commands.
        write: toolList.default(['read', 'grep', 'find', 'ls', 'edit', 'write']),
      })
      .prefault({}),
  })
  .strict()
  .superRefine((config, ctx) => {
    if (!(config.defaultModel in config.aliases) && !config.defaultModel.includes('/')) {
      ctx.addIssue({
        code: 'custom',
        path: ['defaultModel'],
        message: `"${config.defaultModel}" is neither an alias nor provider/model-id`,
      })
    }
  })

export type DeepTokensConfig = z.output<typeof configSchema>
export type DeepTokensConfigInput = z.input<typeof configSchema>

export function parseConfig(input: unknown): DeepTokensConfig {
  const parsed = configSchema.safeParse(input)
  if (!parsed.success) {
    throw new DeepTokensError('config-invalid', z.prettifyError(parsed.error))
  }
  return parsed.data
}

/** Reads `deeptokens.config.json` from `root`; a missing file means all defaults. */
export async function loadConfig(root: string): Promise<DeepTokensConfig> {
  let text: string
  try {
    text = await readFile(join(root, CONFIG_FILE), 'utf8')
  } catch (error) {
    if (isMissing(error)) return parseConfig({})
    throw error
  }
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch (error) {
    throw new DeepTokensError('config-invalid', `${CONFIG_FILE} is not valid JSON`, {
      cause: error,
    })
  }
  return parseConfig(json)
}

/** Resolves an alias, or a raw `provider/model-id` with no defaults of its own. */
export function resolveModel(config: DeepTokensConfig, name: string): AliasTarget | undefined {
  const aliased = config.aliases[name]
  if (aliased !== undefined) return aliased
  const raw = modelRef.safeParse(name)
  return raw.success ? { target: raw.data } : undefined
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT'
}
