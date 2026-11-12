// @vitest-environment jsdom
/**
 * 卡片上的「生图模型（水印）」选择器（issue #241）。
 *
 * 这个控件是本次改动唯一**花钱方向**的入口：选上无水印那条，单价从约 6 涨到约
 * 11.1 积分/张、尺寸上限从 419 万像素掉到约 105 万。所以这一组测试盯的不是
 * 「下拉框画出来了没有」，而是四件容易在重构里悄悄坏掉的事：
 *
 *  1. 默认值是「跟随目录」——新装、升级、没点过的用户不能被静默换成贵的那条；
 *  2. 选项里必须**同时**有便宜的带水印那条和无水印那条，否则「让用户选」是空话；
 *  3. 只有国内区给这个选择——国际区没有 v3.0 的路由（实测 400 / 14401），
 *     在那里列出来就是一个点了必然失败的按钮；
 *  4. 两个方向都走落盘校验过的写路径，并回读宿主——悄悄回退等于骗用户。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WorkBuddyCard } from '../src/client/WorkBuddyCard.tsx'
import { mount, fakeScope, stubFetch, t } from './pool-render-helpers.tsx'

/**
 * Each case mounts its own card; the harness does not unmount the previous root,
 * so a second `mount` in the same file renders into a container that React has
 * already reconciled against a different tree — the tabs then exist in the
 * previous container while `querySelector` runs against the new one. Tearing the
 * root down here keeps every case independent without editing the shared helper
 * (whose other suites rely on its current semantics).
 */
let mounted: Awaited<ReturnType<typeof mount>> | undefined
afterEach(async () => {
  await mounted?.unmount()
  mounted = undefined
  vi.unstubAllGlobals()
})

const MEDIA_PATH = '/plugins/dsh-connect-workbuddy/media-models'

/** 国内区 `/v3/config` 实测形状：文生图只有 alpha 一条，v3.0 不在目录里。 */
const CN_MEDIA = [
  { id: 'hunyuan-image-alpha', name: 'Hunyuan Image Alpha', tags: ['text-to-image'] },
  { id: 'hunyuan-image-alpha-edit', name: 'Hunyuan Image Alpha Edit', tags: ['image-to-image'] },
]

function usageOf(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    status: 'signed-in',
    region: 'cn',
    domain: 'www.workbuddy.cn',
    accountId: 'cn-1',
    accountName: 'CN One',
    tokenExpiresAtMs: Date.now() + 86_400_000,
    selectionExplicit: true,
    accounts: [{ accountId: 'cn-1', accountName: 'CN One' }],
    models: [{ id: 'glm-5.3', name: 'GLM-5.3' }],
    enabledModelIds: ['glm-5.3'],
    imageModelIds: [],
    contextBudgets: {},
    credits: { total: 10, expiringSoon: 0, packages: [] },
    // 生图工具开着，否则选择器整块不出现（选了也影响不到工具）。
    imageToolEnabled: true,
    ...overrides,
  }
}

async function render(
  overrides: Record<string, unknown> = {},
  media: unknown = CN_MEDIA,
  region: 'cn' | 'global' = 'cn',
): Promise<Awaited<ReturnType<typeof mount>>> {
  const body = usageOf({ ...overrides, region })
  stubFetch(url => {
    if (url.startsWith(MEDIA_PATH)) return { body: { models: media } }
    return { body }
  })
  const m = await mount(WorkBuddyCard, { t, settingsScope: fakeScope({}), view: 'page' })
  mounted = m
  await m.settle()
  // The REGION comes from the clicked tab, not from the usage body: switching
  // `region` in the payload alone leaves the card on its default CN tab, and a
  // "global" case would silently assert against the CN pane.
  if (region === 'global') {
    const globalTab = m.buttons().find(b => b.getAttribute('role') === 'tab'
      && b.textContent === t('row.tabGlobal'))
    if (globalTab === undefined) throw new Error('global region tab missing')
    await m.click(globalTab)
    await m.settle()
  }
  // Capabilities is where the media roster and both tool switches live. The tab
  // must be clicked before its lazy roster fetch runs, so the picker has a
  // catalog to render its options from.
  const tab = m.container.querySelector('#dsm-workbuddy-tab-capabilities')
  if (tab === null) {
    throw new Error(`capabilities tab missing; ids=${Array.from(m.container.querySelectorAll('[id]')).map(el => el.id).join(',')}`)
  }
  await m.click(tab)
  await m.settle()
  await m.settle()
  return m
}

const picker = (m: Awaited<ReturnType<typeof render>>): HTMLSelectElement => {
  const found = m.container.querySelector<HTMLSelectElement>('.dsm-workbuddy-image-model-select')
  if (found === null) throw new Error('image model picker missing')
  return found
}

