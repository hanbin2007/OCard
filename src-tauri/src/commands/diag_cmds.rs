//! 一键导出诊断报告。
//!
//! 起因是 0.4.3 的一次现场事故:Windows 上拷卡中断,用户看到一句
//! 「IO 错误: 拒绝访问。 (os error 5)」,然后**没有任何办法**把现场发出来——
//! 运行日志躺在 `%LOCALAPPDATA%\cn.origenclub.ocard\logs\` 里,界面上一个入口都没有。
//! 能看见但取不走,排障就只能靠猜。
//!
//! 报告是**一个纯文本文件**:能直接拖进聊天窗口发出去,不用先解释怎么打包。
//! 内容只有排障要用的东西(版本 / 系统 / 任务状态 / 通知记录 / 日志尾巴),
//! 但里面**含项目与素材路径**——这一点在文件抬头写明,让人知道自己在发什么。

use super::{notify, AppState};
use chrono::Local;
use std::fmt::Write as _;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager, State};

/// 日志尾巴的上限。整份日志单文件可达 5MB,全塞进去没人看得动,
/// 也发不出去;最近这些足够覆盖一次拷卡任务的全过程。
const LOG_TAIL_BYTES: usize = 512 * 1024;

/// 一份报告里最多写几条通知。通知积压上限本身是 500。
const MAX_NOTICES: usize = 500;

/// 生成诊断报告并在文件管理器里选中它。返回报告文件的完整路径。
///
/// `#[tauri::command(async)]`:要读日志目录,可能落在半死的网络盘上;
/// 同步命令跑在主线程,一卡就是整个界面冻住。
#[tauri::command(async)]
pub async fn export_diagnostics<R: tauri::Runtime>(
    app: AppHandle<R>,
    state: State<'_, AppState>,
) -> Result<ExportedReport, String> {
    // 报告里全是阻塞 IO(可达性探测、读日志目录、读 5MB 日志)。async 命令跑在
    // tokio 上,直接在里面阻塞会占住运行时线程;搬到专用阻塞线程上去。
    let report = {
        let app2 = app.clone();
        let snapshot = ReportInputs::capture(&state);
        tauri::async_runtime::spawn_blocking(move || build_report_from(&app2, &snapshot))
            .await
            .map_err(|e| format!("生成诊断报告的线程异常终止: {e}"))?
    };
    // 毫秒 + create_new:toast 与面板各有一个导出按钮,同一秒内两次导出不许互相覆盖
    let stamp = Local::now().format("%Y%m%d-%H%M%S-%3f");
    let name = format!("OCard-诊断报告-{stamp}.txt");

    // 候选落点按优先级**逐个真的写**:「下载」能解析出来但不可写(企业机的
    // 同步目录、只读配置)时,此前直接报失败,后面的候选一个都不试。
    // 落点不是「下载」时必须说:换个位置本身是降级,用户按经验去下载夹找
    // 会一无所获,然后以为导出没成功
    let (dirs, unresolved) = report_dirs(&app);
    let (path, mut skipped) = write_to_first_writable(&dirs, &name, &report)?;
    // 「下载」连路径都解析不出来时,前面 skipped 是空的,但落点已经不是下载了——
    // 一样要说,否则用户按经验去下载夹找,一无所获
    if let Some(why) = unresolved {
        skipped.insert(0, why);
    }
    if !skipped.is_empty() {
        notify::warn(
            &app,
            "diagnostics-dir-fallback",
            format!(
                "「下载」目录写不进去({}),诊断报告改放到:{}",
                skipped.join(";"),
                path.display()
            ),
        );
    }

    // 打不开文件管理器不算失败:文件已经在那儿了,路径也回给了界面。
    // 但零静默——退化要说出来,否则用户会一直等一个不会弹出的窗口。
    // `revealed` 一并回给界面:设置页此前无条件写「文件管理器已打开」,
    // 和通知中心那句「没能打开」当面打架。
    let revealed = match tauri_plugin_opener::reveal_item_in_dir(&path) {
        Ok(()) => true,
        Err(e) => {
            notify::warn(
                &app,
                "diagnostics-reveal-failed",
                format!(
                    "诊断报告已生成,但没能打开文件管理器({e});请手动打开:{}",
                    path.display()
                ),
            );
            false
        }
    };
    log::info!("诊断报告已导出: {}", path.display());
    Ok(ExportedReport {
        path: path.to_string_lossy().into_owned(),
        revealed,
    })
}

