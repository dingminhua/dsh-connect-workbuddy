# 模型选择器里的胶囊：同族插件共用的一套做法

> 可整篇转发给同族插件作者照做（`dsh-connect-workbuddy` / `dsh-connect-trae` /
> `dsh-connect-qoder` 及后来者）。步骤与包名无关。
> 适用宿主：DSH **0.2.2 及以上**（`LlmModelInfo.badge` 从这一版起存在）。
> 0.1.x 上本文全部步骤都是**无害的空转**，不需要探测版本，见「版本门槛与降级」。

## 一句话结论

**不要改模型名。** 胶囊走宿主的数据字段 `LlmModelInfo.badge`：每个插件在**自己的**
`adapter.listModels()` 里给自己那几行挂一枚；谁赢了 `conversation.input.model.label`
那格 `single` 槽，谁就负责把**别家**模型自带的 `badge` 画出来。
模型名保持纯目录名，一个字符都不动。

**胶囊一律画在名字后面，所有 placement 都一样**（宿主自己在 `trigger` 位把它放前面，
本族**有意不跟**——理由见「4. 别家的行」）。同一条规则同时适用于你自己的行和别家的行，
这是全族视觉统一的前提。

## 现象与原因

**现象**：三个同族插件同时装着，只有其中一个插件的胶囊能显示；另外两个的模型行上
什么装饰都没有。

**原因不是命名，是槽的基数。** `conversation.input.model.label` 声明为 `single`，
渲染器（`@deepseek-ai/dsh-client-ui-renderer`）对它的实现逐字是：

```js
if (spec.kind === "single") {
  const entry = host.entriesOfSlot(slotKey)[0];
  if (!entry) return entries.length > 0 ? deadCell() : <>{opts?.fallback ?? null}</>;
  return guarded(entry, entryKeyOf(entry));
}
```

一格只有一个占位者，**取优先级数值最小的那个**；`entriesOfSlot` 对非 chain 槽按 key 去重，
而 `single` 的 key 是 `undefined`，所以去重后只剩**第一个存活的**条目——其余注册虽然成功，
但渲染时永远轮不到。

> ⚠️ **同一优先级第二次注册不是「轮不到」，是直接抛错。** `SlotCore.register()` 对 `single`
> 槽逐字是：
>
> ```js
> case "single": {
>   const f = r.entries.find(h => (h.options.priority ?? 0) === n)
>   if (f) throw new Error(`single slot "${e.name}" already has a registration ${s(f)}`)
> }
> ```
>
> 错误文案形如 `single slot "conversation.input.model.label" already has a registration at
> priority 0 (registered by Kb) — register at a different priority to shadow it (lowest renders)`。
> 宿主自带的上游插件 `ui-deepseek-model-label-1017` 就用**默认的 `0`** 注册，所以第三方插件
> 若也用默认值，在装了它的宿主上会**注册失败**（而且这个失败常被 try/catch 吞掉，只留一行
> `console.error`，表面上页面正常）。**必须显式给一个负的、族内互不相同的 priority。**

赢家的组件对**所有 provider 的行**都会被调用一次，包括别人的行。

于是「三个插件各自的胶囊都能显示」这件事，**只能由赢家替所有行画**。改名解决不了：
名字只是赢家画出来的那个字符串，别人那枚胶囊的样式、颜色、判定逻辑都还在别人手里。

**为什么不能把胶囊语法写进 `model.name`**（这是最直觉的错答案）：

| 名字还被宿主用在哪 | 后果 |
| --- | --- |
| 菜单行的 `title`（悬停提示） | 悬停会看到 `夜间折扣` 之类的原始语法 |
| 触发器的 `aria-label`（`t("trigger.aria", { model: modelLabel })`） | 读屏器把语法念出来 |
| 搜索框的排序键（`rankByName(items, rawQuery)` 匹配 `label ?? name`） | 搜「夜间」会命中模型，搜真名反而靠后 |
| 卡片的 `triggerLabel` / 选中态摘要 | 语法泄漏到模型选择器以外的界面 |

而且胶囊是**会变的**（折扣窗口一关就该消失），名字是**稳定标识**——把易变的东西
塞进稳定标识里，等于每次窗口翻面都要改一遍目录。

## 数据通道：`LlmModelInfo.badge`

宿主的 LLM 注册表把 `badge` 当**目录数据**搬运，全程不需要插件之间说话：

