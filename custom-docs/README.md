# custom-docs — 二次开发文档

本目录存放**本 fork 二次开发**产生的模块梳理与开发文档。

## 为什么单独建这个目录

`.agents/`、`document/`、`deploy/` 等是上游 labring/FastGPT 维护的内容，rebase/merge 上游时可能变动；在其中新增文件可能与上游冲突，且官方文档与本地内容混杂不便阅读。`custom-docs/` 上游不存在，物理隔离，**不会与上游冲突**。

## 内容

- `dataset.md` — 知识库(dataset)模块前后端架构与文件方法梳理（基于 v4.15.2）

## 命名约定

按模块命名：`<module>.md`（如 `dataset.md`、`workflow.md`、`chat.md`、`app.md`）。
