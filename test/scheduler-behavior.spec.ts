import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import AsyncTask, { type IAsyncTaskOptions } from '../src'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}

const modes = (['single', 'batch'] as const).flatMap(executor =>
  (['serial', 'parallel'] as const).flatMap(strategy =>
    (['debounce', 'throttle'] as const).flatMap(waiting =>
      [false, true].map(keyed => ({ executor, strategy, waiting, keyed })),
    ),
  ),
)

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(10_000) })
afterEach(() => vi.useRealTimers())

describe.each(modes)('$executor / $strategy / $waiting / keyed=$keyed', (mode) => {
  function make(execute: (task: number) => number | Promise<number>, extra: Partial<IAsyncTaskOptions<number, number>> = {}) {
    return new AsyncTask<number, number>({
      ...(mode.executor === 'single'
        ? { doTask: execute }
        : { batchDoTasks: (tasks) => Promise.all(tasks.map(execute)) }),
      taskExecStrategy: mode.strategy, taskWaitingStrategy: mode.waiting,
      maxBatchCount: 2, maxWaitingGap: 10,
      ...(mode.keyed ? { getTaskKey: (n: number) => n } : {}),
      ...extra,
    })
  }

  it('preserves request order and repeated positions across overlapping requests', async () => {
    const execute = vi.fn((n: number) => n * 10)
    const schedule = make(execute)
    const first = schedule.dispatch([3, 1, 3, 2])
    const second = schedule.dispatch([2, 4, 1])
    await vi.runAllTimersAsync()
    await expect(first).resolves.toEqual([30, 10, 30, 20])
    await expect(second).resolves.toEqual([20, 40, 10])
    expect(execute.mock.calls.map(([n]) => n)).toEqual([3, 1, 2, 4])
    expect(schedule.isTaskRunning).toBe(false)
  })

  it('shares active work and returns ordered values after reverse completion', async () => {
    const one = deferred<number>()
    const two = deferred<number>()
    const execute = vi.fn((n: number) => n === 1 ? one.promise : two.promise)
    const schedule = make(execute)
    const first = schedule.dispatch([1, 2, 1])
    await vi.advanceTimersByTimeAsync(10)
    const second = schedule.dispatch([2, 1])
    const empty = schedule.dispatch([])
    await expect(empty).resolves.toEqual([])
    two.resolve(20)
    await vi.advanceTimersByTimeAsync(0)
    expect(schedule.isTaskRunning).toBe(true)
    one.resolve(10)
    await vi.runAllTimersAsync()
    await expect(first).resolves.toEqual([10, 20, 10])
    await expect(second).resolves.toEqual([20, 10])
    expect(execute).toHaveBeenCalledTimes(2)
  })

  it('retries failed tasks while keeping successful cached values', async () => {
    let attempts = 0
    const error = new Error('temporary failure')
    const execute = vi.fn((n: number) => {
      if (n === 2 && ++attempts === 1) throw error
      return n * 10
    })
    // Individual failures in batch results are represented by Error entries.
    const schedule = make(execute, mode.executor === 'batch' ? {
      batchDoTasks: (tasks) => Promise.all(tasks.map(async (task) => {
        try { return await execute(task) } catch (failure) { return AsyncTask.wrapError(failure) }
      })),
    } : {})
    const first = schedule.dispatch([1, 2])
    await vi.runAllTimersAsync()
    await expect(first).resolves.toEqual([10, error])
    const retry = schedule.dispatch([2, 1, 2])
    await vi.runAllTimersAsync()
    await expect(retry).resolves.toEqual([20, 10, 20])
    expect(execute.mock.calls.map(([n]) => n)).toEqual([1, 2, 2])
  })

  it('keeps TTL boundary values and recomputes them only after expiration', async () => {
    const execute = vi.fn((n: number) => n * 10)
    const schedule = make(execute, { invalidAfter: 100 })
    const first = schedule.dispatch([1, 2])
    await vi.runAllTimersAsync()
    await expect(first).resolves.toEqual([10, 20])
    await vi.advanceTimersByTimeAsync(100)
    await expect(schedule.dispatch([2, 1])).resolves.toEqual([20, 10])
    expect(execute).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(1)
    const expired = schedule.dispatch([2, 1])
    await vi.runAllTimersAsync()
    await expect(expired).resolves.toEqual([20, 10])
    expect(execute).toHaveBeenCalledTimes(4)
  })
})

