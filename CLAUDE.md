# DeepFuckinTokens

Claude Code is the lead; pi workers on OpenAI (ChatGPT subscription via pi's Sign in with ChatGPT) do delegated work.
The `deeptokens` MCP server (`.mcp.json`) gives you `pi_run`, `pi_spawn`, `pi_wait`, `pi_send`,
`pi_status`, `pi_collect`, `pi_kill`, `pi_models`. Its instructions say when to delegate.

## Commands

- `pnpm install` then `pnpm build` (the MCP server runs from `packages/mcp/dist`)
- `pnpm check`: format, typecheck, lint, package boundaries, unit tests. Run it before every commit.
- `pnpm lint:boundaries`: dependency-cruiser; fails on an import into another package's subfolder.
- `pnpm test:live`: real pi; the paid call skips unless logged in
- `pnpm pi`: pi's own TUI, for `/login openai`
- `pnpm release`: clean build, `pnpm check`, then publish `core` and `mcp` to npm

## Layout

Packages are deep modules: see [packages/README.md](./packages/README.md) before adding or importing one.

- `packages/core`: the fleet. Public surface is `index.ts` only; everything else is in `lib/`.
  - `lib/fleet/fleet.ts` is the deep module: eleven methods hide processes, worktrees, auth and state.
  - `lib/fleet/job.ts` is a pure reducer: pi events in, job snapshot out.
  - `lib/pi/` is the only code that knows pi's wire protocol. `transport.ts` is the port,
    `rpc-transport.ts` the adapter, `wire.ts` the zod-validated projection.
  - `lib/workspace/` git worktrees for write jobs.
- `packages/mcp`: thin MCP face over a `Fleet`. No fleet logic lives here. `init.ts` sets the
  host up for the `init` subcommand: per repo (`.mcp.json`, the `CLAUDE.md` note) or per user
  (`claude mcp add --scope user`, the note in `~/.claude/CLAUDE.md`).
- `packages/example`: copy-me template for a new package.

## Rules

- Max-strict TypeScript (`tsconfig.base.json`): `exactOptionalPropertyTypes`,
  `noUncheckedIndexedAccess`, `erasableSyntaxOnly` (no enums, no parameter properties).
  Model absent optionals as absent, not `undefined`.
- ESLint is `strictTypeChecked`, zero warnings. Never add a disable comment to get green; fix the type.
- Packages import each other by public entry only, and tests import only entry points (their
  own package's included). `pnpm lint:boundaries` enforces it.
- Errors crossing the core boundary are `DeepTokensError` with a stable `code`.
- Validate everything from outside the process (pi stdout, config, MCP input) with zod.
- Unit tests reach core through `openFleet` with the fake transport
  (`tests/helpers/fake-transport.ts`) or the fake pi process (`tests/fixtures/fake-pi.mjs`);
  nothing in `pnpm test` touches the network.
