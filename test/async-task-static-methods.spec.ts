import AsyncTask from '../src'

describe('async-task static methods', () => {
  describe('wrapError', () => {
    it('should return error itself when receive an error', () => {
      const error = new Error('some error')
      expect(AsyncTask.wrapError(error)).toEqual(error)
    })

    it('should return an error when receive none error', () => {
      const msg = 'some error info'
      const error = AsyncTask.wrapError(msg)
      expect(error).toBeInstanceOf(Error)
      // @ts-ignore
      expect(error !== msg).toBeTruthy()
      // @ts-ignore
      expect(error.original === msg).toBeTruthy()
      expect(error.message).toEqual('task failed')
    })
  })

  describe('chunk', () => {
    it('chunk with empty array', () => {
      const arr: number[] = []
      expect(AsyncTask.chunk(arr, 10).length).toEqual(0)
    })

    it('chunk array with small size ', () => {
      const arr: number[] = Array(20).fill(1)
      const size = 6
      const result = AsyncTask.chunk(arr, size)
      expect(result.length)
        .toEqual(Math.ceil(arr.length / size))
      expect(result.pop()?.length).toEqual(arr.length % size)
    })

    it('chunk array with big size ', () => {
      const arr: number[] = Array(20).fill(1)
      const size = 21
      const result = AsyncTask.chunk(arr, size)
      expect(result.length)
        .toEqual(1)
      expect(result[0].length).toEqual(arr.length)
    })
  })

  describe('runTaskExecutor', () => {
    it('runTaskExecutor with sync function, no parameters', async () => {
      const fun = () => 'sync'
      const result = await AsyncTask.runTaskExecutor(fun)
      expect(result.status).toEqual('fulfilled')
      // @ts-ignore
      expect(result.value).toEqual('sync')
    })

    it('runTaskExecutor with sync function, with parameters', async () => {
      const fun = (a: string) => `hello ${a}`
      const result = await AsyncTask.runTaskExecutor(fun, 'world')
      expect(result.status).toEqual('fulfilled')
      // @ts-ignore
      expect(result.value).toEqual('hello world')
    })

    it('runTaskExecutor with sync function, throw error', async () => {
      const fun = () => { throw new Error('not implemented') }
      const result = await AsyncTask.runTaskExecutor(fun)
      expect(result.status).toEqual('rejected')
      // @ts-ignore
      expect(result.reason).toBeInstanceOf(Error)
    })

    it('runTaskExecutor with async function, no parameters', async () => {
      const fun = async () => 'sync'
      const result = await AsyncTask.runTaskExecutor(fun)
      expect(result.status).toEqual('fulfilled')
      // @ts-ignore
      expect(result.value).toEqual('sync')
    })

    it('runTaskExecutor with async function, with parameters', async () => {
      const fun = async (a: string) => `hello ${a}`
      const result = await AsyncTask.runTaskExecutor(fun, 'world')
      expect(result.status).toEqual('fulfilled')
      // @ts-ignore
      expect(result.value).toEqual('hello world')
    })

    it('runTaskExecutor with async function, throw error', async () => {
      const fun = async () => { throw new Error('not implemented') }
      const result = await AsyncTask.runTaskExecutor(fun)
      expect(result.status).toEqual('rejected')
      // @ts-ignore
      expect(result.reason).toBeInstanceOf(Error)
    })
  })

  describe('wrapDoTask', () => {

  })

  describe('isEqual', () => {
    it('primitives', () => {
      expect(AsyncTask.isEqual('aaa', 'ccc')).toEqual(false)
      expect(AsyncTask.isEqual('ccc', 'ccc')).toEqual(true)
      expect(AsyncTask.isEqual(112, 'ccc')).toEqual(false)
      expect(AsyncTask.isEqual(112, 90)).toEqual(false)
      expect(AsyncTask.isEqual(23, 23)).toEqual(true)
      expect(AsyncTask.isEqual(true, 23)).toEqual(false)
      expect(AsyncTask.isEqual(true, false)).toEqual(false)
      expect(AsyncTask.isEqual(true, true)).toEqual(true)
      expect(AsyncTask.isEqual(Symbol('aa'), Symbol('aa'))).toEqual(false)
      const syb = Symbol('ccc')
      expect(AsyncTask.isEqual(syb, syb)).toEqual(true)
      expect(AsyncTask.isEqual(NaN, NaN)).toEqual(true)
      expect(AsyncTask.isEqual(1/0, 1/0)).toEqual(true)
    })

    it('regexp', () => {
      expect(AsyncTask.isEqual(/aa/, /aa/i)).toEqual(false)
      expect(AsyncTask.isEqual(/cc/, /aa/i)).toEqual(false)
      expect(AsyncTask.isEqual(/ad/, /ad/)).toEqual(true)
    })

    it('array', () => {
      expect(AsyncTask.isEqual([], [])).toEqual(true)
      expect(AsyncTask.isEqual([], /aa/i)).toEqual(false)
      expect(AsyncTask.isEqual(['xx'], /ad/)).toEqual(false)
      expect(AsyncTask.isEqual(['xx'], [1])).toEqual(false)
      expect(AsyncTask.isEqual(['xx', 'ac'], ['xx'])).toEqual(false)
      expect(AsyncTask.isEqual(['xx', 'ac'], ['xx', 'ac'])).toEqual(true)
      expect(AsyncTask.isEqual(['ac', 'xx'], ['xx', 'ac'])).toEqual(false)
      expect(AsyncTask.isEqual(['xx', [1,2,3]], ['xx', 'ac'])).toEqual(false)
      expect(AsyncTask.isEqual(['xx', [1,2,3]], ['xx', [1,2,3]])).toEqual(true)
    })

    it('object', () => {
      expect(AsyncTask.isEqual({}, {})).toEqual(true)
      expect(AsyncTask.isEqual({}, /aa/i)).toEqual(false)
      expect(AsyncTask.isEqual(['xx'], {})).toEqual(false)
      expect(AsyncTask.isEqual({}, {a: 'xxx'})).toEqual(false)
      expect(AsyncTask.isEqual({a: 1, b: 2}, {a: 1, b: 'x'})).toEqual(false)
      expect(AsyncTask.isEqual({a: 1, b: 2}, {b: 2, a: 1})).toEqual(true)
      expect(AsyncTask.isEqual({a: 'xx', c: [1,2,3]}, {a: 'xx', 'ac': 'de'})).toEqual(false)
      expect(AsyncTask.isEqual({a: 'xx', c: [1,2,3]}, {a: 'xx', 'c': [1,2,3]})).toEqual(true)
      expect(AsyncTask.isEqual({a: 'xx', e: {f: ['z', 1, true]}, c: [1,2,3]},
       {a: 'xx', 'c': [1,2,3], e: { f: [ 'z', 1, true ]}})).toEqual(true)
    })
  })
})
