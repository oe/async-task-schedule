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

      const result = await at.dispatch(['a', 'b', 'c'])
      const result2 = await at.dispatch(['a', 'b', 'd'])
      const result3 = await at.dispatch(['b', 'd', 'e'])
      const result4 = await at.dispatch('e')
      expect(result[0][1]).toEqual(result2[0][1])
      // @ts-ignore
      expect(result4).toEqual(result3[2][1])
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
})
