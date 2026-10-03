import { afterEach, describe, expect, it, vi } from 'vitest'
import AsyncTask from '../src'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

afterEach(() => vi.useRealTimers())

describe('scheduler regressions', () => {
  it('resolves empty requests without starting an executor', async () => {
    vi.useFakeTimers()
    const doTask = vi.fn((n: number) => n)
    const schedule = new AsyncTask({ doTask })
    let result: unknown
    schedule.dispatch([]).then((value) => { result = value })
    await vi.runAllTimersAsync()
    expect(result).toEqual([])
    expect(doTask).not.toHaveBeenCalled()
  })

  it('rejects single failures, including cached failures, but resolves batch errors', async () => {
    const error = new Error('failed')
    const doTask = vi.fn((n: number): number => { throw error })
    const schedule = new AsyncTask({ doTask, retryWhenFailed: false, invalidAfter: 0, maxWaitingGap: 0 })
    await expect(schedule.dispatch(1)).rejects.toBe(error)
    await expect(schedule.dispatch(1)).rejects.toBe(error)
    await expect(schedule.dispatch([1])).resolves.toEqual([error])
    expect(doTask).toHaveBeenCalledTimes(1)
  })

  it.each(['single', 'batch'] as const)('deduplicates running %s tasks and stays running until all finish', async (mode) => {
    vi.useFakeTimers()
    const first = deferred<number>()
    const second = deferred<number>()
    const executor = vi.fn((n: number) => n === 1 ? first.promise : second.promise)
    const schedule = new AsyncTask<number, number>({
      ...(mode === 'single' ? { doTask: executor } : { batchDoTasks: (tasks: number[]) => Promise.all(tasks.map(executor)) }),
      maxBatchCount: 1, maxWaitingGap: 0,
    })
    const original = schedule.dispatch([1, 2])
    await vi.advanceTimersByTimeAsync(0)
    const duplicate = schedule.dispatch(1)
    first.resolve(10)
    await vi.advanceTimersByTimeAsync(0)
    expect(schedule.isTaskRunning).toBe(true)
    second.resolve(20)
    await expect(original).resolves.toEqual([10, 20])
    await expect(duplicate).resolves.toBe(10)
    expect(executor.mock.calls.map(([n]) => n)).toEqual([1, 2])
    expect(schedule.isTaskRunning).toBe(false)
  })

  it('starts parallel batches together', async () => {
    vi.useFakeTimers()
    const finish = deferred<void>()
    const batchDoTasks = vi.fn(async (tasks: number[]) => { await finish.promise; return tasks })
    const schedule = new AsyncTask({ batchDoTasks, maxBatchCount: 2, maxWaitingGap: 0 })
    const result = schedule.dispatch([1, 2, 3, 4])
    await vi.advanceTimersByTimeAsync(0)
    expect(batchDoTasks.mock.calls.map(([tasks]) => tasks)).toEqual([[1, 2], [3, 4]])
    finish.resolve()
    await expect(result).resolves.toEqual([1, 2, 3, 4])
  })

  it('preserves serial batch sizes and queues new requests behind active work', async () => {
    vi.useFakeTimers()
    const finish = deferred<void>()
    const batchDoTasks = vi.fn(async (tasks: number[]) => { await finish.promise; return tasks })
    const schedule = new AsyncTask({ batchDoTasks, taskExecStrategy: 'serial', maxBatchCount: 2, maxWaitingGap: 0 })
    const original = schedule.dispatch([1, 2, 3])
    await vi.advanceTimersByTimeAsync(0)
    const later = schedule.dispatch([2, 4])
    await vi.advanceTimersByTimeAsync(0)
    expect(batchDoTasks.mock.calls.map(([tasks]) => tasks)).toEqual([[1, 2]])
    finish.resolve()
    await expect(original).resolves.toEqual([1, 2, 3])
    await expect(later).resolves.toEqual([2, 4])
    expect(batchDoTasks.mock.calls.map(([tasks]) => tasks)).toEqual([[1, 2], [3, 4]])
  })

  it('uses an unlimited serial batch when no batch size is supplied', async () => {
    const batchDoTasks = vi.fn((tasks: number[]) => tasks)
    const schedule = new AsyncTask({ batchDoTasks, taskExecStrategy: 'serial', maxWaitingGap: 0 })
    await expect(schedule.dispatch([1, 2, 3])).resolves.toEqual([1, 2, 3])
    expect(batchDoTasks).toHaveBeenCalledTimes(1)
    expect(batchDoTasks).toHaveBeenCalledWith([1, 2, 3])
  })

  it('defers cache cleaning until every active request finishes', async () => {
    vi.useFakeTimers()
    const finish = deferred<number>()
    const doTask = vi.fn((n: number) => n === 1 ? 10 : finish.promise)
    const schedule = new AsyncTask({ doTask, invalidAfter: 0, maxWaitingGap: 0 })
    const first = schedule.dispatch(1)
    const second = schedule.dispatch(2)
    await vi.advanceTimersByTimeAsync(0)
    await expect(first).resolves.toBe(10)
    schedule.cleanCache()
    const duplicate = schedule.dispatch(1)
    await expect(duplicate).resolves.toBe(10)
    finish.resolve(20)
    await expect(second).resolves.toBe(20)
    const fresh = schedule.dispatch(1)
    await vi.advanceTimersByTimeAsync(0)
    await expect(fresh).resolves.toBe(10)
    expect(doTask.mock.calls.map(([n]) => n)).toEqual([1, 2, 1])
  })

  it('dispatches distinct null and object tasks without comparator errors', async () => {
    const doTask = vi.fn((task: null | { id: number }) => task === null ? 0 : task.id)
    const schedule = new AsyncTask({ doTask, maxWaitingGap: 0 })
    await expect(schedule.dispatch([null, { id: 1 }, null])).resolves.toEqual([0, 1, 0])
    expect(doTask).toHaveBeenCalledTimes(2)
  })

  it.each([-1, 0.5, NaN, Infinity])('rejects invalid maxBatchCount %s', (maxBatchCount) => {
    expect(() => new AsyncTask({ doTask: (n: number) => n, maxBatchCount })).toThrow(/maxBatchCount/)
  })
})
