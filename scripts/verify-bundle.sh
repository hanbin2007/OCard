#!/usr/bin/env bash
# 校验构建产物中的 sidecar(ffmpeg/ffprobe)与 YuNet 模型:存在性 + SHA-256 钉死。
# fail-closed:任何一项不符即以 ::error:: 注解退出非零,绝不静默放行。
# CI 与 Release 双边共用(.github/workflows/ci.yml、release.yml),本地也可直接跑。
#
# 用法:scripts/verify-bundle.sh [--signed] [bundle-dir]
#   --signed     macOS 已签名产物模式(仅 Release 用)。codesign 会重写 .app 内嵌
#                Mach-O 的字节,包内 sidecar 哈希必然与钉死值不同 → 换成
#                「codesign 有效性 + 钉死源字节」组合校验,并打 ::warning:: 明示降级。
#   bundle-dir   不传时默认 src-tauri/target/release/bundle;不存在再自动探测
#                src-tauri/target/<triple>/release/bundle(tauri build --target 产物)。
set -euo pipefail
cd "$(dirname "$0")/.."

fail() { echo "::error::$1"; exit 1; }
warn() { echo "::warning::$1"; }
need_file() { [ -f "$1" ] || fail "缺少 $1"; }
need_exec() { [ -x "$1" ] || fail "缺少或不可执行 $1"; }
sha_of() { shasum -a 256 "$1" 2>/dev/null | awk '{print $1}' || sha256sum "$1" | awk '{print $1}'; }

SIGNED=0
BUNDLE=""
while [ $# -gt 0 ]; do
  case "$1" in
    --signed) SIGNED=1 ;;
    -h|--help) sed -n '2,13p' "$0"; exit 0 ;;
    -*) fail "verify-bundle.sh 未知参数: $1" ;;
    *) BUNDLE="$1" ;;
  esac
  shift
done

case "$(uname -s)" in
  Darwin) PLATFORM=macOS ;;
  Linux) PLATFORM=Linux ;;
  MINGW* | MSYS* | CYGWIN*) PLATFORM=Windows ;;
  *) fail "未知平台 $(uname -s)" ;;
esac
[ "$SIGNED" -eq 0 ] || [ "$PLATFORM" = macOS ] || fail "--signed 仅适用于 macOS,当前 $PLATFORM"

SUMS="src-tauri/binaries/SHA256SUMS.txt"
need_file "$SUMS"

MODEL_NAME="face_detection_yunet_2023mar.onnx"
# 与 src-tauri/src/core/yunet.rs 的 YUNET_SHA256、resources/models/LICENSE-yunet.txt 同源
MODEL_SHA="8f2383e4dd3cfbb4553ea8718107fc0423210dc964f9f4280604804ed2552fa4"

# 取 SHA256SUMS.txt 中某条目的期望哈希 → 全局 want。
# 刻意不做成 want=$(want_of …):命令替换里的 fail() 只会退出子 shell,
# ::error:: 注解还会被吞进变量 → 变成无注解静默失败。
want=""
want_of() {
  want=$(grep " $1\$" "$SUMS" | awk '{print $1}' || true)
  [ -n "$want" ] || fail "SHA256SUMS.txt 缺少条目 $1"
}

# $1=待校验文件 $2=SHA256SUMS 条目名 $3=人类可读位置说明
check_sha() {
  want_of "$2"
  got=$(sha_of "$1")
  if [ "$got" != "$want" ]; then
    hint=""
    if [ "$PLATFORM" = macOS ] && codesign -dv "$1" >/dev/null 2>&1; then
      hint=";该文件已带 codesign 签名,签名会重写 Mach-O 字节 → Release 侧应传 --signed"
    fi
    fail "$3 SHA 不符: got $got, want $want$hint"
  fi
  echo "  ok  $3"
}

# --signed 模式下,包内 sidecar 改用签名有效性把关。必须是真身份签发:
# ad-hoc(codesign -s -)任何人都能造,放行等于没验 → 显式拒绝。
# $1=待校验文件 $2=位置说明
require_real_signature() {
  codesign --verify --strict "$1" || fail "$2 codesign 校验未通过"
  info=$(codesign -dvvv "$1" 2>&1 || true)
  case "$info" in
    *"Signature=adhoc"*) fail "$2 仅为 ad-hoc 签名(未用 Developer ID),拒绝发布" ;;
  esac
  printf '%s\n' "$info" | grep -q "^Authority=" || fail "$2 签名缺少 Authority(非可信身份签发),拒绝发布"
  echo "  ok  $2 codesign(Authority: $(printf '%s\n' "$info" | grep -m1 "^Authority=" | cut -d= -f2-))"
}

# $1=模型文件 $2=位置说明
check_model() {
  got=$(sha_of "$1")
  [ "$got" = "$MODEL_SHA" ] || fail "$2 模型 SHA 不符: got $got, want $MODEL_SHA"
  echo "  ok  $2 模型"
}

