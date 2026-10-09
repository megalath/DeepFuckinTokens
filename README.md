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

Needs Node 22.13 or newer, git, Claude Code, and a ChatGPT subscription.

```bash
npx -y @deeptokens/mcp pi    # pi's TUI: /login openai, choose "Sign in with ChatGPT", finish in the browser
```

On a machine without a browser, pi prints the sign-in link; open it anywhere, sign in, and paste the
URL your browser lands on (a dead `127.0.0.1:1455` page) back into pi. pi also accepts
`OPENAI_API_KEY` for the `openai` provider, billed to the API instead of your subscription.

Then, in the git repo you want workers in, add the server:

```bash
claude mcp add deeptokens -- npx -y @deeptokens/mcp@latest
```

That registers it for you alone. To share it with everyone on the repo, commit a `.mcp.json` instead:

```json
{
  "mcpServers": {
    "deeptokens": { "type": "stdio", "command": "npx", "args": ["-y", "@deeptokens/mcp@latest"] }
  }
}
```

Open Claude Code in that repo, approve the `deeptokens` server, and ask Claude to call `pi_models` to
confirm the login. Workers run against the repo Claude Code was started in, and the server does not
start outside a git repository.

`@latest` makes `npx` ask the registry for the newest release each time the server starts, so
restarting Claude Code is the whole update. Pin a release with `@deeptokens/mcp@0.1.0` instead.

### From source

```bash
pnpm install
pnpm build
pnpm pi            # the same pi TUI, for /login openai
```

Open Claude Code in this repo and approve the `deeptokens` server from `.mcp.json`, which runs the
local build. To use that build from another repo, point its `.mcp.json` at it:
`"command": "node", "args": ["/abs/path/to/DeepFuckinTokens/packages/mcp/dist/main.js"]`.

`pnpm release` publishes `@deeptokens/core` and `@deeptokens/mcp` to npm after a clean build and
`pnpm check`. Bump both versions first; pnpm skips a version that is already published.

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

| Alias       | Model                  | Effort  | For                                                 |
| ----------- | ---------------------- | ------- | --------------------------------------------------- |
| `gpt`       | `openai/gpt-6.1-sol`   | medium  | default: multi-file changes, features, refactors    |
| `fast`      | `openai/gpt-6-luna`    | low     | renames, boilerplate, test scaffolding, summaries   |
| `deep`      | `openai/gpt-6.1-sol`   | xhigh   | stubborn bugs, concurrency, security, design review |
| `sol-6-1`   | `openai/gpt-6.1-sol`   | default | GPT-6.1 Sol, when you ask for it by name            |
| `astra-6`   | `openai/gpt-6-astra`   | default | GPT-6 Astra, when you ask for it by name            |
| `sol-6`     | `openai/gpt-6-sol`     | default | GPT-6 Sol, when you ask for it by name              |
| `luna-6`    | `openai/gpt-6-luna`    | default | GPT-6 Luna, when you ask for it by name             |
| `sol-5-6`   | `openai/gpt-5.6-sol`   | default | GPT-5.6 Sol, when you ask for it by name            |
| `terra-5-6` | `openai/gpt-5.6-terra` | default | GPT-5.6 Terra, when you ask for it by name          |
| `luna-5-6`  | `openai/gpt-5.6-luna`  | default | GPT-5.6 Luna, when you ask for it by name           |

The seven named routes are the models in the ChatGPT model picker; each one answered a live job on a
ChatGPT login on 2026-10-08. They carry no effort of their own, so `defaultThinking` applies.

Effort on a job beats the alias's effort, which beats `defaultThinking`. pi clamps it to what the
model supports. Raw `provider/model-id` works too, with no defaults of its own.

## What a worker sees

Workers start bare: none of your own pi extensions, skills, prompt templates or MCP servers load into
them. A worker gets the tools listed in `tools`, the repo's `AGENTS.md`/`CLAUDE.md`, and Claude's
brief. `usage.costUsd` on a job is pi's estimate at API list prices; a ChatGPT login is not billed
per call.

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

## License

[0BSD](./LICENSE): use it for anything, no conditions, no attribution required.
