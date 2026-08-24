#!/usr/bin/env bash
# 拉取三平台 ffmpeg/ffprobe sidecar 制品(来自本仓 ffmpeg-b1 release),
# SHA-256 强制校验(fail-closed:不匹配即失败,绝不静默用错制品)。
# 用法:scripts/fetch-ffmpeg.sh [target-triple]
#   不传 target 时按当前平台推断。CI 与本地开发共用。
set -euo pipefail
cd "$(dirname "$0")/.."

RELEASE_TAG="ffmpeg-b1"
BASE="https://github.com/hanbin2007/OCard/releases/download/${RELEASE_TAG}"
DEST="src-tauri/binaries"
SUMS="${DEST}/SHA256SUMS.txt"

target="${1:-}"
if [ -z "$target" ]; then
  case "$(uname -s)-$(uname -m)" in
    Darwin-arm64) target="aarch64-apple-darwin" ;;
    Linux-x86_64) target="x86_64-unknown-linux-gnu" ;;
    MINGW*-x86_64|MSYS*-x86_64|CYGWIN*-x86_64) target="x86_64-pc-windows-msvc" ;;
    *) echo "无法推断 target,请显式传入" >&2; exit 1 ;;
  esac
fi

suffix=""
case "$target" in *windows*) suffix=".exe" ;; esac

for tool in ffmpeg ffprobe; do
  name="${tool}-${target}${suffix}"
  path="${DEST}/${name}"
  want="$(grep " ${name}\$" "$SUMS" | awk '{print $1}')"
  if [ -z "$want" ]; then echo "SHA256SUMS.txt 缺少 ${name}" >&2; exit 1; fi
  if [ -f "$path" ]; then
    have="$(shasum -a 256 "$path" 2>/dev/null | awk '{print $1}' || sha256sum "$path" | awk '{print $1}')"
    if [ "$have" = "$want" ]; then echo "已就绪: ${name}"; continue; fi
    echo "本地 ${name} 校验不符,重新下载"
  fi
  echo "下载 ${name} ..."
  curl -fsSL -o "$path" "${BASE}/${name}"
  have="$(shasum -a 256 "$path" 2>/dev/null | awk '{print $1}' || sha256sum "$path" | awk '{print $1}')"
  if [ "$have" != "$want" ]; then
    echo "SHA-256 校验失败: ${name} (got ${have}, want ${want})" >&2
    rm -f "$path"
    exit 1
  fi
  chmod +x "$path"
  echo "校验通过: ${name}"
done
