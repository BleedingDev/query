import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const projects = {
  '@tanstack/query-core': 'packages/query-core',
  '@tanstack/query-test-utils': 'packages/query-test-utils',
  '@tanstack/solid-query': 'packages/solid-query',
}
const project = process.env.NX_PROJECT_NAME
assert(Object.hasOwn(projects, project), `Unexpected Nx project: ${project}`)
assert.equal(path.resolve(process.cwd()), path.join(repo, projects[project]))
assert.equal(process.env.NX_PROJECT_ROOT_PATH, projects[project])
const [binary, ...args] = process.argv.slice(2)
const allowed = new Set([
  'vitest/vitest.mjs',
  'eslint/bin/eslint.js',
  'tsup/dist/cli-default.js',
  'typescript/bin/tsc',
  ...['54', '55', '56', '57', '58', '59', '60'].map(
    (version) => `typescript${version}/lib/tsc.js`,
  ),
  'publint/src/cli.js',
  '@arethetypeswrong/cli/dist/index.js',
])
assert(allowed.has(binary), `Unexpected check binary: ${binary}`)
const dependency = project !== '@tanstack/solid-query'
const command = dependency ? 'typescript/bin/tsc' : binary
const parameters = dependency ? ['--build'] : args
console.log(`[${project}] ${command} ${parameters.join(' ')}`)
const result = spawnSync(
  process.execPath,
  [path.join(repo, 'node_modules', command), ...parameters],
  { cwd: process.cwd(), stdio: 'inherit', env: process.env },
)
if (result.error) throw result.error
if (result.signal) {
  throw new Error(`${project} check terminated by ${result.signal}`)
}
process.exitCode = result.status ?? 1
