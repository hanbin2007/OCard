# Linux 工作站部署注意(M3)

## 中文字体(必装)

界面全中文。Linux 桌面发行版默认可能不含 CJK 字体,缺失时界面显示为方块(豆腐块)。

- **.deb 安装(推荐)**:包已声明依赖 `fonts-noto-cjk`,apt 会自动安装。
- **AppImage / .rpm**:请手动安装等价字体包:
  - Debian/Ubuntu:`sudo apt install fonts-noto-cjk`
  - Fedora:`sudo dnf install google-noto-sans-cjk-vf-fonts`
  - Arch:`sudo pacman -S noto-fonts-cjk`

## WebKit 渲染崩溃(WebKitWebProcess SIGABRT)

### 已定位:AppImage + Mesa 25+/Wayland 宿主(EGL_BAD_PARAMETER)

实机 coredump + 靶机复现定位(上游 tauri-apps/tauri#15665):AppImage 里被
linuxdeploy 过度捆绑的 `libwayland-client` 1.22(Ubuntu 24.04)会被 webkit
经 RUNPATH 优先加载;宿主 Mesa 25+ 的 EGL Wayland 平台需要更新的 libwayland,
于是 Wayland 会话下 WebKitWebProcess 创建 EGL display 直接失败:

```
Could not create default EGL display: EGL_BAD_PARAMETER. Aborting...
```

webkit 2.5x 中 EGL 是硬依赖——靶机实测 `WEBKIT_DISABLE_DMABUF_RENDERER`、
`WEBKIT_DISABLE_COMPOSITING_MODE`、`WEBKIT_SKIA_ENABLE_CPU_RENDERING`、
`WEBKIT_DMABUF_RENDERER_FORCE_SHM` 全部拦不住这个 abort。修复分两层:

- **打包层(根治)**:发版流水线就地重打包 AppImage,剔除捆绑的
  `libwayland-{client,cursor,egl,server}`,回落宿主版本(与宿主 Mesa 配套),
  并重新生成 updater 签名 —— `scripts/fix-appimage-wayland.sh`。
- **运行时(防线)**:AppImage 下应用把 `EGL_PLATFORM=x11` 与 AppRun 强制的
  `GDK_BACKEND=x11` 对齐,Mesa 不再因环境里的 `WAYLAND_DISPLAY` 走 Wayland
  平台 —— `src-tauri/src/main.rs`。

### 其他驱动相关规避(启动时自动应用,仅 AppImage)

- `WEBKIT_DISABLE_DMABUF_RENDERER=1`(webkit 2.42+ DMA-BUF 渲染在部分
  驱动上的已知崩溃)
- `WEBKIT_DISABLE_COMPOSITING_MODE=1`(捆绑 webkit 混用宿主 GL 不可信,
  强制软件合成)

.deb/.rpm 用系统 webkit,GL 栈自洽,不动任何开关(CI E2E 实证:系统
webkit 下全局禁 DMA-BUF 反而会让 WebKitWebProcess 中途崩掉)。

已显式设置的同名环境变量不会被覆盖——例如想恢复加速合成可
`WEBKIT_DISABLE_COMPOSITING_MODE=0 ./OCard.AppImage`;
`OCARD_NO_WEBKIT_WORKAROUNDS=1` 可一键停用全部自动规避。
实际生效状态会写入应用日志(`~/.local/share/cn.origenclub.ocard/logs/`,
启动行「Linux WebKit 规避」)。

若仍崩溃,请把终端里 abort 前 stderr 的最后几行(WebKit 的致命 g_error
在这里留明文,最关键)、`coredumpctl info WebKitWebProces` 输出与应用日志
一起反馈。

## 其他

- 创建时间(btime):Linux 文件系统不支持设置文件创建时间,拷贝后创建时间为
  拷贝时刻(mtime 与源一致)——见收敛文档声明边界。
- VAAPI 硬件编码需要 `/dev/dri/renderD128` 可访问(用户加入 `render`/`video` 组)。