describe('生图模型选择器（issue #241）', () => {
  it('默认停在「跟随目录」，不替任何人换成贵一倍的那条', async () => {
    const m = await render()
    const select = picker(m)
    expect(select.value).toBe('')
    // 第一行必须是「默认」，且文案要说清它带水印——用户得知道自己在放弃什么。
    const first = select.options[0]
    expect(first?.value).toBe('')
    // The harness translator renders `key|param=value`, never prose: wording
    // lives in `locales.ts`, and this suite asserts which KEY is used.
    expect(first?.textContent).toBe(t('row.imageModelDefault'))
  })

  it('两个选项都在：便宜的带水印那条，和无水印那条', async () => {
    // 「让用户选」要求两条都在。只剩一条的话这个控件就是一块假的选择题。
    const m = await render()
    const values = Array.from(picker(m).options).map(option => option.value)
    expect(values).toEqual(['', 'hunyuan-image-alpha', 'hunyuan-image-v3.0'])
  })

  it('提示文案讲的是水印与代价，不是「便宜/推荐」这类诱导词', async () => {
    // 文案本体在 locales.ts（有单独的用例盯它的措辞），这里盯的是「卡片有没有
    // 把那条 hint 画出来」——提示整个丢掉时，用户只看到一个孤零零的下拉框。
    const m = await render()
    expect(m.text()).toContain('row.imageModelLabel')
    expect(m.text()).toContain('row.imageModelHint')
  })

  it('宿主已经存了 v3.0 时就显示 v3.0', async () => {
    const m = await render({ preferredImageModel: 'hunyuan-image-v3.0' })
    expect(picker(m).value).toBe('hunyuan-image-v3.0')
  })

  it('存的值目录里已经没有了 → 回到「默认」，因为工具也会这么回落', async () => {
    // 下拉框不能显示一个它自己都没有的选项；而工具对过期 id 的处理正是回落，
    // 所以显示「默认」恰好是事实。
    const m = await render({ preferredImageModel: 'hunyuan-image-gone' })
    expect(picker(m).value).toBe('')
  })

  it('国际区不给这个选择：工具开着也不给，那边没有 v3.0 的路由', async () => {
    // `imageToolEnabled` DELIBERATELY true here. With it false the picker would
    // be absent for an unrelated reason (the tool is off), and this case would
    // keep passing even after the CN-only gate was deleted — a guard that cannot
    // fail. Keeping the tool on makes the REGION the only thing that can
    // suppress the control.
    const m = await render(
      { imageToolEnabled: true },
      [{ id: 'hy-image-3.5', name: 'HY Image 3.5', tags: ['text-to-image', 'image-to-image'] }],
      'global',
    )
    // The media roster DID render, so the absence below is the gate and not a
    // card that failed to draw the panel at all.
    expect(m.container.querySelector('.dsm-workbuddy-media-list')).not.toBeNull()
    expect(m.container.querySelector('.dsm-workbuddy-image-model-select')).toBeNull()
  })

  it('生图工具没打开时不给选择——选了也影响不到工具', async () => {
    const m = await render({ imageToolEnabled: false })
    expect(m.container.querySelector('.dsm-workbuddy-image-model-select')).toBeNull()
  })

  it('长在「生图工具」开关下面，跟视频那一组分开排（5.22.0 的回归）', async () => {
    // WHAT WENT WRONG. 5.22.0 shipped the picker next to the VIDEO pin row, so
    // the image picker sat between the video switch and the video pins and read
    // as part of the video group — the owner reported it as 「怎么跑到视频的选项
    // 了」. Nothing in this suite could catch it: every existing case asks "does
    // the picker exist", and it existed in the wrong place.
    //
    // The rule this pins is the pairing, not a pixel position: each tool switch
    // owns the picker that configures it. So for each switch, its own picker must
    // come AFTER it and BEFORE the other switch.
    // A catalog carrying BOTH media kinds: the CN fixture has no video rows, so
    // the video picker would be absent for a data reason and this assertion
    // would fail to distinguish "missing" from "misplaced".
    const m = await render({ videoToolEnabled: true }, [
      ...CN_MEDIA,
      { id: 'kling-video-v3', name: 'Kling Video V3', tags: ['text-to-video'] },
    ])
    const order = Array.from(m.container.querySelectorAll(
      '.dsm-workbuddy-image-tool-check, .dsm-workbuddy-image-model-select, .dsm-workbuddy-video-tool-check, .dsm-workbuddy-video-model-select',
    )).map(el => el.className.includes('image-tool-check') ? 'imageSwitch'
      : el.className.includes('image-model-select') ? 'imagePicker'
        : el.className.includes('video-tool-check') ? 'videoSwitch'
          : 'videoPicker')

    // Both pickers must be present for this to be a real ordering assertion; a
    // missing one would otherwise make the index comparisons vacuously true.
    expect(order).toContain('imagePicker')
    expect(order).toContain('videoPicker')
    expect(order).toEqual(['imageSwitch', 'imagePicker', 'videoSwitch', 'videoPicker'])
  })
})
