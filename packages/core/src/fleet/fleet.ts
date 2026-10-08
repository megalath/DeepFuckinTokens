import { randomBytes } from 'node:crypto'

import { providerStatus } from '../auth/auth.js'
import { resolveModel, type DeepTokensConfig } from '../config/config.js'
import { DeepTokensError, messageOf } from '../errors.js'
import type { PiEvent, PiSession, PiTransport } from '../pi/transport.js'
import type {
  Changes,
  JobId,
  JobResult,
  JobSnapshot,
  ModelReport,
  TaskSpec,
  Workspace,
} from '../types.js'
import type { Worktree, Worktrees } from '../workspace/worktree.js'
import { isFinal, reduceJob, ZERO_USAGE } from './job.js'

/**
 * A fleet of pi workers. Each job is one pi process on one model: `read` jobs
 * look at the repo in place, `write` jobs edit a git worktree whose work is
 * committed to its own branch the moment the job settles.
 *
 * Lifecycle: starting → running → settled | failed | killed. Final states are
 * final; a follow-up after settling is a new job.
 */
export interface Fleet {
  /** Starts a job and returns as soon as pi has accepted the task. */
  spawn(spec: TaskSpec): Promise<JobSnapshot>
  /** `spawn`, `wait`, then `collect`; kills the job if it outlives the timeout. */
  run(spec: TaskSpec, timeoutMs: number): Promise<JobResult>
  /** Sends a running job more instructions: now (`steer`) or once it finishes (`followUp`). */
  send(id: string, text: string, delivery: 'steer' | 'followUp'): Promise<JobSnapshot>
  /** Resolves when the job is final or the timeout passes, whichever is first. */
  wait(id: string, timeoutMs: number): Promise<JobSnapshot>
  status(id: string): JobSnapshot
  list(): readonly JobSnapshot[]
  /** The final answer and, for write jobs, the committed changes. The job must be final. */
  collect(id: string): Promise<JobResult>
  /** Stops a job and throws away its worktree and branch. */
  kill(id: string): Promise<JobSnapshot>
  models(): Promise<ModelReport>
  /** Kills every live job. The fleet refuses new work afterwards. */
  close(): Promise<void>
}

export interface FleetDeps {
  readonly root: string
  readonly config: DeepTokensConfig
  readonly agentDir: string
  readonly transport: PiTransport
  readonly worktrees: Worktrees
  readonly now?: () => Date
  readonly newId?: () => string
}

const WORKER_BRIEF = `You are a delegated worker. Another agent gave you this task and will review your output.
Stay inside the task. Do not ask questions; make the best call and note it.
Finish with a short report: what you did, files you changed, anything unresolved.

Task:
`

interface Job {
  snapshot: JobSnapshot
  session: PiSession | undefined
  readonly worktree: Worktree | undefined
  changes: Changes | undefined
  /** Set once the job is final and its process and worktree are dealt with. */
  finalized: Promise<void> | undefined
  readonly waiters: Set<() => void>
}

