export default class AsyncTask<Task, Result> {
  /**
   * action to do batch tasks
   *  Task: single task request info
   *  Result: single task success response
   * 
   * batchDoTasks should receive multi tasks, and return tuple of task and response or error in array
   */
  private batchDoTasks: (tasks: Task[]) => Promise<Array<[Task, Result | Error ]>>

  /**
   * check whether two tasks are equal
   *  it helps to avoid duplicated tasks
   *  default: (a, b) => a === b
   */
  private isSameTask: (a: Task, b: Task) => boolean

  /**
   * max task count for batchDoTasks, default unlimited
   *  undefined or 0 for unlimited
   */
  private maxBatchCount?: number

  /**
   * do batch tasks executing strategy, default parallel
   *  only works if maxBatchCount is specified and tasks more than maxBatchCount are executed
   *  
   * parallel: split all tasks into a list stride by maxBatchCount, exec them at the same time
   * serial: split all tasks into a list stride by maxBatchCount, exec theme one group by one group
   *    if serial specified, when tasks are executing, new comings will wait for them to complete
   *    it's very useful to cool down task requests
   */
  private taskExecStrategy: 'parallel' | 'serial'

  /**
   * task waiting stragy, default to debounce
   *  throttle: tasks will combined and dispatch every `maxWaitingGap`
   *  debounce: tasks will combined and dispatch util no more tasks in next `maxWaitingGap`
   */
  private taskWaitingStrategy: 'throttle' | 'debounce'
  /**
   * task waiting time in milliseconds, default 50ms
   *     differently according to taskWaitingStrategy
   */
  private maxWaitingGap: number


  /**
   * validity of the result(in ms), default unlimited
   *    undefined or 0 for unlimited
   */
  private invalidAfter?: number

  /**
   * retry failed tasks next time after failing, default true
   */
  private retryWhenFailed?: boolean

  /**
   * tasks ready to be executed
   */
  private pendingTasks: Task[]

  /**
   * tasks in progress
   */
  private doingTasks: Task[]

  /**
   * original tasks request in queue
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
    isSameTask: (a: any, b: any) => a === b,
    taskExecStrategy: 'parallel',
    maxWaitingGap: 50,
    taskWaitingStrategy: 'debounce',
    retryWhenFailed: true,
  }

  constructor(options: {
    maxBatchCount?: number,
    batchDoTasks: (tasks: Task[]) => Promise<Array<[Task, Result | Error ]>>,
    taskExecStrategy?: 'parallel' | 'serial'
    invalidAfter?: number
    retryWhenFailed?: boolean
    isSameTask?: (a: Task, b: Task) => boolean
  }) {
    const userOptions = { ...AsyncTask.defaultOptions, ...options }
    this.pendingTasks = []
    this.doingTasks = []
    this.doneTaskMap = []
    this.taskQueue = []
    this.isSameTask = userOptions.isSameTask
    this.maxBatchCount = userOptions.maxBatchCount
    this.maxWaitingGap = userOptions.maxWaitingGap
    // @ts-ignore
    this.taskWaitingStrategy = userOptions.taskWaitingStrategy
    this.batchDoTasks = userOptions.batchDoTasks
    // @ts-ignore
    this.taskExecStrategy = userOptions.taskExecStrategy
    this.retryWhenFailed = userOptions.retryWhenFailed
    this.invalidAfter = userOptions.invalidAfter
    this.tryTodDoTasks = this.tryTodDoTasks.bind(this)
  }

  async dispatch(task: Task): Promise<Result>
  async dispatch(tasks: Task[]): Promise<[[Task, Result | Error]]>
  async dispatch(tasks: Task[] | Task) {
    this.cleanupTasks()
    try {
      const result = this.tryGetTaskResult(tasks)
      if (result instanceof Error) {
        throw result
      }
      return result
    } catch (error) {
      // not found
    }
    return new Promise((resolve, reject) => {
      this.createTasks(tasks, resolve, reject)
    })
  }

  /**
   * clean cached task result
   *  this may not exec immediately, it will take effect after all tasks are done
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
    if (this.pendingTasks.length || this.doingTasks.length || this.taskQueue.length) return
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
    // 去除掉正在等待的、正在处理的以及已经成功的
    if (this.pendingTasks.length) {
      myTasks = myTasks.filter((f) => !this.hasTask(this.pendingTasks, f))
    }
    if (myTasks.length && this.doingTasks.length) {
      myTasks = myTasks.filter((f) => !this.hasTask(this.doingTasks, f))
    }
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
    this.timeoutId = setTimeout(this.tryTodDoTasks, timeout)
  }

  private delayTimeoutId?: any
  
  /**
   * try to do tasks
   *  if taskExecStrategy is parallel then do it immediately,
   *  otherwise waiting util taskQueue is empty
   */
  private tryTodDoTasks() {
    // should exec in serial, and still has executing tasks
    if (this.taskExecStrategy === 'serial' && this.taskQueue.length) {
      clearTimeout(this.delayTimeoutId)
      // wait a moment then check again
      this.delayTimeoutId = setTimeout(this.tryTodDoTasks, 100)
    } else {
      this.doTasks()
    }
  }

