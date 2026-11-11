/**
 * opt-in 开关的统一政策：**只认字面 `true`**。
 *
 * 这条政策原先在五个文件里各写一遍（同一组反例、同一句理由）。它是**一条**产品
 * 决策：会花钱或多挂一块界面的开关，缺省与类型错误都不能被读成同意。合成一张表
 * 后新增开关只加一行，政策要改也只改一处。各文件仍保留自己独有的断言（逐区隔离、
 * 写回只动一个字段等），这里只收「读的语义」。
 *
 * @module dsh-connect-workbuddy/tests/optin-policy
 */

import { describe, expect, it } from 'vitest'
import { cliBridgeEnabledOf, sidebarPanelEnabledOf } from '../src/client/account-selection.ts'
import { hostNewModelsShownOf } from '../src/client/ComposerCredits.tsx'
import { regionImageToolEnabledOf, regionVideoToolEnabledOf } from '../src/status-paths.ts'

/** 每个 reader 的"开"与一组"非开"输入（缺席 / false / 字符串 / 数字 / 相邻开关）。 */
const CASES = [
  {
    name: 'regionImageToolEnabledOf',
    read: (v: any) => regionImageToolEnabledOf(v, 'cn'),
    on: { regions: { cn: { imageToolEnabled: true } } },
    off: [{}, { regions: {} }, { regions: { cn: {} } },
      { regions: { cn: { imageToolEnabled: false } } },
      { regions: { cn: { imageToolEnabled: 'yes' } } },
      { regions: { cn: { imageToolEnabled: 1 } } }],
  },
  {
    name: 'regionVideoToolEnabledOf',
    read: (v: any) => regionVideoToolEnabledOf(v, 'cn'),
    on: { regions: { cn: { videoToolEnabled: true } } },
    off: [{}, { regions: {} }, { regions: { cn: {} } },
      { regions: { cn: { videoToolEnabled: false } } },
      { regions: { cn: { videoToolEnabled: 'yes' } } },
      { regions: { cn: { videoToolEnabled: 1 } } }],
  },
  {
    name: 'cliBridgeEnabledOf',
    read: (v: any) => cliBridgeEnabledOf(v),
    on: { cliBridge: { enabled: true } },
    off: [undefined, {}, { cliBridge: {} }, { cliBridge: { enabled: false } },
      { cliBridge: { enabled: 'true' } }, { regions: { cn: { enabled: true } } }],
  },
  {
    name: 'sidebarPanelEnabledOf',
    read: (v: any) => sidebarPanelEnabledOf(v),
    on: { sidebarPanel: true },
    off: [undefined, {}, { sidebarPanel: false }, { sidebarPanel: 'true' },
      { sidebarPanel: 1 }, { cliBridge: { enabled: true } }],
  },
  {
    name: 'hostNewModelsShownOf',
    read: (v: any) => hostNewModelsShownOf(v),
    on: { status: 'signed-in', showNewModelsInMainUi: true },
    off: [undefined, { status: 'error' }, { status: 'signed-in' },
      { status: 'signed-in', showNewModelsInMainUi: false },
      { status: 'signed-in', showNewModelsInMainUi: 'yes' },
      { status: 'signed-in', showNewModelsInMainUi: 1 }],
  },
] as const

describe('every opt-in switch reads ON only for the literal boolean true', () => {
  for (const { name, read, on, off } of CASES) {
    it(`${name}: OFF for every shape that does not say ON`, () => {
      for (const value of off) expect(read(value), `${name}(${JSON.stringify(value)})`).toBe(false)
    })
    it(`${name}: ON for an explicit true`, () => expect(read(on)).toBe(true))
  }
})