for (const keyed of [false, true]) {
  describe(`edge cases / keyed=${keyed}`, () => {
    const identity = keyed ? { getTaskKey: (n: number) => n } : {}

    it.each([0, false, '', null, undefined, NaN])('caches a falsy result %s without confusing it with a miss', async (value) => {
      const doTask = vi.fn((n: number) => value)
      const schedule = new AsyncTask({ doTask, maxWaitingGap: 0, ...identity })
      const first = schedule.dispatch([1, 1])
      await vi.runAllTimersAsync()
      await expect(first).resolves.toEqual([value, value])
      await expect(schedule.dispatch(1)).resolves.toEqual(value)
      expect(doTask).toHaveBeenCalledTimes(1)
    })

    it.each(['throw', 'reject'] as const)('wraps a non-Error %s and preserves the original value', async (failureMode) => {
      const reason = { code: 503 }
      const schedule = new AsyncTask({
        doTask: (n: number): Promise<number> => {
          if (failureMode === 'throw') throw reason
          return Promise.reject(reason)
        }, maxWaitingGap: 0, ...identity,
      })
      const result = schedule.dispatch(1).then(() => undefined, error => error)
      await vi.runAllTimersAsync()
      const error = await result
      expect(error).toBeInstanceOf(Error)
      expect(error.original).toBe(reason)
      expect(schedule.isTaskRunning).toBe(false)
    })

    it('keeps cached errors when retry is disabled, then retries after clearing cache', async () => {
      const error = new Error('cached failure')
      const doTask = vi.fn((n: number): number => { throw error })
      const schedule = new AsyncTask({ doTask, retryWhenFailed: false, invalidAfter: 0, maxWaitingGap: 0, ...identity })
      const first = schedule.dispatch([1])
      await vi.runAllTimersAsync()
      await expect(first).resolves.toEqual([error])
      await expect(schedule.dispatch(1)).rejects.toBe(error)
      expect(doTask).toHaveBeenCalledTimes(1)
      schedule.cleanCache()
      const fresh = schedule.dispatch([1])
      await vi.runAllTimersAsync()
      await expect(fresh).resolves.toEqual([error])
      expect(doTask).toHaveBeenCalledTimes(2)
    })

    it('supports per-task TTL and unlimited caching in the same result set', async () => {
      const doTask = vi.fn((n: number) => n)
      const invalidAfter = vi.fn((task: number, result: number | Error) => task === 1 ? 0 : 20)
      const schedule = new AsyncTask({ doTask, invalidAfter, maxWaitingGap: 0, ...identity })
      const first = schedule.dispatch([1, 2])
      await vi.runAllTimersAsync()
      await first
      await vi.advanceTimersByTimeAsync(21)
      const next = schedule.dispatch([1, 2])
      await vi.runAllTimersAsync()
      await expect(next).resolves.toEqual([1, 2])
      expect(doTask.mock.calls.map(([n]) => n)).toEqual([1, 2, 2])
      expect(invalidAfter).toHaveBeenCalledWith(1, 1)
      expect(invalidAfter).toHaveBeenCalledWith(2, 2)
    })

    it('coalesces multiple cache clears while work is active', async () => {
      const finish = deferred<number>()
      const doTask = vi.fn((n: number) => finish.promise)
      const schedule = new AsyncTask({ doTask, invalidAfter: 0, maxWaitingGap: 0, ...identity })
      const first = schedule.dispatch(1)
      schedule.cleanCache()
      schedule.cleanCache()
      await vi.advanceTimersByTimeAsync(0)
      const second = schedule.dispatch(1)
      finish.resolve(10)
      await vi.runAllTimersAsync()
      await expect(first).resolves.toBe(10)
      await expect(second).resolves.toBe(10)
      const next = schedule.dispatch(1)
      await vi.runAllTimersAsync()
      await expect(next).resolves.toBe(10)
      expect(doTask).toHaveBeenCalledTimes(2)
    })

    it.each(['serial', 'parallel'] as const)('isolates a failing batch from successful %s batches', async (taskExecStrategy) => {
      const error = new Error('batch failed')
      const batchDoTasks = vi.fn((tasks: number[]) => {
        if (tasks[0] === 1) throw error
        return tasks.map(n => n * 10)
      })
      const schedule = new AsyncTask({ batchDoTasks, maxBatchCount: 2, taskExecStrategy, maxWaitingGap: 0, ...identity })
      const result = schedule.dispatch([1, 2, 3, 4, 5])
      await vi.runAllTimersAsync()
      await expect(result).resolves.toEqual([error, error, 30, 40, 50])
      expect(batchDoTasks).toHaveBeenCalledTimes(3)
    })

    it('handles missing batch results and ignores surplus results', async () => {
      const schedule = new AsyncTask({ batchDoTasks: (tasks: number[]) => tasks[0] === 1 ? [10] : [20, 30, 40], maxWaitingGap: 0, ...identity })
      const missing = schedule.dispatch([1, 2])
      await vi.runAllTimersAsync()
      await expect(missing).resolves.toEqual([10, new Error('not found')])
      const extra = schedule.dispatch([2, 3])
      await vi.runAllTimersAsync()
      await expect(extra).resolves.toEqual([20, 30])
    })

    it.each([0, undefined])('supports unlimited batch size %s', async (maxBatchCount) => {
      const batchDoTasks = vi.fn((tasks: number[]) => tasks)
      const schedule = new AsyncTask({ batchDoTasks, maxBatchCount, maxWaitingGap: 0, ...identity })
      const result = schedule.dispatch([1, 2, 3, 4])
      await vi.runAllTimersAsync()
      await expect(result).resolves.toEqual([1, 2, 3, 4])
      expect(batchDoTasks).toHaveBeenCalledTimes(1)
    })
  })
}

