import { defineConfig } from 'vitest/config'

/**
 * Manual screenshot run: renders the settings SECTION with the REAL zh strings
 * into /tmp/wb-section-preview.html so a headless Chrome can measure it.
 *
 * Kept out of `vitest.config.ts` on purpose — that suite must be pure (no files
 * written, no browser) and must not carry a test that is skipped on purpose, or
 * every run reports "1 skipped" and the green result stops meaning "everything
 * ran". The file lives in `tools/`, so the default glob never sees it.
 *
 * Ported from `dsh-connect-trae`'s `vitest.card.config.ts`, which exists for the
 * identical reason: the card now lives in a 564px column (Settings panel minus
 * its nav rail), and every breakpoint in `styles.ts` measures the viewport.
 */
export default defineConfig({
  test: {
    include: ['tools/*.tsx'],
    environment: 'node',
  },
})
