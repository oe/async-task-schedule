export default class AsyncTask<Task, Result> {
  /**
   * action to do batch tasks
   *  Task: single task request info
   *  Result: single task success response
   * 
   * batchDoTasks should receive multi tasks, and return tuple of task and response in array
   */
  private batchDoTasks: (tasks: Task[]) => Promise<Array<[Task, Result | Error ]>>

  /**
   * max task count for batchDoTasks, default unlimited
   *  undefined or 0 for unlimited
   */
  private maxBatchCount?: number

  /**
   * do batch tasks executing strategy, default parallel
   *  only works if maxBatchCount is specified and tasks more than maxBatchCount are executed
   * parallel: split all tasks into a list stride by maxBatchCount, exec them at the same time
   * serial: split all tasks into a list stride by maxBatchCount, exec theme one by one
   */
  private taskExecStrategy: 'parallel' | 'serial'

  /**
   * throttle in milliseconds, default 50
   */
  private maxWaitingGap?: number


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
   * check whether two tasks are equal
   *  default: (a, b) => a === b
   */
  private isSameTask: (a: Task, b: Task) => boolean


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
   * default task options
   */
  private static defaultOptions = {
    isSameTask: (a: any, b: any) => a === b,
    taskExecStrategy: 'parallel',
    maxWaitingGap: 50,
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
    this.batchDoTasks = userOptions.batchDoTasks
    // @ts-ignore
    this.taskExecStrategy = userOptions.taskExecStrategy
    this.retryWhenFailed = userOptions.retryWhenFailed
    this.invalidAfter = userOptions.invalidAfter
    this.innerDoTasks = this.innerDoTasks.bind(this)
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
      this.createTask(tasks, resolve, reject)
    })
  }

  private timeoutId?: any

  private nextTime?: any

  private createTask(tasks: Task | Task[], resolve: Function, reject: Function) {
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
    const now = Date.now()
    this.nextTime = (!this.nextTime || now > this.nextTime)
      ? now + this.maxWaitingGap! : this.nextTime
    this.timeoutId = setTimeout(this.innerDoTasks, this.nextTime - now)
  }

  private async innerDoTasks() {
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
  private checkAllTasks() {
    this.taskQueue.forEach((taskItem) => {
      try {
        const result = this.tryGetTaskResult(taskItem.tasks)
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

  private tryGetTaskResult(tasks: Task[] | Task) {
    if (!this.doneTaskMap.length) throw new Error('no done task')

    if (Array.isArray(tasks)) {
      const result: Array<[Task, Result | Error]> = []
      return tasks.reduce((acc, task) => {
        const val = this.getTaskResult(task)
        if (!val) {
          throw new Error('not found')
        }
        acc.push(val)
        return acc
      }, result)
    }
    const val = this.getTaskResult(tasks)
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
      // todo
      this.taskQueue = []
    }
    // has validity and no taskQueue
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
   * simulate Promise.allSettled result item
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
