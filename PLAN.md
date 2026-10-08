# DeepFuckinTokens: plan

Claude Code is the brain. pi is the muscle. Cheap and subscription-paid tokens do the grunt work; Claude plans, delegates, reviews, and merges.

## The one-line architecture

A Claude Code mod (`deeptokens`) gives Claude a set of tools that start, steer, and collect **pi workers**. Each worker is a headless `pi --mode rpc` process pinned to a provider and model (DeepSeek, anything on OpenRouter, or OpenAI via the ChatGPT/Codex subscription). A small pi extension runs inside every worker for guardrails and structured reporting.

```
Claude Code (master)
  └─ deeptokens mod
       ├─ tools:  pi_spawn / pi_send / pi_status / pi_collect / pi_kill / pi_models
       ├─ pane:   live fleet view (worker, model, state, tokens, $)
       ├─ state:  jobs, spend, budgets
       └─ $.process.spawn ──► pi --mode rpc --provider X --model Y  (one per worker)
                                 └─ deeptokens-pi extension (guardrails + report tool)
                                      └─ own git worktree (write jobs) or shared cwd (read-only jobs)
```

## Decisions (committed, not options)

1. **Workers are tools, not Claude agent types.** `$.agent.register` makes Claude subagents, and those only run Anthropic models. Faking a Claude shell agent that then calls pi burns Claude tokens to save Claude tokens. Dumb. Claude calls `mcp__deeptokens__pi_*` tools directly.
2. **Claude Code does the fan-out, not pi.** pi has no built-in subagents by design. Every pi process already *is* a subagent. Nested pi subagents are a v2 maybe, not v1.
3. **Async by default.** `pi_spawn` returns a job id right away. A background loop (started in `session.start`, the pattern the mod API documents for long-lived children) reads the RPC stream, waits for `agent_end`, then wakes Claude with `$.session.append` (if a turn is running) or `$.prompt.submit` (if idle). Same feel as Claude Code background agents. A blocking `pi_run` exists for jobs under ~2 min.
4. **Write jobs get their own git worktree.** `git worktree add .deeptokens/wt/<job> -b dt/<job>`. Worker edits there, returns a diff + summary. Claude reviews and merges. Read-only jobs (research, review, summarize) share cwd with `--tools read,grep,find,ls`. No two workers ever write the same tree.
5. **Auth lives in pi, never in the mod.** pi already stores keys and OAuth in `~/.pi/agent/auth.json` (0600, auto-refresh). The mod only checks that a provider is logged in and tells you how to fix it if not.
6. **Model aliases, not raw ids, in Claude's hands.** Claude picks `cheap`, `reason`, `gpt`, `bulk`; config maps them to real ids. Swap models without touching prompts.

## Providers

| Alias | Route | Auth | Use it for |
| --- | --- | --- | --- |
| `cheap` | DeepSeek chat (latest V3.x) | `DEEPSEEK_API_KEY` | mechanical edits, test scaffolding, renames, boilerplate |
| `reason` | DeepSeek reasoner | `DEEPSEEK_API_KEY` | debugging hypotheses, second opinions |
| `gpt` | OpenAI Codex models via ChatGPT Plus/Pro | `pi` → `/login` → OpenAI ChatGPT | heavier coding jobs, cross-model review of Claude's own diff |
| `bulk` | OpenRouter, anything | `OPENROUTER_API_KEY` | long tail: Qwen, Kimi, GLM, Gemini, whatever's cheapest this week |

**Codex OAuth setup:** run `pi`, `/login`, pick OpenAI ChatGPT, finish in a browser, once. Tokens refresh themselves. In a headless/cloud box there's no browser, so log in on your laptop and copy `~/.pi/agent/auth.json` over (or keep the whole setup local, which is where this belongs anyway).

**Data routing call:** direct DeepSeek API means your code goes to servers in China. Fine for open-source and scratch work. For Scopable or client code, route DeepSeek through OpenRouter pinned to US hosts with data collection denied. (Spike S3 confirms pi can pass OpenRouter provider-routing params.)

## Mod surface (Claude Code side)

**Tools the model sees** (`isDeferred: false` so Claude actually reaches for them):

| Tool | Input | Returns |
| --- | --- | --- |
| `pi_spawn` | `task`, `model` alias, `mode: read\|write`, `files?`, `budgetUsd?`, `thinking?` | `jobId` immediately |
| `pi_run` | same as spawn | final text, diff, cost (blocking, short jobs) |
| `pi_send` | `jobId`, `text`, `as: steer\|followUp` | ack (maps to RPC `steer` / `follow_up`) |
| `pi_status` | `jobId?` | state, last tool, tokens, cost for one or all |
| `pi_collect` | `jobId` | final text, diff vs base, files touched, cost |
| `pi_kill` | `jobId` | RPC `abort`, then kill, then remove worktree |
| `pi_models` | none | aliases, resolved ids, which providers are logged in |

