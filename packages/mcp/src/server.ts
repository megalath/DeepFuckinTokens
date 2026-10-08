import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'

import { DeepTokensError, THINKING_LEVELS, type Fleet, type TaskSpec } from '@deeptokens/core'

const INSTRUCTIONS = `deeptokens runs pi coding-agent workers on non-Anthropic models (OpenAI via the user's ChatGPT/Codex subscription). You are the lead; workers are contractors.

Delegate: self-contained, well-specified work (mechanical edits, test scaffolding, bulk reading and summarizing, a second model's opinion on a design or diff).
Keep: planning, architecture, anything touching secrets, auth or payments, and the review of every worker diff.

Workers start cold. Brief them like a contractor: the files involved, the acceptance criteria, what not to touch.
mode "read" (default) looks at the repo in place. mode "write" edits a private git worktree off HEAD (uncommitted changes in the main tree are not there) and commits to branch dt/<jobId>; review the patch, then merge it or delete the branch.
For parallel work, pi_spawn several jobs, then pi_wait on each.`

const jobId = z.string().describe('The id pi_spawn or pi_run returned.')
const taskShape = {
  task: z
    .string()
    .min(1)
    .describe(
      'Complete instructions: files, acceptance criteria, constraints. Workers start cold.',
    ),
  model: z
    .string()
    .optional()
    .describe(
      'An alias from pi_models (e.g. "gpt", "fast") or provider/model-id. Omit for the default.',
    ),
  mode: z
    .enum(['read', 'write'])
    .optional()
    .describe(
      '"read" (default): inspect in place. "write": edit an isolated worktree, get a commit back.',
    ),
  thinking: z.enum(THINKING_LEVELS).optional().describe('Reasoning effort. Omit for the default.'),
}

type TaskInput = { [K in keyof TaskSpec]-?: TaskSpec[K] | undefined } & { task: string }

/** Zod reports a missing optional as `undefined`; core's TaskSpec wants it absent. */
function toSpec(input: TaskInput): TaskSpec {
  const { task, model, mode, thinking } = input
  return {
    task,
    ...(model === undefined ? {} : { model }),
    ...(mode === undefined ? {} : { mode }),
    ...(thinking === undefined ? {} : { thinking }),
  }
}

const ok = (value: unknown): CallToolResult => ({
  content: [{ type: 'text', text: JSON.stringify(value, null, 2) }],
})

const failed = (error: unknown): CallToolResult => ({
  isError: true,
  content: [
    {
      type: 'text',
      text:
        error instanceof DeepTokensError
          ? `${error.code}: ${error.message}`
          : `internal: ${error instanceof Error ? error.message : String(error)}`,
    },
  ],
})

async function answer(work: () => Promise<unknown>): Promise<CallToolResult> {
  try {
    return ok(await work())
  } catch (error) {
    return failed(error)
  }
}

const seconds = (value: number): number => value * 1_000

/** The MCP face of a fleet: eight tools, each a thin call into it. */
export function createServer(fleet: Fleet, version: string): McpServer {
  const server = new McpServer({ name: 'deeptokens', version }, { instructions: INSTRUCTIONS })

  server.registerTool(
    'pi_run',
    {
      title: 'Run a pi worker and wait',
      description:
        'Runs one task on a pi worker and waits for its answer (killed if it outlives timeoutSec). Best for jobs under ~5 minutes. Write jobs return the commit, diffstat and patch.',
      inputSchema: {
        ...taskShape,
        timeoutSec: z.number().int().min(10).max(600).default(300),
      },
    },
    async ({ timeoutSec, ...spec }) =>
      answer(async () => fleet.run(toSpec(spec), seconds(timeoutSec))),
  )

  server.registerTool(
    'pi_spawn',
    {
      title: 'Start a pi worker',
      description:
        'Starts a task on a pi worker in the background and returns its job at once. Follow with pi_wait, then pi_collect.',
      inputSchema: taskShape,
    },
    async (spec) => answer(async () => fleet.spawn(toSpec(spec))),
  )

  server.registerTool(
    'pi_wait',
    {
      title: 'Wait for a pi job',
      description:
        'Waits until the job is final (settled, failed, killed) or timeoutSec passes, then returns its state. Call again if it is still running.',
      inputSchema: { jobId, timeoutSec: z.number().int().min(1).max(600).default(120) },
      annotations: { readOnlyHint: true },
    },
    async ({ jobId: id, timeoutSec }) => answer(async () => fleet.wait(id, seconds(timeoutSec))),
  )

  server.registerTool(
    'pi_send',
    {
      title: 'Message a running pi job',
      description:
        'Sends a running job more instructions. "steer" lands before its next model call; "followUp" once it finishes its current work.',
      inputSchema: {
        jobId,
        text: z.string().min(1),
        delivery: z.enum(['steer', 'followUp']).default('steer'),
      },
    },
    async ({ jobId: id, text, delivery }) => answer(async () => fleet.send(id, text, delivery)),
  )

  server.registerTool(
    'pi_status',
    {
      title: 'pi job status',
      description: 'One job by id, or every job this session when jobId is omitted.',
      inputSchema: { jobId: jobId.optional() },
      annotations: { readOnlyHint: true },
    },
    async ({ jobId: id }) =>
      answer(async () => Promise.resolve(id === undefined ? fleet.list() : fleet.status(id))),
  )

  server.registerTool(
    'pi_collect',
    {
      title: 'Collect a pi job',
      description:
        "A final job's answer, usage and, for write jobs, its branch, commit, diffstat and patch.",
      inputSchema: { jobId },
      annotations: { readOnlyHint: true },
    },
    async ({ jobId: id }) => answer(async () => fleet.collect(id)),
  )

  server.registerTool(
    'pi_kill',
    {
      title: 'Kill a pi job',
      description: 'Stops a job and deletes its worktree and branch.',
      inputSchema: { jobId },
      annotations: { destructiveHint: true },
    },
    async ({ jobId: id }) => answer(async () => fleet.kill(id)),
  )

  server.registerTool(
    'pi_models',
    {
      title: 'pi models and logins',
      description:
        'Model aliases and what they resolve to, whether pi is logged in to each provider (with the fix if not), and the models available.',
      annotations: { readOnlyHint: true },
    },
    async () => answer(async () => fleet.models()),
  )

  return server
}
