# DeepFuckinTokens

Claude Code as the master harness, [pi](https://github.com/earendil-works/pi) as the worker harness,
OpenAI models through your ChatGPT subscription (pi's Sign in with ChatGPT) doing the delegated grunt work.

Claude plans, briefs, reviews and merges. pi workers read, edit and report. Write jobs run in their
own git worktree (kept inside `.git/`, so `git status` never sees it) and land on their own
`dt/<job>` branch for Claude or you to merge.

**Isolation, not a sandbox (yet).** A worktree keeps a worker's normal edits off your checkout, but
pi's file tools accept any path, so a worker that writes `../../file` or an absolute path on
purpose can reach outside it. That's why write jobs get no `bash` by default. The real fence is the
pi guard extension (PLAN.md, M3): a path jail on every file tool.

## Setup

```bash
pnpm install
pnpm build
pnpm pi            # pi's TUI: /login openai, choose "Sign in with ChatGPT", finish in the browser
```

On a machine without a browser, pi prints the sign-in link; open it anywhere, sign in, and paste the
URL your browser lands on (a dead `127.0.0.1:1455` page) back into pi. pi also accepts
`OPENAI_API_KEY` for the `openai` provider, billed to the API instead of your subscription.

Then open Claude Code in this repo and approve the `deeptokens` MCP server from `.mcp.json`.
Ask Claude to call `pi_models` to confirm the login.

Use it from another repo by pointing that repo's `.mcp.json` at this build:
`"args": ["/abs/path/to/DeepFuckinTokens/packages/mcp/dist/main.js"]`. Workers run against the repo
Claude Code was started in.

## Tools Claude gets

| Tool         | Does                                                                     |
| ------------ | ------------------------------------------------------------------------ |
| `pi_run`     | One task, wait for the answer (killed past `timeoutSec`)                 |
| `pi_spawn`   | Start a task in the background, get a job id                             |
| `pi_wait`    | Block until a job is final or the timeout passes                         |
| `pi_send`    | Steer a running job, or queue a follow-up                                |
| `pi_status`  | One job, or all of them                                                  |
| `pi_collect` | Final answer, usage, and for write jobs the branch, commit, stat, patch  |
| `pi_kill`    | Stop a job, delete its worktree and branch (a finished job's branch too) |
| `pi_models`  | Aliases, what they resolve to, login state with the fix                  |

## Picking models and effort

Tell Claude in plain English ("use `fast`", "go deep on this one") or let it route. Each alias names a
model, what it's for, and a default effort, and Claude reads all three:

| Alias  | Model                | Effort | For                                                 |
| ------ | -------------------- | ------ | --------------------------------------------------- |
| `gpt`  | `openai/gpt-6.1-sol` | medium | default: multi-file changes, features, refactors    |
| `fast` | `openai/gpt-6-luna`  | low    | renames, boilerplate, test scaffolding, summaries   |
| `deep` | `openai/gpt-6.1-sol` | xhigh  | stubborn bugs, concurrency, security, design review |

Effort on a job beats the alias's effort, which beats `defaultThinking`. pi clamps it to what the
model supports. Raw `provider/model-id` works too, with no defaults of its own.

## Config

Optional `deeptokens.config.json` at the repo root; see `deeptokens.config.example.json`. An alias is
either `{ "model", "useFor", "thinking" }` or a bare `"provider/model-id"`. Restart the MCP server
after editing it: Claude reads the routes when the server starts.

Write jobs get no `bash` by default: pi has no permission prompts, and a worktree is not a sandbox
(see above). Add `"bash"` to `tools.write` once you accept that.

**A repo's config is code you run.** `piCliPath` names the script started for every worker,
`agentDir` picks the credentials, and `tools.write` can enable `bash`. Before pointing the server at
someone else's repo, read its `deeptokens.config.json`. Relative paths in it resolve from the repo
root.
