# issue #261 回复草稿（可直接粘贴到 GitHub）

> 取证：本机 DSH `0.2.2-rc.3`（`@deepseek-ai/dsh` 与 `@deepseek-ai/dsh-client-connection`
> 同版本），读的是安装目录 `app.asar` 里的源码与 Cordis Inspect 的 Service 目录。
> 报告里的环境、复现、根因分析都核对过；下面「已修」指的是本仓库已落地的改动。

---

感谢反馈，这份报告质量很高——现象、根因、对照实验都准确。先说结论：**这是真 bug，已经修了**，
加一个默认关闭的 `trustedHosts` 配置；同时卡片不再把 403 吞成空白。但你建议的「更省事的做法」
（注入 `connection` 直接读宿主白名单）在本机版本上**不成立**，我们改走了插件自有配置。下面逐条说明。

## 一、确认的部分

- **范围**：出事的是设置卡片那族路由（`src/web-status.ts` 的 `requireLoopback`，Host 与 Origin
  两道闸门）。聊天用的 shim 自己 `listen(0, '127.0.0.1')`、用更严的 `hostIsLoopback`，由 DSH
  本机调用，反代碰不到它。所以严格说不是「所有插件路由」，但卡片空白、模型分组消失、网页登录
  点不动这些用户可见症状，全部对得上——卡片把 403 静默吞了。
- **根因**：`hostMatchesListener` 拿 `req.socket.localAddress` 与 `Host` 比较。反代后面宿主绑定
  回环，这个 socket 地址恒为 `127.0.0.1`；Caddy 默认原样转发 `Host`，两者永远不相等。而 DSH
  自己的 `/api` 走的是另一套栅栏（`@deepseek-ai/dsh-client-connection/src/api-request-trust.ts`
  的 `isTrustedApiRequest`），它接受 `trustedHosts` + listener 的 bind 地址——`dsh web
  --trusted-host 192.168.1.250` 的值经 `dsh-web-app/cordis.patch.yml` 的
  `trustedHosts: !!js ctx.webStartup.trustedHosts` 喂给 `client-connection` 插件的 Config。
  同一个 Host、`/api` 200、`/plugins` 403，就是这么来的。
- **「这算 bug 而不是配置问题」**：同意。宿主已经认为这个 Host 可信，插件却全量拒绝，用户看到
  的就是「插件坏了」，而「绑定 LAN / 反代」本来就是文档里提到的部署场景。

## 二、为什么没有走「读宿主白名单」那条路

报告里建议 `const connection = ctx.get("connection"); const trusted = connection.trustedHosts`。
我在本机 `0.2.2-rc.3` 上核过，这条**编译不过**：

- `HostConnectionService`（`rpc-host.ts`）里 `trustedHosts` 是 **`private readonly`**，构造参数上的
  私有字段；公开面只有 `allowsRemoteAuthorities: boolean` 这一个布尔值。Cordis Inspect 的
  `connection` Service 目录也只列了 `allowsRemoteAuthorities`，没有 `trustedHosts`。
- 值实际挂在 `client-connection` 这个**插件的 Config** 上，不在 `connection` 服务上；插件没有
  直接读另一个插件 Config 的通道。
- `allowsRemoteAuthorities` 绝不能当放行开关：它只是「配过至少一个远程 authority 吗」的布尔，
  拿它跳过 `localAddress` 比较等于接受**任意** Host，反而把 rebinding 防护拆了。
- `connection` 上确实有 `requestRejection()` / `admit()` 会跑同一道栅栏，但它们把「栅栏」和
  「浏览器鉴权（cookie / peer）」揉在一起：插件自己的 fetch 不带浏览器 cookie，会拿到 401，
  得靠「403 才是栅栏拒绝」这种未文档化语义去反推。再加上把卡片可用性绑到 `connection` 服务
  是否在场（`connection` 缺席时卡片会整块消失），是没必要的新耦合；本仓库 `docs/DESIGN.md`
  §零的取向也是「不为别处是否在场做适配」。

