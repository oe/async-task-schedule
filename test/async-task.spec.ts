import AsyncTask from '../src'

describe('async-task-schedule', () => {
  describe('simple task schedule', () => {
    it('should use cache', async () => {
      let count = 0
      const at = new AsyncTask({
        batchDoTasks: async (names: string[]) => {
          count += 1
          return names.map((n) => ([n, `${n}${count}`] as [string, string]))
        },
      })

      const result = await Promise.all([
        at.dispatch(['a', 'b', 'c']),
        at.dispatch(['a', 'b', 'd']),
        at.dispatch(['b', 'd', 'e']),
        at.dispatch('e')
      ])
      expect(result[0][0][1]).toEqual(result[1][0][1])
      expect(count).toBe(1)
      // @ts-ignore
      expect(result[3]).toEqual(result[2][2][1])
    })

    it("should get a not found error when result is missing", async () => {
      const at = new AsyncTask({
        // @ts-ignore
        batchDoTasks: async (names: number[]) => {
          return names.map((n) => n % 2 ? ([n, `${n}-result`] as [number, string]) : false).filter(Boolean)
        },
      })

      const result = await at.dispatch([1, 2, 3])
      const respFor2 = result.find(item => item[0] === 2)
      expect(respFor2).toBeDefined()
      expect(respFor2![1]).toBeInstanceOf(Error)
      expect(result[0][1]).toContain('-result')
    })
  })

  it('using doTask', async () => {
    const taskList = new Set<number>()
    const at = new AsyncTask({
      doTask(n: number) {
        if (taskList.has(n)) {
          console.log(`duplicated task found: ${n}`)
        }
        taskList.add(n)
        if (n > 20) throw new Error(`jackpot bong! ${n}`)
        return n * n
      }
    })
    const result = await Promise.all([
      at.dispatch([1, 2, 3, 4]),
      at.dispatch([5, 1, 7]),
      at.dispatch([7, 3, 21]),
    ])

    expect(result[2][0][1] > 0).toEqual(true)
    try {
      const result = await at.dispatch(21)
      fail('should go into error')
    } catch(e) {
      expect(e).toBeInstanceOf(Error)
    }
  })
})
