#!/usr/bin/env node
/**
 * Does every entry this package DECLARES actually exist on disk?
 *
 *   node scripts/verify-entry-artifacts.mjs              # 当前仓库
 *   node scripts/verify-entry-artifacts.mjs <目录>        # 已安装的副本（含软链）
 *
 * WHY THIS EXISTS. `lib/` is a build product and is gitignored, so a source
 * checkout has no entry until something builds it. `dsh plugin add <dir>`
 * installs it as a `link:`, and a link install runs NO lifecycle scripts — so
 * `pnpm install` never ran, `prepare` never ran, and DSH answers the install
 * with:
 *
 *   声明的入口产物缺失(源码检出或构建被拦),下次启动会失败
 *   the declared entry artifact is missing (source-only checkout or blocked
 *   build) — the next boot would fail
 *
 * That verdict comes from `dshmarket`'s `entryArtifactExists()`, which reads
 * `main` plus every string under `exports` and asks `existsSync`. This script
 * is the same predicate, printed with the file names, so the failure can be
 * read here instead of decoded from a one-line warning.
 *
 * It is also wired into `build` (`tsdown && node scripts/…`): if someone points
 * `main` at a path tsdown does not emit, the build fails instead of shipping a
 * package that only fails at boot.
 *
 * Read-only. No network, no writes.
 */

import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const target = resolve(process.argv[2] ?? process.cwd())

/** Read the manifest, or explain why we cannot and exit. */
function readManifest() {
  const path = join(target, 'package.json')
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    console.error(`Cannot read ${path}: ${error instanceof Error ? error.message : String(error)}`)
    process.exit(2)
  }
}

/**
 * Every path the runtime or the installer will open by name.
 *
 * `exports` keys that contain `*` are subpath PATTERNS (`./locale/*.json`),
 * not single artifacts: they name a family, and `existsSync` cannot answer for
 * a family. Skipping them is deliberate — inventing a representative member
 * would report a file the manifest never names.
 */
function declaredEntries(manifest) {
  const found = []
  const add = (label, value) => {
    if (typeof value !== 'string') return
    // `./lib/index.js` and `lib/index.js` are the same file. Normalising here
    // is what lets the de-dupe below collapse `main` + `exports['.'].default`
    // into one line — otherwise a package reads as two artifacts where there
    // is one, and the summary over-counts exactly the healthiest packages.
    const rel = value.trim().replace(/^\.\//, '')
    if (rel === '' || rel.includes('*')) return
    found.push({ label, rel })
  }

  add('main', manifest.main)
  add('types', manifest.types)

  if (typeof manifest.bin === 'string') {
    add('bin', manifest.bin)
  } else if (manifest.bin !== null && typeof manifest.bin === 'object') {
    for (const [name, value] of Object.entries(manifest.bin)) add(`bin[${name}]`, value)
  }

  const { exports } = manifest
  if (typeof exports === 'string') {
    add('exports', exports)
  } else if (exports !== null && typeof exports === 'object') {
    for (const [subpath, value] of Object.entries(exports)) {
      if (typeof value === 'string') {
        add(`exports[${subpath}]`, value)
      } else if (value !== null && typeof value === 'object') {
        for (const [condition, path] of Object.entries(value)) {
          add(`exports[${subpath}].${condition}`, path)
        }
      }
    }
  }

  // The boot reads this file before it reads any of the above, so a missing
  // patch is the same class of failure with a worse symptom (nothing loads).
  add('dsh.bundle.patch', manifest.dsh?.bundle?.patch)

  // One artifact can be declared three ways (`main` + `exports['.'].default`
  // + `types` pointing at the same file). Report it once, keep the first label.
  const seen = new Set()
  return found.filter(({ rel }) => {
    if (seen.has(rel)) return false
    seen.add(rel)
    return true
  })
}

const manifest = readManifest()
const entries = declaredEntries(manifest)
if (entries.length === 0) {
  // A manifest with no entry at all is a different defect, not a pass.
  console.error(`${manifest.name ?? '(unnamed)'} declares no entry artifact at all`)
  process.exit(2)
}

const missing = []
console.log(`Entry artifacts of ${manifest.name ?? '(unnamed)'}@${manifest.version ?? '?'}`)
console.log(`  ${target}`)
console.log('')

for (const { label, rel } of entries) {
  const present = existsSync(join(target, rel))
  if (!present) missing.push({ label, rel })
  console.log(`  ${present ? 'ok     ' : 'MISSING'} ${rel.padEnd(28)} ${label}`)
}

console.log('')
if (missing.length === 0) {
  console.log(`${entries.length} declared artifact(s) present.`)
  process.exit(0)
}

console.log(`${missing.length} of ${entries.length} declared artifact(s) are missing:`)
for (const { label, rel } of missing) console.log(`  - ${rel}  (${label})`)
console.log('')

// The advice has to match the cause. A checkout with no `lib/` at all was
// never built; one with `lib/` but a missing file means the manifest and the
// build disagree, and rebuilding will not help.
if (!existsSync(join(target, 'lib'))) {
  console.log('This looks like a source checkout that was never built.')
  console.log('  pnpm install          # `prepare` builds once (`lib/` is gitignored)')
  console.log('  pnpm run build        # …or just build')
  console.log('`link:` installs run no lifecycle scripts, so DSH reads this directory as-is;')
  console.log('build it, then restart DSH Desktop.')
} else {
  console.log('`lib/` exists, so this is a manifest/build disagreement: the package declares')
  console.log('a path tsdown does not emit. Fix package.json or the build, not the install.')
}
process.exit(1)
