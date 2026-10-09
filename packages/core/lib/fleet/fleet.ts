import { randomBytes } from 'node:crypto'

import { isCheckedProvider, providerStatus } from '../auth/auth.js'
import { resolveModel, type DeepTokensConfig } from '../config/config.js'
import { DeepTokensError, messageOf } from '../errors.js'
import type { PiEvent, PiSession, PiTransport } from '../pi/transport.js'
import type {
  Changes,
  JobId,
  JobResult,
  JobSnapshot,
  ModelReport,
  ModelRoute,
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
 * final, with one exception: killing a settled write job discards its branch and
 * makes it killed. A follow-up after settling is a new job.
 */
export interface Fleet {
  /** Starts a job and returns as soon as pi has accepted the task. */
  spawn(spec: TaskSpec): Promise<JobSnapshot>
  /** `spawn`, `wait`, then `collect`; kills the job if it outlives the timeout or `signal` aborts. */
  run(spec: TaskSpec, timeoutMs: number, signal?: AbortSignal): Promise<JobResult>
  /** Sends a running job more instructions: now (`steer`) or once it finishes (`followUp`). */
  send(id: string, text: string, delivery: 'steer' | 'followUp'): Promise<JobSnapshot>
  /** Resolves when the job is final or the timeout passes, whichever is first. */
  wait(id: string, timeoutMs: number): Promise<JobSnapshot>
  status(id: string): JobSnapshot
  list(): readonly JobSnapshot[]
  /** The final answer and, for write jobs, the committed changes. The job must be final. */
  collect(id: string): Promise<JobResult>
  /** Stops a job and throws away its worktree and branch, a finished job's branch included. */
  kill(id: string): Promise<JobSnapshot>
  /** The configured aliases, without asking pi anything. */
  routes(): readonly ModelRoute[]
  /** The routes checked against pi: which resolve, and whether pi is logged in. */
  models(): Promise<ModelReport>
  /** Kills every live job; finished jobs keep their branches. The fleet refuses new work afterwards. */
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
  // Read through a function: TypeScript would otherwise narrow it across awaits.
  const closed = (): boolean => isClosed
  /** Slots taken by spawns that have not registered their job yet. */
  let reserved = 0
  const spawning = new Set<Promise<unknown>>()

  const find = (id: string): Job => {
    const job = jobs.get(id as JobId)
    if (job === undefined) throw new DeepTokensError('unknown-job', `No job "${id}".`)
    return job
  }

  const live = (): number =>
    reserved + [...jobs.values()].filter((job) => !isFinal(job.snapshot)).length

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
    // Stopping pi makes its in-flight prompt reject; that must not turn a killed (or settled)
    // job into a failed one. An already failed job does take the error: pi's exit is reported
    // first, and what the caller threw says why (a boot timeout, the exit code).
    if (job.snapshot.state === 'killed' || job.snapshot.state === 'settled') return
    transition(job, { ...job.snapshot, state: 'failed', endedAt: now(), error: messageOf(error) })
  }

  const routes = (): readonly ModelRoute[] =>
    Object.entries(config.aliases).map(([alias, route]) => ({ alias, ...route }))

  const spawn = async (spec: TaskSpec): Promise<JobSnapshot> => {
    const started = startJob(spec)
    spawning.add(started)
    void started.catch(() => undefined).finally(() => spawning.delete(started))
    return started
  }

  const startJob = async (spec: TaskSpec): Promise<JobSnapshot> => {
    if (isClosed) throw new DeepTokensError('fleet-closed', 'The fleet is shut down.')
    if (live() >= config.maxConcurrent) {
      throw new DeepTokensError(
        'fleet-full',
        `${String(config.maxConcurrent)} jobs are already live. Wait for one, or kill one.`,
      )
    }
    const modelName = spec.model ?? config.defaultModel
    const route = resolveModel(config, modelName)
    if (route === undefined) {
      throw new DeepTokensError(
        'unknown-model',
        `"${modelName}" is not an alias (${Object.keys(config.aliases).join(', ')}) or provider/model-id.`,
      )
    }
    const model = route.target

    // Take the slot before the first await, so parallel spawns can't all pass the check.
    reserved += 1
    try {
      if (isCheckedProvider(model.provider)) {
        const [auth] = await providerStatus(deps.agentDir, [model.provider])
        if (auth !== undefined && !auth.isLoggedIn) {
          throw new DeepTokensError(
            'not-logged-in',
            `pi has no credentials for ${model.provider}. ${auth.loginHint ?? ''}`,
          )
        }
      }
      if (closed()) throw new DeepTokensError('fleet-closed', 'The fleet is shut down.')
    } finally {
      reserved -= 1
    }

    const id = newId() as JobId
    const mode = spec.mode ?? 'read'
    const worktree = mode === 'write' ? worktrees.plan(id) : undefined
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
    // Registered synchronously with the slot release above: kill and close see it from here.
    jobs.set(id, job)

    try {
      if (worktree !== undefined) {
        await worktrees.create(worktree)
        if (isFinal(job.snapshot)) {
          // Killed while git ran: finalize may have cleaned up before the worktree existed.
          await worktrees.discard(worktree)
          return job.snapshot
        }
      }
      const session = await transport.open(
        {
          cwd: workspace.path,
          model,
          thinking: spec.thinking ?? route.thinking ?? config.defaultThinking,
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
      const wasFinal = isFinal(job.snapshot)
      fail(job, error)
      if (wasFinal && worktree !== undefined) await worktrees.discard(worktree)
    }
    return job.snapshot
  }

  const wait = async (id: string, timeoutMs: number): Promise<JobSnapshot> => {
    const job = find(id)
    if (job.finalized !== undefined) {
      // Final already; cleanup may still be running (a kill's grace period). Honor the timeout.
      let timer: NodeJS.Timeout | undefined
      await Promise.race([
        job.finalized,
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, timeoutMs)
        }),
      ])
      clearTimeout(timer)
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
    // A settled write job's work lives on its branch; killing it means dropping that too.
    // It then reads as killed: 'settled' promises a branch to review, and leaving it would
    // have the lead try to merge one that is gone. endedAt stays the moment the work ended.
    if (job.changes !== undefined && job.worktree !== undefined) {
      await worktrees.discard(job.worktree)
      job.changes = undefined
      job.snapshot = { ...job.snapshot, state: 'killed' }
    }
    return job.snapshot
  }

  return {
    spawn,
    wait,
    collect,
    kill,

    async run(spec, timeoutMs, signal) {
      const started = await spawn(spec)
      // The caller gave up (Esc in the host): it never saw the id, so nobody else will kill it.
      const onAbort = (): void => void kill(started.id)
      signal?.addEventListener('abort', onAbort, { once: true })
      try {
        if (signal?.aborted === true) await kill(started.id)
        const settled = await wait(started.id, timeoutMs)
        if (!isFinal(settled)) await kill(started.id)
      } finally {
        signal?.removeEventListener('abort', onAbort)
      }
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

    routes,

    async models() {
      const available = await transport.listModels()
      const has = (provider: string, modelId: string): boolean =>
        available.some((model) => model.provider === provider && model.id === modelId)
      const aliases = routes().map((route) => ({
        ...route,
        isAvailable: has(route.target.provider, route.target.id),
      }))
      const providers = [...new Set(aliases.map(({ target }) => target.provider))]
      return {
        aliases,
        defaultModel: config.defaultModel,
        defaultThinking: config.defaultThinking,
        providers: await providerStatus(deps.agentDir, providers),
        available: available.filter((model) => providers.includes(model.provider)),
      }
    },

    async close() {
      isClosed = true
      // Stop what is registered (keeping finished jobs' branches), then let in-flight spawns
      // notice and clean up after themselves.
      await Promise.all(
        [...jobs.values()].map(async (job) => {
          if (job.finalized === undefined) {
            transition(job, { ...job.snapshot, state: 'killed', endedAt: now() })
          }
          await job.finalized
        }),
      )
      await Promise.allSettled([...spawning])
    },
  }
}
