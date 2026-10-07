import { readFileSync } from 'node:fs'
import type { UserConfig } from 'tsdown'

const PLUGIN_ID = 'dsh-connect-workbuddy'

/**
 * Read the npm version once so the build injects it into src/version.ts.
 * Inherited from `dsh-workbuddy-connect`, whose CLI reports the package
 * version from a build-time define rather than a runtime package.json read
 * (the published bundle ships only `lib/`).
 */
const PACKAGE_VERSION = JSON.parse(
  readFileSync(new URL('./package.json', import.meta.url), 'utf8'),
).version as string

const VERSION_DEFINE = { __DSH_WORKBUDDY_VERSION__: JSON.stringify(PACKAGE_VERSION) }

const CLIENT_EXTERNALS = [
  'react',
  'react/jsx-runtime',
  /**
   * `react-dom` MUST stay external. It is registered by the shell's module
   * loader (`staticModules`), so externalizing turns the import into a
   * `require` the page resolves. BUNDLING it inlines both the development and
   * production CJS builds, and every one of them opens with
   *   if (process.env.NODE_ENV !== "production") …
   * which throws `ReferenceError: process is not defined` in the browser — at
   * module-evaluation time, so the ENTIRE client half fails to import:
   * web boot: 1 entry did not activate
   * dsh-connect-workbuddy: import failed
   * That is exactly what shipped in the referring project (dsh-connect-trae
   * 2.12.0 / 2.13.0) once its credit panel needed `createPortal`. This plugin
   * now uses `createPortal` too, so the rule applies here verbatim;
   * `tests/client-runtime-imports.spec.ts` pins it.
   */
  'react-dom',
  /**
   * The subpath is externalized alongside the root for the same reason, and
   * because a future `createRoot`/portal helper would otherwise silently pull
   * the whole DOM renderer back into the bundle. The shell registers it.
   */
  'react-dom/client',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-locale/client',
  '@deepseek-ai/dsh-client-ui-settings-plugins/client',
  '@deepseek-ai/dsh-client-ui-primitives',
] as const

export default [
  {
    entry: {
      index: 'src/index.ts',
      bin: 'src/bin.ts',
    },
    outDir: 'lib',
    format: ['esm'],
    platform: 'node',
    target: 'es2024',
    fixedExtension: false,
    dts: true,
    clean: true,
    define: VERSION_DEFINE,
    deps: {
      neverBundle: [
        '@earendil-works/pi-ai',
        '@deepseek-ai/schemastery',
        '@deepseek-ai/cordis',
        '@deepseek-ai/dsh-atomic-write',
        '@deepseek-ai/dsh-attachment',
        '@deepseek-ai/dsh-home-paths',
        '@deepseek-ai/dsh-host-webserver',
        '@deepseek-ai/dsh-llm',
        '@deepseek-ai/dsh-llm-pi-ai',
        '@deepseek-ai/dsh-settings',
      ],
    },
  },
  {
    entry: { client: 'src/client/index.tsx' },
    outDir: 'lib',
    format: ['cjs'],
    platform: 'browser',
    dts: false,
    clean: false,
    define: VERSION_DEFINE,
    deps: { neverBundle: [...CLIENT_EXTERNALS] },
    outputOptions: {
      entryFileNames: 'client.js',
      banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(PLUGIN_ID)}, factory: (require) => {`,
      footer: 'return module.exports; } });',
      intro: 'var module = { exports: {} }; var exports = module.exports;',
    },
  },
] satisfies UserConfig[]