```
你的 adapter.listModels()        ← 你在这里挂 badge（唯一需要你写的地方）
  → ctx.llm.listModels()         ← 注册表校验并复制（text 浅拷贝、tone 透传）
    → buildModelCatalog()        ← 会话控制器的模型目录，badge 原样带上
      → 选择器 props.model.badge ← 赢家的组件从这里读到它
```

⚠️ 这条链上**没有任何一步会按规则校验你的 `badge`**。注册表只做**规范化**——把 `text`
拆包、把 `tone` 原样拷贝——它既不检查 `tone` 是不是四个字面量之一，也不检查文案是否
超长。`session/modelCatalog` 的 schema 虽然标着 `mode: 'strict'`，但 0.2.2-rc.1 的网关在
结果方向拿不到 `encode` 编解码器就原样放行（`codec.encode?.(value) ?? value`）。所以写错了
不会有人拦你，只会安静地画错——详见「文本与类型规则」。

类型逐字（0.2.2 起）：

```ts
/** 强调程度：neutral 陈述事实，info 突出模型，success 标记优惠，warning 请求注意。 */
export type LlmModelBadgeTone = 'neutral' | 'info' | 'success' | 'warning';

export interface LlmModelBadge {
  /** 一条字面量，或按小写语言 id 索引、且**必须含 en** 的翻译表。 */
  text: LocalizedText;
  tone: LlmModelBadgeTone;
}

export interface LlmModelInfo {
  // ...provider / id / name / description / inputModalities
  /** 目录发现阶段播报的选择器标签；精确路由解析不带它，请求与 Session 事件也不带。 */
  badge?: LlmModelBadge;
}
```

**一个必须知道的细节**：`badge` 只走**目录**这条路。精确路由解析
（`normalizeModelInfo`）不复制它，请求与 Session 事件也不携带它。所以想显示胶囊，
只能从 `listModels()` 走；别指望在 `resolveModel()` 里塞。

## 先选一个 priority（不做这一步，另外四步都白做）

> **2026-11-08 更正：下面这一整节是 `single` 槽的规则，宿主改成 `keyed` 后其核心断言作废。**
> 正确的做法是**按槽的声明注册**：`keyed` 下每个 provider id 一格，优先级不再决定谁可见
> （见文末「宿主把槽改成 `keyed` 之后」）。本节保留，因为**当前每个已发布宿主仍然是
> `single`**，读它才能理解正在发生的现象。

`single` 槽的胜负规则是：**priority 数值最小的那个渲染**，其余注册虽然成功但永远不被调用。
而**同一优先级第二次注册会直接抛错**（见「现象与原因」里的 `SlotCore.register` 原文），
错误常被 try/catch 吞成一行 `console.error`，页面看起来正常、胶囊就是不出现——极难排查。

所以每个同族插件在 `single` 宿主上都必须**显式写一个负的、族内互不相同的 priority**，
绝不能用默认的 `0`：

| 插件 | priority | 说明 |
| --- | --- | --- |
| 宿主自带的 `ui-deepseek-model-label-1017` | `0` | 上游 web-app bundle 里的默认值，占了 `0` 这一格 |
| workbuddy | `-105` | 当前**赢家**（数值最小），负责复现全族的胶囊 |
| trae | `-102` | 注册成功，不渲染 |
| qoder | `-101` | 注册成功，不渲染 |

三条硬要求（**仅 `single` 宿主**）：

1. **必须 < 0**，且避开宿主自带插件占用的 `0`。
2. **族内互不相同**，否则第二个装上的会注册失败。
3. **别用「我比谁小」来表达优先级意图**——按 `docs/DESIGN.md` §零 第 3 条，取值只要求
   「不与别人碰撞」，不要求知道别人用了几。上面这张表只是记录现状，不是协调机制。

> 谁赢谁就负责画全族的胶囊。所以**每一个**同族插件都要实现第 4 步（复现别家的行），
> 不能赌自己永远赢：用户装了什么、谁先注册，都不是你能控制的。

### 宿主把槽改成 `keyed` 之后

`keyed` 是这次的根治路径。它和 `list` 不是一回事——`list` 每次调用渲染**全部**存活行，
实现不了「一个 provider 一行」，而且要求 `options.id`（同 id 同优先级抛错）；
`chain` 按 `select()` 选唯一赢家，语义同 `single`。三者里只有 `keyed` 成立。

插件侧要做的只有一件：**按宿主的声明决定注册几条**。

```ts
// 关键：kind 写在宿主包里，插件自己的 SlotMap 增强不代表运行中的声明。
const kind = ctx.slots.spec('conversation.input.model.label')?.kind
const seats = kind === 'keyed'
  ? MY_PROVIDER_IDS.map(id => ({ name: SLOT, key: id, priority: MY_PRIORITY }))
  : [{ name: SLOT, priority: MY_PRIORITY }]
seats.forEach(seat => ctx.slots.register(seat, MyModelLabel))
```

