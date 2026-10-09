# Packages

Every folder here is a **deep module**: a lot of behaviour behind a small interface. A package's
public surface is its **entry points**, the files at its root. Everything in a subfolder is private.

```
packages/
  <name>/
    index.ts        an entry point (public). Import this from outside.
    client.ts       another entry point. A package may expose several.
    lib/            implementation: hidden from outside, free to import each other.
    tests/          tests and fixtures: a subfolder, so private too.
```

`packages/example/` is a minimal template: copy it to start a package, or delete it.

Workspace packages (`core`, `mcp`) also carry a `package.json` whose `exports` names the entry
point, so other packages import them by name (`@deeptokens/core`), never by path.

## Rules

`pnpm lint:boundaries` (dependency-cruiser, config in `.dependency-cruiser.cjs`) enforces all four as
errors. It runs inside `pnpm check` and in CI.

**Entry-point boundary.** Code outside a package may import only that package's entry points (its
root files), never anything in its subfolders.

**Intra-package freedom.** A package's own files import each other freely.

**Tests through the entry points.** Files under `<pkg>/tests/` may import any package's entry points
and their own `tests/` helpers and fixtures, but never a subfolder's internals, not even their own
package's. If behaviour cannot be reached through an entry point, no caller can reach it either. In
`core`, tests get there with `openFleet` plus a scripted transport or the fake pi process.

**No cycles.** No dependency cycles.

## No barrel files

Do not re-export a whole subtree through one `index.ts`. If a package has two audiences, give it two
small entry points (`index.ts`, `client.ts`) and export only what each caller needs. Adding an entry
point is adding a root file; adding a private folder needs no config change.
