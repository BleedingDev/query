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
export function verifyReceipt(receipt, run, bytes, packageVersion) {
  assert.equal(receipt.schema, 1)
  assert.equal(receipt.repository, repository)
  assert.equal(receipt.source, run.head_sha)
  assert.equal(receipt.runId, String(run.id))
  assert.equal(receipt.runAttempt, String(run.run_attempt))
  assert.equal(receipt.package, '@tanstack/solid-query')
  assert.equal(typeof packageVersion, 'string')
  assert.equal(receipt.packageVersion, packageVersion)
  assert.equal(receipt.solid, '2.0.0-rc.15')
  assert.equal(receipt.queryCore, '5.102.0')
  assert.equal(
    receipt.archive,
    `tanstack-solid-query-${run.head_sha.slice(0, 12)}.tgz`,
  )
  assert.equal(
    receipt.integrity,
    `sha512-${createHash('sha512').update(bytes).digest('base64')}`,
  )
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
  const currentBranch = await request(`branches/${branch}`)
  assert.equal(
    currentBranch.commit.sha,
    source,
    'Release requires current merged branch source',
  )
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
    assert.equal(receipt.archive, path.basename(receipt.archive))
    const files = await readdir(work)
    assert.deepEqual(files.sort(), ['acceptance.json', receipt.archive].sort())
    const archive = await readFile(path.join(work, receipt.archive))
    const packageVersion = JSON.parse(
      await readFile(
        new URL('../packages/solid-query/package.json', import.meta.url),
        'utf8',
      ),
    ).version
    verifyReceipt(receipt, run, archive, packageVersion)
    const evidence = `Source: https://github.com/${repository}/commit/${source}\nAccepted CI: https://github.com/${repository}/actions/runs/${runId}\nActions artifact: ${matching[0].id}\nIntegrity: ${receipt.integrity}\n\nSolid 2.0.0-rc.15 with one host Query Core5.102.0. Exact accepted archive, without rebuilding.\n`
    const release = await request('releases', 'POST', {
      tag_name: tag,
      target_commitish: source,
      name: `Solid Query source ${source.slice(0, 12)}`,
      body: evidence,
      draft: true,
      prerelease: true,
    })
    for (const filename of files) {
      const bytes = await readFile(path.join(work, filename))
      const url = `https://uploads.github.com/repos/${repository}/releases/${release.id}/assets?name=${encodeURIComponent(filename)}`
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
    await request(`releases/${release.id}`, 'PATCH', { draft: false })
    const published = await request(`releases/${release.id}`)
    assert.equal(published.draft, false)
    assert.equal(
      published.immutable,
      true,
      'Repository immutable releases must be enabled before dispatch',
    )
    assert.equal(published.assets.length, 2)
    const ref = await request(`git/ref/tags/${tag}`)
    assert.equal(ref.object.sha, source)
    console.log(published.html_url)
  } finally {
    await rm(work, { recursive: true, force: true })
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  await main()
