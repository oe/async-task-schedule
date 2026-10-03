# async-task-schedule

**Batch and deduplicate async requests with TTL caching.**

[![CI](https://github.com/oe/async-task-schedule/actions/workflows/main.yml/badge.svg)](https://github.com/oe/async-task-schedule/actions/workflows/main.yml)
[![npm version](https://img.shields.io/npm/v/async-task-schedule)](https://www.npmjs.com/package/async-task-schedule)
[![MIT license](https://img.shields.io/npm/l/async-task-schedule)](./LICENSE)

Let multiple callers share one execution for the same task. Group distinct tasks
into a batch when your API supports it, and reuse completed results for a configurable
time. Works with synchronous or asynchronous functions, in Node.js and browsers.
TypeScript declarations are included; there are no runtime dependencies.

## Install

```sh
npm install async-task-schedule
```

The examples below use existing APIs unless marked **unreleased**. The latest npm
release is currently 1.0.1; `getTaskKey` and the improvements in
[PR #1](https://github.com/oe/async-task-schedule/pull/1) are awaiting publication.
For the default TypeScript imports shown here with npm 1.0.1, enable
`esModuleInterop` in your `tsconfig.json`.

## Quick start: six calls, one batch

This example runs without a server. Replace the executor with your batch endpoint
when integrating it into your application.

```ts
import TaskSchedule from 'async-task-schedule'

async function main() {
  let requests = 0
  const users = new TaskSchedule({
    batchDoTasks: async (ids: string[]) => {
      requests += 1
      console.log('Batch:', ids)
      return ids.map(id => ({ id, name: `User ${id}` }))
    },
    maxWaitingGap: 10,
    invalidAfter: 3000,
  })

  const results = await Promise.all(
    ['a', 'b', 'b', 'c', 'a', 'd'].map(id => users.dispatch(id)),
  )

  console.log(results.map(user => user.id)) // ['a', 'b', 'b', 'c', 'a', 'd']
  console.log(requests)                     // 1: batch ['a', 'b', 'c', 'd']

  await users.dispatch('a')                 // cached; no extra request
  console.log(requests)                     // 1
}

main().catch(console.error)
```

Submit calls before awaiting their results to let them join the same waiting window.
Sequential `await` calls cannot join a batch that has already executed, although
those calls can reuse cached results. You can also submit multiple tasks with
`users.dispatch(['a', 'b'])`; results preserve the input order, including duplicates.

## When to use it

- Several parts of your application request the same data at nearly the same time.
- Your backend accepts batches, but callers need a convenient single-item function.
- You want a short-lived result cache around an existing async function.
- You want to execute batches serially instead of starting them all together.

| Your main need | Consider |
| --- | --- |
| Wrap existing functions with deduplication, batching and built-in TTL | async-task-schedule |
| A mature data loader with batching and request-scoped caching | [DataLoader](https://github.com/graphql/dataloader), which also supports custom scheduling and cache implementations |
| A global concurrency limit or a task queue | [p-limit](https://github.com/sindresorhus/p-limit) or [p-queue](https://github.com/sindresorhus/p-queue) |
| Async function memoization without batching | [p-memoize](https://github.com/sindresorhus/p-memoize) |
| Fetch state, retries and revalidation for a frontend framework | [SWR](https://swr.vercel.app/) or [TanStack Query](https://tanstack.com/query) |

`maxBatchCount` limits the size of each batch. In parallel mode it does **not** impose
a global concurrency limit. The waiting window adds latency (50 ms by default);
choose it according to your application's latency budget.

## Recipes

### Deduplicate a JSON read and cache it for three seconds

Use `doTask` when the service has no batch endpoint. Cache parsed data rather than
a raw Fetch `Response`, whose body can only be consumed once.

```ts
import TaskSchedule from 'async-task-schedule'

type User = { id: string; name: string }

// Use a separate instance for each authentication / tenant context.
const users = new TaskSchedule({
  async doTask(id: string): Promise<User> {
    const response = await fetch(`/api/users/${encodeURIComponent(id)}`)
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    return response.json()
  },
  invalidAfter: 3000,
  maxWaitingGap: 0,
})

export const getUser = (id: string) => users.dispatch(id)
```

Use the instance for repeatable reads. A short TTL still shares pending and running
tasks, so it does not make deduplication appropriate for writes that must execute
once per call. Include every result-affecting input in task identity, including
tenant, authorization context and query options. Avoid sharing a cache across users
with different permissions. Treat cached objects as shared data; clone them before
caller-specific mutation.

### Limit batch size and execute batches serially

**Unreleased fix:** the upcoming version preserves `maxBatchCount` in serial mode.
In npm 1.0.1, serial mode forces batches of one item, so this example's batch sizes
require the upcoming release.

```ts
import TaskSchedule from 'async-task-schedule'

async function main() {
  const users = new TaskSchedule({
    batchDoTasks: async (ids: string[]) => {
      console.log('Batch:', ids)
      return ids.map(id => ({ id }))
    },
    maxBatchCount: 2,
    taskExecStrategy: 'serial',
  })

  await users.dispatch(['a', 'b', 'c', 'd', 'e'])
  // Batches: ['a', 'b'], then ['c', 'd'], then ['e'].
}

main().catch(console.error)
```

A real batch executor must return one result or `Error` for each input, in the same
order. If your endpoint returns unordered rows, map them back to the requested IDs.
Throwing from the executor fails the entire batch; returning an `Error` entry fails
only that item. Serial execution waits for each batch to finish; it does not enforce
a fixed number of requests per second.

## API

### `new TaskSchedule(options)`

Supply `doTask`, `batchDoTasks`, or both. If both are supplied, `batchDoTasks` takes priority.

| Option | Default | Behavior |
| --- | --- | --- |
| `doTask(task)` | — | Execute one task; return a value or Promise. |
| `batchDoTasks(tasks)` | — | Execute a batch; return an array or Promise of results / `Error` entries, in input order. |
| `isSameTask(a, b)` | `TaskSchedule.isEqual` | Compare task inputs for deduplication and cache lookup. |
| `getTaskKey(task)` **unreleased** | — | Stable string, number or symbol identity for indexed lookup; takes precedence over `isSameTask`. |
| `maxBatchCount` | Unlimited | `0` or omitted means unlimited; otherwise use a positive integer. |
| `taskExecStrategy` | `'parallel'` | `'parallel'` starts batches together; `'serial'` waits for each batch. In serial mode, `doTask` without a batch size runs one task at a time. |
| `taskWaitingStrategy` | `'debounce'` | `'debounce'` resets the waiting window when new tasks arrive; `'throttle'` keeps a window measured from its first arrival. |
| `maxWaitingGap` | `50` | Waiting-window duration in milliseconds. |
| `invalidAfter` | `1000` | Cache TTL in milliseconds, or `(task, resultOrError) => ttl`. `0` or explicit `undefined` retains results indefinitely. |
| `retryWhenFailed` | `true` | Allow a later dispatch of a failed task to execute again. |

Cache TTL starts when execution completes. Expiration is checked lazily on dispatch;
expired entries are not removed by a background timer. `invalidAfter: 1` means a
one-millisecond TTL, and still allows in-flight deduplication. Use a finite TTL or
`cleanCache()` to avoid retaining an unbounded set of successful results.

### `dispatch(task)` and `dispatch(tasks)`

- A single task resolves to its result, or rejects on failure.
- An array resolves to results or `Error` entries in input order. Task failures do
  not reject the array dispatch; identity / cache-policy callback failures can reject it.
- An array always means multiple tasks. Wrap an array-valued single input in an object.

```ts
import TaskSchedule from 'async-task-schedule'

async function main() {
  const squares = new TaskSchedule({
    doTask(n: number) {
      if (n < 0) throw new Error('Expected a non-negative number')
      return n * n
    },
    maxWaitingGap: 0,
  })

  const results = await squares.dispatch([2, -1, 3])
  console.log(results[0], results[1] instanceof Error, results[2]) // 4, true, 9

  try {
    await squares.dispatch(-1)
  } catch (error) {
    console.error(error)
  }
}

main().catch(console.error)
```

### `cleanCache()`

Request clearing of cached results. When work is pending or running, clearing takes
effect after all that work finishes. It does not cancel execution. When idle,
clearing is immediate; the next dispatch executes again.

### Task identity

Default equality compares plain objects and arrays deeply, including cyclic values,
and compares Dates and RegExps by value. Map, Set, typed arrays and class instances
use reference identity. Supply `isSameTask` for domain-specific equality. These
boundaries describe the upcoming release; 1.0.1 has a less complete comparator.

**Unreleased:** use `getTaskKey` for larger workloads with a natural identity,
for example `task => JSON.stringify([task.tenantId, task.userId])`. Equal keys share
execution and cached results, using the first task's parameters. Include every
input that affects the result. Keys must be pure and stable; avoid mutating tasks
after dispatch. Reuse symbols rather than creating one per call. Keys use `Map`
equality (`1` differs from `'1'`, `NaN` equals `NaN`, `0` equals `-0`).

### Static utilities

- `TaskSchedule.isEqual(a, b)`: the default equality comparator.
- `TaskSchedule.wrapError(value)`: preserve an `Error`, or wrap another thrown value
  in an `Error` with an `original` property.
- `TaskSchedule.runTaskExecutor(executor, ...args)`: resolve to a
  `{ status: 'fulfilled', value }` or `{ status: 'rejected', reason }` object.

## Performance and development

```sh
yarn install --frozen-lockfile
yarn typecheck
yarn test
yarn test:perf
yarn test:package
yarn benchmark
```

The performance suite checks deterministic work counts. The benchmark compares the
current implementation with the pre-refactor implementation and writes
`perf-results.json`; elapsed times are diagnostic and depend on the machine.
CI runs on Node 22 and 24 and uploads benchmark reports.

See [performance and testing](https://github.com/oe/async-task-schedule/blob/main/docs/performance.md)
for methodology, task-key guidance and cache-policy behavior.
See the [changelog](https://github.com/oe/async-task-schedule/blob/main/CHANGELOG.md)
for the changes awaiting release.
Before upgrading from 1.0.1, read the
[upgrade notes](https://github.com/oe/async-task-schedule/blob/main/docs/upgrading.md)
for corrected error, batch-execution and equality behavior. Existing import forms
and package paths are retained.

## License

[MIT](./LICENSE)
