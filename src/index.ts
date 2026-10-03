import { isEqual } from './equal'

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
interface TaskRecord<Task, Result> {
  task: Task
  key: ITaskKey
  state: 'pending' | 'running' | 'done'
  promise: Promise<Result | Error>
  resolve: (value: Result | Error) => void
  value?: Result | Error
  time: number
}

export default class AsyncTask<Task, Result> {
  private options: IAsyncTaskOptions<Task, Result>
  private records = new Map<ITaskKey, TaskRecord<Task, Result>>()
  private pending: Array<TaskRecord<Task, Result>> = []
  private pendingHead = 0
  private active = 0
  private pumping = false
  private clearRequested = false
  private nextExpiry = Infinity
  private timeout?: ReturnType<typeof setTimeout>
  private nextTime?: number

  // Preserve the public running indicator; internal progress uses record counts.
  isTaskRunning = false

  constructor(options: IAsyncTaskOptions<Task, Result>) {
    if (!options.batchDoTasks && !options.doTask) {
      throw new Error('one of batchDoTasks / doTask must be specified')
    }
    const count = options.maxBatchCount
    if (count !== undefined && count !== 0 && (!Number.isInteger(count) || count < 1)) {
      throw new Error('maxBatchCount must be a positive integer or 0 for unlimited')
    }
    this.options = {
      ...options,
      isSameTask: options.isSameTask ?? AsyncTask.isEqual,
      taskExecStrategy: options.taskExecStrategy ?? 'parallel',
      taskWaitingStrategy: options.taskWaitingStrategy ?? 'debounce',
      maxWaitingGap: options.maxWaitingGap ?? 50,
      retryWhenFailed: options.retryWhenFailed ?? true,
      // Explicit undefined TTL retains the documented unlimited-cache behavior.
      invalidAfter: 'invalidAfter' in options ? options.invalidAfter : 1000,
    }
    this.dispatch = this.dispatch.bind(this)
  }

  async dispatch(task: Task): Promise<Result>
  async dispatch<T extends readonly Task[] | []>(tasks: T): Promise<{ [k in keyof T]: Result | Error }>
  async dispatch(tasks: Task | Task[]): Promise<unknown> {
    this.cleanupExpired()
    const requested = Array.isArray(tasks) ? tasks : [tasks]
    // Identity callbacks run before changes are committed, and only at dispatch.
    const keys = this.options.getTaskKey ? requested.map(task => this.options.getTaskKey!.call(this, task)) : undefined
    if (keys && !Array.isArray(tasks)) {
      const cached = this.records.get(keys[0])
      if (cached?.state === 'done') return this.unwrap(cached.value!)
    }
    const staged = new Map<ITaskKey, TaskRecord<Task, Result>>()
    const records = requested.map((task, index) => {
      const key = keys ? keys[index] : Symbol()
      const existing = keys
        ? this.records.get(key) || staged.get(key)
        : this.findRecord(task, this.records) || this.findRecord(task, staged)
      if (existing) return existing
      let resolve!: (value: Result | Error) => void
      const promise = new Promise<Result | Error>(done => { resolve = done })
      const record: TaskRecord<Task, Result> = { task, key, state: 'pending', promise, resolve, time: 0 }
      staged.set(key, record)
      return record
    })
    for (const record of staged.values()) {
      this.records.set(record.key, record)
      this.pending.push(record)
    }
    if (staged.size) this.schedule()
    if (Array.isArray(tasks)) return Promise.all(records.map(record => record.promise))
    const record = records[0]
    return this.unwrap(record.state === 'done' ? record.value! : await record.promise)
  }

  private unwrap(value: Result | Error) {
    if (value instanceof Error) throw value
    return value
  }

  private findRecord(task: Task, records: Map<ITaskKey, TaskRecord<Task, Result>>) {
    for (const record of records.values()) {
      if (this.options.isSameTask!.call(this, record.task, task)) return record
    }
  }

  /** Cache clearing still waits for all pending and running work. */
  cleanCache() {
    this.clearRequested = true
    this.clearIfIdle()
  }

  private clearIfIdle() {
    if (this.clearRequested && !this.active && this.pendingHead === this.pending.length) {
      this.records.clear()
      this.nextExpiry = Infinity
      this.clearRequested = false
    }
  }