**System prompt section** (`prompt.compose`): when to delegate and when not to. Delegate: bulk mechanical work, parallel independent subtasks, "get a second model's take." Keep in Claude: planning, architecture, anything touching secrets/auth/payments, the final review of every diff before merge.

**UI:**
- Pane "pi fleet": one row per worker, model, state, live last-tool, tokens, $. Kill button per row.
- Status line: `pi 3 running · $0.41 today`.
- Toast on job done/failed.
- Slash commands: `/pi` (open pane), `/pi models`, `/pi login` (prints exact login steps per missing provider), `/pi budget 5`, `/pi killall`.

**State** (`types/index.d.ts` contract): `jobs` (map by id), `spendSession`. `$.store` keeps `spendDaily` and budgets across sessions.

**Budgets:** per-job `budgetUsd` (default $0.50), per-session cap, daily cap. Cost comes from each assistant message's `usage.cost` in the RPC stream, so the mod aborts a runaway worker mid-flight, not after the bill. Codex jobs cost $0 but burn the 5-hour subscription window: track message count per window and warn before you hit the wall.

## pi extension (`deeptokens-pi`, worker side)

pi runs with zero permission prompts by design. A DeepSeek worker with `bash` in your repo is the single biggest risk here, so the extension is not optional.

- **Path jail:** `tool_call` hook denies `write`/`edit` outside the worktree, and denies `read` of `.env*`, `~/.ssh`, `~/.pi/agent/auth.json`, `~/.claude`.
- **Bash policy:** read-only jobs get no bash. Write jobs get an allowlist (test runners, linters, package scripts); `curl`, `git push`, `rm -rf`, and anything network is denied.
- **`report` tool:** worker must end by calling `report({ summary, filesChanged, confidence, openQuestions })`. Claude gets structured output instead of a wall of prose.
- **Heartbeat:** emits progress the pane can show.

## Repo layout

```
.claude-plugin/marketplace.json        # /plugin install deeptokens --marketplace megalath/deepfuckintokens
plugins/deeptokens/
  .claude-plugin/plugin.json
  hooks/hooks.json
  hooks/register.tsx                   # tools, pane, commands, prompt section
  hooks/rpc.ts                         # pi RPC client over $.process.spawn
  hooks/worktree.ts                    # git worktree lifecycle
  hooks/budget.ts
  types/index.d.ts
  tests/*.test.ts
pi-extension/                          # pi package: pi install git:megalath/deepfuckintokens
  package.json
  src/index.ts                         # guardrails, report tool, heartbeat
config/aliases.example.json
```

## Build order

**M0, spikes (half a day). Kill the plan here if any fail.**
- S1: `$.process.spawn(['pi','--mode','rpc','--no-session', ...])` from a mod: send `prompt`, read events to `agent_end`, from a background loop that survives the hook returning.
- S2: Codex OAuth through pi: log in once, run a job headless, confirm refresh works after expiry, list the actual Codex model ids pi exposes.
- S3: OpenRouter provider routing (host pinning, `data_collection: deny`) through pi's `models.json` or an extension.
- S4: wake Claude from a finished background job with `$.prompt.submit` while idle and `$.session.append` mid-turn.

**M1, one-shot (day 1):** `pi_run` + `pi_models`, read-only jobs only, aliases config, cost in the result.

**M2, fleet (days 2–3):** `pi_spawn/send/status/collect/kill`, worktrees, background loop, pane, status line.

**M3, guardrails + budgets (day 4):** pi extension, per-job/session/daily caps, Codex window tracking.

**M4, delegation policy (day 5):** system prompt section, tune by running real tasks and checking what Claude delegates badly.

**M5, power moves:** ensemble mode (same task to `cheap` + `gpt`, Claude judges), review mode (Codex reviews every Claude diff before commit via a `tool.call` hook on `git commit`), marketplace packaging.

## Risks worth losing sleep over

- **ChatGPT subscription ToS.** That OAuth is meant for Codex CLI. pi uses it openly and people aren't getting banned for it today, but it's OpenAI's call, not yours. Don't build the business on it; build it so `gpt` can flip to an API key in one config line.
- **Cheap models produce confident garbage.** Every write job comes back as a diff Claude reviews. No auto-merge. Ever.
- **Context handoff is the real cost.** Workers start cold. The win comes from tight task specs (files, acceptance criteria, test command), which is Claude's job. A sloppy spec costs more in rework than it saves in tokens.
- **pi moves fast** (package appears to be moving from `@mariozechner/*` to `@earendil-works/*`). Pin the version, wrap RPC behind `rpc.ts`, and only that file changes when the protocol does.