/// 导出结果。`revealed` 必须回给界面:文件管理器没弹出来时,界面不能还写着
/// 「已打开」——用户会盯着屏幕等一个不会来的窗口。
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportedReport {
    pub path: String,
    pub revealed: bool,
}

/// 把报告落到盘上。单独成函数是为了能在临时目录里直接考它——
/// 命令本体会往用户的「下载」里写,测试不该去碰那儿。
fn write_report_to(dir: &Path, name: &str, report: &str) -> Result<PathBuf, String> {
    std::fs::create_dir_all(dir).map_err(|e| {
        format!(
            "创建报告目录失败: {} —— {}",
            dir.display(),
            crate::core::error::explain_io(&e)
        )
    })?;
    let path = dir.join(name);
    std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&path)
        .and_then(|mut f| std::io::Write::write_all(&mut f, report.as_bytes()))
        .map_err(|e| {
            format!(
                "写入诊断报告失败: {} —— {}",
                path.display(),
                crate::core::error::explain_io(&e)
            )
        })?;
    Ok(path)
}

/// 按顺序逐个**真的写**,第一个写成功的算数;返回落点与前面写失败的原因
/// (非空 = 发生了降级,调用方必须说出来)。全都写不进去才报错。
fn write_to_first_writable(
    dirs: &[PathBuf],
    name: &str,
    report: &str,
) -> Result<(PathBuf, Vec<String>), String> {
    let mut failures: Vec<String> = Vec::new();
    for dir in dirs {
        match write_report_to(dir, name, report) {
            Ok(p) => return Ok((p, failures)),
            Err(e) => failures.push(e),
        }
    }
    Err(format!(
        "诊断报告写不进任何一个候选目录:{}",
        failures.join(";")
    ))
}

/// 报告的候选落点,按优先级:「下载」→「桌面」→ 日志目录 → 临时目录。
/// 全部列出来由调用方逐个真写——「能解析出路径」不等于「写得进去」。
/// 第二个返回值:「下载」目录**解析不出来**的原因(有的话)——它不会出现在
/// 写失败列表里,但同样意味着落点不是下载,必须告知。
fn report_dirs<R: tauri::Runtime>(app: &AppHandle<R>) -> (Vec<PathBuf>, Option<String>) {
    let p = app.path();
    let download = p.download_dir();
    let unresolved = download
        .as_ref()
        .err()
        .map(|e| format!("下载目录解析失败:{e}"));
    let mut out: Vec<PathBuf> = [download.ok(), p.desktop_dir().ok(), p.app_log_dir().ok()]
        .into_iter()
        .flatten()
        .collect();
    out.push(std::env::temp_dir());
    out.dedup();
    (out, unresolved)
}

/// 从 `AppState` 里拷一份报告要用的数据。
///
/// `State<'_, AppState>` 借用 `self`,过不了 `spawn_blocking` 的 `'static`;
/// 而且这些锁本来就不该跨越一次可能长达数秒的阻塞探测。
pub(crate) struct ReportInputs {
    pub machine_id: String,
    pub config_dir: PathBuf,
    pub tasks: Vec<crate::commands::dto::CopyTaskDto>,
    pub notices: Vec<notify::NoticeDto>,
}

impl ReportInputs {
    pub fn capture(state: &AppState) -> Self {
        Self {
            machine_id: state.machine_id.clone(),
            config_dir: state.config_dir.clone(),
            // 必须用 detailed_snapshots:`snapshots()` 走 summary_of,会把 files 清空
            tasks: state.tasks.detailed_snapshots(),
            // 中毒也照读:诊断导出是故障之后的最后出口,不能因为别处 panic 过就跟着炸
            notices: state
                .notices
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .clone(),
        }
    }
}

