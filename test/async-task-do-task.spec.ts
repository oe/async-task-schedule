import AsyncTask from '../src'

describe.skip('async-task-schedule with doTask', () => {

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
    expect(result[2][0][1] > 0).toEqual(true)
    try {
      const result = await at.dispatch(21)
      fail('should go into error')
    } catch(e) {
      expect(e).toBeInstanceOf(Error)
    }
  })
})
