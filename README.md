# DeepFuckinTokens

Claude Code as the master harness, [pi](https://github.com/earendil-works/pi) as the worker harness,
OpenAI models through your ChatGPT Plus/Pro (Codex) subscription doing the delegated grunt work.

Claude plans, briefs, reviews and merges. pi workers read, edit and report. Write jobs land on their
own git branch, so nothing touches your tree until Claude (or you) merges it.

## Setup

```bash
pnpm install
pnpm build
pnpm pi            # pi's TUI: type /login, choose OpenAI ChatGPT Plus/Pro (Codex), finish in the browser
```

Then open Claude Code in this repo and approve the `deeptokens` MCP server from `.mcp.json`.
Ask Claude to call `pi_models` to confirm the login.

Use it from another repo by pointing that repo's `.mcp.json` at this build:
`"args": ["/abs/path/to/DeepFuckinTokens/packages/mcp/dist/main.js"]`. Workers run against the repo
Claude Code was started in.

## Tools Claude gets

| Tool         | Does                                                                    |
| ------------ | ----------------------------------------------------------------------- |
| `pi_run`     | One task, wait for the answer (killed past `timeoutSec`)                |
| `pi_spawn`   | Start a task in the background, get a job id                            |
| `pi_wait`    | Block until a job is final or the timeout passes                        |
| `pi_send`    | Steer a running job, or queue a follow-up                               |
| `pi_status`  | One job, or all of them                                                 |
| `pi_collect` | Final answer, usage, and for write jobs the branch, commit, stat, patch |
| `pi_kill`    | Stop a job, delete its worktree and branch                              |
| `pi_models`  | Aliases, what they resolve to, login state with the fix                 |

## Config

Optional `deeptokens.config.json` at the repo root; see `deeptokens.config.example.json`.
Write jobs get no `bash` by default: pi has no permission prompts, and a worktree fences file
edits, not shell commands. Add `"bash"` to `tools.write` once you accept that.
