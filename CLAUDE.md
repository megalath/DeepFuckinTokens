# DeepFuckinTokens

Claude Code is the lead; pi workers on OpenAI (ChatGPT/Codex subscription) do delegated work.
The `deeptokens` MCP server (`.mcp.json`) gives you `pi_run`, `pi_spawn`, `pi_wait`, `pi_send`,
`pi_status`, `pi_collect`, `pi_kill`, `pi_models`. Its instructions say when to delegate.

## Commands

- `pnpm install` then `pnpm build` (the MCP server runs from `packages/mcp/dist`)
- `pnpm check`: format, typecheck, lint, unit tests. Run it before every commit.
- `pnpm test:live`: real pi; the Codex call skips unless logged in
- `pnpm pi`: pi's own TUI, for `/login`

## Layout

- `packages/core`: the fleet. Public surface is `src/index.ts` only.
  - `fleet/fleet.ts` is the deep module: eleven methods hide processes, worktrees, auth and state.
  - `fleet/job.ts` is a pure reducer: pi events in, job snapshot out.
  - `pi/` is the only code that knows pi's wire protocol. `transport.ts` is the port,
    `rpc-transport.ts` the adapter, `wire.ts` the zod-validated projection.
  - `workspace/` git worktrees for write jobs.
- `packages/mcp`: thin MCP face over a `Fleet`. No logic lives here.

## Rules

- Max-strict TypeScript (`tsconfig.base.json`): `exactOptionalPropertyTypes`,
  `noUncheckedIndexedAccess`, `erasableSyntaxOnly` (no enums, no parameter properties).
  Model absent optionals as absent, not `undefined`.
- ESLint is `strictTypeChecked`, zero warnings. Never add a disable comment to get green; fix the type.
- Packages import each other by public entry only. Lint enforces it.
- Errors crossing the core boundary are `DeepTokensError` with a stable `code`.
- Validate everything from outside the process (pi stdout, config, MCP input) with zod.
- Unit tests use the fake transport (`test/helpers/fake-transport.ts`) or the fake pi
  (`test/fixtures/fake-pi.mjs`); nothing in `pnpm test` touches the network.
