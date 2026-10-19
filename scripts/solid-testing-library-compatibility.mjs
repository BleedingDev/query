import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFile, readdir, realpath } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const dependency = '@solidjs/testing-library'
// These provider versions were selected for the two runtime engines in this
// workspace. A broad upstream peer range is not evidence of tested V2 support.
const testedProviders = new Map([
  [1, '0.8.10'],
  [2, '1.0.0-beta.3'],
])

export function checkCompatibility(packages, semver) {
  assert(packages.length > 0, 'No declared testing-library owners were checked')
  const cohorts = new Map()
  const errors = []
  for (const pkg of packages) {
    const engine = semver.major(pkg.runtimes['solid-js'].version)
    const expected = testedProviders.get(engine)
    if (
      !semver.satisfies(pkg.provider.version, pkg.specifier, {
        includePrerelease: true,
      })
    ) {
      errors.push(
        `${pkg.name}: installed provider ${pkg.provider.version} does not satisfy its manifest ${pkg.specifier}`,
      )
    }
    if (!expected || pkg.provider.version !== expected) {
      errors.push(
        `${pkg.name}: Solid ${engine} requires tested ${dependency}@${expected ?? '(no accepted provider)'}, received ${pkg.provider.version}`,
      )
    }
    if (!pkg.provider.peers['solid-js']) {
      errors.push(`${pkg.name}: ${dependency} does not declare its Solid peer`)
    }
    for (const peer of ['solid-js', '@solidjs/web']) {
      const range = pkg.provider.peers[peer]
      if (!range) continue
      const runtime = pkg.runtimes[peer]
      if (!runtime) {
        errors.push(
          `${pkg.name}: required provider peer ${peer}@${range} is not installed`,
        )
      } else {
        if (
          !semver.satisfies(runtime.version, range, { includePrerelease: true })
        ) {
          errors.push(
            `${pkg.name}: ${peer}@${runtime.version} does not satisfy provider peer ${range}`,
          )
        }
        if (runtime.root !== runtime.providerRoot) {
          errors.push(
            `${pkg.name}: provider resolves a different ${peer} instance`,
          )
        }
      }
    }
    const prior = cohorts.get(engine)
    if (prior && prior.specifier !== pkg.specifier) {
      errors.push(
        `${pkg.name}: Solid ${engine} provider specifier ${pkg.specifier} differs from ${prior.name}: ${prior.specifier}`,
      )
    } else cohorts.set(engine, { name: pkg.name, specifier: pkg.specifier })
  }
  assert.equal(errors.length, 0, errors.join('\n'))
  return packages.length
}

async function installedPackage(name, require) {
  let directory = path.dirname(await realpath(require.resolve(name)))
  for (;;) {
    try {
      const manifestPath = path.join(directory, 'package.json')
      const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
      if (manifest.name === name)
        return { manifest, manifestPath, root: directory }
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
    const parent = path.dirname(directory)
    assert.notEqual(
      parent,
      directory,
      `Cannot locate installed manifest for ${name}`,
    )
    directory = parent
  }
}

export async function readInstalledProviders(repo) {
  // Match test:sherif's non-example/non-integration workspace scope: the root
  // package and packages/*, including every declared testing-library owner.
  const directories = [repo]
  for (const entry of await readdir(path.join(repo, 'packages'), {
    withFileTypes: true,
  })) {
    if (entry.isDirectory())
      directories.push(path.join(repo, 'packages', entry.name))
  }
  const packages = []
  for (const directory of directories) {
    let manifest
    try {
      manifest = JSON.parse(
        await readFile(path.join(directory, 'package.json'), 'utf8'),
      )
    } catch (error) {
      if (error.code === 'ENOENT') continue
      throw error
    }
    const specifiers = [
      'dependencies',
      'devDependencies',
      'optionalDependencies',
    ]
      .map((field) => manifest[field]?.[dependency])
      .filter(Boolean)
    if (!specifiers.length) continue
    assert(
      specifiers.every((value) => value === specifiers[0]),
      `${manifest.name}: conflicting provider declarations`,
    )
    try {
      const require = createRequire(path.join(directory, 'package.json'))
      const provider = await installedPackage(dependency, require)
      const providerRequire = createRequire(provider.manifestPath)
      const peers = provider.manifest.peerDependencies ?? {}
      const runtimes = {}
      for (const name of ['solid-js', '@solidjs/web']) {
        if (name !== 'solid-js' && !peers[name]) continue
        const runtime = await installedPackage(name, require)
        const providerRuntime = await installedPackage(name, providerRequire)
        runtimes[name] = {
          version: runtime.manifest.version,
          root: runtime.root,
          providerRoot: providerRuntime.root,
        }
      }
      packages.push({
        name: manifest.name,
        specifier: specifiers[0],
        provider: { version: provider.manifest.version, peers },
        runtimes,
      })
    } catch (error) {
      throw new Error(
        `${manifest.name}: installed testing-library compatibility could not be verified`,
        { cause: error },
      )
    }
  }
  return packages
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const semver = (await import('semver')).default
  const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  const count = checkCompatibility(await readInstalledProviders(repo), semver)
  console.log(
    `Verified ${count} installed Solid testing-library providers against tested engines, peer ranges, runtime identities and cohort specifiers`,
  )
}
