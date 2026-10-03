import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import AsyncTask from '../src'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(10_000) })
afterEach(() => vi.useRealTimers())

describe.each([false, true])('shared task records / keyed=%s', keyed => {
  const identity = keyed ? { getTaskKey: (n: number) => n } : {}

  it('expires cached results while unrelated work remains active', async () => {
    const hold = deferred<number>()
    let calls = 0
    const schedule = new AsyncTask({ doTask: (n: number) => n === 2 ? hold.promise : ++calls, invalidAfter: 5, maxWaitingGap: 0, ...identity })
    const first = schedule.dispatch(1)
    await vi.advanceTimersByTimeAsync(0)
    await expect(first).resolves.toBe(1)
    const blocked = schedule.dispatch(2)
    await vi.advanceTimersByTimeAsync(6)
    const fresh = schedule.dispatch(1)
    hold.resolve(2)
    await vi.runAllTimersAsync()
    await expect(fresh).resolves.toBe(2)
    await blocked
    expect(calls).toBe(2)
  })

  it('keeps already waiting results even after their cache entries expire', async () => {
    const hold = deferred<number>()
    const doTask = vi.fn((n: number) => n === 2 ? hold.promise : 10)
    const schedule = new AsyncTask({ doTask, invalidAfter: 5, maxWaitingGap: 0, ...identity })
    const original = schedule.dispatch([1, 2, 1])
    await vi.advanceTimersByTimeAsync(6)
    const fresh = schedule.dispatch(1)
    hold.resolve(20)
    await vi.runAllTimersAsync()
    await expect(original).resolves.toEqual([10, 20, 10])
    await expect(fresh).resolves.toBe(10)
    expect(doTask.mock.calls.map(([n]) => n)).toEqual([1, 2, 1])
  })

  it('retries a failed task without waiting for unrelated running work', async () => {
    const hold = deferred<number>()
    let calls = 0
    const error = new Error('temporary')
    const schedule = new AsyncTask({ doTask: (n: number) => n === 2 ? hold.promise : ++calls === 1 ? Promise.reject(error) : 10, maxWaitingGap: 0, ...identity })
    const original = schedule.dispatch([1, 2])
    await vi.advanceTimersByTimeAsync(0)
    const retry = schedule.dispatch(1)
    hold.resolve(20)
    await vi.runAllTimersAsync()
    await expect(original).resolves.toEqual([error, 20])
    await expect(retry).resolves.toBe(10)
    expect(calls).toBe(2)
  })

  it('settles a throwing cache policy as a task error and remains usable', async () => {
    const error = new Error('policy failed')
    let fail = true
    const schedule = new AsyncTask({ doTask: (n: number) => n, invalidAfter: () => { if (fail) throw error; return 0 }, maxWaitingGap: 0, ...identity })
    const first = schedule.dispatch([1, 2])
    await vi.runAllTimersAsync()
    await expect(first).resolves.toEqual([error, error])
    expect(schedule.isTaskRunning).toBe(false)
    const second = schedule.dispatch(1).catch(reason => reason)
    await vi.runAllTimersAsync()
    expect(await second).toBe(error)
    fail = false
    const fresh = schedule.dispatch(1)
    await vi.runAllTimersAsync()
    await expect(fresh).resolves.toBe(1)
  })

  it('rejects a policy failure on cache access, evicts that entry, then recovers', async () => {
    const error = new Error('policy changed')
    let fail = false
    const schedule = new AsyncTask({ doTask: (n: number) => n, invalidAfter: () => { if (fail) throw error; return 0 }, maxWaitingGap: 0, ...identity })
    const first = schedule.dispatch(1)
    await vi.runAllTimersAsync()
    await first
    fail = true
    await expect(schedule.dispatch(1)).rejects.toBe(error)
    fail = false
    const fresh = schedule.dispatch(1)
    await vi.runAllTimersAsync()
    await expect(fresh).resolves.toBe(1)
  })

  it('does not retain results with negative TTL', async () => {
    const doTask = vi.fn((n: number) => n)
    const schedule = new AsyncTask({ doTask, invalidAfter: -1, maxWaitingGap: 0, ...identity })
    for (let i = 0; i < 2; i++) {
      const result = schedule.dispatch(1)
      await vi.runAllTimersAsync()
      await expect(result).resolves.toBe(1)
    }
    expect(doTask).toHaveBeenCalledTimes(2)
  })
})

it('settles invalid batch return values as task errors', async () => {
  const schedule = new AsyncTask<number, number>({ batchDoTasks: (() => null) as unknown as (tasks: number[]) => number[], maxWaitingGap: 0 })
  const result = schedule.dispatch([1, 2])
  await vi.runAllTimersAsync()
  const values = await result
  expect(values[0]).toBeInstanceOf(TypeError)
  expect(values[1]).toBe(values[0])
  expect(schedule.isTaskRunning).toBe(false)
})

it('preserves defaults when optional settings are explicitly undefined', async () => {
  const schedule = new AsyncTask({ doTask: (n: number) => n, isSameTask: undefined, taskExecStrategy: undefined, taskWaitingStrategy: undefined, maxWaitingGap: undefined, retryWhenFailed: undefined })
  const result = schedule.dispatch([1, 1])
  await vi.advanceTimersByTimeAsync(49)
  expect(schedule.isTaskRunning).toBe(false)
  await vi.advanceTimersByTimeAsync(1)
  await expect(result).resolves.toEqual([1, 1])
})

