# native/turing-sdk

内置的 Turing Shield SDK 副本，以及把它跑起来的那个子进程脚本。`src/turing-sdk.ts`
是唯一的调用方。

## 目录

```
worker.cjs                  子进程入口（probe / token 两种模式）
win32-x64/
  index.cjs                 N-API 桥接：isSupported / configure / fetchDeviceToken
  package.json              main = index.cjs
  build/Release/
    turing_sdk.node         N-API 原生模块（NAPI_VERSION 10）
    TuringShieldSDK.dll     原生模块在运行时加载的同目录依赖
```

`win32-x64` 这一层是按 `platform-arch` 分出来的：`src/turing-sdk.ts` 用
`bundledSdkBundleId()` 拼目录名，所以加 macOS 副本只需新增 `darwin-arm64/`，
不用改代码。目录不存在时 `probe` 答 `missing`，插件按"这一档没有真实值可用"
处理（真实值档下于是不发任何设备头）。

## 为什么通过子进程调用

原生模块不能 `require` 进插件进程，理由有三条，任何一条都足够：

1. **失败范围**：加载失败（ABI 不匹配、缺 DLL、DLL 被安全软件替换）在插件进程里
   就是插件起不来；在子进程里只是"这一条命令失败"。
2. **没有 cancel**：`fetchDeviceToken` 返回 Promise，超时之后没有取消手段，句柄会
   留在进程里。子进程可以杀掉。
3. **它会探测宿主**：SDK 在初始化时读进程与网络环境，把它放进宿主进程等于把宿主
   的环境一起交出去。

`worker.cjs` 的输出是**一行 JSON**，退出码 0/1/2/3 分别对应成功、SDK 不可用、
取数失败、看门狗超时。父进程只解析最后一行 stdout，stderr 只留最后几行做错误摘要。

## 配置（全部走环境变量）

| 变量 | 默认 | 说明 |
|---|---|---|
| `TURING_SDK_DIR` | 同目录下的 `win32-x64` | 也可以指向别的副本 |
| `TURING_TIMEOUT_MS` | 15000 | 子进程看门狗；父进程另有一层（20 s） |
| `TURING_CHANNEL_ID` | 109144 | 与桌面端 `product.json` 的 `turingSdk.channelId` 一致 |
| `TURING_PRODUCT_NAME` | `WorkBuddy` | |
| `TURING_PRODUCT_VERSION` | `5.8.3` | 由调用方传入插件自称的版本，避免两处字面量漂移 |

命令行参数只用来选模式，路径与配置一律走环境变量：Windows 上命令行要经过一次
引号解析，而路径里可能出现空格与反斜杠。

## 平台

目前只有 Windows。macOS 的取链多一个前提：联网取风险消息那条路径里有
`dispatch_sync(_dispatch_main_queue, …)`，普通 Node 进程的主线程停在 libuv 的
kevent 里，永远不排空主队列 → 死等。要支持 macOS 就得同时提供排空主队列的伴生
模块，否则表现为"有时能取到、有时超时"。

## 加副本时

1. 新建 `<platform>-<arch>/`，保持 `index.cjs` / `package.json` /
   `build/Release/{turing_sdk.node,<vendor>.dll|dylib}` 的相对位置不变——原生模块
   按同目录查找它依赖的动态库。
2. 确认 `index.cjs` 里的 `supportedPlatform` 包含该平台，否则 `isSupported()`
   恒为 false，`probe` 会答 `unsupported`。
3. 跑一次 `node native/turing-sdk/worker.cjs probe`，确认 `napi` 与
   `supported` 都如预期。
