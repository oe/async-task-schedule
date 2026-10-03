import { expectTypeOf, it } from 'vitest'
import AsyncTask, { type IAsyncTaskOptions, type ITaskKey } from '../src'

it('preserves single, array, readonly tuple, and empty tuple response types', () => {
  const schedule = new AsyncTask({ doTask: (n: number) => String(n), getTaskKey: n => n })
  const single = () => schedule.dispatch(1)
  const array = () => schedule.dispatch([1, 2] as number[])
  const tuple = () => schedule.dispatch([1, 2] as const)
  const empty = () => schedule.dispatch([])
  expectTypeOf<ReturnType<typeof single>>().toEqualTypeOf<Promise<string>>()
  expectTypeOf<ReturnType<typeof array>>().toEqualTypeOf<Promise<Array<string | Error>>>()
  expectTypeOf<ReturnType<typeof tuple>>().toEqualTypeOf<Promise<readonly [string | Error, string | Error]>>()
  expectTypeOf<ReturnType<typeof empty>>().toEqualTypeOf<Promise<[]>>()
  expectTypeOf<ITaskKey>().toEqualTypeOf<string | number | symbol>()
})

it('accepts typed key extractors and rejects unsupported key types', () => {
  const options: IAsyncTaskOptions<{ id: string }, number> = {
    doTask: task => task.id.length,
    getTaskKey: task => task.id,
  }
  expectTypeOf(options.getTaskKey).toEqualTypeOf<((task: { id: string }) => ITaskKey) | undefined>()
  const invalid: IAsyncTaskOptions<number, number> = {
    doTask: n => n,
    // @ts-expect-error Keys must be stable primitive values, not objects.
    getTaskKey: n => ({ id: n }),
  }
  expectTypeOf(invalid).toMatchTypeOf<IAsyncTaskOptions<number, number>>()
})
