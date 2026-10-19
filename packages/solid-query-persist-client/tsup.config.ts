import { parse } from 'path'
import { readFile } from 'fs/promises'
import { createRequire } from 'node:module'
import { transformAsync } from '@babel/core'
import { defineConfig } from 'tsup'
import type { Plugin } from 'esbuild'
import type { Options } from 'tsup'

const require = createRequire(import.meta.url)
const typescriptPreset = require.resolve('@babel/preset-typescript')
const solidPlugin = require.resolve('@solidjs/babel-plugin')

function solidV2Plugin(): Plugin {
  return {
    name: 'esbuild:solid-v2',
    setup(build) {
      build.onLoad({ filter: /\.(t|j)sx$/ }, async (args) => {
        const source = await readFile(args.path, { encoding: 'utf-8' })
        const { name, ext } = parse(args.path)
        const result = await transformAsync(source, {
          presets: [[typescriptPreset, {}]],
          plugins: [[solidPlugin, { generate: 'dom' }]],
          filename: name + ext,
          sourceMaps: 'inline',
        })
        if (result?.code === undefined || result.code === null) {
          throw new Error('No result was provided from Babel')
        }
        return { contents: result.code, loader: 'js' }
      })
    },
  }
}

export default defineConfig(
  [false, true].flatMap((development) =>
    [false, true].map<Options>((preserveJsx) => ({
      target: 'esnext',
      platform: 'browser',
      format: preserveJsx ? 'esm' : ['esm', 'cjs'],
      clean: !development && !preserveJsx,
      entry: { [development ? 'dev' : 'index']: 'src/index.ts' },
      outDir: 'build',
      experimentalDts: !preserveJsx,
      treeshake: { preset: 'safest' },
      replaceNodeEnv: true,
      external: ['@tanstack/query-core', 'solid-js', '@solidjs/web'],
      outExtension({ format }) {
        return preserveJsx && format === 'esm' ? { js: '.jsx' } : {}
      },
      esbuildOptions(options) {
        const mode = development ? 'development' : 'production'
        options.define = {
          ...options.define,
          'process.env.NODE_ENV': JSON.stringify(mode),
          'process.env.PROD': String(!development),
          'process.env.DEV': String(development),
          'process.env.SSR': 'false',
          'import.meta.env.NODE_ENV': JSON.stringify(mode),
          'import.meta.env.PROD': String(!development),
          'import.meta.env.DEV': String(development),
          'import.meta.env.SSR': 'false',
        }
        options.jsx = 'preserve'
        options.chunkNames = '[name]/[hash]'
        if (development) options.conditions = ['development']
        else options.drop = ['console', 'debugger']
      },
      esbuildPlugins: preserveJsx ? [] : [solidV2Plugin()],
    })),
  ),
)