四条注意：

1. **`keyed` 强制要求 `key`。** 没有 `key` 的注册会抛
   `keyed slot "…" requires options.key`，而本族每个插件都把注册包在吞错 try/catch 里，
   于是表现就是「标签悄悄消失」。所以**不能只改宿主的声明**，插件必须同时发版——否则
   改口那天全族一起静默失效。
2. **`single` 宿主上不能注册多条。** 第二条会在第一条已落地之后抛
   `single slot … already has a registration at priority …`，即「半注册」。
3. 所以**一个构建要同时服务两种宿主**：运行时读 `kind`，读不到（老宿主没有 `spec()`、
   服务未就绪、未声明的 kind）就退回历史上的单条。
4. `priority` 不再决定**可见性**，但仍是**同一格内**的裁决（两个插件抢同一个 provider id：
   同值抛错、低者渲染）。三家 `-101` / `-102` / `-105` 之间不再有压制关系，数值**不必**
   继续下探——停战靠的是换槽的基数，不是再压一次价。

`keyed` 下第 4 步（复现别家的行）在**运行时走不到**：每条注册只在自己 provider 的行上被
调用。但那一步仍然必须实现，因为一个构建同时服务两种宿主，而 `single` 宿主上它就是整行。
它还是最便宜的哨兵：如果某个自己 provider 的行走进了外来行分支，说明 `key` 写错了。

### ⚠️ 改声明不够：宿主还必须传 `entryKey`

**这是最容易被忽略、而且最坏的一步。** keyed 的派发依赖**两个**独立事实：

1. 槽的声明是 `keyed`（插件侧读它决定注册几条）；
2. 渲染调用点传了 `{ entryKey: provider.id }`（宿主侧决定派发给哪个 key 的格子）。

渲染器的 keyed 分支逐字是：

```js
if (spec.kind === "keyed") {
  const entry = host.entriesOfSlot(slotKey).find(e => e.options.key === opts?.entryKey)
  if (!entry) return entries.some(e => e.options.key === opts?.entryKey) ? deadCell() : <>{opts?.fallback ?? null}</>
  return guarded(entry, entryKeyOf(entry))
}
```

`opts.entryKey` 是 `undefined` 时，`.find()` 匹配不到任何「以 provider id 为 key」的条目，
`entries.some()` 也是 false，于是**每一行**都渲染 `opts.fallback`。

而 `@deepseek-ai/dsh-client-ui-model-selection@0.2.2-rc.1` 里渲染这个槽**只有一个**调用点，
第三个参数只有 `fallback`、**没有 `entryKey`**：

```js
renderSlot("conversation.input.model.label",
  { provider, model, placement, selected },
  { fallback: model.badge === void 0 ? model.name : <badge> })
```

结论：**只把声明改成 `keyed`，全族的标签会一起消失，而且不报错。** 插件侧的注册成功、
inject 回调也跑了、没有任何异常和日志——只是那个组件再也不会被调用。这正是这一系列
问题里最难排查的一类。

所以上游的最小改动是**两处**：

```diff
- children: { "conversation.input.model.label": { kind: "single", scope: "session", inline: true } }
+ children: { "conversation.input.model.label": { kind: "keyed", scope: "session", inline: true } }

  children: renderSlot("conversation.input.model.label",
    { provider, model, placement, selected },
-   { fallback: model.badge === void 0 ? model.name : <badge> })
+   { fallback: model.badge === void 0 ? model.name : <badge>, entryKey: provider.id })
```

顺带一个放大器：宿主自己的契约注册表把该槽登记为 `registerOptions: []`，并给了一个
**无 key** 的注册示例（README 同样如此）。也就是说「无 key 注册」是它**文档化的写法**，
任何照文档写的第三方贡献者都注册无 key 条目——第二处改动缺失时，他们全体一起失效。

### 一个必须承认的现实

本族三个插件**当前无法验证**这个前提：读得到 `spec().kind`，但读不到宿主的调用点传了
什么。所以「注册了两格」不等于「会被调用」。宿主升级后请先按这个顺序自查：

1. `window.__dshWorkBuddyModelLabel__`（qoder/trae 无此视图）里的 `slotKind` 是否变成
   `keyed`、`seats` 是否等于 provider 数；