所以采用你建议的第一条：**插件自有 `trustedHosts` 配置，默认空**。不依赖宿主私有字段、不依赖
另一个服务在场、也不挑宿主版本。「DSH 认为可信的 Host，插件也认为可信」这个目标仍然达到了，
只是由部署方在两处各声明一次（宿主的 `--trusted-host` 和插件的 `trustedHosts`）。要让两边
真正共用一份声明，得等上游把「纯栅栏」作为公开 API 暴露出来——那属于宿主改动，类似 issue
#138 的 `keyed` 槽位，我们这版先把插件侧修好。

## 三、已落地的改动

- **配置**：`trustedHosts`，`asVolatile(z.array(z.string()).default([]))`，默认空、请求时读取，
  改动无需重载插件。元素是裸 `host[:port]`：不带端口匹配该主机名任意端口，带端口精确匹配该
  authority；挂载期用 `assertTrustedAuthority` 逐条校验，`host/path`、内嵌凭据、`0x7f.0.0.1`
  这类会被 WHATWG 重写的值**加载即报错**，而不是悄悄授权一个前缀。
- **闸门**：`hostMatchesListener` / `originIsLoopback` 各收一个 trust getter，在 loopback 分支与
  `0.0.0.0`/`[::]` 显式拒绝之后、`localAddress` 比较之前，用**完整 authority（含端口）**比对。
  两半读的是同一份列表，且都按请求的 scheme 做 WHATWG 归一化——大小写、IPv6 括号、`:443` 这种
  scheme 默认端口在 https Origin 里被剥掉的情况，两边仍然一致。
  - 这一条正是报告里 `normalizeAuthority(entry) === hostname` 那行**不能直接抄**的地方：
    `hostnameOfHost` 和 `URL.hostname` 已经把端口剥掉了，拿 `192.168.1.250:8443` 去比裸
    hostname 永远不匹配，Host 半边修好之后 Origin 半边会继续 403。必须在 authority 级比较。
- **安全边界不变**：默认空时回环 / LAN 绑定 / 通配符拒绝 / rebinding 防护逐字不变。白名单只是
  把「本机地址」的定义从「socket 落在哪」扩展到「部署方声明的权威」，与宿主对齐；这两个头本来
  就可伪造、不是鉴权，加白名单不改变威胁模型（这一点报告里也写对了）。
- **卡片不再空白**：`refreshUsage` 现在读响应体的 `error`，对 `host-not-trusted` /
  `origin-not-trusted` 给一条专属提示，明确说「这不是登录问题，重新登录不会有用，请改用本机
  地址打开，或把这个 authority 配进 `trustedHosts`」；同时抑制「重新登录 WorkBuddy」「服务可能
  刚重启」这两条对此**事实错误**的通用建议。带一个「重试」按钮。其它 403 / 500 / 未登录 /
  上游拒绝全部走原路径，误伤面为零。
- **文档**：README（中/英）新增「反向代理 / 局域网访问」一节，CHANGELOG 有对应条目。

测试：`tests/loopback.spec.ts`（信任判定、端口语义、默认端口、非规范值）、
`tests/web-status.spec.ts`（反代场景 403→200、未命中仍 403、Origin 半边、端口语义、空列表
等价、volatile 请求时读取）、`tests/issue261-gate-hint.spec.tsx`（门禁码专属文案、其它错误零
影响、恢复后清除）。按仓库规矩做了变异验证：禁用信任匹配 / 放宽门禁码判定 / 移除 Origin 半边
信任，三层对应测试均转红。`pnpm run check` 全绿（含 `check-pii`、typecheck、build、3617 测试）。

## 四、你现在可以怎么用

升级到带这个改动的版本后，在插件配置里加：

```yaml
trustedHosts:
  - 192.168.1.250:8443      # 与 --trusted-host 同一个 authority
```

默认空，其它部署零影响。加完立即生效，不用重启、不用改 Caddy 的 `header_up Host`（你担心
「改写会丢掉 Origin 校验的意义」是对的，不用改反代）。卡片会直接显示账号和积分；网页登录
（`window.open` 在浏览器侧、服务器只轮询）本来就是好的，只是之前被 403 挡住了——你实测能出
对话 `workbuddy-global/deepseek-v4.1-flash` 也正好印证这一点。

再次感谢这份报告，尤其是「同一个 Host、只换路径」的对照实验，省掉了大量复现时间。
