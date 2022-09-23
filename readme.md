# async-task-schedule


<div align="center">
  <a href="https://github.com/oe/async-task-schedule/actions">
    <img src="https://github.com/oe/async-task-schedule/actions/workflows/main.yml/badge.svg" alt="github actions">
  </a>
  <a href="#readme">
    <img src="https://badgen.net/badge/Built%20With/TypeScript/blue" alt="code with typescript" height="20">
  </a>
  <a href="#readme">
    <img src="https://badge.fury.io/js/async-task-schedule.svg" alt="npm version" height="20">
  </a>
  <a href="https://www.npmjs.com/package/async-task-schedule">
    <img src="https://img.shields.io/npm/dm/async-task-schedule.svg" alt="npm downloads" height="20">
  </a>
</div>

schedule async tasks in order

## Features
* remove duplicated tasks' requests
* combine tasks' requests in same time and do all together
* cache result and can specify validity


## Install
```sh
yarn add async-task-schedule
# or with npm
npm install async-task-schedule -S
```

## Usage

```ts
import AsyncTask from 'async-task-schedule'

const asyncTask = new AsyncTask({
  batchDoTasks: async (names: string[]) => {
    count += 1
    return names.map((n) => ([n, `${n}${count}`] as [string, string]))
  },
})

asyncTask.dispatch(['a', 'b']).then(console.log)
asyncTask.dispatch('b').then(console.log)
```

## API

### constructor(options: IAsyncTask)

```ts
interface IAsyncTask {
  /**
   * action to do batch tasks
   *  Task: single task request info
   *  Result: single task success response
   * 
   * batchDoTasks should receive multi tasks, and return tuple of task and response or error in array
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
   * check whether two tasks are equal
   *  default: (a, b) => a === b
   */
  private isSameTask?: (a: Task, b: Task) => boolean
}
```

### dispatch(tasks: Task[]):Promise<Array<[Task, Result | Error]>>
dispatch multi tasks at a time, will get tuple of task and response in array

this method won't throw any error, it will fulfilled even partially failed, you can check whether its success by `tuple[1] instanceof Error`

### dispatch(tasks: Task):Promise<Result>
dispatch a task, will get response if success, or throw an error


