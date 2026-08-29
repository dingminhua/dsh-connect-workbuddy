# Changelog

## Unreleased

### Docs

- 确立溯源与致谢规范：`THIRD_PARTY_NOTICES.md` 完整记录参考项目及其许可证；README 与 README.en.md 的致谢章节按「连接内核的参照 / 插件外观与结构的基准」两类如实标注来源。
- `dsh-codex-connect`（Apache-2.0）作为唯一非 MIT 参考项，其第 4 条声明义务（保留声明、声明未修改、NOTICE 说明）在 `THIRD_PARTY_NOTICES.md` 中单独履行。
- `docs/DESIGN.md` 第 5.3 节确立源文件头标注规范：每个借鉴自参考项目的文件必须写明「参考了谁 / 参考了什么 / 改动了什么」。
- `RELEASING.md` 将「核对溯源与致谢」列为发布前强制步骤，防止后续发版遗漏。
