/**
 * The card copy has FOUR homes, and the host reads three of them:
 *
 * 1. `locale/en.json` + `locale/zh.json` — what the DSH plugin manager shows on
 *    the Plugins page. `readPluginMeta()` (`@deepseek-ai/dsh-app-boot`) resolves
 *    `<pkg>/locale/en.json` through the Node resolver, then scans THAT file's
 *    directory for the other language files, and reads `meta.title` /
 *    `meta.description` out of each.
 * 2. `package.json` `description` — the English fallback used when the locale
 *    dictionary could not be read at all.
 * 3. `awesome-dsh-plugin-submission/<owner>__<repo>.yml` — the marketplace
 *    listing's own copy of the same sentence.
 *
 * None of the three fails loudly when it drifts. A missing locale resource is
 * swallowed by the host as "no localized metadata": the title then falls back to
 * the bare package name (`displayName` is never read) and the description to
 * `package.json`. A card can therefore read "dsh-connect-workbuddy" with a
 * Chinese description inside an English UI and still look like a working
 * plugin — which is exactly what this repository looked like before this
 * directory existed.
 *
 * The cases below pin the contract that makes the card correct:
 *
 *   1. `locale/en.json` is the ANCHOR. The host scans the directory of the
 *      resolved English file, so without it `zh.json` is never read at all.
 *   2. The exports wildcard `"./locale/*.json"` is what lets the host RESOLVE
 *      that file; without it the resolution throws
 *      `ERR_PACKAGE_PATH_NOT_EXPORTED`, which the host also swallows.
 *   3. `files` must carry the bare `locale` directory, or the published
 *      tarball ships the package without its own copy.
 *   4. The three copies of the sentence must say the same thing: the English
 *      fallback, the card dictionary and the marketplace draft.
 */
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const repoRoot = new URL('../', import.meta.url)

function read(relativePath: string): string {
  return readFileSync(fileURLToPath(new URL(relativePath, repoRoot)), 'utf8')
}

interface Manifest {
  name: string
  description?: string
  exports?: Record<string, unknown>
  files?: string[]
  repository?: { url?: string }
}

function manifest(): Manifest {
  return JSON.parse(read('package.json')) as Manifest
}

interface Meta {
  title?: string
  description?: string
}

/** The `meta` object of one locale file, as the host reads it. */
function metaOf(language: string): Meta {
  const parsed = JSON.parse(read(`locale/${language}.json`)) as { meta?: Meta }
  return parsed.meta ?? {}
}

/**
 * A locale file's name is its language id — the host takes the basename minus
 * `.json` and rejects anything that is not a language id.
 */
const LANGUAGE_ID = /^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/

/** Strips one layer of YAML quoting; a plain scalar is returned as it is. */
function unquote(value: string): string {
  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1).replaceAll("''", "'")
  }
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    return value.slice(1, -1).replaceAll('\\"', '"')
  }
  return value
}

/**
 * The two descriptions of the marketplace draft.
 *
 * Read line by line rather than with a YAML parser: the draft is a flat
 * top-level mapping plus a two-line `description` block, and the repository
 * deliberately carries no YAML dependency. A regex over the whole file would
 * also match the `en:`/`zh:` inside a quoted value.
 */
function draftDescriptions(text: string): { en?: string; zh?: string } {
  const result: { en?: string; zh?: string } = {}
  let insideDescription = false
  for (const raw of text.split('\n')) {
    if (raw.trim() === '') continue
    if (!/^\s/.test(raw)) {
      // A top-level key ends the description block.
      insideDescription = /^description:\s*$/.test(raw.trim())
      continue
    }
    if (!insideDescription) continue
    const match = /^\s+(en|zh):\s*(.*)$/.exec(raw)
    if (match === null) continue
    const [, language, value] = match
    if (language === undefined || value === undefined) continue
    result[language as 'en' | 'zh'] = unquote(value.trim())
  }
  return result
}