it('prefers the batch executor when both are supplied and keeps dispatch bound', async () => {
  const doTask = vi.fn((n: number) => -n)
  const batchDoTasks = vi.fn((tasks: number[]) => tasks)
  const schedule = new AsyncTask({ doTask, batchDoTasks, maxWaitingGap: 0 })
  const dispatch = schedule.dispatch
  const result = dispatch([1, 2])
  await vi.runAllTimersAsync()
  await expect(result).resolves.toEqual([1, 2])
  expect(doTask).not.toHaveBeenCalled()
})

it.each(['serial', 'parallel'] as const)('lets single-task results settle independently in %s mode', async (taskExecStrategy) => {
  const one = deferred<number>()
  const two = deferred<number>()
  const schedule = new AsyncTask({ doTask: (n: number) => n === 1 ? one.promise : two.promise, taskExecStrategy, maxBatchCount: 2, maxWaitingGap: 0 })
  const first = schedule.dispatch(1)
  const second = schedule.dispatch(2)
  const combined = schedule.dispatch([1, 2])
  let combinedDone = false
  combined.then(() => { combinedDone = true })
  await vi.advanceTimersByTimeAsync(0)
  one.resolve(10)
  await vi.advanceTimersByTimeAsync(0)
  await expect(first).resolves.toBe(10)
  expect(combinedDone).toBe(false)
  expect(schedule.isTaskRunning).toBe(true)
  two.resolve(20)
  await vi.runAllTimersAsync()
  await expect(second).resolves.toBe(20)
  await expect(combined).resolves.toEqual([10, 20])
})

it.each(['serial', 'parallel'] as const)('respects active batch concurrency in %s mode', async (taskExecStrategy) => {
  const finish = deferred<void>()
  let active = 0
  let peak = 0
  const batchDoTasks = vi.fn(async (tasks: number[]) => {
    peak = Math.max(peak, ++active)
    await finish.promise
    --active
    return tasks
  })
  const schedule = new AsyncTask({ batchDoTasks, taskExecStrategy, maxBatchCount: 2, maxWaitingGap: 0, getTaskKey: n => n })
  const result = schedule.dispatch([1, 2, 3, 4, 5])
  await vi.advanceTimersByTimeAsync(0)
  expect(active).toBe(taskExecStrategy === 'serial' ? 1 : 3)
  finish.resolve()
  await vi.runAllTimersAsync()
  await expect(result).resolves.toEqual([1, 2, 3, 4, 5])
  expect(peak).toBe(taskExecStrategy === 'serial' ? 1 : 3)
  expect(batchDoTasks.mock.calls.map(([tasks]) => tasks)).toEqual([[1, 2], [3, 4], [5]])
})

it.each(['debounce', 'throttle'] as const)('%s handles sustained arrivals and a subsequent waiting window', async (taskWaitingStrategy) => {
  const batchDoTasks = vi.fn((tasks: number[]) => tasks)
  const schedule = new AsyncTask({ batchDoTasks, taskWaitingStrategy, maxWaitingGap: 30, getTaskKey: n => n })
  const responses = [schedule.dispatch(0)]
  for (let i = 1; i <= 2; i++) {
    await vi.advanceTimersByTimeAsync(10)
    responses.push(schedule.dispatch(i))
  }
  await vi.advanceTimersByTimeAsync(10)
  expect(batchDoTasks).toHaveBeenCalledTimes(taskWaitingStrategy === 'throttle' ? 1 : 0)
  await vi.advanceTimersByTimeAsync(20)
  expect(await Promise.all(responses)).toEqual([0, 1, 2])
  expect(batchDoTasks).toHaveBeenCalledTimes(1)
  const next = schedule.dispatch(3)
  await vi.advanceTimersByTimeAsync(29)
  expect(batchDoTasks).toHaveBeenCalledTimes(1)
  await vi.advanceTimersByTimeAsync(1)
  await expect(next).resolves.toBe(3)
  expect(batchDoTasks).toHaveBeenCalledTimes(2)
})
