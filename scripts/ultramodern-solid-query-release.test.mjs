import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { verifyRun, verifyReceipt } from './ultramodern-solid-query-release.mjs'
const source = 'a'.repeat(40)
test('missing settings credential stops before any release API request', () => {
  const script = new URL('./ultramodern-solid-query-release.mjs', import.meta.url)
  const result = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '--eval',
      `globalThis.fetch = async () => {
        console.error("UNEXPECTED_RELEASE_REQUEST");
        throw new Error("Release API must not be called without verification credentials");
      };
      process.argv[1] = ${JSON.stringify(fileURLToPath(script))};
      process.argv[2] = "123";
      await import(${JSON.stringify(script.href)});`,
    ],
    {
      encoding: 'utf8',
      env: {
        GITHUB_REPOSITORY: 'BleedingDev/query',
        GITHUB_REF: 'refs/heads/solid-query-v6-pre',
        GITHUB_SHA: source,
        GH_TOKEN: 'guard-test-token',
      },
    },
  )
  assert.equal(result.status, 1)
  assert.match(result.stderr, /QUERY_RELEASE_SETTINGS_TOKEN is required/)
  assert.doesNotMatch(result.stderr, /UNEXPECTED_RELEASE_REQUEST/)
  assert.equal(result.stdout, '')
})
const run = {
  id: 123,
  run_attempt: 1,
  repository: { full_name: 'BleedingDev/query' },
  head_repository: { full_name: 'BleedingDev/query' },
  path: '.github/workflows/ultramodern-solid-query-source.yml',
  event: 'push',
  head_branch: 'solid-query-v6-pre',
  head_sha: source,
  status: 'completed',
  conclusion: 'success',
}
const bytes = Buffer.from('accepted bytes')
const receipt = {
  schema: 1,
  repository: 'BleedingDev/query',
  source,
  runId: '123',
  runAttempt: '1',
  package: '@tanstack/solid-query',
  packageVersion: '6.0.0-rc.5',
  solid: '2.0.0-rc.15',
  queryCore: '5.102.0',
  archive: `tanstack-solid-query-${source.slice(0, 12)}.tgz`,
  integrity: `sha512-${createHash('sha512').update(bytes).digest('base64')}`,
}
test('accepts exact successful merged source and its bytes', () => {
  verifyRun(run, source)
  verifyReceipt(receipt, run, bytes, '6.0.0-rc.5')
})
test('rejects PR, foreign, failed, stale source and altered bytes', () => {
  for (const change of [
    { event: 'pull_request' },
    { repository: { full_name: 'TanStack/query' } },
    { head_branch: 'feature' },
    { conclusion: 'failure' },
    { head_sha: 'b'.repeat(40) },
    { path: '.github/workflows/release.yml' },
  ]) {
    assert.throws(() => verifyRun({ ...run, ...change }, source))
  }
  assert.throws(() =>
    verifyReceipt(receipt, run, Buffer.from('replacement'), '6.0.0-rc.5'),
  )
  assert.throws(() =>
    verifyReceipt({ ...receipt, runId: '124' }, run, bytes, '6.0.0-rc.5'),
  )
  assert.throws(() =>
    verifyReceipt({ ...receipt, solid: '1.9.17' }, run, bytes, '6.0.0-rc.5'),
  )
})
