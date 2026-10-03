export type ITaskKey = string | number | symbol
export type ITaskExecStrategy = 'parallel' | 'serial'
export type ITaskWaitingStrategy = 'throttle' | 'debounce'
export interface IAsyncTaskOptions<Task, Result> {
  /**
   * max batch tasks count when dispatching
   */
  maxBatchCount?: number,
  /**
   * action to do batch tasks
   *  one of batchDoTasks/doTask must be specified, batchDoTasks will take priority
   */
  batchDoTasks?: (tasks: Task[]) => Promise<Array<Result | Error>> | Array<Result | Error>,
  /**
   * action to do single task
   *  one of batchDoTasks/doTask must be specified, batchDoTasks will take priority
   */
  doTask?: (task: Task) => Promise<Result> | Result
  /**
   * do batch tasks executing strategy, default to parallel
   */
  taskExecStrategy?: ITaskExecStrategy
  /**
   * max waiting time(in milliseconds) for combined tasks, default to 50
   */
  maxWaitingGap?: number
  /**
   * task result caching duration(in milliseconds), default to 1000ms (1s)
   * >`undefined` or `0` for unlimited  
   * >set to minimum value `1` to disable caching  
   * >`function` to specified specified each task's validity
   * 
   * *cache is lazy cleaned after invalid*
   */
  invalidAfter?: number | ((task: Task, result: Result | Error) => number)
  /**
   * retry failed tasks next time after failing, default true
   */
  retryWhenFailed?: boolean
  /**
   * task waiting strategy, default to debounce
   *  throttle: tasks will combined and dispatch every `maxWaitingGap`
   *  debounce: tasks will combined and dispatch util no more tasks in next `maxWaitingGap`
   */
  taskWaitingStrategy?: ITaskWaitingStrategy
  /**
   * check whether two tasks are identified the same
   */
  isSameTask?: (a: Task, b: Task) => boolean
  /**
   * Optional stable task identity for indexed deduplication and cached lookups.
   * Equal keys identify the same task; takes precedence over isSameTask.
   */
  getTaskKey?: (task: Task) => ITaskKey
}
export default class AsyncTask<Task, Result> {
  /**
   * action to do batch tasks
   *  Task: single task request info
   *  Result: single task success response
   * 
   * batchDoTasks should receive multi tasks, and return result or error in order
   */
  private batchDoTasks?: (tasks: Task[]) => Promise<Array<Result | Error>> | Array<Result | Error>
  
  /**
   * do single task
   */
  private doTask?: (task: Task) => Result | Error | Promise<Result | Error>

  /**
   * check whether two tasks are equal
   *  it helps to avoid duplicated tasks
   *  default:  AsyncTask.isEqual (deep comparison)
   */
  private isSameTask: (a: Task, b: Task) => boolean
  private getTaskKey?: (task: Task) => ITaskKey
  private pendingKeys = new Set<ITaskKey>()
  private runningKeys = new Set<ITaskKey>()
  private resultByKey = new Map<ITaskKey, { task: Task, value: Result | Error, time: number }>()

  /**
   * max task count for batchDoTasks, default unlimited
   *  undefined or 0 for unlimited
   */
  private maxBatchCount?: number

  /**
   * batch tasks executing strategy, default parallel
   *  serial preserves maxBatchCount; doTask defaults to one task at a time
   *  
   * parallel: split all tasks into a list stride by maxBatchCount, exec them at the same time
   * serial: split all tasks into a list stride by maxBatchCount, exec theme one group by one group
   *    if serial specified, when tasks are executing, new comings will wait for them to complete
   *    it's very useful to cool down task requests
   */
  private taskExecStrategy: ITaskExecStrategy

  /**
   * task waiting stragy, default to debounce
   *  throttle: tasks will combined and dispatch every `maxWaitingGap`
   *  debounce: tasks will combined and dispatch util no more tasks in next `maxWaitingGap`
   */
  private taskWaitingStrategy: ITaskWaitingStrategy

  /**
   * task waiting time in milliseconds, default 50ms
   *     differently according to taskWaitingStrategy
   */
  private maxWaitingGap: number

  /**
   * validity(caching duration) of the result(in ms), default unlimited
   *    - undefined or 0 for unlimited
   *    - function to specified each task's validity
   *       - function receive (task, result) as parameters
   *       - return a number(ms) as the validity of the result
   *  
   * default to 1s
   * 
   * cache is lazy cleaned after invalid
   */
  private invalidAfter?: number | ((task: Task, result: Result | Error) => number)

  /**
   * retry failed tasks next time after failing, default true
   */
  private retryWhenFailed?: boolean

