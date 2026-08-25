#!/usr/bin/env bash
# AppImage 修复:剔除过度捆绑的 libwayland-*,根治 Mesa 25+/Wayland 宿主上
# WebKitWebProcess "Could not create default EGL display: EGL_BAD_PARAMETER"
# 崩溃(实机复现,tauri-apps/tauri#15665)。
#
# 机理:linuxdeploy 把 Ubuntu 24.04 的 libwayland-client 1.22 打进 AppImage,
# webkit 经 RUNPATH 先加载它;宿主 Mesa 25+ 的 EGL Wayland 平台需要更新的
# libwayland 符号/行为 → 同名库已被旧版占位 → EGL display 创建失败 → webkit
# 2.5x 里 EGL 是硬依赖(实测任何 WEBKIT_DISABLE_* 都救不回) → SIGABRT。
# 删掉捆绑副本后,加载器自然回落到宿主 libwayland,与宿主 Mesa 天然配套。
# (2022+ 年代的发行版 libwayland 均 ≥1.20,webkit 2.5x 本就要求 glibc 2.35+,
# 不存在"宿主没有 libwayland"的目标环境。)
#
# 用法: fix-appimage-wayland.sh [--smoke] <xxx.AppImage>...
#   就地重打包;设置了 TAURI_SIGNING_PRIVATE_KEY 时用 tauri signer 重新生成
#   .sig(重打包后原签名必然失效,不重签 = updater 链路静默坏死)。
#   --smoke: 重打包后解包实跑冒烟(xvfb),确认应用真能启动。
#
# fail-closed:每一步显式判错;要删的库不存在(上游打包布局变了)也算失败,
# 绝不静默放行一个没修过的产物。
set -euo pipefail

SMOKE=0
if [[ "${1:-}" == "--smoke" ]]; then
  SMOKE=1
  shift
fi

if [[ $# -eq 0 ]]; then
  echo "::error::fix-appimage-wayland: 未传入任何 AppImage 路径" >&2
  exit 1
fi

# 要剔除的捆绑库(soname 前缀匹配,含符号链接)
WAYLAND_LIBS=(
  libwayland-client.so
  libwayland-cursor.so
  libwayland-egl.so
  libwayland-server.so
)

for APPIMAGE in "$@"; do
  if [[ ! -f "$APPIMAGE" ]]; then
    echo "::error::AppImage 不存在: $APPIMAGE" >&2
    exit 1
  fi
  echo "==> 修复 $APPIMAGE"
  chmod +x "$APPIMAGE"

  OFFSET=$("$APPIMAGE" --appimage-offset)
  if ! [[ "$OFFSET" =~ ^[0-9]+$ ]] || [[ "$OFFSET" -le 0 ]]; then
    echo "::error::--appimage-offset 取值异常: '$OFFSET'" >&2
    exit 1
  fi

  WORK=$(mktemp -d)
  trap 'rm -rf "$WORK"' EXIT

  # 解包(unsquashfs 不需要 FUSE,CI 容器友好)
  unsquashfs -q -no-progress -o "$OFFSET" -d "$WORK/AppDir" "$APPIMAGE" >/dev/null

  LIBDIR="$WORK/AppDir/usr/lib"
  for lib in "${WAYLAND_LIBS[@]}"; do
    matches=("$LIBDIR/$lib"*)
    if [[ ! -e "${matches[0]}" ]]; then
      # 库没了 = tauri/linuxdeploy 打包布局变了,本脚本假设失效,必须人工复查
      echo "::error::预期存在的捆绑库缺失: $LIBDIR/$lib*(打包布局变更?)" >&2
      exit 1
    fi
    rm -f "$LIBDIR/$lib"*
    echo "    已剔除 $lib*"
  done

  # 重打包:复用原 AppImage 自带的 runtime 头 + 相同压缩参数(zstd/128K)
  head -c "$OFFSET" "$APPIMAGE" > "$WORK/runtime"
  mksquashfs "$WORK/AppDir" "$WORK/new.squashfs" \
    -comp zstd -b 131072 -all-root -noappend -quiet -no-progress >/dev/null
  cat "$WORK/runtime" "$WORK/new.squashfs" > "$WORK/new.AppImage"
  chmod +x "$WORK/new.AppImage"

  # 核查:新包里 wayland 库必须为 0,webkit 必须还在(防止删错/打包半途损坏)
  NEW_OFFSET=$("$WORK/new.AppImage" --appimage-offset)
  LISTING=$(unsquashfs -l -o "$NEW_OFFSET" "$WORK/new.AppImage")
  if grep -q "libwayland-" <<<"$LISTING"; then
    echo "::error::重打包后仍含 libwayland-*,修复未生效" >&2
    exit 1
  fi
  if ! grep -q "libwebkit2gtk-4.1.so" <<<"$LISTING"; then
    echo "::error::重打包后 libwebkit2gtk 缺失,产物损坏" >&2
    exit 1
  fi

  if [[ "$SMOKE" -eq 1 ]]; then
    # 冒烟:解包实跑,应用启动日志出现即算过(无 GPU 环境,验证的是"能起来")
    ( cd "$WORK" && ./new.AppImage --appimage-extract >/dev/null )
    set +e
    timeout 45 xvfb-run -a dbus-run-session -- "$WORK/squashfs-root/AppRun" \
      > "$WORK/smoke.log" 2>&1
    set -e
    if ! grep -q "OCard 启动" "$WORK/smoke.log"; then
      echo "::error::冒烟失败:修复后的 AppImage 未见启动日志。输出:" >&2
      tail -30 "$WORK/smoke.log" >&2
      exit 1
    fi
    if grep -q "Aborting" "$WORK/smoke.log"; then
      echo "::error::冒烟失败:修复后的 AppImage 仍有进程 abort。输出:" >&2
      grep -a "Abort" "$WORK/smoke.log" >&2
      exit 1
    fi
    echo "    冒烟通过(应用启动,无 abort)"
  fi

  mv "$WORK/new.AppImage" "$APPIMAGE"
  rm -rf "$WORK"
  trap - EXIT

  # 重签名:updater 校验的是 .sig,重打包后旧签名必然失效
  if [[ -n "${TAURI_SIGNING_PRIVATE_KEY:-}" ]]; then
    pnpm tauri signer sign "$APPIMAGE"
    if [[ ! -s "$APPIMAGE.sig" ]]; then
      echo "::error::重签名后 $APPIMAGE.sig 缺失或为空" >&2
      exit 1
    fi
    echo "    已重签名 $(basename "$APPIMAGE").sig"
  else
    echo "    未设置 TAURI_SIGNING_PRIVATE_KEY,跳过重签名(仅限本地/CI 验证场景)"
  fi

  echo "==> 完成 $APPIMAGE"
done
