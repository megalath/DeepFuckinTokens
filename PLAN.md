# DeepFuckinTokens: plan

Claude Code is the brain. pi is the muscle. OpenAI models on the ChatGPT subscription do the grunt work; Claude plans, delegates, reviews, and merges.

## Architecture

```
Claude Code (master)
  └─ deeptokens MCP server (packages/mcp, stdio, thin)
       └─ Fleet (packages/core, the deep module)
            ├─ PiTransport ──► pi --mode rpc --provider openai --model …  (one process per job)
            ├─ Worktrees   ──► .git/deeptokens/worktrees/<job>, branch dt/<job>   (write jobs)
            └─ auth        ──► reads key names in ~/.pi/agent/auth.json, never tokens
```

## Decisions

1. **MCP is the integration, not a Claude Code mod.** The mod runtime has no Node, so the fleet can't live there anyway. MCP works in Claude Code, Claude Desktop, and any other MCP host, is testable with a plain client, and Claude already treats mod tools as `mcp__*` tools, so nothing is lost on the model side. A mod comes later only for what MCP can't do: a live fleet pane and waking Claude when a background job finishes.
2. **Workers are tools, not Claude agent types.** Claude agent types only run Anthropic models.
3. **Claude Code does the fan-out.** Every pi process is a subagent. No nested pi subagents.
4. **Own RPC client, not pi's `RpcClient`.** pi's client can't report an unexpected exit, mirrors child stderr into ours, and buffers it unbounded. Ours is ~200 lines, follows pi's strict JSONL framing, validates with zod, dismisses extension dialogs so a worker never hangs, and reports crashes as job failures.
5. **Write jobs get their own worktree, committed on settle.** Claude gets branch, commit, diffstat and patch back, and merges or deletes. Worktrees live inside `.git/` so `git status` and `git add -A` never see them. Once a commit exists, nothing deletes it except an explicit `pi_kill`.
6. **Isolation, not a sandbox.** pi has no permission prompts and its file tools accept any path, so a worktree keeps normal edits apart but does not jail a worker that writes `../` or absolute paths (QA reproduced this). Write jobs get no bash until the guard extension (M3) adds the jail.
7. **Auth stays in pi, on the current provider.** `pnpm pi` → `/login openai` → Sign in with ChatGPT. pi 0.99 renamed `openai-codex` to "(legacy)" and superseded it with this; our defaults use `openai/*`. pi stores and refreshes the token. The fleet only checks the provider key is present and names the fix if not.
8. **Aliases are routes, not just names.** Each carries a model, a one-line `useFor` and a default effort (`gpt` medium, `fast` low, `deep` xhigh). Claude reads them in the MCP instructions and the `model` schema, so it routes on purpose instead of guessing. Effort precedence: job, then alias, then `defaultThinking`; pi clamps per model.

## Status

**M0 + M1 done (this scaffold):**

- `@deeptokens/core`: fleet, RPC transport, job reducer, worktrees, config, auth check
- `@deeptokens/mcp`: 8 tools (`pi_run/spawn/wait/send/status/collect/kill/models`) plus delegation instructions
- Max-strict TS, `strictTypeChecked` ESLint, Prettier, Vitest, CI
- 54 unit tests (fake transport, fake pi process, real git); live tests boot the real pi and skip the paid call without a login

**Next:**

- **M2: prove it on the subscription.** Log in, run the live suite, then real tasks. Tune the worker brief and the MCP instructions from what Claude actually delegates badly.
- **M3: pi guard extension (next, top priority).** `tool_call` hook: path jail to the worktree on every file tool, bash allowlist (test runners, linters), deny network and secrets. Then turn bash on for write jobs by default.
- **Follow-ups from QA:** reclaim orphaned worktrees and empty `dt/*` branches after a crash (needs per-server ownership so two sessions don't reap each other); progress notifications for long `pi_wait`/`pi_run` on hosts with a 60s request timeout.
- **M4: Claude Code mod.** Fleet pane, status line, toast, and wake-on-complete via `$.prompt.submit`, talking to the same core.
- **M5: power moves.** GPT reviews every Claude diff before commit; ensemble mode (same task to `gpt` and `fast`, Claude judges).
- **Later:** add providers back (DeepSeek, OpenRouter) as aliases; the core is provider-agnostic already.

## Risks

- **Cold-start workers.** The win depends on tight briefs. A sloppy spec costs more in rework than it saves.
- **Subscription rate windows.** ChatGPT-plan usage is metered in rolling windows. `maxConcurrent` defaults to 3; watch for 429s surfacing as job errors.
- **pi moves fast** (1.1.0 shipped 2026-10-07). Version is pinned; protocol knowledge lives in `packages/core/src/pi/` only.
