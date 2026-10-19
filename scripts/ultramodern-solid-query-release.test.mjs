import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  verifyRun,
  verifyReceipt,
  packageNames,
  archiveName,
  archiveUrl,
} from './ultramodern-solid-query-release.mjs'
const source = 'a'.repeat(40)
test('missing settings credential stops before any release API request', () => {
  const script = new URL(
    './ultramodern-solid-query-release.mjs',
    import.meta.url,
  )
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
const sourceManifests = new Map(
  packageNames.map((name) => [
    name,
    {
      name,
      version: name.includes('solid-query') ? '6.0.0-rc.5' : '5.101.4',
      peerDependencies: { '@tanstack/query-core': '>=5.102.0 <6.0.0' },
    },
  ]),
)
for (const [wrapper, provider] of [
  ['@tanstack/solid-query-devtools', '@tanstack/query-devtools'],
  [
    '@tanstack/solid-query-persist-client',
    '@tanstack/query-persist-client-core',
  ],
]) {
  sourceManifests.get(wrapper).dependencies = { [provider]: 'workspace:*' }
  sourceManifests.get(wrapper).peerDependencies['@tanstack/solid-query'] =
    'workspace:^'
}
function fixture() {
  const archives = new Map(
    packageNames.map((name) => {
      const sourceManifest = sourceManifests.get(name)
      const manifest = structuredClone(sourceManifest)
      if (name === '@tanstack/solid-query-devtools') {
        manifest.dependencies = {
          '@tanstack/query-devtools': archiveUrl(
            '@tanstack/query-devtools',
            source,
          ),
          '@tanstack/solid-query': archiveUrl('@tanstack/solid-query', source),
        }
        delete manifest.peerDependencies['@tanstack/solid-query']
      }
      if (name === '@tanstack/solid-query-persist-client') {
        manifest.dependencies = {
          '@tanstack/query-persist-client-core': archiveUrl(
            '@tanstack/query-persist-client-core',
            source,
          ),
          '@tanstack/solid-query': archiveUrl('@tanstack/solid-query', source),
        }
        delete manifest.peerDependencies['@tanstack/solid-query']
      }
      return [
        archiveName(name, source),
        { bytes: Buffer.from(`accepted ${name} bytes`), manifest },
      ]
    }),
  )
  const receipt = {
    schema: 2,
    repository: 'BleedingDev/query',
    source,
    runId: '123',
    runAttempt: '1',
    solid: '2.0.0-rc.15',
    queryCore: '5.102.0',
    packages: packageNames.map((name) => {
      const archive = archiveName(name, source)
      return {
        package: name,
        packageVersion: sourceManifests.get(name).version,
        archive,
        integrity: `sha512-${createHash('sha512').update(archives.get(archive).bytes).digest('base64')}`,
      }
    }),
  }
  return { receipt, archives }
}
test('accepts all five exact accepted archives and same-release wrapper graph', () => {
  const { receipt, archives } = fixture()
  verifyRun(run, source)
  verifyReceipt(receipt, run, archives, sourceManifests)
  assert.equal(
    archiveUrl('@tanstack/query-devtools', source),
    `https://github.com/BleedingDev/query/releases/download/ultramodern-solid-query-${source.slice(0, 12)}/tanstack-query-devtools-${source.slice(0, 12)}.tgz`,
  )
})
test('rejects PR, foreign, failed, stale source and another workflow', () => {
  for (const change of [
    { event: 'pull_request' },
    { repository: { full_name: 'TanStack/query' } },
    { head_repository: { full_name: 'TanStack/query' } },
    { head_branch: 'feature' },
    { conclusion: 'failure' },
    { status: 'in_progress' },
    { head_sha: 'b'.repeat(40) },
    { path: '.github/workflows/release.yml' },
  ])
    assert.throws(() => verifyRun({ ...run, ...change }, source))
})
test('rejects old receipts, incomplete cohorts, duplicate packages and wrong run attempts', () => {
  for (const change of [
    { schema: 1 },
    { runId: '124' },
    { runAttempt: '2' },
    { source: 'b'.repeat(40) },
    { solid: '1.9.17' },
    { queryCore: '5.101.4' },
    { repository: 'TanStack/query' },
  ]) {
    const { receipt, archives } = fixture()
    assert.throws(() =>
      verifyReceipt({ ...receipt, ...change }, run, archives, sourceManifests),
    )
  }
  for (const mutate of [
    (receipt) => receipt.packages.pop(),
    (receipt) => {
      receipt.packages[4] = receipt.packages[3]
    },
    (receipt) => {
      receipt.packages[0].archive = '../outside.tgz'
    },
    (receipt) => {
      receipt.packages[0].packageVersion = '6.0.0-rc.4'
    },
  ]) {
    const { receipt, archives } = fixture()
    mutate(receipt)
    assert.throws(() => verifyReceipt(receipt, run, archives, sourceManifests))
  }
})
test('rejects altered or absent bytes from any accepted provider', () => {
  for (const name of packageNames) {
    for (const missing of [false, true]) {
      const { receipt, archives } = fixture()
      const filename = archiveName(name, source)
      if (missing) archives.delete(filename)
      else archives.get(filename).bytes = Buffer.from('replacement')
      assert.throws(() =>
        verifyReceipt(receipt, run, archives, sourceManifests),
      )
    }
  }
})
test('rejects stale registry providers, cross-release URLs and private Core copies', () => {
  for (const mutate of [
    (manifest) => {
      manifest.dependencies['@tanstack/query-devtools'] = '5.101.4'
    },
    (manifest) => {
      manifest.dependencies['@tanstack/query-devtools'] = archiveUrl(
        '@tanstack/query-devtools',
        'b'.repeat(40),
      )
    },
    (manifest) => {
      manifest.dependencies['@tanstack/solid-query'] = '^6.0.0-rc.5'
    },
    (manifest) => {
      manifest.peerDependencies['@tanstack/solid-query'] = '^6.0.0-rc.5'
    },
    (manifest) => {
      manifest.dependencies['@tanstack/query-core'] = '5.102.0'
    },
    (manifest) => {
      delete manifest.peerDependencies['@tanstack/query-core']
    },
    (manifest) => {
      manifest.optionalDependencies = { '@tanstack/query-core': '5.102.0' }
    },
    (manifest) => {
      manifest.peerDependenciesMeta = {
        '@tanstack/query-core': { optional: true },
      }
    },
    (manifest) => {
      manifest.optionalDependencies = {
        '@tanstack/query-devtools': 'workspace:*',
      }
    },
    (manifest) => {
      manifest.name = '@tanstack/solid-query'
    },
    (manifest) => {
      manifest.version = '6.0.0-rc.4'
    },
  ]) {
    const { receipt, archives } = fixture()
    mutate(
      archives.get(archiveName('@tanstack/solid-query-devtools', source))
        .manifest,
    )
    assert.throws(() => verifyReceipt(receipt, run, archives, sourceManifests))
  }
})