/// 测试入口:直接从 `AppState` 采一次再生成(生产路径见 `export_diagnostics`)。
#[cfg(test)]
pub(crate) fn build_report<R: tauri::Runtime>(app: &AppHandle<R>, state: &AppState) -> String {
    build_report_from(app, &ReportInputs::capture(state))
}

pub(crate) fn build_report_from<R: tauri::Runtime>(
    app: &AppHandle<R>,
    state: &ReportInputs,
) -> String {
    let mut s = String::with_capacity(64 * 1024);

    let _ = writeln!(s, "OCard 诊断报告");
    let _ = writeln!(
        s,
        "生成时间: {}",
        Local::now().format("%Y-%m-%d %H:%M:%S %:z")
    );
    let _ = writeln!(
        s,
        "=========================================================="
    );
    let _ = writeln!(s);
    let _ = writeln!(
        s,
        "【这份文件里有什么】排障要靠这些定位,所以都带上了:\n\
         · 操作人姓名、本机机器 ID\n\
         · 项目名、NAS 路径、配置与日志目录(路径里通常含本机登录用户名)\n\
         · 素材文件名与失败原因(**不含素材文件本身**)\n\
         · 界面上出现过的提示原文(最多最近 500 条,更早的已被积压上限丢弃)\n\
         · 最近 {} KB 运行日志(自由文本,内容以实际记录为准)\n\
         发之前可以先打开看一眼;确认没问题再整份发给维护者。",
        LOG_TAIL_BYTES / 1024
    );
    let _ = writeln!(s);

    section(&mut s, "运行环境");
    let _ = writeln!(s, "OCard 版本   : {}", env!("CARGO_PKG_VERSION"));
    let _ = writeln!(
        s,
        "操作系统     : {} / {}",
        std::env::consts::OS,
        std::env::consts::ARCH
    );
    let _ = writeln!(s, "系统版本     : {}", os_version());
    let _ = writeln!(s, "机器 ID      : {}", state.machine_id);
    let _ = writeln!(s, "配置目录     : {}", state.config_dir.display());
    let _ = writeln!(
        s,
        "日志目录     : {}",
        app.path()
            .app_log_dir()
            .map(|d| d.display().to_string())
            .unwrap_or_else(|_| "(取不到)".into())
    );
    let _ = writeln!(s);

    section(&mut s, "工作站配置");
    let (cfg, cfg_note) = crate::core::config::load_checked(&state.config_dir);
    let nas = cfg.nas_root.clone().unwrap_or_default();
    let _ = writeln!(s, "操作人       : {}", blank_as(&cfg.operator));
    let _ = writeln!(s, "NAS 根       : {}", blank_as(&nas.to_string_lossy()));
    let _ = writeln!(s, "NAS 可达     : {}", reachable(&nas));
    if let Some(note) = cfg_note {
        let _ = writeln!(s, "配置读取告警 : {note}");
    }
    let _ = writeln!(s);

    section(&mut s, "拷卡任务(本次运行期间)");
    let tasks = &state.tasks;
    if tasks.is_empty() {
        let _ = writeln!(s, "(无)");
    }
    for t in tasks {
        let c = super::tasks::status_counts(&t.files);
        let _ = writeln!(
            s,
            "- [{}] {} / 目标夹 {} / 已拷 {} 字节 / 文件 {}(待处理 {} 已拷 {} 已校验 {} 失败 {})",
            t.state,
            t.id,
            t.target_folder,
            t.copied_bytes,
            t.files.len(),
            c.pending,
            c.copied,
            c.verified,
            c.failed,
        );
        for d in &t.destinations {
            if let Some(err) = &d.error {
                let _ = writeln!(s, "    目的地 {} 报错: {err}", d.path);
            }
        }
        // 逐文件失败原文是定位的关键,但一个任务可能失败上千个,只取前 20 条
        let failed: Vec<_> = t.files.iter().filter(|f| f.error.is_some()).collect();
        if !failed.is_empty() {
            let _ = writeln!(
                s,
                "    失败文件 {} 个,前 {} 条:",
                failed.len(),
                failed.len().min(20)
            );
            for f in failed.iter().take(20) {
                let _ = writeln!(s, "      {} — {}", f.path, f.error.as_deref().unwrap_or(""));
            }
        }
    }
    let _ = writeln!(s);

    section(&mut s, "通知记录(界面上出现过的提示,最新在后)");
    let notices = &state.notices;
    if notices.is_empty() {
        let _ = writeln!(s, "(无)");
    }
    for n in notices.iter().rev().take(MAX_NOTICES).rev() {
        let rep = n.repeats.map(|r| format!(" ×{r}")).unwrap_or_default();
        let _ = writeln!(
            s,
            "{} [{}] {}{rep}  {}",
            n.occurred_at, n.level, n.code, n.message
        );
    }
    let _ = writeln!(s);

    section(&mut s, "日志目录内容");
    match app.path().app_log_dir() {
        Ok(dir) => match std::fs::read_dir(&dir) {
            Ok(rd) => {
                let mut any = false;
                for e in rd.flatten() {
                    any = true;
                    let size = e.metadata().map(|m| m.len()).unwrap_or(0);
                    let _ = writeln!(s, "{:>12} 字节  {}", size, e.file_name().to_string_lossy());
                }
                if !any {
                    let _ = writeln!(s, "(空)");
                }
            }
            Err(e) => {
                let _ = writeln!(s, "读不出日志目录 {}: {e}", dir.display());
            }
        },
        Err(e) => {
            let _ = writeln!(s, "取不到日志目录: {e}");
        }
    }
    let _ = writeln!(s);

    section(
        &mut s,
        &format!("运行日志(最后 {} KB)", LOG_TAIL_BYTES / 1024),
    );
    let _ = writeln!(s, "{}", log_tail(app));

    s
}