2. 若两者都对而标签仍然消失，问题在**第 2 个前提**，不在插件里——去查宿主的调用点。

## 具体做法（5 步）

### 1. 决定这一枚胶囊说什么

一个模型**只有一枚**。先回答「这一行最想让用户在选择那一刻知道什么」，然后只放那一件：

- ✅ 放：`限时免费`、`夜间折扣`、`新`、`会员专享` —— 一分钟内不会变的判定结论
- ❌ 不放：负载等级、剩余积分、队列长度 —— 分钟级事实，见「三个已知边界」第 2 条
- ❌ 不放：模型参数（`200K`、`reasoning`）—— 那是 `description` 与详情页的事

### 2. 在自己的 adapter 里挂上

覆盖 `listModels`，**只加 `badge`，别的一个字段都不动**：

```ts
import type { LlmModelInfo } from '@deepseek-ai/dsh-llm'

type BadgeTone = 'neutral' | 'info' | 'success' | 'warning'
interface MyBadge { text: string | Record<string, string>, tone: BadgeTone }

/** 这个模型此刻该说的那一件事；`undefined` 表示不说。 */
function badgeOf(modelId: string): MyBadge | undefined {
  // ...你自己的判定
}

class MyAdapter extends PiAiAdapter {
  override async listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    const models = await super.listModels(provider)
    return models.map((model) => {
      const badge = badgeOf(model.id)
      return { ...model, ...(badge === undefined ? {} : { badge }) }
    })
  }
}
```

⚠️ **必须用展开（`...`）而不是对象字面量直写 `badge`。** 宿主 0.1.x 的 `LlmModelInfo`
里没有 `badge` 字段，直写会在旧版类型下报「对象字面量只能指定已知属性」；展开一个变量
不受这条检查约束，同一份代码在 0.1.x 与 0.2.x 上都能编译（已用 0.1.7-rc.1 的类型实测）。
旧版宿主会在注册表里把 `badge` 悄悄丢掉，不报错、不崩——这就是「版本门槛与降级」说的那件事。

### 3. 自己的行：按自己的设计画

你自己的模型行走你自己的组件，那枚 `badge` 画不画由你定——workbuddy 在自己的行上
画的是完整装饰（活动胶囊 + 负载图标 + 新模型标记），比一枚胶囊信息多，所以它不画。
**但别家的行没有这个待遇**，见下一步。

### 4. 别家的行：画出来，而且顺序与我们自己的行一致

这是整套做法里**唯一真正需要动手**的地方，也是现在胶囊消失的那一行。

宿主的 fallback（没有插件占槽时它自己会画的）逐字是：

```jsx
model.badge === undefined ? model.name : (
  <span className={badgedName}>
    {placement === "trigger" ? <><Tag tone={badge.tone}>{resolveText(badge.text)}</Tag> </> : null}
    <span className={badgedNameText}>{model.name}</span>
    {placement === "trigger" ? null : <> <Tag tone={badge.tone}>{resolveText(badge.text)}</Tag></>}
  </span>
)
```

**注意宿主是换边的**：`trigger` 位胶囊在前，`menu`/`option` 位在后。

> ### ⚠️ 但你不要照抄这个换边
>
> 这是本文档唯一一处**明确建议偏离宿主**的地方，理由不是审美：
>
> 1. 宿主 fallback 只在**那一格没人注册**时才出现。你的插件一旦赢了这一格，
>    全菜单的每一行都由你画，宿主那段代码根本不执行。
> 2. 于是「换边」只剩坏处：你自己的行（有促销胶囊的那种）通常不换边，
>    而外来行换边，**同一份打开着的菜单里就出现两种摆法**——
>    别家模型是「胶囊 名字」，自家模型是「名字 胶囊」。
> 3. 用户学不会一条会逐行变化的规则，看起来就像渲染 bug。
>
> **正确规则：所有行、所有 placement，胶囊一律在名字后面。**
> 本仓库三家（workbuddy / trae / qoder）已全部统一到这一条，并且都有测试钉住
> 「自己行与外来行的顺序必须相同」——不是各自对着一个写死的字符串断言。

| `placement` | 画出来的顺序（本规则） | 宿主 fallback 的顺序（**不要**跟） |
| --- | --- | --- |
| `"trigger"`（输入框旁，当前选中） | 名字在前，**胶囊在后** | 胶囊在前 |
| `"menu"` / `"option"`（菜单行） | 名字在前，**胶囊在后** | 名字在前 |

`selected` 不参与胶囊的显示与否，只影响宿主的勾选标记。