  /** Tasks currently being executed, used to deduplicate new requests. */
  private runningTasks: Task[] = []

  /** Tasks ready to be executed. */
  private pendingTasks: Task[]

  /**
   * original tasks request in queue waiting to resolve
   *  empty if all task are done
   */
  private taskQueue: Array<{
    tasks: Task[]|Task, resolve: Function, reject: Function }>
  
  /**
   * cached task result
   */
  private doneTaskMap: Array<{ task: Task, value: Result | Error, time: number }>
  
  /**
   * whether need to clean cache result, aka clean doneTaskMap
   */
  private needCleanCache?: boolean
  private nextCacheCleanup = Infinity
  /**
   * default task options
   */
  private static defaultOptions = {
    isSameTask: AsyncTask.isEqual,
    taskExecStrategy: 'parallel' as const,
    maxWaitingGap: 50,
    invalidAfter: 1000,
    taskWaitingStrategy: 'debounce' as const,
    retryWhenFailed: true,
  }

  constructor(options: IAsyncTaskOptions<Task, Result>) {
    const userOptions = { ...AsyncTask.defaultOptions, ...options }
    this.pendingTasks = []
    this.doneTaskMap = []
    this.taskQueue = []
    this.isSameTask = userOptions.isSameTask
    this.getTaskKey = userOptions.getTaskKey
    this.maxBatchCount = userOptions.maxBatchCount
    this.maxWaitingGap = userOptions.maxWaitingGap

    this.taskWaitingStrategy = userOptions.taskWaitingStrategy
    if (!userOptions.batchDoTasks && !userOptions.doTask) {
      throw new Error('one of batchDoTasks / doTask must be specified')
    }
    this.doTask = userOptions.doTask
    this.batchDoTasks = userOptions.batchDoTasks

    this.taskExecStrategy = userOptions.taskExecStrategy
    if (this.maxBatchCount !== undefined && this.maxBatchCount !== 0
      && (!Number.isInteger(this.maxBatchCount) || this.maxBatchCount < 1)) {
      throw new Error('maxBatchCount must be a positive integer or 0 for unlimited')
    }

    this.retryWhenFailed = userOptions.retryWhenFailed
    this.invalidAfter = userOptions.invalidAfter
    this.runTasks = this.runTasks.bind(this)
    this.dispatch = this.dispatch.bind(this)
  }
  /**
   * execute task, get task result in promise
   */
  async dispatch(task: Task): Promise<Result>
  /**
   * execute tasks, get response in tuple of task and result/error
   */
  async dispatch<T extends readonly Task[] | []>(tasks: T): Promise<{ [k in keyof T]: Result | Error } >
  async dispatch(tasks: Task[] | Task) {
    this.cleanupTasks()
    const result = this.findTaskResults(tasks)
    if (result) {
      if (!Array.isArray(tasks) && result.value instanceof Error) throw result.value
      return result.value
    }
    return new Promise((resolve, reject) => {
      this.createTasks(tasks, resolve, reject)
    })
  }

  /**
   * clean cached task result
   *  - this may not exec immediately
   *  - it will take effect after all tasks are done
   */
  cleanCache() {
    this.needCleanCache = true
    this.cleanCacheIfNeeded()
  }

  /**
   * clean cache if needed
   */
  private cleanCacheIfNeeded() {
    if (!this.needCleanCache) return
    if (this.isTaskRunning || this.pendingTasks.length || this.taskQueue.length) return
    this.needCleanCache = false
    this.doneTaskMap = []
    this.resultByKey.clear()
    this.nextCacheCleanup = Infinity
  }

  /** tasks combine waiting timeout */
  private timeoutId?: any

  /** next exec time for taskWaitingStrategy === 'throttle' */
  private nextTime?: any

  /**
   * create tasks
   * @param tasks task list
   * @param resolve promise resolve function
   * @param reject promise reject function
   */
  private createTasks(tasks: Task | Task[], resolve: Function, reject: Function) {
    const requested = Array.isArray(tasks) ? tasks : [tasks]
    let myTasks: Task[]
    if (this.getTaskKey) {
      const seen = new Set<ITaskKey>()
      myTasks = requested.filter((task) => {
        const key = this.getTaskKey!(task)
        if (seen.has(key) || this.pendingKeys.has(key) || this.runningKeys.has(key) || this.resultByKey.has(key)) return false
        seen.add(key)
        return true
      })
      for (const task of myTasks) this.pendingKeys.add(this.getTaskKey(task))
    } else {
      myTasks = requested.filter((task, idx) => idx === requested.findIndex(t => this.isSameTask(t, task)))
      myTasks = myTasks.filter((task) => !this.hasTask(this.pendingTasks, task)
        && !this.hasTask(this.runningTasks, task) && !this.getTaskResult(task))
    }
    this.taskQueue.push({ tasks, resolve, reject })
    if (!myTasks.length) return
    for (const task of myTasks) this.pendingTasks.push(task)

    clearTimeout(this.timeoutId)
    let timeout = 0
    if (this.taskWaitingStrategy === 'throttle') {
      const now = Date.now()
      this.nextTime = (!this.nextTime || now > this.nextTime)
      ? now + this.maxWaitingGap : this.nextTime
      timeout = this.nextTime - now
    } else {
      timeout = this.maxWaitingGap
    }
    this.timeoutId = setTimeout(this.runTasks, timeout)
  }

