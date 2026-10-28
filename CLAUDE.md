# maqetin-js: agent operating manual

This repo is the Maqetin JavaScript SDK, npm package `@maqetin/sdk-js` (browser and Node). Two entries: `@maqetin/sdk-js` (data in, public key) and `@maqetin/sdk-js/server` (messages out, secret key). It is public, and so is everything you commit here.

The plan is `../docs/maqetin-sdk-plan.md`: section 5.1 (web SDK), 5.2 (server SDKs), 4 (shared contracts), 6 (release). `../docs/PROGRESS.md` and Linear (team MAQ, project SDK family, goals MAQ-12 and MAQ-13) hold what is done and what is next. A checkout without `../docs/` (CI) has no docs.

## Gate

`pnpm verify`: Biome CI, type check, `tsc -b` build, Vitest. It must exit 0. `pnpm check` autofixes formatting and import order. Never weaken a check to make it pass.

## Rules

- **Zero runtime dependencies.** `devDependencies` only (versions exact, no catalog).
- **ESM.** Relative imports end in `.js`. `sideEffects: false`. The web entry never imports the server entry.
- **The wire contract is not defined here.** `conformance/batch.wire.json` is a copy of the backend's `libs/events/src/json-schema/batch.wire.json`; `test/wire.ts` validates what the SDK sends against it. Refresh the copy from the backend (`pnpm export:schemas` there), never edit it by hand.
- **Version.** `SDK_VERSION` in `src/version.ts`, `package.json` `version` and the git tag `vX.Y.Z` are equal (a spec checks the first two).
- **Public source.** No secret, no internal host, no customer data, no pointer to a private repo's internals in code, comments, commits or issues.
- **Branches.** Work on a branch, merge to `main` by pull request. A release is a tag on `main`.

## Releasing

Not automated yet. The first publish is by hand (owner, 2FA). Then a trusted publisher on npm (GitHub Actions OIDC) and a `release.yml`; see Linear MAQ-19. `repository.url` in `package.json` must match this repo exactly, case included.
