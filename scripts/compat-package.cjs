const { copyFileSync, readFileSync, writeFileSync } = require('node:fs')
const path = require('node:path')

const dist = path.resolve(__dirname, '../dist')
// Retain the file paths shipped in 1.0.1, including CommonJS deep imports.
copyFileSync(path.join(dist, 'index.umd.js'), path.join(dist, 'index.js'))

// Preserve the old structural public type and CommonJS `import = require` form.
// The ESM declaration remains available as index.d.ts.
const declaration = readFileSync(path.join(dist, 'index.d.ts'), 'utf8')
  .replace(/^    private .+;\r?\n/gm, '')
writeFileSync(path.join(dist, 'index.d.ts'), declaration)
const commonjs = declaration
  .replace(/^export default class /m, 'declare class ')
  .replace(/^export declare type /gm, 'type ')
  .replace(/^export interface /gm, 'interface ')
const names = ['ITaskKey', 'ITaskExecStrategy', 'ITaskWaitingStrategy']
const namespace = names.map(name => `    type ${name} = import('./index').${name};`).join('\n')
writeFileSync(path.join(dist, 'types.d.ts'), `${commonjs}\n` +
  `declare namespace AsyncTask {\n${namespace}\n` +
  `    type IAsyncTaskOptions<Task, Result> = import('./index').IAsyncTaskOptions<Task, Result>;\n` +
  `}\nexport = AsyncTask;\n`)