  private async doTasks() {
    const tasks = this.pendingTasks.splice(0)
    this.doingTasks = this.doingTasks.concat(tasks)
    const tasksGroup = this.maxBatchCount ? AsyncTask.chunk(tasks, this.maxBatchCount) : [tasks]
    if (this.taskExecStrategy === 'serial') {
      // eslint-disable-next-line no-plusplus
      for (let index = 0; index < tasksGroup.length; ++index) {
        const taskList = tasksGroup[index]
        try {
          // eslint-disable-next-line no-await-in-loop
          const result = await this.batchDoTasks(taskList)
          this.updateResultMap(taskList, result)
        } catch (error) {
          this.updateResultMap(taskList, AsyncTask.wrapError(error))
        }
        this.checkAllTasks()
        this.removeDoneTasks(taskList)
      }
    } else {
      try {
        const allResponse = await Promise.all(
          tasksGroup
            .map((taskList) => AsyncTask.wrapPromise(this.batchDoTasks(taskList))),
        )
        allResponse.forEach((result, index) => {
          this.updateResultMap(tasksGroup[index],
            // @ts-ignore
            result.status === 'rejected' ? AsyncTask.wrapError(result.reason) : result.value)
        })
      } catch (error) {
        this.updateResultMap(tasks, AsyncTask.wrapError(error))
      }
      this.checkAllTasks()
      this.removeDoneTasks(tasks)
    }
    // remove all unresolved tasks
    this.cleanupTasks()
  }

  /**
 * 检查所有任务
 * @param succeed 获取成功的结果对象
 * @param failed  获取失败的 fileId 数组
 */
  private checkAllTasks(defaultResult?: any) {
    this.taskQueue.forEach((taskItem) => {
      try {
        const result = this.tryGetTaskResult(taskItem.tasks, defaultResult)
        // eslint-disable-next-line no-param-reassign
        taskItem.isDone = true
        if (result instanceof Error) {
          taskItem.reject(result)
        } else {
          taskItem.resolve(result)
        }
      } catch (error) {
        // not found
      }
    })
    // clean done task
    this.taskQueue = this.taskQueue.filter((task) => !task.isDone)
  }

  private tryGetTaskResult(tasks: Task[] | Task, defaultResult?: any) {
    // no cached data and no default result provided
    if (!this.doneTaskMap.length && !defaultResult) throw new Error('no done task')

    if (Array.isArray(tasks)) {
      const result: Array<[Task, Result | Error]> = []
      return tasks.reduce((acc, task) => {
        const val = this.getTaskResult(task) || (defaultResult ? [task, defaultResult] : false)
        if (!val) {
          throw new Error('not found')
        }
        acc.push(val)
        return acc
      }, result)
    }
    const val = this.getTaskResult(tasks) || (defaultResult ? [tasks, defaultResult] : false)
    if (!val) {
      throw new Error('not found')
    }
    return val[1]
  }

  private getTaskResult(task: Task): [Task, Result | Error] | undefined {
    const result = this.doneTaskMap.find((t) => this.isSameTask(task, t.task))
    if (result) {
      return [result.task, result.value]
    }
    return undefined
  }

  private hasTask(list: Task[], task: Task): boolean {
    return list.some((item) => this.isSameTask(task, item))
  }

  private removeDoneTasks(tasks: Task[]) {
    this.doingTasks = this.doingTasks.filter((f) => this.hasTask(tasks, f))
  }

  private updateResultMap(tasks: Task[], result: Array<[Task, Result | Error]> | Error) {
    const now = Date.now()
    let doneArray: any[] = []
    if (result instanceof Error) {
      doneArray = tasks.map((t) => ({ task: t, value: result, time: now }))
    } else {
      const defaultValue = new Error('not found')
      doneArray = tasks.map((t) => {
        const taskResult = result.find((item) => this.isSameTask(item[0], t))
        return { task: t, value: taskResult?.[1] || defaultValue, time: now }
      })
    }
    this.doneTaskMap = this.doneTaskMap.concat(doneArray)
  }

  /**
   * clean tasks
   */
  private cleanupTasks() {
    // no doing tasks, but the que is not empty, aka, there is some unresolved tasks
    if (this.taskQueue.length && !this.pendingTasks.length && !this.doingTasks.length) {
      this.checkAllTasks(new Error('not found'))
      this.taskQueue = []
    }
    this.cleanCacheIfNeeded()
    // has validity or retry flag and no taskQueue
    if ((this.invalidAfter || this.retryWhenFailed) && !this.taskQueue.length) {
      const now = Date.now()
      this.doneTaskMap = this.doneTaskMap.filter((item) => {
        if (this.invalidAfter) {
          return now - item.time <= this.invalidAfter!
        }
        if (this.retryWhenFailed) {
          return !(item.value instanceof Error)
        }
        return true
      })
    }
  }

  static wrapError(e: any): Error {
    if (e instanceof Error) return e
    const newError = new Error('task failed')
    // @ts-ignore
    newError.original = e
    return newError
  }

  /**
   * split array to chunks with specified size
   * @param arr array of fileIds
   * @param size chunk size
   * @returns 2 dimensional array
   */
  static chunk<T>(arr: T[], size: number): T[][] {
    const result: T[][] = []
    for (let i = 0; i < arr.length; i += size) {
      result.push(arr.slice(i, i + size))
    }
    return result
  }

  /**
   * simulate Promise.allSettled result item for better compatibility
   *    (due to Promise.allSettled only support newer platforms)
   * @param promise 
   * @returns 
   */
  static async wrapPromise<T>(promise: Promise<T>) {
    try {
      const result = await promise
      return { status: 'fulfilled', value: result }
    } catch (error) {
      return { status: 'rejected', reason: error }
    }
  }
}

export { AsyncTask }