**用 flex 行，不要用「裸 span + 一个空格」。** 空格对齐的是**文字基线**，而胶囊自身是
`inline-flex`，它的基线取自内部文字，于是整颗胶囊会被**明显推高**，与你自己那些
`inline-flex` 的行对不齐（这是实测到的真实缺陷，不是理论问题）：

```tsx
// ❌ 旧写法：靠空格分隔，胶囊会被抬到文字基线上
return <span>{model.name} {chip}</span>

// ✅ 正确写法：与宿主 fallback 的 .badgedName 同一个对齐模型
//    display:inline-flex; align-items:center; gap:4px
return <span className="my-model-label">   {/* 你自己的 inline-flex 类 */}
  <span>{model.name}</span>
  {chip}
</span>
```

组件里的写法（props 用**本地接口**声明 `badge`，别 import 宿主类型——旧版类型没有它）：

```tsx
interface HostBadge { text: string | Record<string, string>, tone: BadgeTone }

function resolveBadgeText(text: HostBadge['text'], language: string): string | undefined {
  if (typeof text === 'string') return text.trim() === '' ? undefined : text
  const lower = language.toLowerCase()
  const base = lower.split('-')[0] ?? ''
  const picked = text[lower] ?? (base === '' ? undefined : text[base]) ?? text.en
  return picked === undefined || picked.trim() === '' ? undefined : picked
}

// ...在「不是我的 provider」那一支里：
const badge = model.badge                       // 类型：HostBadge | undefined
const label = badge === undefined ? undefined : resolveBadgeText(badge.text, uiLanguage())
if (badge === undefined || label === undefined) return <span>{model.name}</span>
return (
  <span className="my-model-label">
    <span>{model.name}</span>
    <Capsule tone={badge.tone}>{label}</Capsule>
  </span>
)
```

⚠️ **这一支必须是纯函数，而且不能抛。** 不要在别家的行上发请求、读快照、起定时器：
一个菜单可能同时有二十行别家的模型，二十个请求会随「打开选择器」这个动作一起发出去。
更不要让它抛错——见「文本与类型规则」第三行：这一支崩了，被摘掉的是**你整个组件**，
不只是那一枚胶囊。宁可 `return <span>{model.name}</span>`，也不要让一个没见过的
`badge` 形状把你的模型标签从选择器里弄没。

**顺便：这一支也不要读 `placement`。** 顺序固定了，`placement` 就与胶囊无关；
留着它只会让人以为某处还有一条按位置分支的规则。

### 5. 胶囊长什么样

**首选：直接用宿主的 `Tag`**（`@deepseek-ai/dsh-client-ui-primitives`）。四个 `badge` 的
tone 都是合法的 `TagTone`，宿主自己的 fallback 就是 `<Tag tone={badge.tone}>`，所以你
传进去天然一致，且以后宿主改配色你会跟着改：

```tsx
import { Tag } from '@deepseek-ai/dsh-client-ui-primitives'
// ...
<Tag tone={badge.tone}>{label}</Tag>
```

**次选：手写一颗。** 如果你不想依赖 primitives，就照宿主 `Tag` 的真实 CSS 抄
（`Tag.module.css`，0.2.2-rc.1）：

> **本仓库自己走的就是「次选」**，而且是有理由的：`src/client/WorkBuddyQuotaNotice.tsx`
> 记录了那次教训——依赖 primitives 会让整张卡片的**能否渲染**取决于最易变的宿主包，
> 一次 stale inject 就白屏；手写一颗则永远渲染得出来，最坏只是颜色不对。
> 你如果也怕这个，就照下面的表抄；如果你不介意那层依赖，用 `Tag` 最省事。

| `tone` | 文字色 | 底色 | 描边 |
| --- | --- | --- | --- |
| `neutral` | `--dsw-alias-label-secondary` | `--dsw-alias-bg-module-platform` | 无 |
| `info` | `--dsw-alias-state-business-primary` | 同色 10% `color-mix` | 无 |
| `success` | `--dsw-alias-state-success-primary` | 同色 10% `color-mix` | 无 |
| `warning` | `--dsw-alias-state-warn-primary` | 同色 12% `color-mix` | 无 |

几何（同样是宿主的真值）：`display: inline-flex`、`align-items: center`、
`border-radius: 999px`、`corner-shape: round`、`padding: 1px 8px`、`font-size: 11px`、
`line-height: 17px`、`font-weight: 500`、`white-space: nowrap`。

