// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

/// Linux WebKitGTK 崩溃规避:必须在任何 GTK/WebKit 初始化之前设置环境变量,
/// 否则 WebKitWebProcess 继承不到,等于没设。
///
/// 背景:用户实机(新内核 + 新显卡驱动)上 WebKitWebProcess 收 SIGABRT 崩溃。
/// webkit2gtk 2.42+ 的 DMA-BUF 渲染路径在 NVIDIA 私有驱动、以及
/// AppImage(捆绑 Ubuntu 的 webkit 混用宿主机 GL/mesa)场景下是已知崩溃源
/// (tauri-apps/tauri#9304 等)。
///
/// 策略:
/// - 用户已显式设置的变量绝不覆盖(可用 `WEBKIT_DISABLE_DMABUF_RENDERER=0` 关掉);
/// - `OCARD_NO_WEBKIT_WORKAROUNDS=1` 一键停用全部自动规避(排障用);
/// - 所有安装形态:禁用 DMA-BUF 渲染器;
/// - 仅 AppImage(`APPIMAGE` 环境变量存在):再禁用加速合成,整个渲染走软件路径
///   ——捆绑 webkit + 宿主 GL 的组合里 GL 栈本身不可信,稳定性优先于渲染性能。
///   .deb/.rpm 用系统 webkit,GL 栈自洽,保留加速合成。
#[cfg(target_os = "linux")]
fn apply_linux_webkit_workarounds() {
    if std::env::var_os("OCARD_NO_WEBKIT_WORKAROUNDS").is_some_and(|v| v == "1") {
        eprintln!("OCard: OCARD_NO_WEBKIT_WORKAROUNDS=1,跳过全部 WebKit 崩溃规避");
        return;
    }
    let set_default = |key: &str, why: &str| {
        if std::env::var_os(key).is_none() {
            std::env::set_var(key, "1");
            eprintln!("OCard: 已设置 {key}=1({why})");
        }
    };
    set_default(
        "WEBKIT_DISABLE_DMABUF_RENDERER",
        "规避 webkit2gtk 2.42+ DMA-BUF 渲染在部分驱动上的 WebKitWebProcess 崩溃",
    );
    if std::env::var_os("APPIMAGE").is_some() {
        set_default(
            "WEBKIT_DISABLE_COMPOSITING_MODE",
            "AppImage 捆绑 webkit 混用宿主 GL 不可信,强制软件合成保稳定",
        );
    }
}

fn main() {
    #[cfg(target_os = "linux")]
    apply_linux_webkit_workarounds();
    ocard_lib::run()
}
