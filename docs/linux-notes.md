# Linux 工作站部署注意(M3)

## 中文字体(必装)

界面全中文。Linux 桌面发行版默认可能不含 CJK 字体,缺失时界面显示为方块(豆腐块)。

- **.deb 安装(推荐)**:包已声明依赖 `fonts-noto-cjk`,apt 会自动安装。
- **AppImage / .rpm**:请手动安装等价字体包:
  - Debian/Ubuntu:`sudo apt install fonts-noto-cjk`
  - Fedora:`sudo dnf install google-noto-sans-cjk-vf-fonts`
  - Arch:`sudo pacman -S noto-fonts-cjk`

## 其他

- 创建时间(btime):Linux 文件系统不支持设置文件创建时间,拷贝后创建时间为
  拷贝时刻(mtime 与源一致)——见收敛文档声明边界。
- VAAPI 硬件编码需要 `/dev/dri/renderD128` 可访问(用户加入 `render`/`video` 组)。