fn section(s: &mut String, title: &str) {
    let _ = writeln!(s, "---------- {title} ----------");
}

fn blank_as(v: &str) -> String {
    if v.trim().is_empty() {
        "(未配置)".into()
    } else {
        v.to_string()
    }
}

/// NAS 可达性探测的硬超时。
///
/// 半死的 SMB 挂载上 `metadata` 会在内核里卡住——分钟级,甚至不返回。诊断
/// 工具**不能依赖它要诊断的那个东西**:探测卡住 = 导出永远出不来,而这恰恰
/// 是最需要报告的时刻。超时就如实写「探测超时」,那本身就是一条强证据。
const REACHABILITY_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(3);

/// 只做「现在能不能读到」的一次探测,带硬超时。
/// 报文按 [`crate::core::error::explain_io`] 的口径。
fn reachable(p: &Path) -> String {
    if p.as_os_str().is_empty() {
        return "(未配置)".into();
    }
    let path = p.to_path_buf();
    let (tx, rx) = std::sync::mpsc::channel();
    // 探测线程可能永远回不来:detach 掉,不 join。多挂一个卡死的线程,
    // 好过让整份报告陪着一起卡死
    std::thread::spawn(move || {
        let r = match std::fs::metadata(&path) {
            Ok(m) if m.is_dir() => "可达".to_string(),
            Ok(_) => "存在但不是目录".to_string(),
            Err(e) => format!("不可达 —— {}", crate::core::error::explain_io(&e)),
        };
        let _ = tx.send(r);
    });
    match rx.recv_timeout(REACHABILITY_TIMEOUT) {
        Ok(r) => r,
        // 别用 `\` 续行拼这句:续行后的缩进空格会**原样印进**用户拿到的报告里,
        // 而这正是整份报告里最像「强证据」的一句话
        Err(_) => format!(
            concat!(
                "探测超时({} 秒没有返回)—— 挂载点处于半死状态",
                "(SMB 会话断了但没解挂)。这本身就是拷卡中断的一个强嫌疑;",
                "在资源管理器/访达里重连一次共享再试"
            ),
            REACHABILITY_TIMEOUT.as_secs()
        ),
    }
}

