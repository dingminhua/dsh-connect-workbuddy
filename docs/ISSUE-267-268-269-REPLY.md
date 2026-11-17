# issue #267 / #268 / #269 回复草稿（可直接粘贴到 GitHub）

> 取证：本仓库 `main`（5.24.10）逐条读了 `src/oauth.ts` 的 `collectAccount()`、
> `src/auth.ts` 的 `workbuddyAccountId()` / `addOAuthAccount()` 与卡片空名字的渲染路径。
> 下面「已修」指的是本仓库已落地的改动，随 **5.24.11** 发布。

---

感谢三位反馈，三个现象是**同一个根因**，不是三个bug。先说结论：**账号资料采集用错了端点，
拿到的是空资料**，已经修好，随 5.24.11 发布。

## 一、根因：上游的 `/login/account` 现在对任何凭据都回空

OAuth 登录成功后，插件要再调一次上游接口拿账号资料（uid / nickname / uin）。此前只调
`GET /v2/plugin/login/account`。上游现在对这个端点**无论哪把凭据**都回：

```json
{"code":12151,"msg":"12151:not choose login account","data":{}}
```

旧代码把 `data: {}` 当成正常资料接受了，于是 `uid` / `nickname` / `uin` 全为空。后果正好对应三位看到的现象：

- **显示**：空名字走到卡片的 `row.accountUnnamed` → 「未命名账号」（#268）；
- **账号互相覆盖**：vault 文件 id 由 `workbuddyAccountId()` 算，输入是 `uin ?? uid ?? nickname ?? 'unknown'`。
  三个字段全空时，每个账号都变成对同一个字符串求哈希，得到同一个 id，第二个登录直接覆盖第一个的文件——
  所以「登录了两个账号只显示一个」（#269），国际版 Google 账号也「只能登一个」（#267）。

## 二、修复：三层，只动登录成功那一刻的采集链

1. **先试正确的端点** `GET /v2/plugin/account`。同样的 `Authorization: Bearer` 与 `X-Domain` 头，
   它返回完整身份。旧端点 `/login/account` 只作为「仍服务它的主机」的回退保留。
2. **拒绝空资料**：任一端点返回的 data 没有非空 uid，就当作没拿到，继续试下一个。12151 的空 envelope
   不再能被当成有效身份写进 vault。
3. **JWT 兜底**：两端点都空或都不可达时，从 access token 自己的 JWT payload 里读 `sub` / `nickname` /
   `uin` / `preferred_username`。这不是鉴权——token 已经被 `/auth/token` 接受，这里只把它当显示名和稳定
   id 的种子读，而且只用非空值——只是让身份不会因为上游某个端点故障又彻底丢失。

## 三、效果

- OAuth 添加的账号显示真实昵称，不再是「未命名账号」；
- 两个（或多个）账号各有各的 vault id，可以同时登录、同时出现在账号列表里；
- 旧端点仍可用的主机不受影响：新端点先试，拿不到才回退。

## 四、验证

`tests/oauth.spec.ts` 新增守护测试：优先新端点、拒绝 12151 空资料后回退旧端点、JWT 兜底、两个空资料账号
得到不同 vault id、畸形 token 不抛错、身份调用仍带 Bearer + X-Domain。三项核心改动都做了**变异验证**——
把端点顺序改回旧的、去掉空资料拒绝、去掉 JWT 兜底，对应测试都会变红。全量 `check`（typecheck / build /
check:pii / test）通过。

### 关于 #269 提到的「密码登录」

插件本身的账号添加入口是网页/扫码 OAuth（会话在进程内，凭据交给宿主写入统一 vault）；「密码登录」在
WorkBuddy 桌面端完成后，插件通过读取桌面端凭据文件发现账号。无论凭据来自哪条路，只要落进同一个 vault，
显示名和 id 都走同一套逻辑。这次修复覆盖的是插件自己发起的 OAuth 登录；如果你是在桌面端用密码登录、插件
这边仍只看到一个账号，请补一句桌面端版本和账号来源，我们按那条路径再核一次——但从「未命名」这个共同症状
看，大概率就是上面那个空身份导致的同一 id 覆盖。
