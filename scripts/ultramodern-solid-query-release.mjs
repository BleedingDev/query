import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const repository = 'BleedingDev/query'
const branch = 'solid-query-v6-pre'
const workflow = '.github/workflows/ultramodern-solid-query-source.yml'
export function verifyRun(run, source) {
  assert.equal(run.repository.full_name, repository)
  assert.equal(run.head_repository.full_name, repository)
  assert.equal(run.path, workflow)
  assert.equal(run.event, 'push')
  assert.equal(run.head_branch, branch)
  assert.equal(run.head_sha, source)
  assert.equal(run.status, 'completed')
  assert.equal(run.conclusion, 'success')
}
export const packageNames = [
  '@tanstack/solid-query',
  '@tanstack/query-devtools',
  '@tanstack/query-persist-client-core',
  '@tanstack/solid-query-devtools',
  '@tanstack/solid-query-persist-client',
]
export function archiveName(name, source) {
  return `tanstack-${name.slice('@tanstack/'.length)}-${source.slice(0, 12)}.tgz`
}
export function archiveUrl(name, source) {
  return `https://github.com/${repository}/releases/download/ultramodern-solid-query-${source.slice(0, 12)}/${archiveName(name, source)}`
}
// Every cohort archive is supplied directly by the caller. Internal edges are
// required exact-version peers so strict installs never follow nested URL deps.
export function projectManifest(manifest, sourceManifests) {
  const projected = structuredClone(manifest)
  for (const name of packageNames) {
    if (
      !['dependencies', 'optionalDependencies', 'peerDependencies'].some(
        (field) => Object.hasOwn(projected[field] ?? {}, name),
      )
    )
      continue
    const provider = sourceManifests.get(name)
    assert(
      provider?.name === name && typeof provider.version === 'string',
      `Missing accepted source version for ${name}`,
    )
    delete projected.dependencies?.[name]
    delete projected.optionalDependencies?.[name]
    projected.peerDependencies ??= {}
    projected.peerDependencies[name] = provider.version
    delete projected.peerDependenciesMeta?.[name]
  }
  return projected
}
export function verifyReceipt(receipt, run, archives, sourceManifests) {
  assert.equal(receipt.schema, 2)
  assert.equal(receipt.repository, repository)
  assert.equal(receipt.source, run.head_sha)
  assert.equal(receipt.runId, String(run.id))
  assert.equal(receipt.runAttempt, String(run.run_attempt))
  assert.equal(receipt.solid, '2.0.0-rc.15')
  assert.equal(receipt.queryCore, '5.102.0')
  assert.deepEqual(
    receipt.packages.map((entry) => entry.package),
    packageNames,
  )
  assert.equal(archives.size, packageNames.length)
  for (const entry of receipt.packages) {
    const source = sourceManifests.get(entry.package)
    assert(source, `Missing merged manifest for ${entry.package}`)
    assert.equal(entry.packageVersion, source.version)
    assert.equal(entry.archive, archiveName(entry.package, run.head_sha))
    const archive = archives.get(entry.archive)
    assert(archive, `Missing accepted archive ${entry.archive}`)
    assert.equal(
      entry.integrity,
      `sha512-${createHash('sha512').update(archive.bytes).digest('base64')}`,
    )
    const manifest = archive.manifest
    assert.equal(manifest.name, entry.package)
    assert.equal(manifest.version, source.version)
    const expected = projectManifest(source, sourceManifests)
    for (const field of [
      'dependencies',
      'optionalDependencies',
      'peerDependencies',
      'peerDependenciesMeta',
    ]) {
      assert.deepEqual(
        manifest[field] ?? {},
        expected[field] ?? {},
        `${entry.package} must retain the accepted caller-owned ${field}`,
      )
    }
    assert.equal(
      typeof manifest.peerDependencies?.['@tanstack/query-core'],
      'string',
    )
    assert(
      !manifest.dependencies?.['@tanstack/query-core'] &&
        !manifest.optionalDependencies?.['@tanstack/query-core'],
      'Query Core must remain caller-owned',
    )
    assert.notEqual(
      manifest.peerDependenciesMeta?.['@tanstack/query-core']?.optional,
      true,
    )
    for (const field of [
      'dependencies',
      'optionalDependencies',
      'peerDependencies',
    ]) {
      for (const [name, specifier] of Object.entries(manifest[field] ?? {})) {
        assert(
          !specifier.startsWith('workspace:'),
          `Unresolved workspace edge ${entry.package} -> ${name}`,
        )
        if (packageNames.includes(name)) {
          assert.equal(
            field,
            'peerDependencies',
            'Cohort edges must be caller-owned peers',
          )
          assert.equal(specifier, sourceManifests.get(name).version)
          assert.notEqual(manifest.peerDependenciesMeta?.[name]?.optional, true)
        }
      }
    }
  }
}
async function main() {
  const source = process.env.GITHUB_SHA
  const runId = process.argv[2]
  assert.equal(process.env.GITHUB_REPOSITORY, repository)
  assert.equal(process.env.GITHUB_REF, `refs/heads/${branch}`)
  assert(source && /^[a-f0-9]{40}$/.test(source))
  assert(runId && /^[1-9][0-9]*$/.test(runId))
  const token = process.env.GH_TOKEN
  assert(token, 'GH_TOKEN is required')
  async function request(route, method = 'GET', body, optional = false) {
    const response = await fetch(
      `https://api.github.com/repos/${repository}/${route}`,
      {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      },
    )
    if (optional && response.status === 404) return undefined
    assert(
      response.ok,
      `GitHub ${method} ${route} failed with ${response.status}`,
    )
    return response.json()
  }
  // GITHUB_TOKEN cannot read Administration settings. Require an authorized
  // settings credential to verify the live setting before either mutation.
  async function verifyImmutabilitySetting() {
    const settingsToken = process.env.QUERY_RELEASE_SETTINGS_TOKEN
    assert(settingsToken, 'QUERY_RELEASE_SETTINGS_TOKEN is required')
    const response = await fetch(
      `https://api.github.com/repos/${repository}/immutable-releases`,
      {
        headers: {
          Authorization: `Bearer ${settingsToken}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
        },
      },
    )
    assert(response.ok, `Immutability preflight failed with ${response.status}`)
    assert.equal(
      (await response.json()).enabled,
      true,
      'Enable immutable releases before publishing accepted bytes',
    )
  }
  await verifyImmutabilitySetting()
  const run = await request(`actions/runs/${runId}`)
  verifyRun(run, source)
  async function verifyCurrentSource() {
    const currentBranch = await request(`branches/${branch}`)
    assert.equal(
      currentBranch.commit.sha,
      source,
      'Release requires current merged branch source',
    )
  }
  await verifyCurrentSource()
  const name = `solid-query-source-${source}`
  const artifacts = await request(
    `actions/runs/${runId}/artifacts?per_page=100`,
  )
  assert(artifacts.total_count <= 100, 'Unexpected artifact pagination')
  const matching = artifacts.artifacts.filter(
    (artifact) => artifact.name === name && !artifact.expired,
  )
  assert.equal(matching.length, 1, 'Expected one immutable accepted artifact')
  assert.equal(matching[0].workflow_run.head_sha, source)
  const tag = `ultramodern-solid-query-${source.slice(0, 12)}`
  assert.equal(
    await request(`releases/tags/${tag}`, 'GET', undefined, true),
    undefined,
    'Release already exists; do not replace or redispatch accepted publication',
  )
  assert.equal(
    await request(`git/ref/tags/${tag}`, 'GET', undefined, true),
    undefined,
    'Tag already exists; do not reuse publication identity',
  )
  const work = await mkdtemp(path.join(os.tmpdir(), 'solid-query-promotion-'))
  try {
    execFileSync(
      'gh',
      [
        'run',
        'download',
        runId,
        '--repo',
        repository,
        '--name',
        name,
        '--dir',
        work,
      ],
      { stdio: 'inherit' },
    )
    const receipt = JSON.parse(
      await readFile(path.join(work, 'acceptance.json'), 'utf8'),
    )
    const files = await readdir(work)
    const archiveFiles = packageNames.map((name) => archiveName(name, source))
    assert.deepEqual(files.sort(), ['acceptance.json', ...archiveFiles].sort())
    const archives = new Map()
    const sourceManifests = new Map()
    for (const name of packageNames) {
      const filename = archiveName(name, source)
      const absolute = path.join(work, filename)
      archives.set(filename, {
        bytes: await readFile(absolute),
        manifest: JSON.parse(
          execFileSync('tar', ['-xOf', absolute, 'package/package.json'], {
            encoding: 'utf8',
          }),
        ),
      })
      sourceManifests.set(
        name,
        JSON.parse(
          await readFile(
            new URL(
              `../packages/${name.slice('@tanstack/'.length)}/package.json`,
              import.meta.url,
            ),
            'utf8',
          ),
        ),
      )
    }
    verifyReceipt(receipt, run, archives, sourceManifests)
    const integrities = receipt.packages
      .map(
        (entry) =>
          `${entry.package}@${entry.packageVersion}: ${entry.integrity}`,
      )
      .join('\n')
    const evidence = `Source: https://github.com/${repository}/commit/${source}\nAccepted CI: https://github.com/${repository}/actions/runs/${runId}\nActions artifact: ${matching[0].id}\n\n${integrities}\n\nSolid 2.0.0-rc.15 with one caller-owned Query Core5.102.0. All five exact accepted archives, without rebuilding. Callers supply all five authenticated archives directly; wrappers require exact cohort version peers.\n`
    await verifyCurrentSource()
    const release = await request('releases', 'POST', {
      tag_name: tag,
      target_commitish: source,
      name: `Solid Query and providers source ${source.slice(0, 12)}`,
      body: evidence,
      draft: true,
      prerelease: true,
    })
    for (const filename of files) {
      const bytes = await readFile(path.join(work, filename))
      const url = `https://uploads.github.com/repos/${repository}/releases/${release.id}/assets?name=${encodeURIComponent(filename)}`
      await verifyCurrentSource()
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github+json',
          'Content-Type': filename.endsWith('.tgz')
            ? 'application/gzip'
            : 'application/json',
        },
        body: bytes,
      })
      assert(
        response.ok,
        `Asset upload failed with ${response.status}; retain draft and inspect exact run`,
      )
      const asset = await response.json()
      assert.equal(
        asset.digest,
        `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
      )
    }
    await verifyImmutabilitySetting()
    await verifyCurrentSource()
    await request(`releases/${release.id}`, 'PATCH', { draft: false })
    const published = await request(`releases/${release.id}`)
    assert.equal(published.draft, false)
    assert.equal(
      published.immutable,
      true,
      'Repository immutable releases must be enabled before dispatch',
    )
    assert.deepEqual(
      published.assets.map((asset) => asset.name).sort(),
      files.sort(),
    )
    for (const asset of published.assets) {
      const bytes = await readFile(path.join(work, asset.name))
      assert.equal(
        asset.digest,
        `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
      )
    }
    const ref = await request(`git/ref/tags/${tag}`)
    assert.equal(ref.object.sha, source)
    console.log(published.html_url)
  } finally {
    await rm(work, { recursive: true, force: true })
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  await main()
