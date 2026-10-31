// @vitest-environment jsdom
/**
 * 设备参数弹窗里那三件"看不见就等于没说"的事。
 *
 * 1. 留空时到底会发什么，必须画在输入框下面。旧版只写"留空 = 自动派生"，
 *    用户既看不到结果，也无法判断两个账号是不是被算成了同一台设备。
 * 2. 填了覆盖值就不再显示派生值——那个值已经不会发出去了，留着它就是误导。
 * 3. 算不出来时要说清是"本机没有设备盐"还是"这个账号没有 uid"，两者用户能做
 *    的事完全不同。
 *
 * 另外钉住档位选中态的配色：暗色主题下 `--dsw-alias-brand-primary` 本身是浅色，
 * 品牌色底 + 白字会变成一格空白（用户截图里的现象）。选中态因此改用
 * 「前景色底 + 底色字」这一对，两者按定义互为反色。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { DeviceProfileDialog } from '../src/client/DeviceProfileDialog.tsx'
import { mount, t } from './pool-render-helpers.tsx'

const MACHINE = 'a'.repeat(36)
const SESSION = 'b'.repeat(36)
const OTHER = 'c'.repeat(36)

const baseProps = {
  t,
  accountName: '张三',
  saved: { machineId: '', sessionId: '' },
  saving: false,
  onCancel: () => {},
  onSave: () => {},
}

describe('DeviceProfileDialog — 留空会发什么', () => {
  it('shows both derived ids under empty fields', async () => {
    const dialog = await mount(DeviceProfileDialog, {
      ...baseProps,
      derived: { machineId: MACHINE, sessionId: SESSION },
    })
    expect(dialog.text()).toContain(MACHINE)
    expect(dialog.text()).toContain(SESSION)
    // 两个字段各一行：只有一处就说明其中一个框没画出来。
    expect(dialog.text().match(/row\.deviceDerivedNow/gu)?.length).toBe(2)
    await dialog.unmount()
  })

  it('hides the derived value once that field is overridden', async () => {
    const dialog = await mount(DeviceProfileDialog, {
      ...baseProps,
      saved: { machineId: MACHINE, sessionId: '' },
      derived: { machineId: OTHER, sessionId: SESSION },
    })
    // 被覆盖的那一项不再显示派生值（它已经不会发出去），另一项照常显示。
    expect(dialog.text()).not.toContain(OTHER)
    expect(dialog.text()).toContain(SESSION)
    await dialog.unmount()
  })

  it('names the reason when there is nothing to show', async () => {
    const noSalt = await mount(DeviceProfileDialog, { ...baseProps, derivedNote: 'row.deviceDerivedUnavailable' })
    expect(noSalt.text()).toContain('row.deviceDerivedUnavailable')
    expect(noSalt.text()).not.toContain('row.deviceDerivedNow')
    await noSalt.unmount()

    const noUid = await mount(DeviceProfileDialog, { ...baseProps, derivedNote: 'row.deviceDerivedNoUid' })
    expect(noUid.text()).toContain('row.deviceDerivedNoUid')
    await noUid.unmount()
  })

  it('renders no note at all when the values are known', async () => {
    const dialog = await mount(DeviceProfileDialog, {
      ...baseProps,
      derived: { machineId: MACHINE, sessionId: SESSION },
      derivedNote: 'row.deviceDerivedNoUid',
    })
    expect(dialog.text()).not.toContain('row.deviceDerivedNoUid')
    await dialog.unmount()
  })
})

describe('设备档位选中态的配色', () => {
  // 直接读源文件而不是 import：这些字串是 CSS，模块导出的是整段模板字符串，
  // 断言具体那条规则比断言"整段里出现过"更能钉住问题。
  const css = readFileSync(join(process.cwd(), 'src', 'client', 'styles.ts'), 'utf8')
  const rule = /\.dsm-workbuddy-device-seg-on\{([\s\S]*?)\}/u.exec(css)?.[1] ?? ''

  it('fills with the label colour and writes with the base colour', () => {
    expect(rule).toContain('background:var(--dsw-alias-label-primary')
    expect(rule).toContain('color:var(--dsw-alias-bg-base')
    // 品牌色底 + 固定白字在暗色主题下是同色叠同色，正是这次反馈的现象。
    expect(rule).not.toContain('#fff')
    expect(rule).not.toContain('brand-primary')
  })

  it('keeps the hover tint off the selected segment', () => {
    // 权重：btn:hover 高于 .seg-on。不排除的话鼠标一划过，选中的那一格会被
    // 换成半透明底，看起来像"选中被取消了"。
    expect(css).toContain(':hover:not(:disabled):not(.dsm-workbuddy-device-seg-on)')
  })
})