fn os_version() -> String {
    let long = sysinfo::System::long_os_version().unwrap_or_default();
    let kernel = sysinfo::System::kernel_version().unwrap_or_default();
    match (long.is_empty(), kernel.is_empty()) {
        (true, true) => "(取不到)".into(),
        (false, true) => long,
        (true, false) => kernel,
        (false, false) => format!("{long}(内核 {kernel})"),
    }
}

/// 截断后丢掉开头那半行:不然报告的第一行是半个 UTF-8 字符 + 半条日志。
fn trim_partial_first_line(slice: &[u8]) -> &[u8] {
    match slice.iter().position(|b| *b == b'\n') {
        Some(i) => &slice[i + 1..],
        None => slice,
    }
}

/// 运行日志的尾巴。
///
/// **跨轮转文件按修改时间从新到旧拼**:日志是 5MB 一轮转 + KeepAll,只读
/// 当前那份的话,刚轮转过时它几乎是空的,而事故正躺在刚被转走的那份里——
/// 用户第二天才想起来导出时尤其容易踩到。
fn log_tail<R: tauri::Runtime>(app: &AppHandle<R>) -> String {
    let Ok(dir) = app.path().app_log_dir() else {
        return "(取不到日志目录)".into();
    };
    let mut files: Vec<(std::time::SystemTime, PathBuf)> = match std::fs::read_dir(&dir) {
        Ok(rd) => rd
            .flatten()
            .filter(|e| {
                e.path()
                    .extension()
                    .is_some_and(|x| x.eq_ignore_ascii_case("log"))
            })
            .filter_map(|e| Some((e.metadata().ok()?.modified().ok()?, e.path())))
            .collect(),
        Err(e) => return format!("(读不出日志目录 {}: {e})", dir.display()),
    };
    if files.is_empty() {
        return format!("(日志目录里没有 .log 文件: {})", dir.display());
    }
    files.sort_by_key(|(mtime, _)| std::cmp::Reverse(*mtime)); // 新 → 旧

    // 从新到旧收集,够 LOG_TAIL_BYTES 就停;再按时间正序拼出来(读起来是顺的)
    let mut chunks: Vec<(PathBuf, Vec<u8>)> = Vec::new();
    let mut budget = LOG_TAIL_BYTES;
    let mut errors: Vec<String> = Vec::new();
    for (_, path) in &files {
        if budget == 0 {
            break;
        }
        match std::fs::read(path) {
            Ok(bytes) => {
                let start = bytes.len().saturating_sub(budget);
                let slice = if start > 0 {
                    trim_partial_first_line(&bytes[start..])
                } else {
                    &bytes[..]
                };
                budget = budget.saturating_sub(slice.len());
                chunks.push((path.clone(), slice.to_vec()));
            }
            Err(e) => errors.push(format!("{}: {e}", path.display())),
        }
    }
    chunks.reverse();

    let mut out = String::new();
    for e in &errors {
        let _ = writeln!(out, "(读不出 {e})");
    }
    for (path, bytes) in &chunks {
        let _ = writeln!(
            out,
            "----- {} -----",
            path.file_name().unwrap_or_default().to_string_lossy()
        );
        out.push_str(&String::from_utf8_lossy(bytes));
        if !out.ends_with('\n') {
            out.push('\n');
        }
    }
    if out.trim().is_empty() {
        return "(日志为空)".into();
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 考的是**真实函数**。此前这里把切片算法在测试体里抄了一遍再断言自己抄的
    /// 那份——改坏实现本体,测试恒绿(评审两路都点了这条)。
    #[test]
    fn log_tail_cut_starts_on_a_line_boundary() {
        // 从半行中间切进去:必须把残缺的那半行丢掉
        assert_eq!(
            trim_partial_first_line(b"aa\nbbbb\ncccc\n"),
            b"bbbb\ncccc\n"
        );
        // 正好切在行首:整段保留
        assert_eq!(trim_partial_first_line(b"bbbb\ncccc\n"), b"cccc\n");
        // 整段里一个换行都没有:没得丢,原样返回,不能返回空
        assert_eq!(
            trim_partial_first_line(b"no newline here"),
            b"no newline here"
        );
    }

    /// 命令的 IO 外壳此前零覆盖:前端三条测试把整个后端 mock 掉了,
    /// Rust 侧只考 `build_report`——把 `fs::write` 换成写空文件两边都绿。
    #[test]
    fn write_report_to_creates_the_file_and_names_the_path_when_it_cannot() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join("下载/子目录");
        let p = write_report_to(&dir, "r.txt", "OCard 诊断报告\n版本 x").unwrap();
        assert!(p.is_file(), "报告没落盘");
        assert!(std::fs::read_to_string(&p)
            .unwrap()
            .contains("OCard 诊断报告"));
        assert_eq!(p.parent(), Some(dir.as_path()));

        // 落不下去时报文必须点名路径 + 给下一步(不能只吐一个 errno)
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            if unsafe { libc::geteuid() } != 0 {
                let ro = tmp.path().join("ro");
                std::fs::create_dir_all(&ro).unwrap();
                std::fs::set_permissions(&ro, std::fs::Permissions::from_mode(0o500)).unwrap();
                let e = write_report_to(&ro, "r.txt", "x").unwrap_err();
                std::fs::set_permissions(&ro, std::fs::Permissions::from_mode(0o700)).unwrap();
                assert!(e.contains("r.txt"), "{e}");
                assert!(e.contains("权限") || e.contains("拒绝访问"), "{e}");
            }
        }
    }

    /// 「下载」能解析出来但写不进去(企业机的同步目录、只读配置)时必须退到
    /// 下一个候选,而且要把「为什么没落在下载里」带回去给调用方说。此前只在
    /// 「解析不到路径」时降级,写失败直接报错、后面的候选一个都不试。
    #[test]
    #[cfg(unix)]
    fn report_falls_through_to_the_next_writable_dir_and_says_why() {
        use std::os::unix::fs::PermissionsExt;
        if unsafe { libc::geteuid() } == 0 {
            panic!("本测试要求非 root(root 无视权限位,造不出这个场景)");
        }
        let tmp = tempfile::tempdir().unwrap();
        let ro = tmp.path().join("ro");
        let ok = tmp.path().join("ok");
        std::fs::create_dir_all(&ro).unwrap();
        std::fs::set_permissions(&ro, std::fs::Permissions::from_mode(0o500)).unwrap();
        let r = write_to_first_writable(&[ro.clone(), ok.clone()], "r.txt", "x");
        let (p, skipped) = r.expect("第二个候选可写,不该整体失败");
        assert_eq!(p.parent(), Some(ok.as_path()));
        assert_eq!(
            skipped.len(),
            1,
            "要带回第一个候选的失败原因,调用方据此发降级通知"
        );
        assert!(skipped[0].contains("ro"), "{skipped:?}");

        let e = write_to_first_writable(std::slice::from_ref(&ro), "r.txt", "x").unwrap_err();
        std::fs::set_permissions(&ro, std::fs::Permissions::from_mode(0o700)).unwrap();
        assert!(e.contains("任何一个候选"), "{e}");
    }

    #[test]
    fn blank_config_is_labelled_not_left_empty() {
        // 空行会被读成「这项没查」,而它其实是「没配」——两回事
        assert_eq!(blank_as("   "), "(未配置)");
        assert_eq!(blank_as("张三"), "张三");
        assert_eq!(reachable(Path::new("")), "(未配置)");
    }

    #[test]
    fn unreachable_nas_explains_why_in_plain_words() {
        let msg = reachable(Path::new("/一个/肯定/不存在的/路径"));
        assert!(msg.starts_with("不可达"), "{msg}");
        assert!(msg.contains("重新挂载"), "要给下一步,不能只报 errno: {msg}");
    }
}
