/**
 * 设备身份的**只读取证视图**（审计报告 P0）。
 *
 * 这一层不注入任何头、不改任何字节，只回答两个问题：
 *
 *   1. **现在**有没有设备身份真的上了线？——答案不是写死的文案，而是把请求路径
 *      上同一批构造器跑出来的头名集合过滤一遍（{@link describeRequestHeaderNames}）。
 *      于是"P1 还没做"这件事是可验证的：往 `chatHeaders` 里加 `X-Machine-ID`，
 *      这里立刻非空，`doctor` 的文案跟着变，而没有任何地方需要改。
 *   2. **派生档**会给这台机器的每个账号发什么？——用同一个盐算出 machine/session
 *      一对 id，并统计"N 个账号 → 几个不同设备"。第二个数字是审计 §5.4 的核心
 *      问题：池子里的号是共用一台设备（易被聚成一群），还是各自一台（隔离）。
 *
 * 两者都不含凭据、不含盐本身。
 *
 * @module dsh-connect-workbuddy/device-state
 */

import { deriveDeviceId } from './device-id.ts'
import { ensureDeviceSalt, readDeviceSalt } from './device-salt.ts'
import type { DeviceSaltState } from './device-salt.ts'
import { describeRequestHeaderNames } from './upstream.ts'
import type { WorkBuddyCredential } from './auth.ts'

/**
 * 承载设备身份的**全部**头名。P2/P3 加 `X-Device-Token` 的读取时，这个常量不变
 * ——它描述的是"哪些头算设备身份"，不是"我们发了哪些"。
 */
export const WORKBUDDY_DEVICE_HEADER_NAMES: readonly string[] = [
  'X-Device-Token',
  'X-Machine-ID',
  'X-Session-ID',
]

/** 一次派生的结果：一台"虚拟设备"的两个 id。 */
export interface WorkBuddyDerivedDevice {
  machineId: string
  sessionId: string
}

/** The read-only answer `doctor` renders. */
export interface WorkBuddyDeviceReport {
  /**
   * 设备头名，**按当前代码实际会发的那一组算出来**。空数组 = 一个都不发，
   * 也就是审计 §4 的 D1。它不是断言，是测量。
   */
  onWire: readonly string[]
  /** 盐文件的状态；`salt` 本身永不出现在报告里。 */
  salt: {
    path: string
    state: DeviceSaltState
    reason?: string
  }
  /**
   * 派生档会给什么，以及池子会不会塌成一台设备。
   *
   * 缺席的三种情况都要能被区分：没有账号（无从派生）、盐不可用（不能派生）、
   * 以及"能派生但就是没派生"（不该发生，因此不设这一态）。
   */
  derived?: {
    /** 参与派生的账号数（= 输入里非空 uid 的个数）。 */
    accounts: number
    /** 其中算出的**不同** machineId 个数。`accounts === distinct` 才算隔离。 */
    distinct: number
    /** 一个样例，供人工比对两次 `doctor` 是否稳定；不代表"唯一"。 */
    sample: WorkBuddyDerivedDevice
  }
}

/**
 * Compose the device report from the local accounts.
 *
 * `credentials` 只用来取 `uid`：报告里不出现账号名、账号 id 或任何令牌。重复的
 * uid 会被折叠（同一个号的两个历史凭据文件不该被算成两台设备）。
 *
 * 盐**只在这一步**被创建，且仅在确有账号可派生时：一个还没登录的机器不需要
 * 也不必留下一个设备盐。
 */
export async function describeDeviceState(
  credentials: readonly WorkBuddyCredential[],
  options: { dir?: string } = {},
): Promise<WorkBuddyDeviceReport> {
  // 头名集合与账号无关，只与"选了哪个档"有关；用第一个凭据做探针就够，
  // 也保证探针走的是真实构造器而不是复刻的清单。
  const probe = credentials[0]
  const onWire = probe === undefined
    ? []
    : describeRequestHeaderNames('chat', probe)
      .filter(name => WORKBUDDY_DEVICE_HEADER_NAMES.includes(name))

  const uids = [...new Set(credentials.map(credential => credential.uid).filter(uid => uid !== ''))]
  // 没有账号就**不创建**盐：一个还没登录的机器不该留下设备身份。此时只报告
  // "我们会在哪里找它"，那本身就是排障需要的信息。
  const readout = uids.length === 0 ? await readDeviceSalt(options) : await ensureDeviceSalt(options)
  const salt: WorkBuddyDeviceReport['salt'] = {
    path: readout.path,
    state: readout.state,
    ...'reason' in readout ? { reason: readout.reason } : {},
  }
  if (uids.length === 0 || readout.state !== 'ok') return { onWire, salt }

  const machineIds = uids.map(uid => deriveDeviceId(uid, 'machine', readout.salt))
  return {
    onWire,
    salt,
    derived: {
      accounts: uids.length,
      distinct: new Set(machineIds).size,
      sample: {
        machineId: machineIds[0] as string,
        sessionId: deriveDeviceId(uids[0] as string, 'session', readout.salt),
      },
    },
  }
}