  // whether task is running
  isTaskRunning = false

  private async runTasks() {
    if (this.isTaskRunning || !this.pendingTasks.length) return
    this.isTaskRunning = true
    try {
      while (this.pendingTasks.length) {
        if (this.taskExecStrategy === 'serial') {
          const count = this.maxBatchCount || (this.batchDoTasks ? this.pendingTasks.length : 1)
          const tasks = this.pendingTasks.splice(0, count)
          this.markRunning(tasks)
          await this.executeTasks(tasks)
        } else {
          const tasks = this.pendingTasks.splice(0)
          this.markRunning(tasks)
          const count = this.maxBatchCount || tasks.length
          const batches: Array<Promise<void>> = []
          for (let i = 0; i < tasks.length; i += count) {
            batches.push(this.executeTasks(tasks.slice(i, i + count)))
          }
          await Promise.all(batches)
        }
      }
    } finally {
      this.isTaskRunning = false
      this.cleanupTasks()
    }
  }

  private async executeTasks(tasks: Task[]) {
    if (this.batchDoTasks) {
      try {
        this.updateResultMap(tasks, await this.batchDoTasks(tasks))
      } catch (error) {
        this.updateResultMap(tasks, AsyncTask.wrapError(error))
      }
      this.finishTasks(tasks)
    } else {
      await Promise.all(tasks.map(async (task) => {
        try {
          this.updateResultMap([task], [await this.doTask!(task)])
        } catch (error) {
          this.updateResultMap([task], AsyncTask.wrapError(error))
        }
        this.finishTasks([task])
      }))
    }
  }

  private markRunning(tasks: Task[]) {
    if (this.getTaskKey) {
      for (const task of tasks) {
        const key = this.getTaskKey(task)
        this.pendingKeys.delete(key)
        this.runningKeys.add(key)
      }
    } else {
      for (const task of tasks) this.runningTasks.push(task)
    }
  }

  private finishTasks(tasks: Task[]) {
    if (this.getTaskKey) {
      for (const task of tasks) this.runningKeys.delete(this.getTaskKey(task))
    } else {
      this.runningTasks = this.runningTasks.filter((task) => !this.hasTask(tasks, task))
    }
    if (!this.runningTasks.length && !this.runningKeys.size && !this.pendingTasks.length) this.isTaskRunning = false
    this.checkAllTasks()
    this.cleanupTasks()
  }

  /** Resolve requests whose results are all available. */
  private checkAllTasks() {
    this.taskQueue = this.taskQueue.filter((taskItem) => {
      const result = this.findTaskResults(taskItem.tasks)
      if (!result) return true
      if (!Array.isArray(taskItem.tasks) && result.value instanceof Error) {
        taskItem.reject(result.value)
      } else {
        taskItem.resolve(result.value)
      }
      return false
    })
  }

  /** A wrapper distinguishes a cached undefined result from a cache miss. */
  private findTaskResults(tasks: Task[] | Task): { value: Result | Error | Array<Result | Error> } | undefined {
    if (Array.isArray(tasks)) {
      const values: Array<Result | Error> = []
      for (const task of tasks) {
        const result = this.getTaskResult(task)
        if (!result) return undefined
        values.push(result[1])
      }
      return { value: values }
    }
    const result = this.getTaskResult(tasks)
    return result ? { value: result[1] } : undefined
  }

  private getTaskResult(task: Task): [Task, Result | Error] | undefined {
    const result = this.getTaskKey
      ? this.resultByKey.get(this.getTaskKey(task))
      : this.doneTaskMap.find((t) => this.isSameTask(task, t.task))
    if (result) {
      return [result.task, result.value]
    }
  }

  private hasTask(list: Task[], task: Task): boolean {
    return list.some((item) => this.isSameTask(task, item))
  }