  private schedule() {
    clearTimeout(this.timeout)
    let wait = this.options.maxWaitingGap!
    if (this.options.taskWaitingStrategy === 'throttle') {
      const now = Date.now()
      if (this.nextTime === undefined || now > this.nextTime) this.nextTime = now + wait
      wait = this.nextTime - now
    }
    this.timeout = setTimeout(() => { void this.run() }, wait)
  }

  /** Consume with a cursor so serial batches do not shift the remaining queue. */
  private take(count: number) {
    const records = this.pending.slice(this.pendingHead, this.pendingHead + count)
    this.pendingHead += records.length
    if (this.pendingHead === this.pending.length) {
      this.pending = []
      this.pendingHead = 0
    }
    for (const record of records) record.state = 'running'
    this.active += records.length
    this.isTaskRunning = true
    return records
  }

  private async run() {
    if (this.pumping || this.pendingHead === this.pending.length) return
    this.pumping = true
    try {
      while (this.pumping && this.pendingHead < this.pending.length) {
        const available = this.pending.length - this.pendingHead
        const count = this.options.maxBatchCount || (this.options.batchDoTasks ? available : 1)
        if (this.options.taskExecStrategy === 'serial') {
          await this.execute(this.take(count))
        } else {
          const records = this.take(available)
          const stride = this.options.maxBatchCount || records.length
          const batches: Array<Promise<void>> = []
          for (let i = 0; i < records.length; i += stride) batches.push(this.execute(records.slice(i, i + stride)))
          await Promise.all(batches)
        }
      }
    } finally {
      this.pumping = false
      this.isTaskRunning = this.active > 0
      this.clearIfIdle()
    }
  }

  private async execute(records: Array<TaskRecord<Task, Result>>) {
    if (this.options.batchDoTasks) {
      let results: Array<Result | Error>
      try {
        results = await this.options.batchDoTasks.call(this, records.map(record => record.task))
        if (!Array.isArray(results)) throw new TypeError('batchDoTasks must return an array')
      } catch (error) {
        results = records.map(() => AsyncTask.wrapError(error))
      }
      let missing: Error | undefined
      records.forEach((record, index) => this.complete(record, index < results.length
        ? results[index] : (missing || (missing = new Error('not found')))))
    } else {
      await Promise.all(records.map(async record => {
        let value: Result | Error
        try { value = await this.options.doTask!.call(this, record.task) }
        catch (error) { value = AsyncTask.wrapError(error) }
        this.complete(record, value)
      }))
    }
  }

  private validity(record: TaskRecord<Task, Result>) {
    const ttl = this.options.invalidAfter
    return typeof ttl === 'function' ? ttl.call(this, record.task, record.value!) : ttl
  }

  private complete(record: TaskRecord<Task, Result>, value: Result | Error) {
    record.value = value
    record.time = Date.now()
    try {
      if (value instanceof Error && this.options.retryWhenFailed) {
        this.records.delete(record.key)
      } else {
        const ttl = this.validity(record)
        if (ttl && ttl < 0) this.records.delete(record.key)
        else if (ttl) this.nextExpiry = Math.min(this.nextExpiry, Math.floor(record.time + ttl) + 1)
      }
    } catch (error) {
      // A policy failure settles this task and cannot escape the background pump.
      value = AsyncTask.wrapError(error)
      this.records.delete(record.key)
    }
    record.value = value
    record.state = 'done'
    --this.active
    if (!this.active && this.pendingHead === this.pending.length) {
      this.isTaskRunning = false
      this.pumping = false
    }
    this.clearIfIdle()
    record.resolve(value)
  }

  private cleanupExpired() {
    const now = Date.now()
    if (typeof this.options.invalidAfter !== 'function' && now < this.nextExpiry) return
    this.nextExpiry = Infinity
    for (const record of this.records.values()) {
      if (record.state !== 'done') continue
      let ttl: number | undefined
      try { ttl = this.validity(record) }
      catch (error) { this.records.delete(record.key); throw error }
      if (!ttl) continue
      if (now - record.time > ttl) this.records.delete(record.key)
      else this.nextExpiry = Math.min(this.nextExpiry, Math.floor(record.time + ttl) + 1)
    }
  }
  /**
   * wrap error info, if it's not instanceof Error, wrap it with Error
   * @returns Error instance
   */
  static wrapError(e: unknown): Error {
    if (e instanceof Error) return e
    const newError = new Error('task failed') as Error & { original: unknown }
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
    return isEqual(a, b)
  }
}
