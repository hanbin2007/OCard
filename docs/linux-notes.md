# Linux 工作站部署注意(M3)

## 中文字体(必装)

界面全中文。Linux 桌面发行版默认可能不含 CJK 字体,缺失时界面显示为方块(豆腐块)。

- **.deb 安装(推荐)**:包已声明依赖 `fonts-noto-cjk`,apt 会自动安装。
- **AppImage / .rpm**:请手动安装等价字体包:
  - Debian/Ubuntu:`sudo apt install fonts-noto-cjk`
  - Fedora:`sudo dnf install google-noto-sans-cjk-vf-fonts`
  - Arch:`sudo pacman -S noto-fonts-cjk`

## WebKit 渲染崩溃(WebKitWebProcess SIGABRT)

新内核/新显卡驱动(尤其 NVIDIA 私有驱动)上,webkit2gtk 2.42+ 的 DMA-BUF
渲染路径存在已知崩溃;AppImage 形态还叠加了「捆绑 Ubuntu webkit + 宿主机
GL/mesa 混用」这一不稳定组合。应用启动时自动应用以下规避(见
`src-tauri/src/main.rs`):

- 所有安装形态:`WEBKIT_DISABLE_DMABUF_RENDERER=1`
- 仅 AppImage:追加 `WEBKIT_DISABLE_COMPOSITING_MODE=1`(强制软件合成)

已显式设置的同名环境变量不会被覆盖——例如想恢复加速合成可
`WEBKIT_DISABLE_COMPOSITING_MODE=0 ./OCard.AppImage`;
`OCARD_NO_WEBKIT_WORKAROUNDS=1` 可一键停用全部自动规避。
实际生效状态会写入应用日志(`~/.local/share/cn.origenclub.ocard/logs/`,
启动行「Linux WebKit 规避」)。

若仍崩溃,请再试 `GDK_BACKEND=x11 ./OCard.AppImage`(排除 Wayland 合成器
兼容性),并附上 `coredumpctl info WebKitWebProces` 输出与应用日志反馈。

## 其他

- 创建时间(btime):Linux 文件系统不支持设置文件创建时间,拷贝后创建时间为
  拷贝时刻(mtime 与源一致)——见收敛文档声明边界。
- VAAPI 硬件编码需要 `/dev/dri/renderD128` 可访问(用户加入 `render`/`video` 组)。