# find 一律用 -print -quit 取首个结果:`find | head -1` 在 pipefail 下会因 head
# 提前关闭管道让 find 吃 SIGPIPE(141),整步无注解终止。语义等价、无管道。
# 末尾统一 `|| true`,让 find 自身失败(目录不存在)也走到下面的显式判空 fail()。
if [ -z "$BUNDLE" ]; then
  BUNDLE="src-tauri/target/release/bundle"
  if [ ! -d "$BUNDLE" ]; then
    BUNDLE=$(find src-tauri/target -maxdepth 3 -type d -path "*/release/bundle" -print -quit || true)
  fi
fi
[ -n "$BUNDLE" ] || fail "未找到 bundle 目录(可显式传参:scripts/verify-bundle.sh <bundle-dir>)"
[ -d "$BUNDLE" ] || fail "bundle 目录不存在: $BUNDLE"
# externalBin 暂存产物(tauri 从这里拷进包)与 bundle 同级,即 …/release
STAGE="$(dirname "$BUNDLE")"

echo "verify-bundle: platform=$PLATFORM signed=$SIGNED bundle=$BUNDLE"

case "$PLATFORM" in
  macOS)
    APP=$(find "$BUNDLE/macos" -maxdepth 1 -name "*.app" -print -quit || true)
    [ -n "$APP" ] || fail "未找到 .app($BUNDLE/macos)"
    need_exec "$APP/Contents/MacOS/ffmpeg"
    need_exec "$APP/Contents/MacOS/ffprobe"
    MODEL=$(find "$APP/Contents/Resources" -name "$MODEL_NAME" -print -quit || true)
    [ -n "$MODEL" ] || fail "app 内缺少 YuNet 模型"
    # 资源文件不会被 codesign 改写,两种模式下一律字节钉死
    check_model "$MODEL" "app 内"
    # 硬编码 aarch64:CI 用 macos-latest、Release 钉 macos-15,当前均为 arm64。
    # 若 runner 架构漂移,want_of 会以 ::error:: 明确报「缺少条目」,不会静默放行。
    if [ "$SIGNED" -eq 1 ]; then
      # 降级说明(禁止无提示 fail-open):签名后包内字节必变,改验签名有效性,
      # 字节等价性由「钉死的暂存源 + CI macOS 腿走同一 bundling 路径」共同覆盖。
      warn "已签名产物:跳过 .app 内 sidecar 字节比对(codesign 会重写 Mach-O),改为校验 codesign 有效性 + 暂存源字节;包内字节一致性由 CI macOS 腿覆盖同一打包路径"
      require_real_signature "$APP/Contents/MacOS/ffmpeg" "app 内 ffmpeg"
      require_real_signature "$APP/Contents/MacOS/ffprobe" "app 内 ffprobe"
      check_sha "src-tauri/binaries/ffmpeg-aarch64-apple-darwin" "ffmpeg-aarch64-apple-darwin" "暂存源 ffmpeg"
      check_sha "src-tauri/binaries/ffprobe-aarch64-apple-darwin" "ffprobe-aarch64-apple-darwin" "暂存源 ffprobe"
    else
      check_sha "$APP/Contents/MacOS/ffmpeg" "ffmpeg-aarch64-apple-darwin" "app 内 ffmpeg"
      check_sha "$APP/Contents/MacOS/ffprobe" "ffprobe-aarch64-apple-darwin" "app 内 ffprobe"
    fi
    ;;
  Linux)
    DEB=$(find "$BUNDLE/deb" -name "*.deb" -print -quit || true)
    [ -n "$DEB" ] || fail "未找到 .deb($BUNDLE/deb)"
    tmp=$(mktemp -d)
    trap 'rm -rf "$tmp"' EXIT
    dpkg-deb -x "$DEB" "$tmp"
    FF=$(find "$tmp" -name ffmpeg -type f -print -quit || true)
    [ -n "$FF" ] || fail ".deb 内缺少 ffmpeg"
    check_sha "$FF" "ffmpeg-x86_64-unknown-linux-gnu" ".deb 内 ffmpeg"
    FP=$(find "$tmp" -name ffprobe -type f -print -quit || true)
    [ -n "$FP" ] || fail ".deb 内缺少 ffprobe"
    check_sha "$FP" "ffprobe-x86_64-unknown-linux-gnu" ".deb 内 ffprobe"
    MODEL=$(find "$tmp" -name "$MODEL_NAME" -print -quit || true)
    [ -n "$MODEL" ] || fail ".deb 内缺少 YuNet 模型"
    check_model "$MODEL" ".deb 内"
    ;;
  Windows)
    # 安装包内容核查由 mac/linux 腿覆盖同一打包路径(声明边界);
    # 此处验暂存产物存在性 + ffmpeg/ffprobe/模型三者 SHA-256 全钉死
    need_file "$STAGE/ffmpeg.exe"
    need_file "$STAGE/ffprobe.exe"
    check_sha "$STAGE/ffmpeg.exe" "ffmpeg-x86_64-pc-windows-msvc.exe" "暂存 ffmpeg.exe"
    check_sha "$STAGE/ffprobe.exe" "ffprobe-x86_64-pc-windows-msvc.exe" "暂存 ffprobe.exe"
    MODEL=$(find "$STAGE" -name "$MODEL_NAME" -print -quit || true)
    [ -n "$MODEL" ] || fail "缺少 YuNet 模型暂存"
    check_model "$MODEL" "暂存"
    ;;
esac

echo "sidecars + model verified (SHA-256)"
