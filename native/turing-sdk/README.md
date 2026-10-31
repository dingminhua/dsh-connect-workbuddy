# native/turing-sdk

发现本机 Turing Shield SDK 的那套约定，加上把它跑起来的那个子进程脚本。
`src/turing-sdk.ts` 是唯一的调用方。

**这里不再有 SDK 副本。** 原生模块与厂商 DLL 是 WorkBuddy 桌面端的构建产物
（`.node` 里的 pdb 路径指向桌面端仓库的构建目录），插件不重新分发它们——
在 npm 包里放一份闭源厂商二进制，等于把"这东西从哪来、什么版本、依不依
得着 EULA"变成每个用户都要自己回答的问题。插件改为**用用户机器上已经装着
的那个**：用户装了桌面端，SDK 就在那儿；没装，真实值档降级为"一个设备头
都不发"（这是档位互斥规则本来就承诺的）。

## 目录

```
worker.cjs    子进程入口（probe / token 两种模式），加载 SDK 目录由环境变量给
README.md     本文件
```

## SDK 目录从哪来（`src/turing-sdk.ts`）

按优先级：

1. `WORKBUDDY_TURING_SDK_DIR`——显式指定，跳过发现。
2. **发现**：按桌面端的安装形状找已安装的 SDK，取第一个可用的：
   - Windows：`<安装目录>\resources\app.asar.unpacked\native\turing-sdk`。
     安装目录来自默认布局（`%LOCALAPPDATA%`、`%ProgramFiles%`、
     `%ProgramFiles(x86)%` × `Programs\WorkBuddy` 等）与卸载注册表
     （装在非默认盘时唯一能找到它的一跳，issue #68 的教训）。
   - macOS：`<bundle>/Contents/Resources/app.asar.unpacked/native/turing-sdk`。
     bundle 来自 `/Applications` 与 `~/Applications`（exe 名是
     `CFBundleExecutable`，真机上两份 bundle 都叫 `Electron`——不能从
     bundle 名倒推）。
3. 都没有 → `state: 'missing'`，真实值档不发设备头。

可用性检查看的是 `build/Release/turing_sdk.node` 在不在，不只是父目录：
装了桌面端但解包不完整（或被安全软件动过）时，跳过它比拿一个加载不了的
目录去起子进程好——`missing`（没装，用户装一个就好）与 `error`（在但坏了，
可修）分开，就是为了这条。

证据分级（`docs/WINDOWS.md` §2 的约定）：macOS 的两个 bundle 形状是 2026-11-01
在真机上直接点验的（A 级）；Windows 的 `resources\app.asar.unpacked` 是按
Electron 默认打包约定推的（B 级），待真机 `doctor` 验证——`Device SDK:` 一行
会打出发现的目录。

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
| `TURING_SDK_DIR` | **必填** | 没有默认副本可退；空值直接答 `no-dir` 退出 |
| `TURING_TIMEOUT_MS` | 15000 | 子进程看门狗；父进程另有一层（20 s） |
| `TURING_CHANNEL_ID` | 109144 | 与桌面端 `product.json` 的 `turingSdk.channelId` 一致 |
| `TURING_PRODUCT_NAME` | `WorkBuddy` | |
| `TURING_PRODUCT_VERSION` | `5.8.3` | 由调用方传入插件自称的版本，避免两处字面量漂移 |
| `TURING_KEYCHAIN_STORAGE` | `0` | `configure` 的第 4 参 `keychainStorageEnabled`，永远传布尔 |

命令行参数只用来选模式，路径与配置一律走环境变量：Windows 上命令行要经过一次
引号解析，而路径里可能出现空格与反斜杠。

**第 4 参必须是布尔**：桌面端（macOS 与新版 Windows 副本）的
`configure(channelId, productName, productVersion, keychainStorageEnabled)`
会校验 `keychainStorageEnabled must be a boolean`，传 `undefined` 直接抛。
旧副本只收 3 参，多收一个无害。默认 `false`：插件进程没有往钥匙串写设备
缓存的设计意图。

## 平台

- **Windows**：完整链路（probe + token）。桌面端自己的主进程里 SDK 跑在同一
  个前提成立的环境；插件的子进程用的就是那个 `.node`，与桌面端同版本宿主
  （DSH 桌面端内嵌的 Node）时 ABI 一致。
- **macOS**：**probe 能过，token 取不到**。2026-11-01 真机实测：
  `worker.cjs probe` 对 `/Applications/WorkBuddy.app` 的副本答
  `{"ok":true,"supported":true,...}`，但 `token` 在 ~13 s 后答
  `Turing SDK device token request timed out`；`sample` 显示主线程卡在
  `_dispatch_thread_main_event_wait_slow → __ulock_wait`——即 SDK 向
  dispatch 主队列 `dispatch_sync`，而纯 libuv 进程（Node，含
  `ELECTRON_RUN_AS_NODE`）永不排空主队列。桌面端 App 能取到 token，是因为
  Electron 主进程的 run loop 在排水。要修得加一个排空主队列的伴生原生模块，
  不在本 PR 范围。**表现**：mac 上 doctor/卡片显示 `ready` 但 token 不可用，
  真实值档按规则降级（零设备头）。

## 自己指一份副本时

`WORKBUDDY_TURING_SDK_DIR` 可以指向任何保持这个形状的目录：

```
<dir>/index.cjs                 N-API 桥接：isSupported / configure / fetchDeviceToken
<dir>/package.json              main = index.cjs
<dir>/build/Release/
  turing_sdk.node               N-API 原生模块（NAPI_VERSION 10）
  TuringShieldSDK.dll           （Windows）原生模块按同目录加载的依赖
```

相对位置不能动——原生模块按同目录查找它依赖的动态库。指好后跑一次
`node native/turing-sdk/worker.cjs probe`（带 `TURING_SDK_DIR`），确认
`supported` 与 `napi` 如预期。
