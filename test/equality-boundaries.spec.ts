import { expect, it } from 'vitest'
import AsyncTask from '../src'

it('keeps opaque objects distinct unless they are the same reference', () => {
  const map = new Map([['x', 1]])
  expect(AsyncTask.isEqual(map, map)).toBe(true)
  expect(AsyncTask.isEqual(map, new Map([['x', 2]]))).toBe(false)
  expect(AsyncTask.isEqual(new Set([1]), new Set([2]))).toBe(false)
  expect(AsyncTask.isEqual(new Uint8Array([1]), new Uint8Array([1]))).toBe(false)
  expect(AsyncTask.isEqual(Promise.resolve(1), Promise.resolve(1))).toBe(false)
  expect(AsyncTask.isEqual(Object.create(null), {})).toBe(false)
})

it('compares enumerable symbols and sparse array lengths', () => {
  const key = Symbol('key')
  expect(AsyncTask.isEqual({ [key]: 1 }, { [key]: 2 })).toBe(false)
  expect(AsyncTask.isEqual({ [key]: 1 }, { [key]: 1 })).toBe(true)
  expect(AsyncTask.isEqual(new Array(1), new Array(2))).toBe(false)
  expect(AsyncTask.isEqual(new Array(1), [undefined])).toBe(false)
  expect(AsyncTask.isEqual(new Array(1), new Array(1))).toBe(true)
  expect(AsyncTask.isEqual(Object.create(null), Object.create(null))).toBe(true)
})

it('handles cyclic plain objects without conflating different cycle shapes', () => {
  const a: { id: number, self?: unknown } = { id: 1 }; a.self = a
  const b: { id: number, self?: unknown } = { id: 1 }; b.self = b
  expect(AsyncTask.isEqual(a, b)).toBe(true)
  const c = { id: 1, self: b }
  expect(AsyncTask.isEqual(a, c)).toBe(false)
  const x: unknown[] = []; x.push(x)
  const y: unknown[] = []; y.push(y)
  expect(AsyncTask.isEqual(x, y)).toBe(true)
})
