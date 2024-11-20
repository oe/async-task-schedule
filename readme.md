# async-task-schedule


<div align="center">
  <a href="https://github.com/oe/async-task-schedule/actions">
    <img src="https://github.com/oe/async-task-schedule/actions/workflows/main.yml/badge.svg" alt="github actions">
  </a>
  <img src="https://img.shields.io/badge/coverage-100%25-brightgreen?logo=codecov" alt="use it with confident">
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
* can prevent massive requests at same time, make them execute one group by one group
* cache result and can specify validity


## Install
```sh
yarn add async-task-schedule
# or with npm
npm install async-task-schedule -S
```

## Usage

```ts
import TaskSchedule from 'async-task-schedule'
let count = 0
const taskSchedule = new TaskSchedule({
    doTask: async (name: string) => {
        count += 1
      return `${name}${count}`
    },
    // or use this will do the same
    // batchDoTasks: async (names: string[]) => {
    //   count += 1
    //   return names.map((n) => `${n}${count}`)
    // },
})

taskSchedule.dispatch(['a', 'b']).then(console.log)
taskSchedule.dispatch(['b', 'c']).then(console.log)
taskSchedule.dispatch(['d', 'c']).then(console.log)
taskSchedule.dispatch('c').then(console.log)
// batchDoTasks will be only called once

```
**NOTICE**: in following example, tasks won't combine
```ts
// batchDoTasks will be executed 3 times due to javascript language features
const result1 = await taskSchedule.dispatch(['a', 'b'])
const result2 = await taskSchedule.dispatch(['b', 'c'])
const result3 = await taskSchedule.dispatch(['d', 'c'])
const result4 = await taskSchedule.dispatch('c')
```


## API

### constructor(options: ITaskScheduleOptions)

options define:

```ts
// `Task` for single task's parameters
// `Result` for single task's response
interface ITaskScheduleOptions<Task, Result> {
  /**
   * action to do batch tasks, can be async or sync function
   *  Task: single task request info
   *  Result: single task success response
   * 
   * batchDoTasks should receive multitasks, and return result or error in order
   * one of batchDoTasks/doTask must be specified, batchDoTasks will take priority
   */
  batchDoTasks: (tasks: Task[]) => Promise<Array<Result | Error>> | Array<Result | Error>

  /**
   * action to do single task, can be async or sync function
   *  one of batchDoTasks/doTask must be specified, batchDoTasks will take priority
   */
  doTask?: (task: Task) => Promise<Result> | Result

  /**
   * check whether two tasks are equal
   *  it helps to avoid duplicated tasks
   *  default: AsyncTask.isEqual (deep equal)
   */
  isSameTask?: (a: Task, b: Task) => boolean

  /**
   * max task count for batchDoTasks, default unlimited
   *  undefined or 0 for unlimited
   */
  maxBatchCount?: number

  /**
   * batch tasks executing strategy, default parallel
   *  only works if maxBatchCount is specified and tasks more than maxBatchCount are executed
   *  
   * parallel: split all tasks into a list stride by maxBatchCount, exec them at the same time
   * serial: split all tasks into a list stride by maxBatchCount, exec theme one group by one group
   *    if serial specified, when tasks are executing, new comings will wait for them to complete
   *    it's especially useful to cool down task requests
   */
  taskExecStrategy: 'parallel' | 'serial'

  /**
   * task waiting strategy, default to debounce
   *  throttle: tasks will combined and dispatch every `maxWaitingGap`
   *  debounce: tasks will combined and dispatch util no more tasks in next `maxWaitingGap`
   */
  taskWaitingStrategy: 'throttle' | 'debounce'

  /**
   * task waiting time in milliseconds, default 50ms
   *     differently according to taskWaitingStrategy
   */
  maxWaitingGap: number


  /**
   * task result caching duration(in milliseconds), default to 1000ms (1s)
   * > `undefined` or `0` for unlimited  
   * > set to minimum value `1` to disable caching  
   * > `function` to specified specified each task's validity
   * 
   * *cache is lazy cleaned after invalid*
   */
  invalidAfter?: number | ((task: Task, result: Result | Error) => number)

  /**
   * retry failed tasks next time after failing, default true
   */
  retryWhenFailed?: boolean
}
```

example:
```ts
import TaskSchedule from 'async-task-schedule'

const taskSchedule = new TaskSchedule({
  doTask(n) { 
    console.log(`do task with ${n}`)
    return n * n
  },
  invalidAfter: 0
})

const result = await taskSchedule.dispatch([1,2,3,1,2])
// get first result
const resultOf1 = result[0] // 1
// doTask won't be called
const result11 = await taskSchedule.dispatch(1) // 1

// clean all cached result
taskSchedule.cleanCache()
// doTask will be call again
const result12 = await taskSchedule.dispatch(1) // 1

```

### dispatch(tasks: Task[]):Promise<Array<Result | Error>>
dispatch multitasks at a time, will get response with corresponding order of `tasks`
this method won't throw any error, it will fulfil even partially failed, you can check whether its success by `response instanceof Error`

```ts
import TaskSchedule from 'async-task-schedule'

const taskSchedule = new TaskSchedule({
  doTask(n) { 
    console.log(`do task with ${n}`)
    if (n % 2) throw new Error(`${n} is unsupported`)
    return n * n
  },
  invalidAfter: 0
})

const result = await taskSchedule.dispatch([1,2,3,1,2])
// get first result
const resultOf1 = result[0] // 1
// second result is error
const isError = result[1] instanceof Error // error object


try {
  // will throw an error
  const result2 = await taskSchedule.dispatch(2) // 1
} catch(error) {
  console.warn(error)
}
```


