# OCard

内部 DIT 素材备份管理工具：插卡 → 按规范自动建夹拷卡（HASH 校验、多目的地）→ 预览分类选片 → 转码/代理 → 交付打包，全程留痕，素材不出内网。

跨平台桌面应用（Windows / macOS / Linux），基于 Tauri 2（Rust 核心 + React UI）。

- 产品需求文档：[docs/superpowers/specs/2026-08-24-ocard-prd.md](docs/superpowers/specs/2026-08-24-ocard-prd.md)
- 流程依据：《摄影前后期技术规格和数据管理流程规范 OB/GF 001—2026（第2版）》

## 开发

```bash
pnpm install
pnpm tauri dev
```

前置依赖：Node 22+、Rust stable；Linux 另需 `libwebkit2gtk-4.1-dev` 等系统库（见 `.github/workflows/ci.yml`）。

## 构建与发布

- CI：push / PR 触发,三平台 lint + test + 打包,产物见 Actions Artifacts。
- 发布：打 `v*` 标签触发 Release 工作流,自动构建三平台安装包（msi / dmg / AppImage / deb / rpm）并挂到 GitHub Release（草稿）。
