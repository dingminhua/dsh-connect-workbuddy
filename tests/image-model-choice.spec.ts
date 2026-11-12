/**
 * 生图模型的选择（issue #241）：宿主侧的读写契约。
 *
 * 为什么这个设置值得单独一套测试：它**不改变水印以外的任何东西，但会改变账单**。
 * 选上无水印那条，单价从约 6 变成约 11.1 积分/张、尺寸上限从 419 万像素掉到约
 * 105 万——而用户看到的只是卡片上一个下拉框。所以这一层的每一条不变量都要钉住：
 *
 *  1. 没选就是没选：不能把「缺省」读成「要那条贵的」；
 *  2. 只影响这一区：国内区选了不能让国际区也跟着换；
 *  3. 清空要真的删掉这个值，而不是留一个空串让工具继续特判；
 *  4. 读写一个来回之后，别的字段一个都不能少。
 */
import { describe, expect, it } from 'vitest'
import {
  nextRegionPreferredImageModel,
  regionPreferredImageModelOf,
} from '../src/status-paths.ts'

describe('regionPreferredImageModelOf', () => {
  it('every shape that carries no choice reads as empty', () => {
    // 空串而不是 undefined：卡片那个 <select> 拿它当「默认」那一行的 value。
    expect(regionPreferredImageModelOf({}, 'cn')).toBe('')
    expect(regionPreferredImageModelOf({ regions: {} }, 'cn')).toBe('')
    expect(regionPreferredImageModelOf({ regions: { cn: {} } }, 'cn')).toBe('')
  })

  it('a malformed value is "no choice", never the expensive model', () => {
    // 这一条是花钱方向的守卫：坏值绝不能读成「要无水印那条」。
    expect(regionPreferredImageModelOf({ regions: { cn: { preferredImageModel: 7 } } }, 'cn')).toBe('')
    expect(regionPreferredImageModelOf({ regions: { cn: { preferredImageModel: null } } }, 'cn')).toBe('')
    expect(regionPreferredImageModelOf(
      { regions: { cn: { preferredImageModel: { id: 'hunyuan-image-v3.0' } } } },
      'cn',
    )).toBe('')
  })

  it('is per region, so a CN choice never answers for the global tab', () => {
    // 无水印那条在国际区根本没有路由（实测 400 / 14401），所以它绝不能从国内区
    // 漏过去——漏过去就是每次调用都失败。
    const value = { regions: { cn: { preferredImageModel: 'hunyuan-image-v3.0' } } }
    expect(regionPreferredImageModelOf(value, 'cn')).toBe('hunyuan-image-v3.0')
    expect(regionPreferredImageModelOf(value, 'global')).toBe('')
  })
})

describe('nextRegionPreferredImageModel', () => {
  it('sets the choice without disturbing the rest of the slot or the other region', () => {
    const value = {
      regions: {
        cn: { enabled: true, imageToolEnabled: true, imageModelIds: ['hunyuan-image-alpha'] },
        global: { enabled: false, preferredImageModel: 'hy-image-3.5' },
      },
    }
    const next = nextRegionPreferredImageModel(value, 'cn', 'hunyuan-image-v3.0') as any
    expect(next.cn.preferredImageModel).toBe('hunyuan-image-v3.0')
    // 一个下拉框的写入不能顺手清掉同区别的设置。
    expect(next.cn.imageToolEnabled).toBe(true)
    expect(next.cn.imageModelIds).toEqual(['hunyuan-image-alpha'])
    expect(next.global.preferredImageModel).toBe('hy-image-3.5')
  })

  it('clears back to "follow the catalog" on undefined or empty', () => {
    const value = { regions: { cn: { preferredImageModel: 'hunyuan-image-v3.0' } } }
    expect((nextRegionPreferredImageModel(value, 'cn', undefined) as any).cn.preferredImageModel).toBe('')
    expect((nextRegionPreferredImageModel(value, 'cn', '') as any).cn.preferredImageModel).toBe('')
  })

  it('round-trips through the reader', () => {
    const on = nextRegionPreferredImageModel({ regions: { cn: {} } }, 'cn', 'hunyuan-image-v3.0')
    expect(regionPreferredImageModelOf({ regions: on }, 'cn')).toBe('hunyuan-image-v3.0')
    const off = nextRegionPreferredImageModel({ regions: on }, 'cn', undefined)
    expect(regionPreferredImageModelOf({ regions: off }, 'cn')).toBe('')
  })
})