  private updateResultMap(tasks: Task[], result: Array<Result | Error> | Error) {
    const now = Date.now()
    let doneArray: Array<{ task: Task, value: Result | Error, time: number }> = []
    if (result instanceof Error) {
      doneArray = tasks.map((t) => ({ task: t, value: result, time: now }))
    } else {
      let defaultValue: Error | undefined
      doneArray = tasks.map((t, idx) => {
        const taskResult = result.length > idx ? result[idx] : (defaultValue || (defaultValue = new Error('not found')))
        return { task: t, value: taskResult, time: now }
      })
    }
    for (const item of doneArray) {
      this.doneTaskMap.push(item)
      if (this.retryWhenFailed && item.value instanceof Error) this.nextCacheCleanup = 0
      if (typeof this.invalidAfter === 'number' && this.invalidAfter) {
        this.nextCacheCleanup = Math.min(this.nextCacheCleanup, Math.floor(now + this.invalidAfter) + 1)
      }
      if (this.getTaskKey) this.resultByKey.set(this.getTaskKey(item.task), item)
    }
  }

  /**
   * clean tasks
   *  - try to clean cache if needed
   *  - try to remove failed result, remove outdated cache if needed
   */
  private cleanupTasks() {
    this.cleanCacheIfNeeded()
    // has unresolved tasks, unable to cleanup task
    if (this.isTaskRunning || this.taskQueue.length) return
    // nothing to cleanup
    if (!this.doneTaskMap.length) return
    // no need to remove outdated or failed tasks
    if (!this.invalidAfter && !this.retryWhenFailed) return
    const now = Date.now()
    if (typeof this.invalidAfter !== 'function' && now < this.nextCacheCleanup) return
    this.nextCacheCleanup = Infinity
    this.doneTaskMap = this.doneTaskMap.filter((item) => {
      if (this.retryWhenFailed && item.value instanceof Error) {
        return false
      }
      if (this.invalidAfter) {
        const invalidAfter = typeof this.invalidAfter === 'function' ? this.invalidAfter(item.task, item.value) : this.invalidAfter
        if (!invalidAfter) return true
        const valid = now - item.time <= invalidAfter
        if (valid) this.nextCacheCleanup = Math.min(this.nextCacheCleanup, Math.floor(item.time + invalidAfter) + 1)
        return valid
      }
      return true
    })
    if (this.getTaskKey) {
      this.resultByKey.clear()
      for (const item of this.doneTaskMap) this.resultByKey.set(this.getTaskKey(item.task), item)
    }
  }

  /**
   * wrap error info, if it's not instanceof Error, wrap it with Error
   * @returns Error instance
   */
  static wrapError(e: unknown): Error {
    if (e instanceof Error) return e
    const newError = new Error('task failed')
    // @ts-ignore
    newError.original = e
    return newError
  }

  /**
   * simulate Promise.allSettled result item for better compatibility
   *    (due to Promise.allSettled only support newer platforms)
   * @param promise 
   * @returns 
   */
  static async runTaskExecutor<A extends Array<unknown>,  F extends ((...args: A) => unknown)>(executor: F, ...args: A) {
    try {
      const result = await executor(...args)
      return { status: 'fulfilled', value: result } as { status: 'fulfilled', value: Awaited<ReturnType<F>> }
    } catch (error) {
      return { status: 'rejected', reason: AsyncTask.wrapError(error) } as { status: 'rejected', reason: Error }
    }
  }

  /**
   * check whether the given values are equal (with deep comparison)
   */
  static isEqual(a: unknown, b: unknown): boolean {
    if (a === b) return true
    const typeA = typeof a
    const typeB = typeof b
    if (typeA !== typeB) return false
    // @ts-ignore
    // for nan
    if (typeA === 'number' && isNaN(a) && isNaN(b)) return true
    // none object type, aka primitive types, are checked by the first line
    if (typeA !== 'object' || a === null || b === null) return false
    // if one of them is regexp, check via regexp literal
    if (a instanceof RegExp || b instanceof RegExp) {
      return a instanceof RegExp && b instanceof RegExp && String(a) === String(b)
    }
    if (a instanceof Date || b instanceof Date) {
      return a instanceof Date && b instanceof Date && AsyncTask.isEqual(a.getTime(), b.getTime())
    }
    // only one is array
    if (Array.isArray(a) !== Array.isArray(b)) return false
    // @ts-ignore
    if (Object.keys(a).length !== Object.keys(b).length) return false
    // @ts-ignore
    if (Object.keys(a).some(k => !Object.prototype.hasOwnProperty.call(b, k) || !AsyncTask.isEqual(a[k], b[k]))) return false
    return true
  }
}
