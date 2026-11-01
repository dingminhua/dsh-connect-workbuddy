/**
 * 设备标识的**纯计算层**：派生与格式校验，不读盘、不发请求、不认识上游。
 *
 * 这一层只回答一个问题——给定账号 uid 与一个本机盐，这台设备"看起来"是哪一个。
 * 把它与 IO 分开，是因为它要被三处共用而只有一处会写盘：诊断（`doctor`）、
 * 出站注入（P1）、单测。混在一起的话，任何一处想验算都得先落一个文件。
 *
 * ## 为什么是派生，而不是真值
 *
 * 官方设备身份只能由 Turing Shield SDK 签发（见 `docs/DEVICE-IDENTITY-AUDIT.md`
 * §5.1 的三角不可能：真实 / 账号隔离 / 可维护，三者不可兼得）。派生是明确选择
 * "牺牲真实性、换账号隔离"的那一格：
 *
 *   - 同 uid + 同盐 + 同用途 → 恒同值（跨进程、跨重启、跨插件升级稳定）；
 *   - 异 uid → 互异值（多账号池里一个号一台"虚拟设备"，不共享）；
 *   - 异盐 → 互异值（两个装了本插件的用户，同一个账号不会算出同一个 id）。
 *
 * 最后一条是 B（workbuddy2api-panel-main）没有做的：它用固定盐 `"wb2a:"`，
 * 于是所有使用该工具的用户对同一个 uid 算出完全相同的值——一旦上游反推该函数，
 * 全体用户就是一个可识别族群。这里的盐由 `src/device-salt.ts` 生成，
 * 本机随机、持久化，**不是常量**。
 *
 * ## 它不是真实设备
 *
 * 派生值**不含任何来自物理设备的信息**：与 SDK 签发的 `X-Device-Token` 无关，
 * 也与真实 machineId 无关。两者同时出现在一条请求里等于自证不一致
 * （审计报告 §5.3），因此调用方必须把它当作一个**互斥档位**使用，不能与真 token 叠加。
 *
 * @module dsh-connect-workbuddy/device-id
 */

import { createHash } from 'node:crypto'

/** 两个用途，与上游两个头一一对应，绝不混用（`X-Machine-ID` / `X-Session-ID`）。 */
export type WorkBuddyDeviceIdPurpose = 'machine' | 'session'

/**
 * 派生结果的字符数：sha256 取前 18 字节 → 36 个十六进制字符。
 *
 * 36 是为了与官方 36 字符 UUID 的形状对齐（去连字符），这样上游任何按
 * "长度 36 / 十六进制"写的校验都能通过；同时 18 字节的熵远高于碰撞需求。
 */
export const WORKBUDDY_DEVICE_ID_LENGTH = 36

/**
 * 盐的字符数：32 字节随机 → 64 个十六进制字符。
 *
 * 与 {@link WORKBUDDY_DEVICE_ID_LENGTH} 一起构成"写入什么、读出什么才算有效"的
 * 唯一契约——盐文件被手工改短、或被旧版写成别的长度，都必须判为不可读，
 * 而不是"凑合着用"。
 */
export const WORKBUDDY_DEVICE_SALT_LENGTH = 64

/**
 * 命名空间，且带版本号。
 *
 * 不带命名空间，本插件的派生值就可能与另一个工具的派生值在同一个 uid 上撞成
 * 同值；不带版本号，将来改一次输入格式就会让所有账号**静默换设备**——那正是
 * 风控最想抓的 device hopping。要改格式，就改这里的 `v1`，并接受"这是一次
 * 有意的身份变更"，而不是让它悄悄发生。
 */
const DEVICE_ID_NAMESPACE = 'dsh-connect-workbuddy/device/v1'

/** 36 个**小写**十六进制字符，别的一律不认。 */
const DEVICE_ID_PATTERN = /^[0-9a-f]{36}$/u

/** 64 个**小写**十六进制字符。 */
const DEVICE_SALT_PATTERN = /^[0-9a-f]{64}$/u

/**
 * Derive one stable, account-scoped device identifier.
 *
 * `uid` 为空串时返回空串：匿名请求没有"这台设备属于哪个账号"可言，上游也不要求
 * （B 的同名实现在 uid 为空时同样不注入）。返回空串而不是抛错，是因为调用方
 * 只需要"发还是不发"，而"没有 uid"是正常状态，不是异常。
 *
 * @param uid the account's stable id, as the desktop auth document records it
 * @param purpose which header this value is for — never reuse one for the other
 * @param salt this machine's random salt (see `device-salt.ts`); a constant here
 *   would make every install of this plugin derive identical ids
 */
export function deriveDeviceId(uid: string, purpose: WorkBuddyDeviceIdPurpose, salt: string): string {
  if (uid === '' || salt === '') return ''
  return createHash('sha256')
    // `\0` 分隔：uid 里出现冒号或下划线都不会让两个不同账号拼出同一个输入。
    .update(`${DEVICE_ID_NAMESPACE}\0${salt}\0${purpose}\0${uid}`, 'utf8')
    .digest('hex')
    .slice(0, WORKBUDDY_DEVICE_ID_LENGTH)
}

/** Whether `value` is exactly a derived device id (36 lowercase hex). */
export function isDeviceId(value: string): boolean {
  return DEVICE_ID_PATTERN.test(value)
}

/** Whether `value` is exactly a device salt (64 lowercase hex). */
export function isDeviceSalt(value: string): boolean {
  return DEVICE_SALT_PATTERN.test(value)
}
