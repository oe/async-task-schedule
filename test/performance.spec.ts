import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import AsyncTask from '../src'

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(10_000) })
afterEach(() => vi.useRealTimers())

// Work counts are deterministic; elapsed-time benchmarks live in scripts/benchmark.cjs.
describe.each(['single', 'batch'] as const)('performance regression / %s executor', executor => {
  it.each([128, 256, 512, 1024])('does one identity lookup per submitted item, N=%s', async count => {
    const execute = vi.fn((n: number) => n)
    const getTaskKey = vi.fn((n: number) => n)
    const isSameTask = vi.fn(() => false)
    const schedule = new AsyncTask({
      ...(executor === 'single' ? { doTask: execute } : { batchDoTasks: (tasks: number[]) => tasks.map(execute) }),
      getTaskKey, isSameTask, maxWaitingGap: 0,
    })
    const tasks = Array.from({ length: count }, (_, i) => i)
    const first = schedule.dispatch([...tasks, ...tasks])
    await vi.runAllTimersAsync()
    await expect(first).resolves.toEqual([...tasks, ...tasks])
    expect(getTaskKey).toHaveBeenCalledTimes(2 * count)
    expect(isSameTask).not.toHaveBeenCalled()
    expect(execute).toHaveBeenCalledTimes(count)
    getTaskKey.mockClear()
    const cached = await Promise.all(tasks.map(task => schedule.dispatch(task)))
    expect(cached).toEqual(tasks)
    expect(getTaskKey).toHaveBeenCalledTimes(count)
    expect(execute).toHaveBeenCalledTimes(count)
  })

  it('shares each completion across 1,000 overlapping requests', async () => {
    const execute = vi.fn((n: number) => n)
    const getTaskKey = vi.fn((n: number) => n)
    const schedule = new AsyncTask({
      ...(executor === 'single' ? { doTask: execute } : { batchDoTasks: (tasks: number[]) => tasks.map(execute) }),
      getTaskKey, maxWaitingGap: 0,
    })
    const inputs = Array.from({ length: 1000 }, (_, i) => [i % 100, (i + 1) % 100, i % 100])
    const results = inputs.map(tasks => schedule.dispatch(tasks))
    await vi.runAllTimersAsync()
    expect(await Promise.all(results)).toEqual(inputs)
    expect(execute).toHaveBeenCalledTimes(100)
    expect(getTaskKey).toHaveBeenCalledTimes(3000)
  })
})

it('has linear identity work for 2,000 serial tasks', async () => {
  const getTaskKey = vi.fn((n: number) => n)
  const doTask = vi.fn((n: number) => n)
  const schedule = new AsyncTask({ getTaskKey, doTask, taskExecStrategy: 'serial', maxBatchCount: 1, maxWaitingGap: 0 })
  const tasks = Array.from({ length: 2000 }, (_, i) => i)
  const result = schedule.dispatch(tasks)
  await vi.runAllTimersAsync()
  await expect(result).resolves.toEqual(tasks)
  expect(getTaskKey).toHaveBeenCalledTimes(tasks.length)
  expect(doTask).toHaveBeenCalledTimes(tasks.length)
})
