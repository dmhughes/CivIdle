# Project Guidelines

These instructions apply to all work in this repository.

## Working Rules

- Read the current file and nearby implementation before editing.
- Preserve existing user changes and unrelated working-tree changes.
- Keep changes focused on the requested behavior; avoid unrelated refactors.
- Do not commit changes or create branches unless explicitly requested.
- Prefer existing project abstractions and patterns over new ones.
- Use ASCII by default when editing files.

## Code Style

- Use TypeScript and React patterns consistent with the surrounding code.
- Run Biome on changed source files and keep formatting consistent with the repository.
- Use `pnpm` for package scripts and dependency operations.
- Add or update focused tests when behavior changes make testing practical.

## Validation

For application changes, run the narrowest relevant checks first. Common project checks are:

```text
pnpm exec biome check <changed-files>
pnpm exec tsc --noEmit -p tsconfig.json
pnpm --dir test exec vitest run
git diff --check
```

## Project-Specific Rules

Add additional rules for this project below. Keep them concrete, short, and applicable to most tasks.