### dispatch(tasks: Task):Promise<Result>
dispatch a task, will get response if success, or throw an error

```ts
import TaskSchedule from 'async-task-schedule'

const taskSchedule = new TaskSchedule({
  doTask(n) { 
    console.log(`do task with ${n}`)
    if (n % 2) throw new Error(`${n} is unsupported`)
    return n * n
  },
  invalidAfter: 0
})

const result1 = await taskSchedule.dispatch(1) // 1
try {
  const result2 = await taskSchedule.dispatch(2),
} catch(error) {
  console.warn(error)
}
```

### cleanCache
clean cached tasks' result, so older task will trigger new request and get fresh response.

attention: this action may not exec immediately, it will take effect after all tasks are done

```ts
import TaskSchedule from 'async-task-schedule'

const taskSchedule = new TaskSchedule({
  doTask(n) { 
    console.log(`do task with ${n}`)
    return n * n
  },
  invalidAfter: 0
})

await Promise.all([
  taskSchedule.dispatch([1, 2, 3, 1, 2]),
  taskSchedule.dispatch([1, 9, 10, 12, 22]),
])
// clean all cached result
taskSchedule.cleanCache()
// task will execute again
const result = await taskSchedule.dispatch(1),

```

## utils methods
there are some utils method as static members of `async-task-schedule`


### isEqual(a: unknown, b: unknown): boolean
check whether the given values are equal (with deep comparison)

```ts
import TaskSchedule from 'async-task-schedule'

TaskSchedule.isEqual(1, '1') // false
TaskSchedule.isEqual('1', '1') // true
TaskSchedule.isEqual(NaN, NaN) // true
TaskSchedule.isEqual({a: 'a', b: 'b'}, {b: 'b', a: 'a'}) // true
TaskSchedule.isEqual({a: 'a', b: 'b', c: {e: [1,2,3]}}, {b: 'b', c: {e: [1,2,3]}, a: 'a'}) // true
TaskSchedule.isEqual({a: 'a', b: /acx/}, {b: new RegExp('acx'), a: 'a'}) // true
```
you can use it to check whether two tasks are equal / find specified task


## Receipts

### how to integrate with existing code
what you need to do is to wrap your existing task executing function into a new `batchDoTasks`

#### example 1: cache `fetch`
suppose we use browser native `fetch` to send request, we can do so to make an improvement:

```ts

const fetchSchedule = new TaskSchedule({
  async doTask(cfg: {resource: string, options?: RequestInit}) {
    return await fetch(cfg.resource, cfg.options)
  },
  // 0 for forever
  // set a minimum number 1 can disable cache after 1 millisecond
  invalidAfter(cfg, result) {
    // cache get request for 3s
    if (!cfg.options || !cfg.options.method || !cfg.options.method.toLowerCase() === 'get') {
      // cache sys static config forever
      if (/\/sys\/static-config$/.test(cfg.resource)) return 0
      return 3000
    }
    // disable other types request
    return 1
  }
})

const betterFetch = (resource: string, options?: RequestInit) => {
  return fetchSchedule.dispatch({resource, options})
}

// than you can replace fetch with betterFetch
```

with those codes above:
1. you can remove redundant request(requests with same parameters at same time will be reduced to one, this may have some side effects)
2. get request can be cached in a short time


#### example 2: deal with `getUsers`
suppose we have a method `getUsers` defined as follows:

```ts
// support max 5 users at a time
getUsers(userIds: string[]) => Promise<[{code: string, message: string, id?: string, name?: string, email?: string}]>
``` 

then we can implement a batch version:
```ts
async function batchGetUsers(userIds: string[]): Promise<Array<[string, {id: string, name: string, email: string}]>> {
  // there is no need to try/catch, errors will be handled properly
  const users = await getUsers(userIds)
  // convert invalid users to error
  return users.map(user => (user.code === 'failed' ? new Error(user.message) : user))
}

const getUserSchedule = new TaskSchedule({
  maxBatchCount: 5,
  batchDoTasks: batchGetUsers,
  // cache user info forever
  invalidAfter: 0,
})

const result = await Promise.all([
  getUserSchedule.dispatch(['user1', 'user2', 'user3', 'user4', 'user5', 'user6']),
  getUserSchedule.dispatch(['user3', 'user2'])
  getUserSchedule.dispatch(['user6', 'user7', 'user8', 'user9', 'user10'])
  getUserSchedule.dispatch(['user2', 'user6', 'user9'])
])
// only 2 requests will be sent via getUsers with userIds ['user1', 'user2', 'user3', 'user4', 'user5'] and ['user6', 'user7', 'user8', 'user9', 'user10']

// request combine won't works when using await separately
const result1 = await getUserSchedule.dispatch(['user1', 'user2'])
const result2 = await getUserSchedule.dispatch(['user3', 'user2'])
```

If you got a batch version function, you just need to make sure it throw an error when error occurred.


### how to cool down massive requests at the same time
by setting `taskExecStrategy` to `serial` and using smaller `maxBatchCount`(you can even set it to `1`), you can achieve this easily

```ts
const taskSchedule = new TaskSchedule({
  ...,
  taskExecStrategy: 'serial',
  maxBatchCount: 2,
})
```