describe('locale metadata', () => {
  it('ships an English locale file, which is the anchor the host scans', () => {
    // The host resolves `<pkg>/locale/en.json` and then scans ITS directory.
    // Without this file there is no directory to scan, so `zh.json` would be
    // dead weight no matter how correct it is.
    expect(read('locale/en.json')).toBeTruthy()
    const files = readdirSync(fileURLToPath(new URL('locale', repoRoot)))
    expect(files).toContain('en.json')
  })

  it('gives every locale file a language id as its filename', () => {
    // The host throws on a file whose basename is not a language id, and that
    // error takes the whole card down — one stray `locale/notes.json` is
    // enough.
    const files = readdirSync(fileURLToPath(new URL('locale', repoRoot)))
    expect(files.length).toBeGreaterThan(0)
    for (const file of files) {
      expect(file.endsWith('.json')).toBe(true)
      const language = file.slice(0, -'.json'.length)
      expect(language).toMatch(LANGUAGE_ID)
    }
  })

  it('carries a non-empty title and description in every locale', () => {
    for (const language of ['en', 'zh']) {
      const meta = metaOf(language)
      expect(typeof meta.title).toBe('string')
      expect(meta.title?.trim()).not.toBe('')
      expect(typeof meta.description).toBe('string')
      expect(meta.description?.trim()).not.toBe('')
    }
  })

  it('shows the package name as the card title, in every language', () => {
    // The title is the PACKAGE NAME on purpose. `displayName` is not part of the
    // host's read chain (the fallback is `manifest.name`), so a localized title
    // can only ever REPLACE the name on the card — and the maintainer wants the
    // card to say `dsh-connect-workbuddy`, which is what the repository, the npm
    // page and every issue refer to.
    //
    // Written out in both files rather than omitted: an absent `meta.title` also
    // renders the package name (via `localizedText`'s `fallback`), so the pixels
    // would match either way — but then nothing in the file would record that
    // this was a decision, and the next "let's give it a nicer name" edit would
    // look like a free improvement instead of a reversal.
    const { name } = manifest()
    expect(metaOf('en').title).toBe(name)
    expect(metaOf('zh').title).toBe(name)
    // Same in both languages. A differing pair would mean one of them is
    // showing the other language's name.
    expect(metaOf('en').title).toBe(metaOf('zh').title)
  })

  it('keeps the Chinese copy Chinese and the English copy English', () => {
    const han = /\p{Script=Han}/u
    expect(han.test(metaOf('zh').description ?? '')).toBe(true)
    expect(han.test(metaOf('en').description ?? '')).toBe(false)
  })

  it('exports the locale directory so the host can resolve it', () => {
    // Without this wildcard the resolution throws
    // `ERR_PACKAGE_PATH_NOT_EXPORTED` — and the host treats that as "no
    // localized metadata", so the card silently stays untranslated.
    const { exports: exported } = manifest()
    expect(exported?.['./locale/*.json']).toBe('./locale/*.json')
  })

  it('publishes the locale directory with the package', () => {
    // The bare directory name, not a glob: `files` entries are read as paths,
    // and a pattern is not a path.
    const { files } = manifest()
    expect(files).toContain('locale')
  })

  it('keeps the package description Chinese, as the repository decided', () => {
    // `package.json.description` is read in TWO places, and this repository
    // wants different things from them:
    //
    //   - the npmjs.com package page, and the "About" line GitHub derives from
    //     it — both are seen by the Chinese audience this plugin is written for;
    //   - the host's LAST-resort fallback when `locale/en.json` could not be
    //     resolved at all (`localizedText` starts from `manifest.description`).
    //
    // The English copy lives in `locale/en.json`, which OVERRIDES the fallback
    // whenever it can be read (`{ en: fallback, ...entries }` spreads the
    // dictionary last). So an English UI reads English; Chinese is what a
    // broken install degrades to, and what the registry page shows.
    //
    // That is a deliberate split, not a drift: `8f3a96e` changed this field
    // FROM English TO Chinese to match the README's first line, and this test
    // exists so a future "make it English again" edit has to say so out loud.
    // Skipping the dictionary is a degraded path; it must not be the reason the
    // registry page turns English for a Chinese plugin.
    const { description } = manifest()
    expect(typeof description).toBe('string')
    if (typeof description !== 'string') throw new Error('package.json has no description')
    expect(description.length).toBeGreaterThan(0)
    // Chinese, and specifically NOT the English dictionary sentence.
    expect(description).toMatch(/[\u4e00-\u9fff]/u)
    expect(description).not.toBe(metaOf('en').description)
    // The two dictionaries still have to be distinct, non-empty and in their
    // own languages — that is the half of the old assertion worth keeping.
    expect(metaOf('en').description).not.toBe(metaOf('zh').description)
    expect(metaOf('en').description).not.toMatch(/[\u4e00-\u9fff]/u)
    expect(metaOf('zh').description).toMatch(/[\u4e00-\u9fff]/u)
  })

  it('keeps the marketplace draft and the card in step', () => {
    const { repository } = manifest()
    const url = (repository?.url ?? '').replace(/^git\+/, '').replace(/\.git$/, '')
    const slug = url.replace(/^https:\/\/github\.com\//, '')
    const draft = read(`awesome-dsh-plugin-submission/${slug.replace('/', '__')}.yml`)
    const descriptions = draftDescriptions(draft)
    expect(descriptions.en).toBe(metaOf('en').description)
    expect(descriptions.zh).toBe(metaOf('zh').description)
  })
})
