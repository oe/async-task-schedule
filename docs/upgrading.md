# Upgrading from 1.0.1

These notes describe the proposed next release. It has not been published yet.

## Import and API compatibility

The constructor options, dispatch overloads, cache-clearing method, running
indicator and static utilities remain available. `getTaskKey` is optional;
existing custom comparators keep working when it is omitted.

The package retains `dist/index.js`, `dist/index.es.js` and `dist/types.d.ts`.
CommonJS `require('async-task-schedule')`, TypeScript `import Schedule =
require('async-task-schedule')`, and default imports with `esModuleInterop` are
checked against the actual packed package. Exported strategy types and the
structural public instance type remain usable.

Private runtime fields and the undocumented `defaultOptions` static field are
implementation details. The refactor changes these internals.

## Observable corrections

The next release follows the documented behavior more closely. It is not a
guarantee of identical behavior for applications relying on bugs in 1.0.1.

| Area | 1.0.1 behavior | Next release / upgrade action |
| --- | --- | --- |
| Single-task failure | Could fulfill with an `Error` value. | Rejects. Use `try/catch` or `.catch()`; array dispatch still returns per-item errors. |
| Parallel batch execution | Batches could execute serially even when configured as parallel. | Parallel batches start together. Set `taskExecStrategy: 'serial'` if the backend requires sequential requests. |
| Serial batch size | Serial mode forced a batch size of one. | Honors `maxBatchCount`. Set it to `1` explicitly to preserve one-item batches. |
| Default task comparison | Could treat different Map/Set values as equal; class instances and typed arrays were compared through enumerable fields. | Opaque objects use reference identity. Supply a domain-specific `isSameTask` or stable `getTaskKey` if separate instances should identify the same task. |
| Other equality boundaries | Ignored enumerable symbols, sparse-array lengths and prototype differences; cycles could overflow. | Considers those boundaries and supports cyclic plain objects / arrays. Review custom object inputs or specify identity explicitly. |
| Cache expiration and retries | Could reuse expired or failed entries while unrelated work was active. | Expiration and retry eligibility apply on dispatch even while other work runs. This may cause additional executions that the old bug suppressed. |
| Invalid batch size | Invalid values were not validated reliably. | Nonzero batch sizes must be positive integers; invalid values throw during construction. |
| TTL callback failures | Could escape background work and leave callers unresolved. | Completion failures settle the task as an error; cache-access failures reject dispatch and evict the entry. |

Cache-policy callbacks should be pure: they can now run at completion as well as
on later cache access. Comparator callbacks should be pure and symmetric; the
indexed implementation does not preserve the old number or order of callback calls.

The batch-size option does not impose a global concurrency limit in parallel
mode. Keep existing backpressure requirements explicit when upgrading.

## Validation scope

Behavior tests cover errors, batching / waiting combinations, deduplication, TTL,
retry and cache clearing. Deterministic performance tests check identity work and
execution counts. Packed-consumer tests check imports, declarations, old file
paths and execution. This verifies supported interfaces and covered behaviors;
it cannot establish compatibility with every application's use of old internals
or previously incorrect behavior.
