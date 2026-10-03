# Performance and testing

[Back to the README](../readme.md)

This document describes 1.1.0. `getTaskKey` is not available in
1.0.1; see the [changelog](../CHANGELOG.md).
For many tasks or large object inputs, supply a stable, inexpensive `getTaskKey`:

```ts
import TaskSchedule from 'async-task-schedule'

const users = new TaskSchedule({
  doTask: async (task: { tenantId: string; userId: string }) => {
    const response = await fetch(`/tenants/${encodeURIComponent(task.tenantId)}/users/${encodeURIComponent(task.userId)}`)
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    return response.json()
  },
  getTaskKey: task => JSON.stringify([task.tenantId, task.userId]),
})
```

Keys take precedence over `isSameTask`. Equal keys share execution and cached results;
the first task's parameters are used. Include every input that affects the result
(e.g. tenant, user, permissions, or query options). Keys must be pure and stable
throughout execution and caching; do not mutate task identity after dispatch.
A symbol must be reused, rather than created anew on each call. Keys use `Map` equality:
`1` differs from `'1'`, `NaN` equals `NaN`, and `0` equals `-0`.
Without `getTaskKey`, deep comparison or your custom `isSameTask` continues to apply.

Each unique task has one record and a shared result Promise. Duplicate requests
subscribe to that result; completing a task no longer scans every waiting request.
The indexed path avoids linear searches for pending, running, and cached tasks.
Numeric TTLs skip cache scans until the next expiration; function TTL policies are
evaluated on completion and on subsequent cache access. Cache expiration and
failed-task retry eligibility apply even while unrelated work is active. Existing
waiters keep their original result Promise after a cache entry expires.
`cleanCache()` still waits for pending/running work before clearing entries.

Default deep comparison supports plain objects, arrays (including cyclic values),
Dates, and RegExps. Other objects such as Map, Set, typed arrays, and class instances
use reference identity; supply a task key or custom comparator when those inputs
need semantic equality. An array passed to `dispatch` always means multiple tasks;
wrap an array-valued single task in an object.

If a TTL policy throws during completion, that task settles with an Error (a single
request rejects, and a multi-task request receives an Error entry). If it throws
on later cache access, the dispatch rejects and that cache entry is removed.
Neither path leaves background rejections or unresolved task records.

Run `yarn test` for behavior tests, deterministic performance regression budgets,
and coverage; `yarn test:perf` runs just the performance regression suite.
`yarn typecheck` checks source and test/type assertions. `yarn benchmark` builds
the library and compares it with the indexed pre-refactor commit
`f2e07d2c2e358c634a5fb075163fdbc2ef353ccd` in this repository (Git history is required).
It covers batch, individual, overlapping, and serial requests at 100/500/1000
unique tasks, verifies outputs and execution counts, and records cold/hot-cache
five-run median timings and key-call counts in `perf-results.json`.

CI on Node 22/24 gates deterministic work budgets: one key extraction per submitted
item, no completion-time identity lookups, and one execution per distinct task.
It also runs the elapsed-time benchmark and uploads its JSON report for comparison.
Elapsed-time measurements include timer and Promise overhead; they are diagnostic,
not machine-independent pass/fail thresholds. No runtime dependencies are added.

`maxBatchCount` remains the batch size, not a global concurrency limit in parallel
mode. Unlimited caching can retain results indefinitely; use a TTL or `cleanCache()`
when appropriate. The existing batching strategies are preserved.
