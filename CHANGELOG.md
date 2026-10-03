# Changelog

## 1.1.0 — 2026-10-03

- Add optional `getTaskKey` for indexed task deduplication and cache lookup.
- Share one task record and result Promise per unique task, and consume serial
  queues with a cursor to reduce scheduling work.
- Fix cache expiration and failed-task retries while unrelated tasks are running.
- Settle task failures reliably, including executor and cache-policy exceptions.
- Handle empty dispatches and missing batch results; preserve result order and
  duplicate task positions.
- Preserve the configured batch size in serial mode instead of forcing one item.
- Compare cyclic plain objects and arrays safely; use reference identity for
  opaque objects such as Map, Set and class instances.
- Correct the built package entry points and include generated TypeScript declarations.
- Retain the published `dist/index.js` and `dist/types.d.ts` paths, CommonJS
  `import = require` syntax, and the structural public instance type. Check real
  packed consumers in CI.
- Expand behavior and type coverage, add deterministic performance regression
  tests, and benchmark against the pre-refactor implementation in CI.
- Rewrite the README around request deduplication, batching and TTL caching,
  with runnable examples and clearer cache / execution semantics.
- Update package discovery metadata and include the MIT license text.

The public signatures are retained, but some bug fixes change observable behavior.
See [upgrade notes](docs/upgrading.md) before upgrading.

## 1.0.1 — 2024-03-21

- Previous npm release.