⚠️ **注意 `info` 用的是 `state-business-primary` 而不是 `brand-primary`，`warning` 用的是
`state-warn-primary` 而不是 `state-warn-secondary`。** 这两个很容易抄错，抄错了同一行里
两颗胶囊的颜色就对不上。另外**这四个 tone 都没有描边**，别自己加一圈。

> 措辞要点：宿主 `Tag` 组件本身还有 `outline` / `solid` / `quiet` / `danger` 四个 tone，
> 其中 `outline` 是带 `0.5px` 描边的。但 `badge.tone` 只声明了 `neutral`/`info`/`success`/
> `warning` 四种，**只有这四种是「无描边」**。别把「Tag 有描边 tone」和「胶囊无描边」混说。

**tone 认不出来时按 `neutral` 画**，不要留白、也不要抛错——旧宿主或未来新增的 tone
都可能落到这一支。同理，别给胶囊加 `max-width` + 省略号：宿主不截断，你截断了就会
在同样的行宽下显示成「限时免…」，反而更不一致。

## 文本与类型规则

真实的失败模式分三档，从轻到重：

| 你写错的东西 | 实际发生什么 |
| --- | --- |
| 翻译表漏了 `en`，当前语言也没命中 | `resolveText` 兜底到 `text.en` = `undefined` → **一颗空胶囊** |
| `tone` 写了四个字面量以外的值 | 宿主的 `Tag` 只把它写成 `data-tone`，没有对应 CSS → **一颗没有配色的胶囊** |
| `text` 漏了（例如传了 `{}` 或一个字符串） | 注册表规范成 `text: {}` → 同样是一颗空胶囊 |
| `badge` 是 `null` | 注册表在 `badge.text` 上**抛错** → 你那**一整个 provider** 从目录里消失（进 `failures`） |

只有最后一行会真的打坏东西，而它正好是最容易避免的：`badge` 要么是一个完整对象，
要么是 `undefined`，**不要用 `null` 表示「没有」**。

最后一行的边界值得说清：`buildModelCatalog` 对每个 provider 单独 `try/catch`，一个
provider 抛错只会让它自己变成一条 `failure` 记录，**不会连累别家**。所以「一个坏
`badge` 会让整份目录失败」是假的，但「会让那个插件的所有模型消失」是真的。

至于组件渲染时抛错——那属于另一条路径：`entriesOfSlot` 会跳过已退役的条目
（`if (this.abdicated.has(s)) continue`），所以你的组件一旦崩，**整个组件会从那一格摘掉**，
让排在后面的另一个插件接管模型标签（只有当所有注册者都退役时，那格才变成 `deadCell`）。
这就是「类型写严一点」值得的原因：把 `badge` 的本地接口写死，别用 `any` 塞进去，
并且让渲染分支对没见过的形状安全退化。

关于空串：宿主 `resolveText` 对**空字符串是原样返回**的（它只兜底缺失的键，不过滤空值），
所以 `text: { en: '' }` 会画出一颗真的空胶囊。你可以在自己的渲染里把空串当「没有」
（上面 `resolveBadgeText` 就是这么写的）——这是**比宿主更严**的选择，目的是不画废话，
但要知道这是你加的判断，不是宿主行为。

**宿主的 `resolveText` 到底怎么回退**（逐字核对过，别照直觉写）：

```js
if (typeof text === "string") return text
return this.fallbackChain(this.snapshot.active).reduceRight((r, l) => text[localeKey(l)] ?? r, text.en)
```

即：**按 locale 注册表里声明的 fallback 链**逐个查表，最后兜底 `text.en`。
宿主内建的语言只有 `zh`（fallback `en`）与 `en` 两种。**注意：宿主并没有「取 `-` 前面的
语言基码」这层逻辑**——`zh-CN` 能命中 `zh`，是因为 `zh` 自己注册了 fallback，
不是因为宿主会截断标签。你若要更宽松的回退（例如 `pt-br` 命中 `pt`），那是**你自己**加的，
要么写清楚，要么干脆别加，免得与宿主画出不同的文案。

键的查找会经过 `localeKey()`（小写化），所以**表里的键必须小写**。

至于文本本身的规矩（这些是**宿主对自己目录的要求**，你照做才会长得一样；宿主并不会
在第三方 adapter 的返回值上执行它们，`badgeText()` 只存在于 `dsh-llm-deepseek` 内部）：