it('captures keys once and keeps completion independent of key callbacks', async () => {
  let executionStarted = false
  const getTaskKey = vi.fn((task: { id: number }) => {
    if (executionStarted) throw new Error('key extraction during completion')
    return task.id
  })
  const schedule = new AsyncTask({ getTaskKey, doTask: (task: { id: number }) => { executionStarted = true; return task.id }, maxWaitingGap: 0 })
  const result = schedule.dispatch([{ id: 1 }, { id: 1 }, { id: 2 }])
  await vi.runAllTimersAsync()
  await expect(result).resolves.toEqual([1, 1, 2])
  expect(getTaskKey).toHaveBeenCalledTimes(3)
})

it('uses a snapshot of the request array', async () => {
  const tasks = [1, 2]
  const schedule = new AsyncTask({ doTask: (n: number) => n, maxWaitingGap: 0 })
  const result = schedule.dispatch(tasks)
  tasks.push(3)
  await vi.runAllTimersAsync()
  await expect(result).resolves.toEqual([1, 2])
})

it('aborts a comparator failure without committing partial tasks', async () => {
  const error = new Error('comparison failed')
  const doTask = vi.fn((n: number) => n)
  let fail = true
  const schedule = new AsyncTask({ doTask, isSameTask: (a, b) => { if (fail) throw error; return a === b }, maxWaitingGap: 0 })
  await expect(schedule.dispatch([1, 2])).rejects.toBe(error)
  await vi.runAllTimersAsync()
  expect(doTask).not.toHaveBeenCalled()
  fail = false
  const next = schedule.dispatch([1, 2])
  await vi.runAllTimersAsync()
  await expect(next).resolves.toEqual([1, 2])
})

it('handles completion at different times in serial batches without moving the remaining queue', async () => {
  const doTask = vi.fn((n: number) => n)
  const schedule = new AsyncTask({ doTask, taskExecStrategy: 'serial', maxBatchCount: 1, maxWaitingGap: 0 })
  const result = schedule.dispatch([1, 2, 3, 4])
  await vi.runAllTimersAsync()
  await expect(result).resolves.toEqual([1, 2, 3, 4])
  expect(doTask.mock.calls.map(([n]) => n)).toEqual([1, 2, 3, 4])
})

it('retains valid per-task TTL values and respects policy changes on cache access', async () => {
  let ttl = 10
  const doTask = vi.fn((n: number) => n)
  const schedule = new AsyncTask({ doTask, invalidAfter: () => ttl, maxWaitingGap: 0 })
  const first = schedule.dispatch(1)
  await vi.runAllTimersAsync()
  await first
  await vi.advanceTimersByTimeAsync(3)
  await expect(schedule.dispatch(1)).resolves.toBe(1)
  ttl = 50
  await vi.advanceTimersByTimeAsync(9)
  await expect(schedule.dispatch(1)).resolves.toBe(1)
  expect(doTask).toHaveBeenCalledTimes(1)
  ttl = 5
  const expired = schedule.dispatch(1)
  await vi.runAllTimersAsync()
  await expect(expired).resolves.toBe(1)
  expect(doTask).toHaveBeenCalledTimes(2)
})

it.each(['single', 'batch'] as const)('starts a fresh waiting window for requests chained after %s completion', async executor => {
  const execute = vi.fn((n: number) => n)
  const schedule = new AsyncTask({
    ...(executor === 'single' ? { doTask: execute } : { batchDoTasks: (tasks: number[]) => tasks.map(execute) }),
    maxWaitingGap: 50, getTaskKey: n => n,
  })
  const next = schedule.dispatch(1).then(() => schedule.dispatch(2))
  await vi.advanceTimersByTimeAsync(50)
  expect(execute.mock.calls.map(([n]) => n)).toEqual([1])
  await vi.advanceTimersByTimeAsync(49)
  expect(execute).toHaveBeenCalledTimes(1)
  await vi.advanceTimersByTimeAsync(1)
  await expect(next).resolves.toBe(2)
  expect(execute.mock.calls.map(([n]) => n)).toEqual([1, 2])
})

it.each(['single', 'batch'] as const)('preserves callback receivers in %s mode', async executor => {
  let schedule: AsyncTask<number, number>
  const receiver = function (this: AsyncTask<number, number>, n: number) {
    expect(this).toBe(schedule)
    return n
  }
  schedule = new AsyncTask({
    ...(executor === 'single' ? { doTask: receiver } : { batchDoTasks: function (this: AsyncTask<number, number>, tasks: number[]) { expect(this).toBe(schedule); return tasks } }),
    getTaskKey: receiver,
    invalidAfter: function (this: AsyncTask<number, number>) { expect(this).toBe(schedule); return 0 },
    maxWaitingGap: 0,
  })
  const result = schedule.dispatch([1, 1])
  await vi.runAllTimersAsync()
  await expect(result).resolves.toEqual([1, 1])
  await expect(schedule.dispatch(1)).resolves.toBe(1)
  const unkeyed = new AsyncTask({
    doTask: (n: number) => n,
    isSameTask: function (this: AsyncTask<number, number>, a: number, b: number) { expect(this).toBe(unkeyed); return a === b },
    maxWaitingGap: 0,
  })
  const duplicate = unkeyed.dispatch([1, 1])
  await vi.runAllTimersAsync()
  await expect(duplicate).resolves.toEqual([1, 1])
})
