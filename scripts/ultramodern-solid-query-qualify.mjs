import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
  copyFile,
} from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const output = path.resolve(process.argv[2] ?? '')
assert(process.argv.length === 3, 'Provide a fresh artifact output directory')
assert(output !== repo && !repo.startsWith(`${output}${path.sep}`))
const work = await mkdtemp(path.join(os.tmpdir(), 'solid-query-qualification-'))
let child
let interrupted = false
const groups = []
const stop = () => {
  interrupted = true
  if (child?.pid) {
    try {
      process.kill(-child.pid, 'SIGTERM')
    } catch (error) {
      if (error.code !== 'ESRCH') throw error
    }
  }
}
process.once('SIGINT', stop)
process.once('SIGTERM', stop)
async function run(command, args, cwd = repo) {
  assert(!interrupted, 'Qualification interrupted')
  await new Promise((resolve, reject) => {
    const env = { ...process.env }
    if (
      args.includes('exec') &&
      args.some((arg) => arg.startsWith('--projects='))
    ) {
      delete env.npm_lifecycle_event
    }
    child = spawn(command, args, {
      cwd,
      stdio: 'inherit',
      detached: true,
      env: {
        ...env,
        PATH:
          cwd === repo
            ? [
                path.join(repo, 'packages/solid-query/node_modules/.bin'),
                path.join(repo, 'node_modules/.bin'),
                env.PATH,
              ]
                .filter(Boolean)
                .join(path.delimiter)
            : env.PATH,
        pnpm_config_verify_deps_before_run: 'error',
        NX_DAEMON: 'false',
        NX_NO_CLOUD: 'true',
        NX_CACHE_DIRECTORY: path.join(work, 'nx-cache'),
        NX_WORKSPACE_DATA_DIRECTORY: path.join(work, 'nx-workspace-data'),
      },
    })
    if (child.pid) groups.push(child.pid)
    child.once('error', reject)
    child.once('close', (code, signal) => {
      child = undefined
      if (code === 0 && !interrupted) resolve()
      else reject(new Error(`${command} failed: ${signal ?? code}`))
    })
  })
}
try {
  const pnpm = process.env.PNPM_BIN ?? 'pnpm'
  // Source installs use the committed strict workspace configuration so their
  // frozen lockfile is identical in normal PR CI and this qualification.
  const sourceConfig = [
    '--workspace-packages=packages/solid-query',
    '--workspace-packages=packages/query-test-utils',
    '--workspace-packages=packages/query-core',
    '--workspace-packages=packages/query-devtools',
    '--workspace-packages=packages/query-persist-client-core',
    '--workspace-packages=packages/solid-query-devtools',
    '--workspace-packages=packages/solid-query-persist-client',
    `--config.virtualStoreDir=${path.join(repo, 'node_modules/.pnpm')}`,
  ]
  await run(pnpm, [
    ...sourceConfig,
    '--strict-peer-dependencies',
    '--filter',
    '.',
    '--filter',
    '@tanstack/solid-query...',
    '--filter',
    '@tanstack/solid-query-devtools...',
    '--filter',
    '@tanstack/solid-query-persist-client...',
    'install',
    '--frozen-lockfile',
  ])
  await run('git', [
    'diff',
    '--exit-code',
    '--',
    'package.json',
    ...[
      'solid-query',
      'query-devtools',
      'query-persist-client-core',
      'solid-query-devtools',
      'solid-query-persist-client',
    ].map((name) => `packages/${name}/package.json`),
    'pnpm-workspace.yaml',
    'pnpm-lock.yaml',
  ])
  // nx exec keeps project discovery and package cwd while invoking the verified
  // installed tool directly. Package-script execution would ask pnpm to install
  // unrelated workspace projects during its implicit verification step.
  async function nxExec(project, binary, ...args) {
    await run(process.execPath, [
      path.join(repo, 'node_modules/nx/bin/nx.js'),
      'exec',
      `--projects=${project}`,
      '--',
      process.execPath,
      path.join(repo, 'scripts/ultramodern-solid-query-check.mjs'),
      binary,
      ...args,
    ])
  }
  await nxExec('@tanstack/solid-query', 'vitest/vitest.mjs', 'run', '--retry=3')
  await nxExec(
    '@tanstack/solid-query',
    'eslint/bin/eslint.js',
    '--concurrency=auto',
    './src',
  )
  await nxExec(
    '@tanstack/solid-query',
    'tsup/dist/cli-default.js',
    '--tsconfig',
    'tsconfig.prod.json',
  )
  for (const version of ['54', '55', '56', '57', '58', '59']) {
    await nxExec(
      '@tanstack/solid-query',
      `typescript${version}/lib/tsc.js`,
      '--build',
      'tsconfig.legacy.json',
    )
  }
  await nxExec('@tanstack/solid-query', 'typescript/bin/tsc', '--build')
  await nxExec(
    '@tanstack/solid-query',
    'typescript60/lib/tsc.js',
    '--build',
    'tsconfig.legacy.json',
  )
  await nxExec('@tanstack/solid-query', 'publint/src/cli.js', '--strict')
  await nxExec(
    '@tanstack/solid-query',
    '@arethetypeswrong/cli/dist/index.js',
    '--pack',
  )
  // Build providers in dependency order, retaining pnpm's injection-sync lifecycle.
  // Filtered run discovers the same selected workspace as install. Nonrecursive
  // run instead rereads every workspace from YAML during dependency verification.
  // Use Nx's root context: exec on each provider would also invoke this command
  // for its dependency projects, duplicating builds (including private utilities).
  const providerPackages = [
    'query-devtools',
    'query-persist-client-core',
    'solid-query-devtools',
    'solid-query-persist-client',
  ]
  for (const name of ['query-core', ...providerPackages]) {
    await run(process.execPath, [
      path.join(repo, 'node_modules/nx/bin/nx.js'),
      'exec',
      '--projects=root',
      '--',
      pnpm,
      ...sourceConfig,
      `--filter=@tanstack/${name}`,
      'run',
      'build',
    ])
  }
  const packed = new Map()
  for (const name of ['solid-query', ...providerPackages]) {
    const destination = path.join(work, 'packs', name)
    await mkdir(destination, { recursive: true })
    await run(pnpm, [
      ...sourceConfig,
      '--dir',
      `packages/${name}`,
      'pack',
      '--pack-destination',
      destination,
    ])
    const archives = (await readdir(destination)).filter((name) =>
      name.endsWith('.tgz'),
    )
    assert.equal(archives.length, 1, `Expected one packed ${name} archive`)
    packed.set(`@tanstack/${name}`, path.join(destination, archives[0]))
  }
  const archive = packed.get('@tanstack/solid-query')
  const consumer = path.join(work, 'consumer')
  await mkdir(consumer)
  await writeFile(
    path.join(consumer, 'package.json'),
    JSON.stringify(
      {
        private: true,
        type: 'module',
        dependencies: {
          ...Object.fromEntries(
            [...packed].map(([name, archive]) => [name, `file:${archive}`]),
          ),
          '@tanstack/query-core': '5.102.0',
          '@tanstack/router-core': '1.171.37',
          '@tanstack/router-ssr-query-core': '1.169.3',
          'solid-js': '2.0.0-rc.15',
          '@solidjs/web': '2.0.0-rc.15',
          '@solidjs/signals': '2.0.0-rc.15',
          typescript: '6.0.3',
          esbuild: '0.27.7',
          jsdom: '25.0.1',
        },
      },
      null,
      2,
    ),
  )
  await writeFile(
    path.join(consumer, 'pnpm-workspace.yaml'),
    // pnpm 11 reads overrides from workspace YAML, not package.json. Keep the
    // workspace-rewritten provider ranges on the exact tarballs under test.
    'packages: []\nminimumReleaseAge: 1440\nminimumReleaseAgeExclude: []\nstrictPeerDependencies: true\nautoInstallPeers: false\npackageImportMethod: clone-or-copy\nallowBuilds:\n  esbuild: true\noverrides:\n' +
      ['@tanstack/query-devtools', '@tanstack/query-persist-client-core']
        .map(
          (name) =>
            `  ${JSON.stringify(name)}: ${JSON.stringify(`file:${packed.get(name)}`)}\n`,
        )
        .join(''),
  )
  await writeFile(
    path.join(consumer, 'tsconfig.json'),
    JSON.stringify(
      {
        compilerOptions: {
          target: 'ES2022',
          module: 'NodeNext',
          moduleResolution: 'NodeNext',
          strict: true,
          noEmit: true,
          skipLibCheck: false,
          lib: ['ES2022', 'DOM', 'DOM.Iterable'],
        },
        include: ['contract.ts'],
      },
      null,
      2,
    ),
  )
  await writeFile(
    path.join(consumer, 'query-options.ts'),
    `import { infiniteQueryOptions, queryOptions } from '@tanstack/solid-query'
export const postOptions = (id: string) => queryOptions({
  queryKey: ['post', id] as const,
  queryFn: async () => ({ title: 'Post', body: 'Body' }),
})
export const postsOptions = queryOptions({
  queryKey: ['posts'] as const,
  queryFn: async () => [{ title: 'Post', body: 'Body' }],
  initialData: [{ title: 'Initial', body: 'Initial body' }],
})
export const infinitePostsOptions = infiniteQueryOptions({
  queryKey: ['infinite-posts'] as const,
  queryFn: async ({ pageParam }) => [{ title: 'Post', body: 'Body', page: pageParam }],
  initialPageParam: 0,
  getNextPageParam: () => undefined,
})
export const definedInfinitePostsOptions = infiniteQueryOptions({
  queryKey: ['defined-infinite-posts'] as const,
  queryFn: async () => [{ title: 'Post', body: 'Body' }],
  initialPageParam: 0,
  getNextPageParam: () => undefined,
  initialData: { pages: [[{ title: 'Initial', body: 'Initial body' }]], pageParams: [0] },
})
export class PostError extends Error { readonly postCode = 'post' }
export const customErrorOptions = queryOptions<{ title: string }, PostError>({
  queryKey: ['post-error'],
  queryFn: async () => ({ title: 'Post' }),
})
`,
  )
  await writeFile(
    path.join(consumer, 'tsconfig.declarations.json'),
    JSON.stringify(
      {
        extends: './tsconfig.json',
        compilerOptions: {
          noEmit: false,
          declaration: true,
          emitDeclarationOnly: true,
          outDir: './emitted',
        },
        include: ['query-options.ts'],
      },
      null,
      2,
    ),
  )
  await writeFile(
    path.join(consumer, 'contract.ts'),
    `import { QueryClient, useQuery, useInfiniteQuery, type QueryClientProviderProps } from '@tanstack/solid-query'
import { onlineManager, type QueryClient as CoreClient } from '@tanstack/query-core'
import type { TanstackQueryDevtoolsConfig } from '@tanstack/query-devtools'
import { SolidQueryDevtools } from '@tanstack/solid-query-devtools'
import type { PersistQueryClientOptions as SharedPersistenceOptions } from '@tanstack/query-persist-client-core'
import type { PersistQueryClientOptions, PersistQueryClientProviderProps, Persister } from '@tanstack/solid-query-persist-client'
import type { AnyRouter } from '@tanstack/router-core'
import { setupCoreRouterSsrQueryIntegration } from '@tanstack/router-ssr-query-core'
import { postOptions, postsOptions, infinitePostsOptions, definedInfinitePostsOptions, customErrorOptions, type PostError } from './emitted/query-options.js'
const client = new QueryClient()
const post = client.getQueryData(postOptions('post').queryKey)
export const title: string | undefined = post?.title
export const body: string | undefined = post?.body
const posts = client.getQueryData(postsOptions.queryKey)
export const postList: Array<{ title: string; body: string }> = [...(posts ?? [])]
const infinitePosts = client.getQueryData(infinitePostsOptions.queryKey)
export const infinitePostList: Array<{ title: string; body: string }> = infinitePosts?.pages.flat() ?? []
const definedInfinitePosts = client.getQueryData(definedInfinitePostsOptions.queryKey)
export const definedInfinitePostList: Array<{ title: string; body: string }> = definedInfinitePosts?.pages.flat() ?? []
export const postError: PostError | null | undefined = client.getQueryState(customErrorOptions.queryKey)?.error
export const coreClient: CoreClient = client
export const provider: QueryClientProviderProps = { client }
export const devtools: Parameters<typeof SolidQueryDevtools>[0] = { client }
export const sharedDevtools: TanstackQueryDevtoolsConfig = { client, onlineManager, queryFlavor: 'Solid Query', version: '6' }
const persister: Persister = { persistClient() {}, restoreClient() { return undefined }, removeClient() {} }
export const persistence: PersistQueryClientOptions = { queryClient: client, persister }
export const sharedPersistence: SharedPersistenceOptions = persistence
export const solidPersistence: PersistQueryClientOptions = sharedPersistence
export const persistenceProvider: PersistQueryClientProviderProps = { client, persistOptions: { persister } }
export const fetchedPost: Promise<{ title: string; body: string }> = client.query(postOptions('post'))
export function checkHooks() {
  const post: { title: string; body: string } = useQuery(() => postOptions('post')).data
  const posts: Array<{ title: string; body: string }> = useQuery(() => postsOptions).data
  const pages: Array<Array<{ title: string; body: string; page: number }>> = useInfiniteQuery(() => infinitePostsOptions).data.pages
  const definedPages: Array<Array<{ title: string; body: string }>> = useInfiniteQuery(() => definedInfinitePostsOptions).data.pages
  const error: PostError | null = useQuery(() => customErrorOptions).error
  return { post, posts, pages, definedPages, error }
}
export function integrate(router: AnyRouter) {
  setupCoreRouterSsrQueryIntegration({ router, queryClient: client })
}
`,
  )
  await writeFile(
    path.join(consumer, 'identity.mjs'),
    `import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { realpathSync } from 'node:fs'
import { QueryClient, queryOptions, infiniteQueryOptions } from '@tanstack/solid-query'
import { QueryClient as CoreClient, QueryCache, dehydrateQuery } from '@tanstack/query-core'
import { persistQueryClientSave, persistQueryClientRestore } from '@tanstack/solid-query-persist-client'
import { persistQueryClientSave as sharedSave, persistQueryClientRestore as sharedRestore } from '@tanstack/query-persist-client-core'
const require = createRequire(import.meta.url)
const adapterRequire = createRequire(require.resolve('@tanstack/solid-query'))
const corePath = realpathSync(require.resolve('@tanstack/query-core'))
assert.equal(corePath, realpathSync(adapterRequire.resolve('@tanstack/query-core')))
for (const name of ['@tanstack/query-devtools', '@tanstack/query-persist-client-core', '@tanstack/solid-query-devtools', '@tanstack/solid-query-persist-client']) {
  const providerRequire = createRequire(require.resolve(name))
  assert.equal(realpathSync(providerRequire.resolve('@tanstack/query-core')), corePath, name + ' must use the caller Core')
}
for (const [wrapper, provider] of [['@tanstack/solid-query-devtools', '@tanstack/query-devtools'], ['@tanstack/solid-query-persist-client', '@tanstack/query-persist-client-core']]) {
  const wrapperRequire = createRequire(require.resolve(wrapper))
  assert.equal(realpathSync(wrapperRequire.resolve(provider)), realpathSync(require.resolve(provider)), wrapper + ' must use the packed provider')
}
assert.equal(persistQueryClientSave, sharedSave)
assert.equal(persistQueryClientRestore, sharedRestore)
const cache = new QueryCache()
const client = new QueryClient({ queryCache: cache })
try {
  assert(client instanceof CoreClient)
  assert.equal(client.getQueryCache(), cache)
  const options = queryOptions({ queryKey: ['packed', 'query'], queryFn: async () => ({ value: 5 }), select: value => value.value.toString() })
  assert.equal(await client.query(options), '5')
  const query = cache.find({ queryKey: options.queryKey })
  assert(query)
  assert.deepEqual(dehydrateQuery(query).state.data, { value: 5 })
  const pages = await client.infiniteQuery(infiniteQueryOptions({ queryKey: ['packed', 'infinite'], queryFn: async ({ pageParam }) => ({ page: pageParam }), initialPageParam: 0, getNextPageParam: () => undefined }))
  assert.deepEqual(pages, { pages: [{ page: 0 }], pageParams: [0] })
  const cjs = require('@tanstack/solid-query')
  assert(new cjs.QueryClient() instanceof require('@tanstack/query-core').QueryClient)
  let saved
  let saves = 0
  const persister = {
    persistClient(snapshot) { saved = structuredClone(snapshot); saves++ },
    restoreClient() { return saved },
    removeClient() { saved = undefined },
  }
  client.setQueryData(['packed', 'persisted'], { value: 'caller cache' })
  await persistQueryClientSave({ queryClient: client, persister, buster: 'packed-providers' })
  assert.equal(saves, 1)
  assert(saved.clientState.queries.some(query => query.queryKey.join('/') === 'packed/persisted'))
  client.clear()
  assert.equal(cache.getAll().length, 0)
  await persistQueryClientRestore({ queryClient: client, persister, buster: 'packed-providers' })
  assert.equal(client.getQueryCache(), cache, 'Restore must retain the caller cache')
  assert.deepEqual(client.getQueryData(['packed', 'persisted']), { value: 'caller cache' })
  const restored = cache.find({ queryKey: ['packed', 'persisted'] })
  assert(restored)
  assert(cache.getAll().includes(restored))
  console.log('Packed providers retain one physical caller Core and save/restore its actual cache')
  console.log('Packed Query ESM/CJS shared Core identity, query, infiniteQuery and dehydrateQuery accepted')
} finally { client.clear() }
`,
  )
  await writeFile(
    path.join(consumer, 'browser.entry.js'),
    `import { createComponent, flush } from 'solid-js'
import { render } from '@solidjs/web'
import { QueryClient, QueryClientProvider, useQueryClient, useQuery, useInfiniteQuery } from '@tanstack/solid-query'
import { QueryClient as CoreClient, QueryCache } from '@tanstack/query-core'
function check(value, message) { if (!value) throw new Error(message) }
export async function verify() {
  const cache = new QueryCache()
  const client = new QueryClient({ queryCache: cache })
  client.setQueryData(['packed', 'live'], 'before')
  client.setQueryData(['packed', 'pages'], { pages: ['first'], pageParams: [0] })
  let query, pages, provided
  function Probe() {
    provided = useQueryClient()
    query = useQuery(() => ({ queryKey: ['packed', 'live'], queryFn: async () => 'unused', staleTime: Infinity }))
    pages = useInfiniteQuery(() => ({ queryKey: ['packed', 'pages'], queryFn: async () => 'unused', initialPageParam: 0, getNextPageParam: () => undefined, staleTime: Infinity }))
    return document.createTextNode(query.data + ':' + pages.data.pages[0])
  }
  const target = document.createElement('div')
  document.body.append(target)
  const dispose = render(() => createComponent(QueryClientProvider, { client, get children() { return createComponent(Probe, {}) } }), target)
  try {
    flush()
    check(provided === client && provided instanceof CoreClient, 'Provider did not retain the shared Core client')
    check(client.getQueryCache() === cache, 'Provider replaced the shared cache')
    check(target.textContent === 'before:first', 'Native provider hooks did not render cache values')
    client.setQueryData(['packed', 'live'], 'after')
    client.setQueryData(['packed', 'pages'], { pages: ['next'], pageParams: [0] })
    await Promise.resolve()
    await new Promise(resolve => setTimeout(resolve, 0))
    flush()
    check(query.data === 'after' && pages.data.pages[0] === 'next', 'Hook reads did not follow the shared cache')
  } finally { dispose(); client.clear(); target.remove() }
}
`,
  )
  await writeFile(
    path.join(consumer, 'browser.mjs'),
    `import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { JSDOM, VirtualConsole } from 'jsdom'
for (const development of [false, true]) {
  const result = await build({ entryPoints: ['browser.entry.js'], bundle: true, write: false, format: 'iife', globalName: 'QueryAcceptance', platform: 'browser', conditions: development ? ['development'] : [], define: { 'process.env.NODE_ENV': JSON.stringify(development ? 'development' : 'production') } })
  const errors = []
  const virtualConsole = new VirtualConsole()
  virtualConsole.on('jsdomError', error => errors.push(error))
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { runScripts: 'dangerously', url: 'http://localhost/', virtualConsole })
  try {
    const script = dom.window.document.createElement('script')
    script.textContent = result.outputFiles[0].text
    dom.window.document.head.append(script)
    assert.deepEqual(errors, [], 'Packed Query entry emitted browser errors')
    assert.equal(typeof dom.window.QueryAcceptance?.verify, 'function')
    await dom.window.QueryAcceptance.verify()
    assert.deepEqual(errors, [], 'Packed Query provider emitted browser errors')
  } finally { dom.window.close() }
}
console.log('Packed Query production/development native Provider, hooks and shared cache accepted')
`,
  )
  const consumerHook = path.join(work, 'consumer-strict-config.cjs')
  await writeFile(
    consumerHook,
    `module.exports = { hooks: { updateConfig(config) {
    return { ...config, minimumReleaseAge: 1440, minimumReleaseAgeExclude: [], packageImportMethod: 'clone-or-copy', strictPeerDependencies: true, autoInstallPeers: false, allowBuilds: { esbuild: true } }
  } } }\n`,
  )
  // This consumer's packages: [] workspace owns its tarball overrides. Keep it
  // enabled and isolate its virtual store from any inherited source-build config.
  await run(
    pnpm,
    [
      `--config.pnpmfile=${consumerHook}`,
      '--config.strictPeerDependencies=true',
      '--config.autoInstallPeers=false',
      '--config.packageImportMethod=clone-or-copy',
      `--config.virtualStoreDir=${path.join(consumer, 'node_modules/.pnpm')}`,
      'install',
      '--no-frozen-lockfile',
    ],
    consumer,
  )
  // Emit a producer's inferred public types, then check a separate consumer of
  // only those declarations. Source-only checks miss unnamed unique-symbol tags.
  await run(
    process.execPath,
    ['node_modules/typescript/bin/tsc', '-p', 'tsconfig.declarations.json'],
    consumer,
  )
  await run(
    process.execPath,
    ['node_modules/typescript/bin/tsc', '-p', 'tsconfig.json'],
    consumer,
  )
  await run(process.execPath, ['identity.mjs'], consumer)
  await run(process.execPath, ['browser.mjs'], consumer)
  const sha512 = createHash('sha512')
    .update(await readFile(archive))
    .digest('base64')
  const providerProofs = await Promise.all(
    providerPackages.map(async (name) => ({
      package: `@tanstack/${name}`,
      packageVersion: JSON.parse(
        await readFile(
          path.join(repo, 'packages', name, 'package.json'),
          'utf8',
        ),
      ).version,
      integrity: `sha512-${createHash('sha512')
        .update(await readFile(packed.get(`@tanstack/${name}`)))
        .digest('base64')}`,
    })),
  )
  const source = process.env.GITHUB_SHA
  assert(
    source && /^[a-f0-9]{40}$/.test(source),
    'GITHUB_SHA must identify qualified source',
  )
  await mkdir(output)
  const filename = `tanstack-solid-query-${source.slice(0, 12)}.tgz`
  await copyFile(archive, path.join(output, filename))
  await writeFile(
    path.join(output, 'acceptance.json'),
    JSON.stringify(
      {
        schema: 1,
        repository: process.env.GITHUB_REPOSITORY,
        source,
        runId: process.env.GITHUB_RUN_ID,
        runAttempt: process.env.GITHUB_RUN_ATTEMPT,
        package: '@tanstack/solid-query',
        packageVersion: JSON.parse(
          await readFile(
            path.join(repo, 'packages/solid-query/package.json'),
            'utf8',
          ),
        ).version,
        archive: filename,
        integrity: `sha512-${sha512}`,
        solid: '2.0.0-rc.15',
        queryCore: '5.102.0',
        providerProofs,
        checks: [
          'source unit and type tests',
          'lint',
          'build',
          'type matrix',
          'package exports',
          'strict packed consumer',
          'inferred helper declaration roundtrip and hook types',
          'public Provider and SSR types',
          'shared ESM/CJS Core identity, query, infiniteQuery and dehydration',
          'production/development native Provider, hooks and cache',
          'five packed archives with strict explicit peers and caller-owned provider Core',
          'provider public DTS share caller QueryClient and persistence saves/restores its cache',
        ],
      },
      null,
      2,
    ) + '\n',
  )
} finally {
  process.removeListener('SIGINT', stop)
  process.removeListener('SIGTERM', stop)
  const live = groups.filter((pid) => {
    try {
      process.kill(-pid, 0)
      return true
    } catch (error) {
      if (error.code === 'ESRCH') return false
      throw error
    }
  })
  if (live.length)
    console.error(
      `Retained ${work}: process groups ${live.join(', ')} remain live`,
    )
  else await rm(work, { recursive: true, force: true })
}
