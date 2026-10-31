/**
 * Turing Shield SDK 的取 token 子进程。
 *
 * ## 为什么必须是一个独立进程
 *
 * SDK 是原生插件，同时会在初始化时探测/修改宿主的网络与进程环境，而且它的
 * Promise 依赖一个会持续跑事件循环的宿主。把它 `require` 进 DSH 的插件进程有两个
 * 问题：一次加载失败（ABI、缺 DLL、DLL 版本被替换）会让整个插件挂掉，而不是
 * "设备头不可用"；再者它没有 cancel —— 一次超时的调用会把句柄留在进程里。
 * 子进程把这两件事都变成"这一条命令失败"，父进程杀掉它就是干净的。
 *
 * ## 协议
 *
 *   node worker.cjs probe    → {"ok":true,"supported":true,"node":"22.22.2",...}
 *   node worker.cjs token    → {"ok":true,"token":"v3:...","ms":99}
 *
 * 只在 stdout 写一行 JSON，**任何情况下都不把配置或 token 写进 stderr**。
 * 退出码：0 成功，1 SDK 不可用/加载失败，2 取 token 失败，3 看门狗超时。
 *
 * 配置全部走环境变量，因为命令行参数在 Windows 上要经过一次引号解析，而 token
 * 与路径都可能含特殊字符——环境变量没有这个问题。
 */

'use strict'

const path = require('node:path')

const mode = process.argv[2] === 'probe' ? 'probe' : 'token'
const sdkDir = process.env.TURING_SDK_DIR || path.join(__dirname, 'win32-x64')
const timeoutMs = Number.parseInt(process.env.TURING_TIMEOUT_MS || '', 10) || 15000

/** 收尾：先冲刷 stdout 再退出，否则 1 KB 以上的 token 会被截断。 */
function finish(code, payload) {
  const text = `${JSON.stringify(payload)}\n`
  process.stdout.write(text, () => {
    process.exit(code)
  })
}

// 看门狗。SDK 自己的 timeoutMs 只覆盖它内部的等待，不覆盖"加载 DLL 卡住"和
// "登录态读不到导致永不 settle"。父进程也会杀，但两个超时是有意的：父进程杀
// 可能来不及冲刷 stdout，这里能先把结构化错误写出去。
const watchdog = setTimeout(() => {
  finish(3, { ok: false, reason: 'timeout', message: `no answer within ${timeoutMs}ms` })
}, timeoutMs)
watchdog.unref?.()

let sdk
try {
  sdk = require(sdkDir)
} catch (error) {
  finish(1, {
    ok: false,
    reason: 'load-failed',
    message: String((error && error.message) || error),
    sdkDir,
  })
  return
}

const supported = (() => {
  try {
    return typeof sdk.isSupported === 'function' ? sdk.isSupported() === true : true
  } catch {
    return false
  }
})()

if (mode === 'probe') {
  finish(0, {
    ok: true,
    supported,
    node: process.versions.node,
    napi: process.versions.napi ?? null,
    platform: process.platform,
    arch: process.arch,
    sdkDir,
    loadError: typeof sdk.getLoadError === 'function' ? sdk.getLoadError() : null,
  })
  return
}

if (!supported) {
  finish(1, {
    ok: false,
    reason: 'unsupported',
    message: (typeof sdk.getLoadError === 'function' && sdk.getLoadError()) || `unsupported platform ${process.platform}`,
    sdkDir,
  })
  return
}

const channelId = Number.parseInt(process.env.TURING_CHANNEL_ID || '109144', 10)
const productName = process.env.TURING_PRODUCT_NAME || 'WorkBuddy'
const productVersion = process.env.TURING_PRODUCT_VERSION || '5.8.3'

/** 取一次 token；SDK 的回调可能永不触发，所以外面还有一层 Promise.race。 */
function fetchOnce() {
  try {
    sdk.configure(channelId, productName, productVersion)
  } catch (error) {
    return Promise.reject(error)
  }
  return Promise.resolve(sdk.fetchDeviceToken({
    usingCachedMessage: true,
    includesOutdatedMessage: true,
    includesDeviceInfo: true,
    // SDK 自身超时略晚于本进程的看门狗：让**我们**先放弃，错误里才有
    // "是我们等的太久"而不是 SDK 内部某个更含糊的文案。
    timeoutMs: Math.max(1000, timeoutMs - 2000),
  }))
}

const startedAt = Date.now()
fetchOnce()
  .then((value) => {
    const token = String(value == null ? '' : value).trim()
    if (token === '') {
      finish(2, { ok: false, reason: 'empty', message: 'sdk returned an empty token', sdkDir })
      return
    }
    finish(0, { ok: true, token, ms: Date.now() - startedAt, sdkDir })
  })
  .catch((error) => {
    finish(2, {
      ok: false,
      reason: 'fetch-failed',
      message: String((error && error.message) || error),
      sdkDir,
      ms: Date.now() - startedAt,
    })
  })
