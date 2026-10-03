const { performance } = require('node:perf_hooks')
const assert = require('node:assert/strict')
const AsyncTask = require('../dist/index.umd.js')

async function sample(count, keyed) {
  let comparisons = 0
  const tasks = Array.from({ length: count }, (_, id) => ({ id, scope: { tenant: 'demo' } }))
  const schedule = new AsyncTask({
    batchDoTasks: tasks => tasks.map(task => task.id),
    maxWaitingGap: 0,
    invalidAfter: 0,
    retryWhenFailed: false,
    isSameTask: (a, b) => { comparisons++; return AsyncTask.isEqual(a, b) },
    ...(keyed ? { getTaskKey: task => task.id } : {}),
  })
  const coldStart = performance.now()
  const result = await schedule.dispatch([...tasks, ...tasks])
  const coldMs = performance.now() - coldStart
  assert.deepEqual(result, [...tasks, ...tasks].map(task => task.id))
  const coldComparisons = comparisons
  comparisons = 0
  const hotStart = performance.now()
  const cached = await Promise.all(tasks.map(task => schedule.dispatch({ id: task.id, scope: { tenant: 'demo' } })))
  const hotMs = performance.now() - hotStart
  assert.deepEqual(cached, tasks.map(task => task.id))
  return { coldMs, hotMs, coldComparisons, hotComparisons: comparisons }
}

async function main() {
  const rows = []
  for (const count of [100, 500, 1000]) {
    for (const keyed of [false, true]) {
      await sample(count, keyed)
      const runs = []
      for (let i = 0; i < 5; i++) runs.push(await sample(count, keyed))
      const median = field => runs.map(run => run[field]).sort((a, b) => a - b)[2]
      rows.push({ tasks: count, identity: keyed ? 'getTaskKey' : 'deep comparison', cold_ms: +median('coldMs').toFixed(2), hot_ms: +median('hotMs').toFixed(2), cold_comparisons: median('coldComparisons'), hot_comparisons: median('hotComparisons') })
    }
  }
  console.log(`Node ${process.version}; median of five runs after warmup; milliseconds include scheduling overhead.`)
  console.table(rows)
}
main().catch(error => { console.error(error); process.exitCode = 1 })
