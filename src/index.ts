export type ITaskExecStrategy = 'parallel' | 'serial'
export type ITaskWaitingStrategy = 'throttle' | 'debounce'

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

  /**
   * max task count for batchDoTasks, default unlimited
   *  undefined or 0 for unlimited
   */
  private maxBatchCount?: number

  /**
   * batch tasks executing strategy, default parallel
   *  only works if maxBatchCount is specified and tasks more than maxBatchCount are executed
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

  /**
   * tasks ready to be executed
   */
  private pendingTasks: Task[]

  /**
   * original tasks request in queue waiting to resolve
   *  empty if all task are done
   */
  private taskQueue: Array<{
    tasks: Task[]|Task, resolve: Function, reject: Function, isDone?: boolean }>
  
  /**
   * cached task result
   */
  private doneTaskMap: Array<{ task: Task, value: Result | Error, time: number }>
  
  /**
   * whether need to clean cache result, aka clean doneTaskMap
   */
  private needCleanCache?: boolean
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

  constructor(options: {
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
  }) {
    const userOptions = { ...AsyncTask.defaultOptions, ...options }
    this.pendingTasks = []
    this.doneTaskMap = []
    this.taskQueue = []
    this.isSameTask = userOptions.isSameTask
    this.maxBatchCount = userOptions.maxBatchCount
    this.maxWaitingGap = userOptions.maxWaitingGap

    this.taskWaitingStrategy = userOptions.taskWaitingStrategy
    if (!userOptions.batchDoTasks && !userOptions.doTask) {
      throw new Error('one of batchDoTasks / doTask must be specified')
    }
    this.doTask = userOptions.doTask
    this.batchDoTasks = userOptions.batchDoTasks

    this.taskExecStrategy = userOptions.taskExecStrategy
    if (this.taskExecStrategy === 'serial') {
      this.maxBatchCount = 1
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
    try {
      const result = this.tryGetTaskResult(tasks)
      return Promise.resolve(result)
    } catch (error) {
      // note all tasks are cached, just created new tasks
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
    if (this.pendingTasks.length || this.taskQueue.length) return
    this.needCleanCache = false
    this.doneTaskMap = []
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
    this.taskQueue.push({ tasks, resolve, reject })
    let myTasks = Array.isArray(tasks) ? tasks : [tasks]
    // remove duplicated tasks in itself
    myTasks = myTasks.filter((task, idx) => idx === myTasks.findIndex(t => this.isSameTask(t, task)))
    // remove pending tasks
    if (this.pendingTasks.length) {
      myTasks = myTasks.filter((f) => !this.hasTask(this.pendingTasks, f))
    }
    // remove done tasks
    if (myTasks.length) {
      myTasks = myTasks.filter((f) => !this.getTaskResult(f))
    }
    if (!myTasks.length) return
    this.pendingTasks = this.pendingTasks.concat(myTasks)

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

  private runTasks() {
    if (this.isTaskRunning || !this.pendingTasks.length) return
    this.isTaskRunning = true
    if (this.batchDoTasks) {
      this.runTaskWithBatchDoTasks()
    } else {
      this.runTasksWithDoTask()
    }
  }

  private async runTasksWithDoTask() {
    const taskItems = this.pendingTasks.splice(0, this.maxBatchCount || this.pendingTasks.length)
    taskItems.forEach(async (task) => {
      try {
        const result = await this.doTask!(task)
        this.updateResultMap([task], [result])
      } catch (error) {
        this.updateResultMap([task], AsyncTask.wrapError(error))
      }
      this.checkAllTasks()
      if (this.pendingTasks.length) {
        this.runTasksWithDoTask()
      } else {
        this.cleanupTasks()
        this.isTaskRunning = false
      }
    })
  }

  private async runTaskWithBatchDoTasks() {
    const taskItems = this.pendingTasks.splice(0, this.maxBatchCount || this.pendingTasks.length)
    try {
      const result = await this.batchDoTasks!(taskItems)
      this.updateResultMap(taskItems, result)
    } catch (error) {
      this.updateResultMap(taskItems, AsyncTask.wrapError(error))
    }
    this.checkAllTasks()
    if (this.pendingTasks.length) {
      this.runTaskWithBatchDoTasks()
    } else {
      this.cleanupTasks()
      this.isTaskRunning = false
    }
  }

  /**
   * check all tasks, try to resolve
   */
  private checkAllTasks() {
    this.taskQueue.forEach((taskItem) => {
      try {
        const result = this.tryGetTaskResult(taskItem.tasks)
        // eslint-disable-next-line no-param-reassign
        taskItem.isDone = true
        taskItem.resolve(result)
      } catch (error) {
        // not found
      }
    })
    // clean done task
    this.taskQueue = this.taskQueue.filter((task) => !task.isDone)
  }

  /**
   * get result list of given tasks
   *  throw error when not found(to make it easier to distinct from falsy results)
   * @param tasks tasks to check
   * @param defaultResult default result if not found
   */
  private tryGetTaskResult(tasks: Task[] | Task): (Result | Error) | Array<Result | Error> {
    // no cached data and no default result provided
    if (!this.doneTaskMap.length) throw new Error('no done task')

    if (Array.isArray(tasks)) {
      const result: Array<Result | Error> = []
      return tasks.reduce((acc, task) => {
        const val = this.getTaskResult(task)
        if (!val) throw new Error('not found')
        acc.push(val[1])
        return acc
      }, result)
    }
    const val = this.getTaskResult(tasks)
    if (!val) throw new Error('not found')
    return val[1]
  }

  private getTaskResult(task: Task): [Task, Result | Error] | undefined {
    const result = this.doneTaskMap.find((t) => this.isSameTask(task, t.task))
    if (result) {
      return [result.task, result.value]
    }
  }

  private hasTask(list: Task[], task: Task): boolean {
    return list.some((item) => this.isSameTask(task, item))
  }


  private updateResultMap(tasks: Task[], result: Array<Result | Error> | Error) {
    const now = Date.now()
    let doneArray: any[] = []
    if (result instanceof Error) {
      doneArray = tasks.map((t) => ({ task: t, value: result, time: now }))
    } else {
      const defaultValue = new Error('not found')
      doneArray = tasks.map((t, idx) => {
        const taskResult = result.length > idx ? result[idx] : defaultValue
        return { task: t, value: taskResult, time: now }
      })
    }
    this.doneTaskMap = this.doneTaskMap.concat(doneArray)
  }

  /**
   * clean tasks
   *  - try to clean cache if needed
   *  - try to remove failed result, remove outdated cache if needed
   */
  private cleanupTasks() {
    this.cleanCacheIfNeeded()
    // has unresolved tasks, unable to cleanup task
    if (this.taskQueue.length) return
    // nothing to cleanup
    if (!this.doneTaskMap.length) return
    // no need to remove outdated or failed tasks
    if (!this.invalidAfter && !this.retryWhenFailed) return
    const now = Date.now()
    this.doneTaskMap = this.doneTaskMap.filter((item) => {
      if (this.retryWhenFailed && item.value instanceof Error) {
        return false
      }
      if (this.invalidAfter) {
        const invalidAfter = typeof this.invalidAfter === 'function' ? this.invalidAfter(item.task, item.value) : this.invalidAfter
        if (!invalidAfter) return true
        return now - item.time <= invalidAfter
      }
      return true
    })
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
    if (typeA !== 'object') return false
    // if one of them is regexp, check via regexp literal
    if (a instanceof RegExp || b instanceof RegExp) return String(a) === String(b)
    if (a instanceof Date || b instanceof Date) return String(a) === String(b)
    // only one is array
    if (Array.isArray(a) !== Array.isArray(b)) return false
    // @ts-ignore
    if (Object.keys(a).length !== Object.keys(b).length) return false
    // @ts-ignore
    if (Object.keys(a).some(k => !AsyncTask.isEqual(a[k], b[k]))) return false
    return true
  }
}
