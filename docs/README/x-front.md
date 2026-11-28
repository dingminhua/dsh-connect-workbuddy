<!-- 原版 README 章节逐字归档：__front__。返回总览：../../README.md -->

<p align="center">
  <img src="docs/assets/dsh-connect-workbuddy-usage-card.png" width="640" alt="dsh-connect-workbuddy 设置卡：模型目录与倍率、图片与可关闭思考开关、活动标签（本页不含任何账号信息）" />
</p>

<h1 align="center">dsh-connect-workbuddy</h1>

<p align="center"><b>把本机登录的 WorkBuddy 模型（国内版与国际版）接入 DeepSeek Harness —— 每次刷新自动读取每个模型的积分倍率，逐模型开关图片输入，多账号可切换，并带每日签到与只读积分概览（卡片与输入框里的胶囊读数）。</b></p>

<p align="center">
  <a href="README.en.md">English</a> ·
  <a href="#安装">安装</a> ·
  <a href="#工作原理">工作原理</a> ·
  <a href="#账号池">账号池</a> ·
  <a href="CHANGELOG.md">更新日志</a> ·
  <a href="https://github.com/dingminhua/dsh-connect-workbuddy/issues">问题反馈</a>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/dsh-connect-workbuddy"><img src="https://img.shields.io/npm/v/dsh-connect-workbuddy?style=flat-square&label=npm&color=cb3837" alt="npm version"></a>
  <a href="https://www.npmjs.com/package/dsh-connect-workbuddy"><img src="https://img.shields.io/npm/d18m/dsh-connect-workbuddy?style=flat-square&label=downloads&color=cb3837" alt="npm downloads"></a>
  <a href="https://github.com/dingminhua/dsh-connect-workbuddy/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/dingminhua/dsh-connect-workbuddy/ci.yml?branch=main&style=flat-square&label=tests" alt="test status"></a>
  <a href="LICENSE"><img src="https://img.shields.io/github/license/dingminhua/dsh-connect-workbuddy?style=flat-square" alt="MIT license"></a>
  <a href="https://github.com/dingminhua/dsh-connect-workbuddy/stargazers"><img src="https://img.shields.io/github/stars/dingminhua/dsh-connect-workbuddy?style=flat-square" alt="GitHub stars"></a>
  <a href="https://dshfind.com/plugins/dingminhua/dsh-connect-workbuddy"><img src="https://dshfind.com/api/badge/dingminhua/dsh-connect-workbuddy" alt="dshfind plugin"></a>
</p>

一个独立的 [DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness) bundle 插件。它把本机已登录的 WorkBuddy 账号（**国内版与国际版 WorkBuddy AI 均支持**）接到 DSH 的模型选择器，同时提供账号池、可勾选的模型管理，以及一套围绕积分的只读能力：**每次刷新按上游目录自动读取每个模型的积分倍率**（`x0.79` 这种，倍率完全由上游给出，插件不写死也不猜）、逐模型开关图片输入、多账号切换与账号池自动换号、每日签到、以及卡片与输入框里胶囊式的只读积分读数。**国内版与国际版是两个并行的供应商（`workbuddy` / `workbuddy-global`），可同时使用**；插件设置页以 tab 区分两者，方便统一管理。只需本机 WorkBuddy 的登录态，**或在浏览器里登录一次**即可。

### 图标样式

在设置页的「能力」tab 最下方选择图标样式。默认是本插件自己的图标；另一个皮肤跟随主题的文字颜色。选择会立即应用到侧边栏、页头和面板，并保存在当前浏览器中；其他浏览器需要单独设置。

