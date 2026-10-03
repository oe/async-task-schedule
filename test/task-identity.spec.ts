import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import AsyncTask, { type ITaskKey } from '../src'

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(10_000) })
afterEach(() => vi.useRealTimers())

describe('task identity and performance invariants', () => {
  it('uses stable keys instead of object identity or deep comparison', async () => {
    const isSameTask = vi.fn(() => false)
    const doTask = vi.fn((task: { id: number, label: string }) => task.label)
    const schedule = new AsyncTask({ doTask, getTaskKey: task => task.id, isSameTask, maxWaitingGap: 0 })
    const first = schedule.dispatch([{ id: 1, label: 'first' }, { id: 1, label: 'second' }, { id: 2, label: 'other' }])
    await vi.runAllTimersAsync()
    await expect(first).resolves.toEqual(['first', 'first', 'other'])
    await expect(schedule.dispatch({ id: 1, label: 'cached' })).resolves.toBe('first')
    expect(doTask).toHaveBeenCalledTimes(2)
    expect(isSameTask).not.toHaveBeenCalled()
  })

  it('keeps numeric, string, symbol, zero, and empty-string keys distinct', async () => {
    const a = Symbol('same label')
    const b = Symbol('same label')
    const keys: ITaskKey[] = [1, '1', 0, '', a, b, NaN]
    const doTask = vi.fn((task: { key: ITaskKey, value: number }) => task.value)
    const schedule = new AsyncTask({ doTask, getTaskKey: task => task.key, maxWaitingGap: 0 })
    const tasks = keys.map((key, value) => ({ key, value }))
    const result = schedule.dispatch([...tasks, { key: a, value: 99 }, { key: NaN, value: 99 }])
    await vi.runAllTimersAsync()
    await expect(result).resolves.toEqual([0, 1, 2, 3, 4, 5, 6, 4, 6])
    expect(doTask).toHaveBeenCalledTimes(keys.length)
  })

  it('supports custom comparison when no key extractor is supplied', async () => {
    const doTask = vi.fn((task: { id: number, label: string }) => task.label)
    const schedule = new AsyncTask({ doTask, isSameTask: (a, b) => a.id === b.id, maxWaitingGap: 0 })
    const result = schedule.dispatch([{ id: 1, label: 'first' }, { id: 1, label: 'second' }])
    await vi.runAllTimersAsync()
    await expect(result).resolves.toEqual(['first', 'first'])
    expect(doTask).toHaveBeenCalledTimes(1)
  })

  it('shares a keyed executor across hundreds of overlapping requests', async () => {
    const doTask = vi.fn((n: number) => n * 10)
    const schedule = new AsyncTask({ doTask, getTaskKey: n => n, maxWaitingGap: 0 })
    const requests = Array.from({ length: 200 }, (_, i) => [i % 20, (i + 1) % 20, i % 20])
    const responses = requests.map(tasks => schedule.dispatch(tasks))
    await vi.runAllTimersAsync()
    expect(await Promise.all(responses)).toEqual(requests.map(tasks => tasks.map(n => n * 10)))
    expect(doTask).toHaveBeenCalledTimes(20)
    expect(schedule.isTaskRunning).toBe(false)
  })

  it('does linear key work for a large batch and one key lookup per hot-cache hit', async () => {
    const batchDoTasks = vi.fn((tasks: number[]) => tasks)
    const getTaskKey = vi.fn((n: number) => n)
    const isSameTask = vi.fn(AsyncTask.isEqual)
    const schedule = new AsyncTask({ batchDoTasks, getTaskKey, isSameTask, maxWaitingGap: 0, invalidAfter: 1000 })
    const tasks = Array.from({ length: 1000 }, (_, i) => i)
    const result = schedule.dispatch([...tasks, ...tasks])
    await vi.runAllTimersAsync()
    await expect(result).resolves.toEqual([...tasks, ...tasks])
    expect(getTaskKey.mock.calls.length).toBeLessThan(12 * tasks.length)
    getTaskKey.mockClear()
    const cached = await Promise.all(tasks.map(task => schedule.dispatch(task)))
    expect(cached).toEqual(tasks)
    expect(getTaskKey).toHaveBeenCalledTimes(tasks.length)
    expect(isSameTask).not.toHaveBeenCalled()
    expect(batchDoTasks).toHaveBeenCalledTimes(1)
  })

  it.each([0.5, 1.5])('expires fractional TTL %s at the next integer millisecond', async (invalidAfter) => {
    const doTask = vi.fn((n: number) => n)
    const schedule = new AsyncTask({ doTask, getTaskKey: n => n, maxWaitingGap: 0, invalidAfter })
    const first = schedule.dispatch(1)
    await vi.runAllTimersAsync()
    await first
    await vi.advanceTimersByTimeAsync(Math.floor(invalidAfter) + 1)
    const fresh = schedule.dispatch(1)
    await vi.runAllTimersAsync()
    await fresh
    expect(doTask).toHaveBeenCalledTimes(2)
  })

  it('rejects a failing key extractor without leaving a queued request behind', async () => {
    const error = new Error('invalid key')
    const batchDoTasks = vi.fn((tasks: number[]) => tasks)
    const schedule = new AsyncTask({ batchDoTasks, getTaskKey: n => { if (n === 2) throw error; return n }, maxWaitingGap: 0 })
    await expect(schedule.dispatch([1, 2])).rejects.toBe(error)
    const next = schedule.dispatch([1])
    await vi.runAllTimersAsync()
    await expect(next).resolves.toEqual([1])
    expect(batchDoTasks).toHaveBeenCalledTimes(1)
    schedule.cleanCache()
    const fresh = schedule.dispatch([1])
    await vi.runAllTimersAsync()
    await fresh
    expect(batchDoTasks).toHaveBeenCalledTimes(2)
  })

  it.each([false, true])('explicit undefined TTL keeps successes while discarding retryable errors, keyed=%s', async (keyed) => {
    const error = new Error('failure')
    const doTask = vi.fn((n: number): number => { if (n === 2) throw error; return n })
    const schedule = new AsyncTask({ doTask, invalidAfter: undefined, maxWaitingGap: 0, ...(keyed ? { getTaskKey: (n: number) => n } : {}) })
    const first = schedule.dispatch([1, 2])
    await vi.runAllTimersAsync()
    await expect(first).resolves.toEqual([1, error])
    await vi.advanceTimersByTimeAsync(100_000)
    await expect(schedule.dispatch(1)).resolves.toBe(1)
    const retry = schedule.dispatch([1, 2])
    await vi.runAllTimersAsync()
    await expect(retry).resolves.toEqual([1, error])
    expect(doTask.mock.calls.map(([n]) => n)).toEqual([1, 2, 2])
  })
})