| 规则 | 照做的理由 |
| --- | --- |
| 文本 `trim()` 后 **≤ 12 个 grapheme** | 宿主自己按这个上限写文案；再长就撑破一行 |
| 必须有可见字符（非空白、非默认可忽略） | 否则就是一颗空胶囊（见上表第一行） |
| 不得含控制字符、行/段分隔符、双向控制符 | 会破坏行内布局 |
| 翻译表的键是小写语言 id（`en`、`zh`、`zh-hans`、`pt-br`） | `resolveText` 按 `localeKey()` 查表，大小写不匹配就查不到 |
| **`en` 必填** | 它是 `resolveText` 的兜底值；缺了它，任何没命中的语言都得到空胶囊 |

12 个 grapheme 大致是：`限时免费`(4)、`夜间折扣`(4)、`会员专享`(4)、`新`(1)、
`Free trial`(10)。**中文与 emoji 混排要按 grapheme 数**，不是按 `length`
（`'🚦'.length === 2`，`'👨‍👩‍👧'.length === 8`，用 `Intl.Segmenter` 数）。

## 版本门槛与降级

`LlmModelInfo.badge` 从 **0.2.2** 起存在。0.1.x 上：

- adapter 返回的 `badge` 被注册表**静默丢弃**（不抛错、不警告）；
- 组件的 `props.model.badge` **永远是 `undefined`**。

> 实测（2026-11-08，逐行读两个版本的 `LlmRuntime.listModels`）：0.1.7-rc.1 用
> `{ provider, id, name, ...description, ...inputModalities }` **重建**每个条目，
> `badge` 不在其中，所以确实是被重建掉的，而不是「没被读到」。0.2.2-rc.1 多了一段
> `const badge = model.badge` 与 `...badge === void 0 ? {} : { badge: { text: typeof
> badge.text === "string" ? badge.text : { ...badge.text }, tone: badge.tone } }`。
> 注意它只做**浅拷贝，不校验**：`tone` 写错不会报错，只会在前端画出一枚没有颜色的
> 胶囊；`badge: null` 则会在 `badge.text` 上**抛错**，把整个 provider 从目录里抹掉。
> 所以「没有胶囊」要用 `undefined`，绝不能用 `null`。

两个方向都自然退化成「今天的样子」——旧宿主上胶囊不显示，但**不会有任何一行崩掉**。
所以：

- ✅ **不需要探测宿主版本**，也不需要为它写分支；
- ✅ **不需要抬 `peerDependencies` 下限**：抬了只会让还在 0.1.x 上的用户装不上，
  换不来任何东西；
- ❌ 不要用 `if (badge 字段存在)` 之类的运行时探测——字段存在与否是**类型层**的事实，
  运行时只看得到 `undefined`，写了也是同一个分支。

`llm/models-updated(provider)` 事件同样是 0.2.2 才有的。它是「目录变了，重新读一次」
的广播，插件**发它**在旧宿主上是无害的空转（cordis 按名字分发，没有监听者）；
**听它**则只在新宿主上生效。

## 三个已知边界

1. **一枚胶囊装不下三件事。** workbuddy 的模型行同时想表达「折扣」「负载 🚦」「新模型 ✓」，
   而 `badge` 一个模型只有一枚。这套做法的分工是：**自己的行**由自己的组件画全部，
   **别家的行**只画那枚唯一的胶囊。所以三个插件各自的胶囊都能出现，但每个插件得先
   想清楚「如果只能给别家看一件事，是哪件」。

2. **`badge` 是目录数据，不是实时状态。** 它随模型列表一起刷新。想让它跟着分钟变，
   得发 `llm/models-updated` 让选择器重读目录——而 `buildModelCatalog()` 对**每个模型**
   都要调一次 `resolveModelInfo()`，一次刷新就是 N 次调用。所以分钟级的负载态不该放进
   胶囊，留在自己行上的组件里（那里可以只读一次快照、按分钟重算）。

3. **只有赢家复现，这套才成立。** 三个插件都注册那格槽时，赢家只有一个。如果赢家
   不画别家的 `badge`，别家的胶囊**永远不会出现**——这正是现在的状态。反过来说，
   这套做法的落地成本集中在一个地方：**赢家的那一个 `if`**。

## 本仓库的落地状态

workbuddy 这半边已经按本文档做完（2026-11-08），两半都在：

| 半边 | 位置 | 测试 |
| --- | --- | --- |
| 发布自己的胶囊 | `src/adapter.ts` 的 `EffortNormalizingAdapter.listModels` | `tests/model-badge-publish.spec.ts` |
| 复现别家的胶囊 | `src/client/WorkBuddyModelLabel.tsx` 的 `HostBadgeChip` + 外来行分支 | `tests/model-label-slot-coexistence.spec.tsx` |

