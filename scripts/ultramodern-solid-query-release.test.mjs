import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  verifyRun,
  verifyReceipt,
  packageNames,
  archiveName,
  archiveUrl,
  projectManifest,
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
      for (const provider of Object.keys(manifest.dependencies ?? {})) {
        delete manifest.dependencies[provider]
        manifest.peerDependencies[provider] =
          sourceManifests.get(provider).version
      }
      if (manifest.peerDependencies['@tanstack/solid-query'])
        manifest.peerDependencies['@tanstack/solid-query'] = '6.0.0-rc.5'
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
test('accepts five direct archives with required exact-version cohort peers', () => {
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
test('projects dependency, optional and peer edges to exact required caller peers', () => {
  const original = {
    name: '@tanstack/solid-query-devtools',
    dependencies: {
      '@tanstack/query-devtools': 'workspace:*',
      outside: '^1.0.0',
    },
    optionalDependencies: {
      '@tanstack/query-persist-client-core': 'workspace:*',
    },
    peerDependencies: {
      '@tanstack/solid-query': 'workspace:^',
      'solid-js': '>=2.0.0-rc.13 <3',
    },
    peerDependenciesMeta: {
      '@tanstack/solid-query': { optional: true },
      outside: { optional: true },
    },
  }
  const projected = projectManifest(original, sourceManifests)
  assert.deepEqual(projected.dependencies, { outside: '^1.0.0' })
  assert.deepEqual(projected.optionalDependencies, {})
  assert.deepEqual(projected.peerDependencies, {
    '@tanstack/solid-query': '6.0.0-rc.5',
    '@tanstack/query-devtools': '5.101.4',
    '@tanstack/query-persist-client-core': '5.101.4',
    'solid-js': '>=2.0.0-rc.13 <3',
  })
  assert.deepEqual(projected.peerDependenciesMeta, {
    outside: { optional: true },
  })
  assert.equal(original.dependencies['@tanstack/query-devtools'], 'workspace:*')
  assert.equal(
    original.peerDependenciesMeta['@tanstack/solid-query'].optional,
    true,
  )
  assert.throws(() => projectManifest(original, new Map()))
})
test('rejects nested URLs, optional or inexact cohort peers, and private Core copies', () => {
  for (const mutate of [
    (manifest) => {
      manifest.dependencies['@tanstack/query-devtools'] = '5.101.4'
    },
    (manifest) => {
      manifest.dependencies['@tanstack/query-devtools'] = archiveUrl(
        '@tanstack/query-devtools',
        source,
      )
    },
    (manifest) => {
      manifest.optionalDependencies = {
        '@tanstack/query-devtools': archiveUrl(
          '@tanstack/query-devtools',
          source,
        ),
      }
    },
    (manifest) => {
      manifest.peerDependencies['@tanstack/solid-query'] = '^6.0.0-rc.5'
    },
    (manifest) => {
      manifest.peerDependencies['@tanstack/query-devtools'] = '5.101.3'
    },
    (manifest) => {
      delete manifest.peerDependencies['@tanstack/query-devtools']
    },
    (manifest) => {
      manifest.peerDependenciesMeta = {
        '@tanstack/query-devtools': { optional: true },
      }
    },
    (manifest) => {
      manifest.peerDependenciesMeta = {
        '@tanstack/solid-query': { optional: true },
      }
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

for (const scenario of ['inspection', 'asset', 'publish', 'stable']) {
  test(`promotion checks live branch before mutations: ${scenario}`, () => {
    const { receipt, archives } = fixture()
    const actualManifests = new Map()
    for (const entry of receipt.packages) {
      const manifest = JSON.parse(
        readFileSync(
          new URL(
            `../packages/${entry.package.slice('@tanstack/'.length)}/package.json`,
            import.meta.url,
          ),
          'utf8',
        ),
      )
      actualManifests.set(entry.package, manifest)
      entry.packageVersion = manifest.version
    }
    for (const entry of receipt.packages) {
      archives.get(entry.archive).manifest = projectManifest(
        actualManifests.get(entry.package),
        actualManifests,
      )
    }
    verifyReceipt(receipt, run, archives, actualManifests)
    const script = new URL(
      './ultramodern-solid-query-release.mjs',
      import.meta.url,
    )
    const data = [...archives].map(([name, archive]) => ({
      name,
      bytes: archive.bytes.toString('base64'),
      manifest: archive.manifest,
    }))
    const result = spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '--eval',
        `
      import childProcess from 'node:child_process';
      import { syncBuiltinESMExports } from 'node:module';
      import { writeFileSync } from 'node:fs';
      import { createHash } from 'node:crypto';
      import path from 'node:path';
      const archives = ${JSON.stringify(data)};
      const scenario = ${JSON.stringify(scenario)};
      const assets = [];
      let inspected = 0;
      let headChecks = 0;
      let settingsChecks = 0;
      let published = false;
      childProcess.execFileSync = (command, args) => {
        if (command === 'gh') {
          const directory = args[args.indexOf('--dir') + 1];
          writeFileSync(path.join(directory, 'acceptance.json'), ${JSON.stringify(JSON.stringify(receipt))});
          for (const archive of archives) writeFileSync(path.join(directory, archive.name), Buffer.from(archive.bytes, 'base64'));
          return;
        }
        if (command === 'tar') {
          const archive = archives.find(archive => archive.name === path.basename(args[1]));
          if (!archive) throw new Error('Unexpected archive inspection');
          console.log('INSPECTED:' + ++inspected);
          return JSON.stringify(archive.manifest);
        }
        throw new Error('Unexpected child command: ' + command);
      };
      syncBuiltinESMExports();
      globalThis.fetch = async (url, options = {}) => {
        const method = options.method ?? 'GET';
        const route = String(url).split('/repos/BleedingDev/query/')[1];
        let body;
        let status = 200;
        if (method !== 'GET') console.log('MUTATION:' + method + ':' + route);
        if (String(url).startsWith('https://uploads.github.com/')) {
          const asset = { name: new URL(url).searchParams.get('name'), digest: 'sha256:' + createHash('sha256').update(options.body).digest('hex') };
          assets.push(asset);
          body = asset;
        } else if (method === 'POST' && route === 'releases') body = { id: 789 };
        else if (method === 'PATCH' && route === 'releases/789') { published = true; body = {}; }
        else if (route === 'immutable-releases') { settingsChecks++; body = { enabled: true }; }
        else if (route === 'actions/runs/123') body = ${JSON.stringify(run)};
        else if (route === 'branches/solid-query-v6-pre') {
          console.log('HEAD_CHECK:' + ++headChecks);
          const advanced = scenario === 'inspection' && inspected === 5 || scenario === 'asset' && assets.length > 0 || scenario === 'publish' && settingsChecks === 2;
          body = { commit: { sha: advanced ? '${'b'.repeat(40)}' : '${source}' } };
        } else if (route === 'actions/runs/123/artifacts?per_page=100') body = { total_count: 1, artifacts: [{ id: 456, name: 'solid-query-source-${source}', expired: false, workflow_run: { head_sha: '${source}' } }] };
        else if (route === 'releases/789') body = { draft: false, immutable: true, assets, html_url: 'https://github.com/BleedingDev/query/releases/accepted' };
        else if (route.startsWith('git/ref/tags/') && published) body = { object: { sha: '${source}' } };
        else if (route.startsWith('releases/tags/') || route.startsWith('git/ref/tags/')) status = 404;
        else throw new Error('Unexpected GitHub request: ' + method + ' ' + route);
        return { ok: status === 200, status, json: async () => body };
      };
      process.argv[1] = ${JSON.stringify(fileURLToPath(script))};
      process.argv[2] = '123';
      await import(${JSON.stringify(script.href)});
    `,
      ],
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          GITHUB_REPOSITORY: 'BleedingDev/query',
          GITHUB_REF: 'refs/heads/solid-query-v6-pre',
          GITHUB_SHA: source,
          GH_TOKEN: 'guard-test-token',
          QUERY_RELEASE_SETTINGS_TOKEN: 'guard-settings-token',
        },
      },
    )
    assert.match(result.stdout, /INSPECTED:5/)
    const mutations = result.stdout.match(/^MUTATION:/gm) ?? []
    if (scenario === 'stable') {
      assert.equal(result.status, 0, result.stderr)
      assert.equal(mutations.length, 8)
      assert.match(result.stdout, /MUTATION:PATCH:releases\/789/)
      assert.match(
        result.stdout,
        /https:\/\/github.com\/BleedingDev\/query\/releases\/accepted/,
      )
    } else {
      assert.equal(result.status, 1)
      assert.match(
        result.stderr,
        /Release requires current merged branch source/,
      )
      assert.equal(
        mutations.length,
        { inspection: 0, asset: 2, publish: 7 }[scenario],
      )
      assert.doesNotMatch(result.stdout, /MUTATION:PATCH/)
    }
  })
}
