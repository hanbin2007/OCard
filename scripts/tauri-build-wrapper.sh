#!/usr/bin/env bash
# tauri-action 的 tauriScript 包装:构建照常走 pnpm tauri,Linux 的 build
# 结束后就地修复 AppImage(剔除捆绑 libwayland,见 fix-appimage-wayland.sh)
# 并重签名 —— 必须发生在 tauri-action 收集产物/生成 latest.json 之前,
# 所以只能包在 tauriScript 里,不能做成 workflow 的后置 step。
set -euo pipefail

pnpm tauri "$@"

if [[ "${1:-}" == "build" && "$(uname -s)" == "Linux" ]]; then
  shopt -s nullglob
  APPIMAGES=(src-tauri/target/release/bundle/appimage/*.AppImage)
  shopt -u nullglob
  if [[ ${#APPIMAGES[@]} -eq 0 ]]; then
    # Linux build 却没有 AppImage 产物 = 打包配置漂移,显式报错而非静默跳过
    echo "::error::tauri build 后未找到任何 AppImage 产物" >&2
    exit 1
  fi
  bash "$(dirname "${BASH_SOURCE[0]}")/fix-appimage-wayland.sh" --smoke "${APPIMAGES[@]}"
fi
