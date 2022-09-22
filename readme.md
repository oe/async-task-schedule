# async-task-schedule
schedule async tasks in order

## Feature
* remove duplicated task request
* combine tasks request in same time and do all together
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
  private isSameTask?: (a: Task, b: Task) => boolean
}
```

### dispatch(tasks: Task[]):Promise<Array<[Task, Result | Error]>>
dispatch multi tasks at a time, will get tuple of task and response in array

this method won't throw any error, it will fulfilled even partially failed, you can check whether its success by `tuple[1] instanceof Error`

### dispatch(tasks: Task):Promise<Result>
dispatch a task, will get response if success, or throw an error


