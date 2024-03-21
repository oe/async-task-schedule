import AsyncTask from '../src'

function delay(time: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, time))
}

describe('async-task-schedule', () => {
  describe('simple task schedule', () => {
    it('should use cache', async () => {
      let count = 0
      const at = new AsyncTask({
        batchDoTasks: async (names: string[]) => {
          count += 1
          return names.map((n) => (`${n}${count}`))
        },
      })

      const result = await Promise.all([
        at.dispatch(['a', 'b', 'c']),
        at.dispatch(['a', 'b', 'd']),
        at.dispatch(['b', 'd', 'e']),
        at.dispatch('e')
      ])
      expect(result[0][0]).toEqual(result[1][0])
      expect(count).toBe(1)
      // @ts-ignore
      expect(result[3]).toEqual(result[2][2])
    })

    it('should get a not found error when result is missing', async () => {
      const at = new AsyncTask({
        // @ts-ignore
        batchDoTasks: async (names: number[]) => {
          return names.map((n) => n % 2 ? `${n}-result` : new Error('not supported'))
        },
      })

      const result = await at.dispatch([1, 2, 3])
      const respFor2 = result[1]
      expect(respFor2).toBeDefined()
      expect(respFor2!).toBeInstanceOf(Error)
      expect(result[0]).toContain('-result')
    })
  })

  describe('using doTask', () => {
    it('using doTask', async () => {
      const at = new AsyncTask({
        doTask(n: number) {
          if (n > 20) throw new Error(`jackpot bong! ${n}`)
          return n * n
        }
      })
      const result = await Promise.all([
        at.dispatch([1, 2, 3, 4]),
        at.dispatch([5, 1, 7]),
        at.dispatch([7, 3, 21]),
      ])
      // @ts-ignore
      expect(result[2][0] > 0).toEqual(true)
      try {
        const result = await at.dispatch(21)
        fail('should go into error')
      } catch(e) {
        expect(e).toBeInstanceOf(Error)
      }
    })
  })

  describe('retryWhenFailed', () => {
    it('should retry if failed',async () => {
      let countOf2 = 0
      const at = new AsyncTask({
        batchDoTasks: async (nums: number[]) => {
          return nums.map(n => {
            let result: number | Error = n * n
            if (n === 2) {
              countOf2++;
              result = countOf2 < 2 ? new Error('new error') : n * n
            }
            return result
          })
        },
        retryWhenFailed: true
      })
  
      const result1 = await at.dispatch([1, 3, 3])
      const result2 = await at.dispatch([1, 2, 2])
      const result3 = await at.dispatch([1, 2])
      const result = await at.dispatch(2)
      expect(result).toEqual(4)
      expect(countOf2).toEqual(2)
    })
  })

  describe('taskExecStrategy', () => {
    it('serial with batch', async () => {
      const at = new AsyncTask({
        // @ts-ignore
        batchDoTasks: async (names: number[]) => {
          return names.map((n) => n % 2 ? (`${n}-result`) : new Error('not support'))
        },
        taskExecStrategy: 'serial',
        maxBatchCount: 2,
      })

      const result = await at.dispatch([1, 2, 3])
      const respFor2 = result[1]
      expect(respFor2).toBeDefined()
      expect(respFor2!).toBeInstanceOf(Error)
      expect(result[0]).toContain('-result')
    })

    it('serial with doTask', async () => {
      const at = new AsyncTask({
        
        doTask: async (n: number) => {
          return  n % 2 ? (`${n}-result`) : new Error('not support')
        },
        taskExecStrategy: 'serial',
        maxBatchCount: 2,
      })

      const result = await at.dispatch([1, 2, 3])
      const respFor2 = result[1]
      expect(respFor2).toBeDefined()
      expect(respFor2!).toBeInstanceOf(Error)
      expect(result[0]).toContain('-result')
    })

    it('serial waiting', async () => {
      const waitTime = 100
      const t1 = Date.now()
      const at = new AsyncTask({
        // @ts-ignore
        batchDoTasks: async (names: number[]) => {
          await delay(waitTime)
          return names.map((n) => n % 2 ? `${n}-result` : new Error(`not supported ${n}`)).filter(Boolean)
        },
        taskExecStrategy: 'serial',
        maxBatchCount: 2,
      })
      const result = Promise.all([
        at.dispatch([1, 2, 3]),
        at.dispatch([3, 4, 5]),
      ])
      const result2 = new Promise((resolve) => {
        setTimeout(() => {
          resolve(at.dispatch([2, 10, 88, 23, 21, 13]))
        }, 60);
      })
      const r = await result
      const r1 = await result2
      const t2 = Date.now()
      // @ts-ignore
      expect(r1.length).toEqual(6)
      // make sure all of them exec in serial
      expect((t2 - t1) > waitTime * 6).toEqual(true)
    })
  })

  describe('taskWaitingStrategy', () => {
    it('throttle waiting', async () => {
      const waitTime = 100
      const t1 = Date.now()
      const at = new AsyncTask({
        // @ts-ignore
        batchDoTasks: async (names: number[]) => {
          await delay(waitTime)
          return names.map((n) => n % 2 ? `${n}-result` : new Error('not supported'))
        },
        taskWaitingStrategy: 'throttle',
        maxBatchCount: 2,
      })
      const result = Promise.all([
        at.dispatch([1, 2, 3]),
        at.dispatch([3, 4, 5]),
      ])

      const delayTime = 60
      const result2 = new Promise((resolve) => {
        setTimeout(() => {
          resolve(at.dispatch([2, 10, 88, 23, 21, 13]))
        }, delayTime);
      })
      const r = await result
      const r1 = await result2
      const t2 = Date.now()
      // @ts-ignore
      expect(r1.length).toEqual(6)
      const duration = (t2 - t1)
      // TODO: not precise
      expect( duration > waitTime * 6).toEqual(true)
      expect( duration < waitTime * 6 + delayTime + 10).toEqual(true)
    })

  })

  describe('miscs', () => {
    it('critical parameters missing', () => {
      try {
        new AsyncTask({})
      } catch (error) {
        expect(error).toBeInstanceOf(Error)
      }
    })

    it('get cached error result', async () => {
      let countOf1 = 0
      const at = new AsyncTask({
        doTask(n: number) {
          if (n === 1) ++countOf1
          throw new Error('not implemented')
        },
        invalidAfter: 0,
        retryWhenFailed: false
      })
      await at.dispatch([1,2,3])
      try {
        const result = await at.dispatch(1)
        fail('should go to catch block')
      } catch (error) {
        expect(error).toBeInstanceOf(Error)
        // @ts-ignore
        expect(error.message).toEqual('not implemented')
        expect(countOf1).toEqual(1)
      }
    })

    it('get cached error result', async () => {
      const at = new AsyncTask({
        doTask(n: number) {
          return n * n
        },
        retryWhenFailed: false
      })
      await at.dispatch([1,2,3])
      at.cleanCache()
      // @ts-ignore
      expect(at.doneTaskMap.length).toBe(0)
    })

    it('delay clean cache', async () => {
      const at = new AsyncTask({
        doTask(n: number) {
          return n * n
        },
        retryWhenFailed: false
      })
      const result1 = at.dispatch([1,2,3])
      at.cleanCache()
      const result2 = at.dispatch([1,2,3, 7, 0, 1, 10])
      await result1
      await result2
      // @ts-ignore
      expect(at.doneTaskMap.length).toBe(0)
    })

  })

  describe('invalidAfter', () => {
    it('should clean cache after validity', async () => {
      let task1Count = 0
      const at = new AsyncTask({
        doTask(n: number) {
          if (n === 1) ++task1Count
          return n * n
        },
        invalidAfter: 1,
      })
  
      await at.dispatch([1,2,3,4])
      await delay(20)
      await at.dispatch(1)
      // @ts-ignore
      expect(at.doneTaskMap.length).toEqual(1)
      expect(task1Count).toEqual(2)
    })

    it('disable invalidity', async() => {
      let task1Count = 0
      const at = new AsyncTask({
        doTask(n: number) {
          if (n === 1) ++task1Count
          return n * n
        },
        invalidAfter: 0,
      })

      await at.dispatch([1,2,3,4])
      await delay(20)
      await at.dispatch(1)
      // @ts-ignore
      expect(at.doneTaskMap.length).toEqual(4)
      expect(task1Count).toEqual(1)
    })

    it('custom validity', async() => {
      const callCount: Record<number, number> = {} 
      const at = new AsyncTask({
        async doTask(n: number) {
          await delay(10)
          callCount[n] = (callCount[n] || 0 ) + 1
          return n * n
        },
        // cache only n < 2
        invalidAfter: (n, r) => {
          if (n < 2) return 0
          return 1
        },
      })

      await at.dispatch([1,2,3,4])
      await delay(20)
      await at.dispatch(1)
      await at.dispatch([1, 2,3,4,5])
      await delay(20)
      await at.dispatch([1, 2,9,4,5])
      await delay(20)
      await at.dispatch(1)
      
      // @ts-ignore
      expect(at.doneTaskMap.length).toEqual(1)
      expect(callCount[1]).toEqual(1)
      expect(callCount[2]).toEqual(3)
    })
  })

  describe('batchDoTasks result error', () => {
    it('should fill with not found error when result absent', async () => {
      const at = new AsyncTask({
        batchDoTasks(nums: number[]) {
          const newNums = nums.slice(0, nums.length - 2)
          return newNums.map(n => n * n)
        },
      })
      const result = await at.dispatch([1,2,3,4])
      expect(result[3]).toBeInstanceOf(Error)
      expect(result[1]).toEqual(4)
    })

    it('should all fill with error when batchDoTasks failed', async() => {
      const at = new AsyncTask({
        batchDoTasks(nums: number[]) {
          throw new Error('inner error')
        },
      })
      const result = await at.dispatch([1,2,3,4])
      expect(result[3]).toBeInstanceOf(Error)
      expect(result[1]).toBeInstanceOf(Error)
    })

    it('should all fill with error when batchDoTasks failed and chunked', async() => {
      const at = new AsyncTask({
        batchDoTasks(nums: number[]) {
          throw new Error('inner error')
        },
        maxBatchCount: 2,
      })
      const result = await at.dispatch([1,2,3,4])
      expect(result[3]).toBeInstanceOf(Error)
      expect(result[1]).toBeInstanceOf(Error)
    })

    it('batchDoTasks failed, chunked, serial', async() => {
      const at = new AsyncTask({
        batchDoTasks(nums: number[]) {
          throw new Error('inner error')
        },
        taskExecStrategy: 'serial',
        maxBatchCount: 2,
      })
      const result = await at.dispatch([1,2,3,4])
      expect(result[3]).toBeInstanceOf(Error)
      expect(result[1]).toBeInstanceOf(Error)
    })
  })

})
