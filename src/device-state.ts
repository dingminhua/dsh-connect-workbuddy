/**
 * 设备身份的**只读取证视图**（审计报告 P0，P1 起同时是"派生档会发什么"的唯一答案）。
 *
 * 这一层不注入头、不写盘、不发请求，只回答两个问题：
 *
 *   1. **现在**有没有设备身份真的上了线？——答案不是写死的文案，而是把请求路径
 *      上同一批构造器跑出来的头名集合过滤一遍（{@link describeRequestHeaderNames}）。
 *      于是它随代码自动变化：P1 之前是空数组，P1 之后是 `X-Machine-ID` /
 *      `X-Session-ID`，而没有任何地方需要改两次。
 *   2. **派生档**会给这台机器的每个账号发什么？——同一个盐算出 machine/session
 *      一对 id，并统计"N 个账号 → 几个不同设备"。第二个数字是审计 §5.4 的核心
 *      问题：池子里的号是共用一台设备（易被聚成一群），还是各自一台（隔离）。
 *
 * ## 为什么盐由调用方传进来
 *
 * P0 时这个模块自己 `ensureDeviceSalt()`，因为那时它是唯一的调用者。P1 之后
 * `doctor` 还要把同一个盐交给 {@link describeRequestHeaderNames} 去渲染完整的
 * 头名清单——两处各自读一次盐，就可能各自读到不同的状态（一次读到 absent、
 * 一次读到 ok），于是报告会在同一屏里自相矛盾。盐是调用方的事实，这里只做算术。
 *
 * 两者都不含凭据、不含盐本身。
 *
 * @module dsh-connect-workbuddy/device-state
 */

import { deriveDeviceId } from './device-id.ts'
import type { DeviceSaltReadout } from './device-salt.ts'
import type { DeviceTokenReadout } from './device-token.ts'
import { describeRequestHeaderNames } from './upstream.ts'
import type { WorkBuddyWireIdentity } from './upstream.ts'
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
   * 设备头名，**按当前代码实际会发的那一组算出来**。空数组 = 一个都不发。
   * 它不是断言，是测量。
   */
  onWire: readonly string[]
  /** 盐文件的状态；`salt` 本身永不出现在报告里。 */
  salt: {
    path: string
    state: DeviceSaltReadout['state']
    reason?: string
  }
  /**
   * 外部设备 token（P2）。
   *
   * 缺席 = 本次诊断没有看到 token 源（`doctor` 读不到插件配置，只能读环境变量，
   * 见 `WORKBUDDY_DEVICE_TOKEN_FILE_ENV`）。这与 `state: 'absent'`（配了路径但
   * 文件不在）必须分开：一个是"没查"，一个是"查了没有"。
   */
  token?: {
    path: string
    state: DeviceTokenReadout['state']
    /** 文件 mtime 至今的毫秒数，只有 `ok` 时有意义。 */
    ageMs?: number
    reason?: string
  }
  /**
   * 派生档会给什么，以及池子会不会塌成一台设备。
   *
   * 缺席的两种情形要能区分：没有账号（无从派生）、盐不可用（不能派生）。"能派生
   * 但就是没派生"不该发生，因此不设这一态。
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
 * 把已经读到的盐与本地账号，组合成 `doctor` 要的那份报告。
 *
 * `credentials` 只用来取 `uid`：报告里不出现账号名、账号 id 或任何令牌。重复的
 * uid 会被折叠（同一个号的两个历史凭据文件不该被算成两台设备）。
 *
 * 纯函数（无 IO、无时钟），所以测试不需要临时目录，也不会因为读写顺序不同而
 * 得到两种答案。
 */
export function describeDeviceState(
  credentials: readonly WorkBuddyCredential[],
  saltReadout: DeviceSaltReadout,
  tokenReadout?: DeviceTokenReadout,
): WorkBuddyDeviceReport {
  const salt: WorkBuddyDeviceReport['salt'] = {
    path: saltReadout.path,
    state: saltReadout.state,
    ...'reason' in saltReadout ? { reason: saltReadout.reason } : {},
  }
  const token: WorkBuddyDeviceReport['token'] = tokenReadout === undefined
    ? undefined
    : {
        path: tokenReadout.path,
        state: tokenReadout.state,
        ...tokenReadout.ageMs === undefined ? {} : { ageMs: tokenReadout.ageMs },
        ...'reason' in tokenReadout ? { reason: tokenReadout.reason } : {},
      }
  // 头名要与真实请求一致：档位取默认，盐与 token 取刚刚那两份读数。少传一个，
  // 报告就会答成"那个头没发"，而实际上发了——那正是这个模块最不该犯的错。
  const identity: WorkBuddyWireIdentity = {
    ...saltReadout.state === 'ok' ? { deviceSalt: saltReadout.salt } : {},
    ...tokenReadout?.state === 'ok' ? { deviceToken: tokenReadout.token } : {},
  }
  const probe = credentials[0]
  const onWire = probe === undefined
    ? []
    : describeRequestHeaderNames('chat', probe, identity)
      .filter(name => WORKBUDDY_DEVICE_HEADER_NAMES.includes(name))

  const uids = [...new Set(credentials.map(credential => credential.uid).filter(uid => uid !== ''))]
  const base: WorkBuddyDeviceReport = token === undefined ? { onWire, salt } : { onWire, salt, token }
  if (uids.length === 0 || saltReadout.state !== 'ok') return base

  const machineIds = uids.map(uid => deriveDeviceId(uid, 'machine', saltReadout.salt))
  return {
    ...base,
    derived: {
      accounts: uids.length,
      distinct: new Set(machineIds).size,
      sample: {
        machineId: machineIds[0] as string,
        sessionId: deriveDeviceId(uids[0] as string, 'session', saltReadout.salt),
      },
    },
  }
}