export function createFleet(deps: FleetDeps): Fleet {
  const { config, transport, worktrees } = deps
  const now = (): string => (deps.now ?? (() => new Date()))().toISOString()
  const newId = deps.newId ?? (() => `j${randomBytes(4).toString('hex')}`)
  const jobs = new Map<JobId, Job>()
  let isClosed = false

  const find = (id: string): Job => {
    const job = jobs.get(id as JobId)
    if (job === undefined) throw new DeepTokensError('unknown-job', `No job "${id}".`)
    return job
  }

  const live = (): number => [...jobs.values()].filter((job) => !isFinal(job.snapshot)).length

  /** Runs once per job, when it first turns final: stop pi, then keep or drop its work. */
  const finalize = async (job: Job): Promise<void> => {
    await job.session?.close().catch(() => undefined)
    job.session = undefined
    if (job.worktree === undefined) return
    if (job.snapshot.state === 'settled') {
      try {
        job.changes = await worktrees.harvest(
          job.worktree,
          `deeptokens ${job.snapshot.id}: ${job.snapshot.task.split('\n')[0]?.slice(0, 72) ?? ''}`,
        )
      } catch (error) {
        job.snapshot = { ...job.snapshot, state: 'failed', error: messageOf(error) }
        await worktrees.discard(job.worktree)
      }
    } else {
      await worktrees.discard(job.worktree)
    }
  }

  const transition = (job: Job, next: JobSnapshot): void => {
    const wasFinal = isFinal(job.snapshot)
    job.snapshot = next
    if (wasFinal || !isFinal(next)) return
    job.finalized = finalize(job).finally(() => {
      for (const wake of job.waiters) wake()
      job.waiters.clear()
    })
  }

  const onEvent = (job: Job) => (event: PiEvent) => {
    transition(job, reduceJob(job.snapshot, event, now()))
  }

  const fail = (job: Job, error: unknown): void => {
    transition(job, { ...job.snapshot, state: 'failed', endedAt: now(), error: messageOf(error) })
  }

  const spawn = async (spec: TaskSpec): Promise<JobSnapshot> => {
    if (isClosed) throw new DeepTokensError('fleet-closed', 'The fleet is shut down.')
    if (live() >= config.maxConcurrent) {
      throw new DeepTokensError(
        'fleet-full',
        `${String(config.maxConcurrent)} jobs are already live. Wait for one, or kill one.`,
      )
    }
    const modelName = spec.model ?? config.defaultModel
    const model = resolveModel(config, modelName)
    if (model === undefined) {
      throw new DeepTokensError(
        'unknown-model',
        `"${modelName}" is not an alias (${Object.keys(config.aliases).join(', ')}) or provider/model-id.`,
      )
    }
    const [auth] = await providerStatus(deps.agentDir, [model.provider])
    if (auth !== undefined && !auth.isLoggedIn) {
      throw new DeepTokensError(
        'not-logged-in',
        `pi has no credentials for ${model.provider}. ${auth.loginHint ?? ''}`,
      )
    }

    const id = newId() as JobId
    const mode = spec.mode ?? 'read'
    const worktree = mode === 'write' ? await worktrees.create(id) : undefined
    const workspace: Workspace =
      worktree === undefined
        ? { kind: 'shared', path: deps.root }
        : { kind: 'worktree', path: worktree.path, branch: worktree.branch }

    const job: Job = {
      snapshot: {
        id,
        state: 'starting',
        task: spec.task,
        mode,
        model,
        workspace,
        startedAt: now(),
        turns: 0,
        toolCalls: 0,
        usage: ZERO_USAGE,
      },
      session: undefined,
      worktree,
      changes: undefined,
      finalized: undefined,
      waiters: new Set(),
    }
    jobs.set(id, job)

    try {
      const session = await transport.open(
        {
          cwd: workspace.path,
          model,
          thinking: spec.thinking ?? config.defaultThinking,
          tools: config.tools[mode],
        },
        onEvent(job),
      )
      if (isFinal(job.snapshot)) {
        // Killed while pi was booting: finalize already ran without a session to close.
        await session.close()
        return job.snapshot
      }
      job.session = session
      await session.prompt(WORKER_BRIEF + spec.task)
    } catch (error) {
      fail(job, error)
    }
    return job.snapshot
  }

  const wait = async (id: string, timeoutMs: number): Promise<JobSnapshot> => {
    const job = find(id)
    if (job.finalized !== undefined) {
      await job.finalized
      return job.snapshot
    }
    await new Promise<void>((resolve) => {
      const timer = setTimeout(done, timeoutMs)
      function done(): void {
        clearTimeout(timer)
        job.waiters.delete(done)
        resolve()
      }
      job.waiters.add(done)
    })
    return job.snapshot
  }

  const collect = async (id: string): Promise<JobResult> => {
    const job = find(id)
    if (job.finalized === undefined) {
      throw new DeepTokensError(
        'job-not-settled',
        `Job ${id} is ${job.snapshot.state}. Wait for it first.`,
      )
    }
    await job.finalized
    const text = job.snapshot.lastText ?? ''
    return job.changes === undefined
      ? { job: job.snapshot, text }
      : { job: job.snapshot, text, changes: job.changes }
  }

  const kill = async (id: string): Promise<JobSnapshot> => {
    const job = find(id)
    if (job.finalized === undefined) {
      transition(job, { ...job.snapshot, state: 'killed', endedAt: now() })
    }
    await job.finalized
    return job.snapshot
  }

  return {
    spawn,
    wait,
    collect,
    kill,

    async run(spec, timeoutMs) {
      const started = await spawn(spec)
      const settled = await wait(started.id, timeoutMs)
      if (!isFinal(settled)) await kill(started.id)
      return collect(started.id)
    },

    async send(id, text, delivery) {
      const job = find(id)
      const session = job.session
      if (session === undefined || isFinal(job.snapshot)) {
        throw new DeepTokensError(
          'job-not-running',
          `Job ${id} is ${job.snapshot.state}; start a new job instead.`,
        )
      }
      await (delivery === 'steer' ? session.steer(text) : session.followUp(text))
      return job.snapshot
    },

    status: (id) => find(id).snapshot,

    list: () =>
      [...jobs.values()]
        .map((job) => job.snapshot)
        .sort((a, b) => a.startedAt.localeCompare(b.startedAt)),

    async models() {
      const available = await transport.listModels()
      const has = (provider: string, modelId: string): boolean =>
        available.some((model) => model.provider === provider && model.id === modelId)
      const aliases = Object.entries(config.aliases).map(([alias, target]) => ({
        alias,
        target,
        isAvailable: has(target.provider, target.id),
      }))
      const providers = [...new Set(aliases.map(({ target }) => target.provider))]
      return {
        aliases,
        defaultModel: config.defaultModel,
        providers: await providerStatus(deps.agentDir, providers),
        available: available.filter((model) => providers.includes(model.provider)),
      }
    },

    async close() {
      isClosed = true
      await Promise.all([...jobs.keys()].map(kill))
    },
  }
}