workbuddy 发出去的是**当前生效的那一枚促销**（`限时免费` / `夜间折扣` 之类）。
上游促销**通常只有中文文案**（没有 `labelEn`），这时 `en = labelEn ?? label` 让两语相同，
于是退化成**纯字符串**——英文用户会看到中文胶囊。这是**有意的取舍**：上游只给了一种文案，
编一个英文出来就是伪造。只有上游确实提供了英文时才会发 `{ en, zh }` 双语表。

负载 🚦 与「新模型」标记**不进**胶囊——理由见上面「三个已知边界」第 2 条，
它们留在 workbuddy 自己行的组件里。

⚠️ **别把「插件本地的 `dsh-llm` 版本」和「宿主版本」搞混**（这是最容易误判的一点）：

| 哪一份 | 版本 | 影响什么 |
| --- | --- | --- |
| 本仓库 `node_modules` 里的 `dsh-llm` | 0.1.7-rc.1 | **只影响编译期类型**（没有 `badge` 字段，所以要用展开写法） |
| 实际运行的宿主 app | **0.2.2-rc.1** | **决定运行时 `badge` 是否被保留**——而它 ≥0.2.2，所以会保留 |

丢弃发生在**宿主**的 `LlmRuntime.listModels` 里，不是发生在插件自己的依赖里。所以
workbuddy 发的胶囊在真机上**是有效的**；本地那份 0.1.7 唯一的作用是逼我们用展开写法
写出在 0.1.x 类型下也能编译的代码。trae 与 qoder 的 `node_modules` 也是 0.2.2-rc.1，
但它们真正的运行时同样由宿主决定。

## 自检清单

- [ ] 我的 `listModels()` 返回的每个模型都带 `badge`（或明确不带），并且用的是展开写法？
- [ ] 我在自己的行上画的东西，和给别家行画的东西，是分开的两条路径？
- [ ] 「不是我的 provider」那一支，返回的是 `<span>{model.name}</span>` 还是
      「名字 + 胶囊」？如果是前者，改它。
- [ ] 所有 placement（含 `trigger`）胶囊都在**名字后面**，与我自己行的顺序**一致**？
- [ ] 那条顺序有测试钉住吗？钉的是「自己行与外来行相同」，还是只对着一个写死的字符串？
- [ ] 胶囊与名字是 flex 行的两个子元素，而不是「裸 span + 一个空格」？
- [ ] 别家行的那一支里没有任何请求、快照读取或定时器？
- [ ] 别家行的那一支**不会抛错**（没见过的 `badge` 形状也要安全退化）？
- [ ] `tone` 是四个字面量之一？翻译表里有 `en`、键是小写？
- [ ] 文案按 grapheme 数 ≤ 12？中英混排、emoji 都试过？
- [ ] 在 0.1.x 宿主上跑一遍：不崩、不报错、只是没有胶囊？
- [ ] 我**没有**把胶囊语法写进 `model.name`？
- [ ] 我**没有**为了让别家的胶囊出现，去读别家的槽位注册或渲染别家的组件？

## 与本仓库 `docs/DESIGN.md` §零 的关系

**这不是插件联动，各自改各自的就行。** §零 的四条可执行规则一条都没破：

- 不读别人的注册——`model.badge` 来自宿主目录，不是从 `slots.entries(...)` 里翻出来的；
- 不渲染别人的组件——你画的还是你自己的那颗胶囊；
- 不依赖别人的优先级——这条规则和谁赢那格槽无关；
- 不因别人在场而改变行为——**这一条是关键**：复现 `badge` 只取决于这一行自己的数据。
  trae 装没装、qoder 装没装，你画出来的东西一模一样，代码里没有任何 `if (别人在场)`。

它和 §零 拒绝过的第 2 条（「接管时补画官方徽标」）的区别也在这里：那条要把某个具体插件的
判断和样式**抄进自己的代码**，是硬编码的耦合；这条只是把宿主已经给你的一个字段画出来，
你不知道也不关心是谁填的。数据单向流过宿主，两个插件之间没有任何通道。

所以 §零 那句「契约下限（**纯目录名**）」里的括号会过时——宿主 0.2.2 起它自己的 fallback
就是「名字 + 可选胶囊」，契约下限本身变宽了。这只是一处**描述需要跟上**，不是不变量要让步：
顺手把那半句改成「目录名，以及该模型自带的 `model.badge`（0.2.2 起）」即可，不必当成
开工前的门槛。

**真正的绊线**只有一条：如果你开始写 `if (某个插件装了)`、或者去枚举同槽位的注册来决定
画什么，那就越界了，停下。

