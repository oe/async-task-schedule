const { performance } = require('node:perf_hooks')
const { execFileSync } = require('node:child_process')
const { writeFileSync } = require('node:fs')
const path = require('node:path')
const assert = require('node:assert/strict')
const ts = require('typescript')
const Current = require('../dist/index.umd.js')

// This is the tested indexed implementation immediately before the record refactor.
const baselineRef = process.env.PERF_BASELINE_REF || 'f2e07d2c2e358c634a5fb075163fdbc2ef353ccd'
const source = execFileSync('git', ['show', `${baselineRef}:src/index.ts`], {
  cwd: path.resolve(__dirname, '..'), encoding: 'utf8',
})
const compiled = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS },
}).outputText
const baselineModule = { exports: {} }
// Execute only the baseline source from this repository, using the same Node runtime.
new Function('exports', 'require', 'module', compiled)(baselineModule.exports, require, baselineModule)
const Before = baselineModule.exports.default

async function sample(Schedule, count, workload) {
  let keyCalls = 0
  let executions = 0
  const tasks = Array.from({ length: count }, (_, id) => ({ id, scope: { tenant: 'demo' } }))
  const execute = task => { executions++; return task.id }
  const schedule = new Schedule({
    ...(workload === 'batch' ? { batchDoTasks: tasks => tasks.map(execute) } : { doTask: execute }),
    getTaskKey: task => { keyCalls++; return task.id },
    taskExecStrategy: workload === 'serial' ? 'serial' : 'parallel',
    ...(workload === 'serial' ? { maxBatchCount: 1 } : {}),
    maxWaitingGap: 0, invalidAfter: 0, retryWhenFailed: false,
  })
  const coldStart = performance.now()
  if (workload === 'overlap') {
    const inputs = tasks.map((task, i) => [task, tasks[(i + 1) % count], task])
    const results = await Promise.all(inputs.map(input => schedule.dispatch(input)))
    assert.deepEqual(results, inputs.map(input => input.map(task => task.id)))
  } else {
    assert.deepEqual(await schedule.dispatch([...tasks, ...tasks]), [...tasks, ...tasks].map(task => task.id))
  }
  const coldMs = performance.now() - coldStart
  assert.equal(executions, count, 'every distinct task executes exactly once')
  const coldKeys = keyCalls
  keyCalls = 0
  const hotStart = performance.now()
  const cached = await Promise.all(tasks.map(task => schedule.dispatch({ id: task.id, scope: { tenant: 'demo' } })))
  const hotMs = performance.now() - hotStart
  assert.deepEqual(cached, tasks.map(task => task.id))
  assert.equal(executions, count, 'hot requests must use cache')
  return { coldMs, hotMs, coldKeys, hotKeys: keyCalls }
}

async function main() {
  const rows = []
  for (const workload of ['batch', 'single', 'overlap', 'serial']) {
    for (const count of [100, 500, 1000]) {
      for (const [version, Schedule] of [['before', Before], ['after', Current]]) {
        await sample(Schedule, count, workload)
        const samples = []
        for (let i = 0; i < 5; i++) samples.push(await sample(Schedule, count, workload))
        const median = field => samples.map(sample => sample[field]).sort((a, b) => a - b)[2]
        rows.push({ workload, tasks: count, version, cold_ms: +median('coldMs').toFixed(3), hot_ms: +median('hotMs').toFixed(3), cold_key_calls: median('coldKeys'), hot_key_calls: median('hotKeys') })
      }
    }
  }
  const report = { node: process.version, baselineRef, warmup: 1, samples: 5, statistic: 'median', rows }
  writeFileSync(path.resolve(__dirname, '../perf-results.json'), JSON.stringify(report, null, 2) + '\n')
  console.log(`Node ${process.version}; five-run medians after warmup; timings include timer and Promise overhead.`)
  console.table(rows)
  console.log('Saved perf-results.json. Wall-clock timings are diagnostic; deterministic work budgets gate CI.')
}
main().catch(error => { console.error(error); process.exitCode = 1 })
