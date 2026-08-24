# ffmpeg sidecar 许可证声明(M3 D1)

OCard 随安装包分发 FFmpeg 的 **GPL 静态构建**(ffmpeg / ffprobe),用于转码引擎
(PRD §5.6)。FFmpeg 是 FFmpeg 团队的作品,依 **GPL v3** 许可分发。

## 制品来源与版本

| 平台 | 版本 | 构建来源 |
|---|---|---|
| Windows x86_64 | FFmpeg n8.1(gpl) | [BtbN/FFmpeg-Builds](https://github.com/BtbN/FFmpeg-Builds)(`ffmpeg-n8.1-latest-win64-gpl-8.1`) |
| Linux x86_64 | FFmpeg n8.1(gpl) | [BtbN/FFmpeg-Builds](https://github.com/BtbN/FFmpeg-Builds)(`ffmpeg-n8.1-latest-linux64-gpl-8.1`) |
| macOS aarch64 | FFmpeg 9.0.1(gpl) | [ffmpeg.martin-riedl.de](https://ffmpeg.martin-riedl.de/)(release/arm64) |

制品镜像托管于本仓库 release [`ffmpeg-b1`](https://github.com/hanbin2007/OCard/releases/tag/ffmpeg-b1);
SHA-256 清单在 `src-tauri/binaries/SHA256SUMS.txt`,`scripts/fetch-ffmpeg.sh`
下载后强制校验(不匹配即失败)。

## 源码获取(GPL 义务)

- FFmpeg 源码:<https://ffmpeg.org/download.html>(对应 n8.1 / 9.0.1 标签)
- BtbN 构建脚本与各依赖库源码指引:<https://github.com/BtbN/FFmpeg-Builds>
- martin-riedl.de 构建说明:<https://ffmpeg.martin-riedl.de/>

OCard 本身是内部工具;若向外分发安装包,分发者有义务随包提供本声明与上述
源码获取途径。GPL 全文见 <https://www.gnu.org/licenses/gpl-3.0.html>。
