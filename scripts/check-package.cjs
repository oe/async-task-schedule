const assert = require('node:assert/strict')
const { execFileSync } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { pathToFileURL } = require('node:url')
const ts = require('typescript')

const root = path.resolve(__dirname, '..')
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'async-task-package-'))

async function main() {
  const [packed] = JSON.parse(execFileSync('npm', ['pack', '--json', '--ignore-scripts', '--pack-destination', temp], {
    cwd: root, encoding: 'utf8',
  }))
  const modules = path.join(temp, 'node_modules')
  fs.mkdirSync(modules)
  execFileSync('tar', ['-xzf', path.join(temp, packed.filename), '-C', modules])
  const pkgDir = path.join(modules, 'async-task-schedule')
  fs.renameSync(path.join(modules, 'package'), pkgDir)
  const pkg = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8'))
  for (const file of [pkg.main, pkg.module, pkg.types, 'dist/index.js', 'dist/types.d.ts', 'LICENSE']) {
    assert.ok(fs.existsSync(path.join(pkgDir, file)), `Missing packed file: ${file}`)
  }
  const Schedule = require(pkgDir)
  assert.equal(typeof Schedule, 'function')
  assert.equal(typeof require(path.join(pkgDir, 'dist/index.js')), 'function')
  const imported = await import(pathToFileURL(path.join(pkgDir, pkg.main)).href)
  assert.equal(imported.default, Schedule)

  const sources = [
    `import Schedule = require('async-task-schedule');`,
    `import Schedule from 'async-task-schedule';`,
    `import Schedule = require('async-task-schedule/dist/types');`,
  ]
  const fixtures = sources.map((source, i) => {
    const file = path.join(temp, `consumer-${i}.ts`)
    fs.writeFileSync(file, `${source}\n` + `
      import type { ITaskExecStrategy, ITaskWaitingStrategy, ITaskKey, IAsyncTaskOptions } from 'async-task-schedule';
      const strategy: ITaskExecStrategy = 'serial';
      const waiting: ITaskWaitingStrategy = 'throttle';
      const options: IAsyncTaskOptions<number, number> = { doTask: n => n * n, taskExecStrategy: strategy, taskWaitingStrategy: waiting };
      const schedule = new Schedule(options);
      const scalar: Promise<number> = schedule.dispatch(2);
      const tuple: Promise<readonly [number | Error, number | Error]> = schedule.dispatch([1, 2] as const);
      const instance: Schedule<number, number> = schedule;
      const key: ITaskKey = 'identity';
      // 1.0.1 declarations allowed structural public instances.
      const structural: Schedule<number, number> = {
        dispatch: schedule.dispatch, cleanCache() {}, isTaskRunning: false,
      };
    `)
    return file
  })
  const program = ts.createProgram(fixtures, {
    target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS,
    moduleResolution: ts.ModuleResolutionKind.Node10, strict: true,
    esModuleInterop: true, skipLibCheck: false, noEmit: true, types: [],
  })
  const errors = ts.getPreEmitDiagnostics(program)
  assert.equal(errors.length, 0, ts.formatDiagnosticsWithColorAndContext(errors, {
    getCanonicalFileName: file => file, getCurrentDirectory: () => temp, getNewLine: () => '\n',
  }))
  const schedule = new Schedule({ doTask: n => n * n, maxWaitingGap: 0 })
  assert.equal(await schedule.dispatch(3), 9)
  assert.deepEqual(await schedule.dispatch([3, 4, 3]), [9, 16, 9])
  console.log('Packed CommonJS / ESM imports, legacy paths, TypeScript consumers and execution pass.')
}

main().finally(() => fs.rmSync(temp, { recursive: true, force: true })).catch(error => {
  console.error(error)
  process.exitCode = 1
})
