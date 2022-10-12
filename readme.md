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
import AsyncTask from 'async-task-schedule'

const asyncTask = new AsyncTask({
  batchDoTasks: async (names: string[]) => {
    count += 1
    return names.map((n) => ([n, `${n}${count}`] as [string, string]))
  },
})

asyncTask.dispatch(['a', 'b']).then(console.log)
asyncTask.dispatch(['b', 'c']).then(console.log)
asyncTask.dispatch(['d', 'c']).then(console.log)
asyncTask.dispatch('c').then(console.log)
// batchDoTasks will be only called once

```
**NOTICE**: in following example, tasks won't combine
```ts
// batchDoTasks will be executed 3 times due to javascript language features
const result1 = await asyncTask.dispatch(['a', 'b'])
const result2 = await asyncTask.dispatch(['b', 'c'])
const result3 = await asyncTask.dispatch(['d', 'c'])
const result4 = await asyncTask.dispatch('c')
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
   * batchDoTasks should receive multitasks, and return tuple of task and response or error in array
   * one of batchDoTasks/doTask must be specified, batchDoTasks will take priority
   */
  private batchDoTasks: (tasks: Task[]) => Promise<Array<[Task, Result | Error ]>>

  /**
   * action to do single task
   *  one of batchDoTasks/doTask must be specified, batchDoTasks will take priority
   */
  doTask?: ((task: Task) => Promise<Result>)

  /**
   * check whether two tasks are equal
   *  it helps to avoid duplicated tasks
   *  default: (a, b) => a === b
   */
  private isSameTask?: (a: Task, b: Task) => boolean

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
   *    it's especially useful to cool down task requests
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
}
```

### dispatch(tasks: Task[]):Promise<Array<[Task, Result | Error]>>
dispatch multitasks at a time, will get tuple of task and response in array

this method won't throw any error, it will fulfil even partially failed, you can check whether its success by `tuple[1] instanceof Error`

### dispatch(tasks: Task):Promise<Result>
dispatch a task, will get response if success, or throw an error

### cleanCache
clean cached tasks' result, so older task will trigger new request and get fresh response.

attention: this action may not exec immediately, it will take effect after all tasks are done

## Receipts

### how to integrate with existing code
what you need to do is to wrap your existing task executing function into a new `batchDoTasks`

#### example 1
suppose we have a method `getUsers` defined as follows:

```ts
getUsers(userIds: string[]) -> Promise<[{id: string, name: string, email: string}]>
``` 

then we can implement a batch version:
```ts
async function batchGetUsers(userIds: string[]): Promise<Array<[string, {id: string, name: string, email: string}]>> {
  // there is no need to try/catch, errors will be handled properly
  const users = await getUsers(userIds)
  // convert users array into tuple of user id and user info in array
  return users.map(user => ([user.id, user]))
}

const getUserAsyncTask = new AsyncTask({
  batchDoTasks: batchGetUsers
})

const result = await Promise.all([
  getUserAsyncTask.dispatch(['user1', 'user2']),
  getUserAsyncTask.dispatch(['user3', 'user2'])
])
// only one request will be sent via getUsers with userIds ['user1', 'user2', 'user3']

// request combine won't works when using await separately
const result1 = await getUserAsyncTask.dispatch(['user1', 'user2'])
const result2 = await getUserAsyncTask.dispatch(['user3', 'user2'])
```

#### example 2
if the request parameter is an object, then we should provide a `isSameTask` to identify unique task

suppose we have a method `decodeGeoPoints` defined as follows:

```ts
decodeGeoPoints(points: Array<{lat: number, long: number}>) -> Promise<[{point: {lat: number, long: number}, title: string, description: string, country: string}]>
``` 

then we can integrate as follows:

```ts
async function batchDecodeGeoPoints(points: Array<{lat: number, long: number}>): Promise<Array<[{lat: number, long: number}, {point: {lat: number, long: number}, title: string, description: string, country: string}]>> {
  // there is no need to try/catch, errors will be handled properly
  const pointInfos = await decodeGeoPoints(userIds)
  // convert point info array into tuple of point and point info in array
  return pointInfos.map(info => ([info.point, info]))
}

const isSamePoint = (a: {lat: number, long: number}, b: {lat: number, long: number}) => a.lat === b.lat && a.long === b.long

const decodePointsAsyncTask = new AsyncTask({
  batchDoTasks: batchDecodeGeoPoints,
  isSameTask: isSamePoint
})

decodePointsAsyncTask.dispatch([{lat: 23.232, long: 43.121}, {lat: 33.232, long: 11.1023}]).then(console.log)
decodePointsAsyncTask.dispatch([{lat: 23.232, long: 43.121}, {lat: 33.232, long: 44.2478}]).then(console.log)
// only one request will be sent via decodeGeoPoints

// request combine won't work when using await
const result1 = await decodePointsAsyncTask.dispatch([{lat: 23.232, long: 43.121}, {lat: 33.232, long: 11.1023}])
const result2 = await decodePointsAsyncTask.dispatch([{lat: 23.232, long: 43.121}, {lat: 33.232, long: 44.2478}]).then(console.log)
```


### how to cool down massive requests at the same time
by setting `taskExecStrategy` to `serial` and using smaller `maxBatchCount`(you can even set it to `1`), you can achieve this easily

```ts
const asyncTask = new AsyncTask({
  ...,
  taskExecStrategy: 'serial',
  maxBatchCount: 2,
})
```


