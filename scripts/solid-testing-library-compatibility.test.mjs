import assert from 'node:assert/strict'
import semver from 'semver'
import test from 'node:test'
import { checkCompatibility } from './solid-testing-library-compatibility.mjs'

function provider(engine = 2, name = `solid-${engine}`, specifier) {
  const version = engine === 1 ? '0.8.10' : '1.0.0-beta.3'
  const runtimes = {
    'solid-js': {
      version: engine === 1 ? '1.9.7' : '2.0.0-rc.15',
      root: `/solid-${engine}`,
      providerRoot: `/solid-${engine}`,
    },
  }
  const peers = { 'solid-js': engine === 1 ? '>=1.0.0' : '>=2.0.0-0' }
  if (engine === 2) {
    peers['@solidjs/web'] = '>=2.0.0-0'
    runtimes['@solidjs/web'] = {
      version: '2.0.0-rc.15',
      root: '/web-2',
      providerRoot: '/web-2',
    }
  }
  return {
    name,
    specifier: specifier ?? (engine === 1 ? '^0.8.10' : version),
    provider: { version, peers },
    runtimes,
  }
}

test('accepts tested Solid 1 and Solid 2 providers with separate cohort specifiers', () => {
  assert.equal(
    checkCompatibility(
      [provider(1), provider(2), provider(2, 'second')],
      semver,
    ),
    3,
  )
})
test('rejects the old provider on V2 even when its broad peer range accepts V2', () => {
  const pkg = provider()
  pkg.provider = provider(1).provider
  assert(
    semver.satisfies(
      pkg.runtimes['solid-js'].version,
      pkg.provider.peers['solid-js'],
      { includePrerelease: true },
    ),
  )
  assert.throws(
    () => checkCompatibility([pkg], semver),
    /requires tested.*1\.0\.0-beta\.3/,
  )
})
test('rejects the V2 provider on the legacy engine', () => {
  const pkg = provider(1)
  pkg.provider = provider().provider
  assert.throws(
    () => checkCompatibility([pkg], semver),
    /requires tested.*0\.8\.10/,
  )
})
test('rejects manifest drift within an actual Solid major cohort', () => {
  assert.throws(
    () =>
      checkCompatibility(
        [provider(), provider(2, 'second', '^1.0.0-beta.3')],
        semver,
      ),
    /provider specifier.*differs/,
  )
})
test('rejects incompatible actual Web peers', () => {
  const pkg = provider()
  pkg.runtimes['@solidjs/web'].version = '1.9.7'
  assert.throws(
    () => checkCompatibility([pkg], semver),
    /@solidjs\/web@1\.9\.7 does not satisfy/,
  )
})
test('rejects missing required Web runtimes', () => {
  const pkg = provider()
  delete pkg.runtimes['@solidjs/web']
  assert.throws(
    () => checkCompatibility([pkg], semver),
    /required provider peer @solidjs\/web/,
  )
})
test('rejects a provider using a second runtime instance', () => {
  const pkg = provider()
  pkg.runtimes['solid-js'].providerRoot = '/other-solid-2'
  assert.throws(
    () => checkCompatibility([pkg], semver),
    /different solid-js instance/,
  )
})
test('fails closed for an untested provider upgrade', () => {
  const pkg = provider()
  pkg.provider.version = '1.0.0-beta.4'
  assert.throws(() => checkCompatibility([pkg], semver), /requires tested/)
})

test('rejects a stale installed provider outside its manifest declaration', () => {
  const pkg = provider(2, 'stale', '1.0.0-beta.4')
  assert.throws(
    () => checkCompatibility([pkg], semver),
    /does not satisfy its manifest/,
  )
})

test('fails closed when no provider owners were checked', () => {
  assert.throws(
    () => checkCompatibility([], semver),
    /No declared testing-library owners/,
  )
})
