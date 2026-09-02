//! 拷卡任务的**独占租约**:同一个任务同时只允许一个进程写它的清单。
//!
//! # 为什么需要它
//!
//! 清单落盘是**整份覆盖**,不是读-改-写事务。两个进程同时写同一个 manifest id
//! 时,后写的整份顶掉先写的,`entries`/`completed` 都可能回退。
//!
//! 0.4.3 的修复把临时文件名改成唯一的(修的是「互相截断出一份坏 JSON」),
//! 副作用是丢更新从**吵闹**变成了**安静**:以前至少会崩出一个 JSON 解析错误,
//! 现在每次 rename 发布的都是一份完整自洽的快照,谁也发现不了少了什么。
//! 更干净,但更难发现——而零静默铁律恰恰要消灭的就是这种性质。
//!
//! # 现实触发点
//!
//! 不是「两台工作站」:续传要求原卡的 UID 指纹当场挂载,同一张物理卡插不进
//! 两台机器。真正的入口是**同一台机器开两个 OCard**(Windows 上双击两次图标),
//! 两个进程都会重建出同一个暂停任务,都看得见同一个挂载点。
//! 应用层装了 single-instance 兜住这一条;租约是第二道闸,并且能覆盖
//! single-instance 管不到的场景(异构挂载、以后真的支持多机协作)。
//!
//! # 机制(每一步都要么原子、要么可串行化)
//!
//! `<项目>/.ocard/manifests/<id>.lease` 一个小 JSON:持有者身份 + 一次性 token + 心跳。
//!
//! - **取得**:先把完整内容写进同目录的唯一临时文件,再 [`rename_no_replace`]
//!   (三平台都是原子的「目标存在即失败」)。绝不先 `create_new` 一个空文件再
//!   往里写——那会留下一个「文件在、内容空」的窗口,第二个进程读到空文件当成
//!   「读不懂」就接管了,两边都拿到租约(评审 P0)。
//! - **接管**(过期 / 本机残留 / 陈旧到读不懂):先 `remove_file`,再走同一个
//!   原子取得。两个进程同时接管时只有一个 rename 会成功,另一个拿到
//!   `AlreadyExists` → 退回 Busy。接管因此是串行化的,不是「检查后覆盖」。
//! - **身份**是每次取得随机生成的 token,不是 machine_id+pid:pid 会被系统
//!   复用,token 不会。心跳、释放都先读盘核对 token,不是自己的就不碰。
//! - **心跳**由独立线程推进,不挂在拷贝回调上:一次几十 GB 的回读校验没有
//!   回调,靠回调推进的心跳会在那里停掉。线程还负责发现「租约已不是我的」
//!   与「心跳已经很久没成功」,拷贝循环按文件边界轮询并停下。
//!
//! # 泄漏的租约必须能自愈
//!
//! 强退、panic、断电都不会走到 release。留下的租约 pid 是本机的、心跳还新鲜——
//! 只按心跳判,续传会被**自己**锁死 30 分钟,报文还指着一个不存在的进程。所以:
//! ① `Held` 实现 `Drop`,panic 与所有早退都会释放;② 同机 + pid 已不存在 =
//! 一定是自己上次的残留(single-instance 保证同机没有第二个 OCard),直接接管;
//! ③ 心跳时间戳在**未来**也当过期(对方机器时钟快,否则那份租约永不过期)。
//!
//! # 边界(如实声明)
//!
//! - `rename_no_replace` 在不支持原子原语的文件系统上会退到「复查+rename」
//!   (见 `fsx`,有可见告警),那种盘上的独占是尽力而为。
//! - 时钟偏差只影响「过期」这一种判断;本机残留靠 pid、活着的别人靠 token,
//!   都不看时钟。

use super::Result;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicI64, Ordering};
use std::sync::{Arc, Mutex};

/// 心跳多久不更新就算过期。
///
/// 只用于**别的机器**留下的租约(本机残留看 pid,不等)。取 30 分钟:宁可让
/// 一次真的崩溃多等半小时,也不要把一个正在好好干活的任务判成死的。
pub const LEASE_TTL: chrono::Duration = chrono::Duration::minutes(30);

/// 读不懂的租约在多「年轻」以内当作「正在初始化/刚被接管」而不是「陈旧」。
/// 取得与接管都是原子的,正常情况下不存在半截文件;这是给不支持原子原语的
/// 文件系统留的余量。
const YOUNG_LEASE: std::time::Duration = std::time::Duration::from_secs(120);

/// 心跳节奏与「多久没成功就算有失去租约的风险」。
#[derive(Debug, Clone, Copy)]
pub struct Timing {
    pub heartbeat_every: std::time::Duration,
    /// 超过这么久没有一次成功的心跳,拷贝就该停:再往前 TTL/2 就可能被别人接管,
    /// 而我们还在写清单。
    pub at_risk_after: std::time::Duration,
}

impl Timing {
    pub const DEFAULT: Timing = Timing {
        heartbeat_every: std::time::Duration::from_secs(30),
        // TTL 的一半:留足余量,在被接管**之前**停下
        at_risk_after: std::time::Duration::from_secs(15 * 60),
    };
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Lease {
    /// 持有者机器 ID(`core::machine::machine_id`)。
    pub machine_id: String,
    /// 持有者进程 ID。同机残留靠它判「进程还在不在」。
    pub pid: u32,
    /// 这一次取得的一次性身份。pid 会被系统复用,这个不会。
    #[serde(default)]
    pub token: String,
    /// 操作人,报文里要说得出「是谁在拷」。
    #[serde(default)]
    pub operator: String,
    /// 主机名。机器 ID 是一串 UUID,用户认不出那是哪台;主机名认得出。
    #[serde(default)]
    pub host: String,
    /// 最近一次心跳(RFC3339)。
    pub heartbeat_at: String,
}

impl Lease {
    fn fresh(machine_id: &str, operator: &str, token: &str) -> Self {
        Self {
            machine_id: machine_id.to_string(),
            pid: std::process::id(),
            token: token.to_string(),
            operator: operator.to_string(),
            host: sysinfo::System::host_name().unwrap_or_default(),
            heartbeat_at: chrono::Utc::now().to_rfc3339(),
        }
    }

    /// 心跳是不是已经过期。
    ///
    /// 时间解析不出来当过期(一份读不懂的租约不该永久堵住一个任务);
    /// 时间戳在**未来**超过 TTL 也当过期——对方机器时钟快时写下的租约,
    /// 否则在别的机器眼里永不过期,而报文还在承诺「等 30 分钟再试」。
    pub fn is_stale(&self, now: chrono::DateTime<chrono::Utc>) -> bool {
        match chrono::DateTime::parse_from_rfc3339(&self.heartbeat_at) {
            Ok(t) => {
                let age = now - t.to_utc();
                age > LEASE_TTL || age < -LEASE_TTL
            }
            Err(_) => true,
        }
    }

    /// 是不是**本机上一个已经不存在的进程**留下的。
    /// 同机不会有第二个 OCard(single-instance),所以「同机 + pid 不在」
    /// 只可能是自己上次强退/崩溃的残留,不用等 TTL。
    fn is_dead_local(&self, machine_id: &str) -> bool {
        self.machine_id == machine_id && !pid_alive(self.pid)
    }

    /// 报文里怎么称呼持有者。是本机就明说,别让用户对着一串 UUID 猜。
    fn who(&self, my_machine_id: &str) -> String {
        let op = if self.operator.trim().is_empty() {
            String::new()
        } else {
            format!("、操作人 {}", self.operator)
        };
        if self.machine_id == my_machine_id {
            if self.pid == std::process::id() {
                format!("本进程内的另一次续传(pid {}{op})", self.pid)
            } else {
                format!("本机上的另一个 OCard 进程(pid {}{op})", self.pid)
            }
        } else if self.host.is_empty() {
            format!("机器 {}{op} 的进程 {}", self.machine_id, self.pid)
        } else {
            format!(
                "主机 {}(机器 {}{op})的进程 {}",
                self.host, self.machine_id, self.pid
            )
        }
    }
}

/// 这个 pid 现在还活着吗(本机)。
fn pid_alive(pid: u32) -> bool {
    use sysinfo::{Pid, ProcessRefreshKind, RefreshKind, System};
    let s = System::new_with_specifics(
        RefreshKind::nothing().with_processes(ProcessRefreshKind::nothing()),
    );
    s.process(Pid::from_u32(pid)).is_some()
}

/// 租约文件落点。id 走与清单同一道形状闸(`manifest_child`),不裸拼。
pub fn lease_path(project_root: &Path, manifest_id: &str) -> Result<PathBuf> {
    super::manifest::manifest_child(project_root, manifest_id, "lease")
}

/// 原子地把一份租约放到 `path`:唯一临时文件 → `rename_no_replace`。
/// 返回 `Ok(false)` = 目标已存在(有人持有);其它错误原样上抛。
fn try_create(path: &Path, lease: &Lease) -> Result<bool> {
    let dir = path.parent().unwrap_or(Path::new("."));
    let tmp = dir.join(format!(
        ".{}.{}.leasetmp",
        path.file_name().unwrap_or_default().to_string_lossy(),
        &uuid::Uuid::new_v4().simple().to_string()[..8]
    ));
    std::fs::write(&tmp, serde_json::to_vec_pretty(lease)?)
        .map_err(|e| super::CoreError::io_detail("写入任务租约", &tmp, &e))?;
    match super::fsx::rename_no_replace(&tmp, path) {
        Ok(()) => Ok(true),
        Err(e) => {
            let _ = std::fs::remove_file(&tmp);
            if e.kind() == std::io::ErrorKind::AlreadyExists {
                Ok(false)
            } else {
                Err(super::CoreError::io_detail("落位任务租约", path, &e))
            }
        }
    }
}

fn read_lease(path: &Path) -> Option<Lease> {
    serde_json::from_slice(&std::fs::read(path).ok()?).ok()
}

/// 文件是不是「年轻」(最近才写的)。读不懂的年轻文件当作正在初始化。
fn is_young(path: &Path) -> bool {
    std::fs::metadata(path)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| std::time::SystemTime::now().duration_since(t).ok())
        .is_some_and(|age| age < YOUNG_LEASE)
}

/// 取得独占租约(默认心跳节奏)。已被**活着的**别人占着时返回
/// [`super::CoreError::Busy`](暂时冲突,不是死路:任务转暂停,等那边结束再续)。
pub fn acquire(
    project_root: &Path,
    manifest_id: &str,
    machine_id: &str,
    operator: &str,
) -> Result<Held> {
    acquire_with(
        project_root,
        manifest_id,
        machine_id,
        operator,
        Timing::DEFAULT,
    )
}

/// 同 [`acquire`],心跳节奏可调(测试用;生产一律 [`Timing::DEFAULT`])。
pub fn acquire_with(
    project_root: &Path,
    manifest_id: &str,
    machine_id: &str,
    operator: &str,
    timing: Timing,
) -> Result<Held> {
    let dir = super::manifest::manifest_dir(project_root);
    super::paths::ensure_dir_within_core(project_root, &dir)?;
    let path = lease_path(project_root, manifest_id)?;
    let token = uuid::Uuid::new_v4().to_string();
    let me = Lease::fresh(machine_id, operator, &token);

    if try_create(&path, &me)? {
        return Ok(Held::start(path, me, timing, None));
    }

    // 已存在:决定能不能接管。判断顺序有讲究:先看过期,再看是不是本机残留——
    // 「同机 pid 活着但 token 不同」在最后,那是真的有人在跑
    let now = chrono::Utc::now();
    let note = match read_lease(&path) {
        None if is_young(&path) => {
            return Err(super::CoreError::Busy(
                "这个拷卡任务的租约刚被写入、还读不出内容(另一个进程正在开始或接管它),稍等片刻再试".into(),
            ));
        }
        None => "上一份任务租约读不懂且已陈旧(可能是异常退出写了一半),已接管".to_string(),
        Some(l) if l.is_stale(now) => format!(
            "接管了一份过期的任务租约:{} 上次心跳 {},已超过 {} 分钟没有动静(多半是上次异常退出;若那台机器时钟不准也会这样)",
            l.who(machine_id),
            l.heartbeat_at,
            LEASE_TTL.num_minutes()
        ),
        Some(l) if l.is_dead_local(machine_id) => format!(
            "接管了本机上一个 OCard 进程(pid {})留下的任务租约:那个进程已经不存在了,多半是上次强退或崩溃。上次的进度都在清单里,会从断点接着拷",
            l.pid
        ),
        Some(l) => {
            return Err(super::CoreError::Busy(format!(
                "这个拷卡任务正被 {} 执行中(心跳 {}),拒绝同时写同一份清单——两处同时写会让一方的记录被整份顶掉。请在那边操作,或等它结束/超过 {} 分钟无心跳后再续传",
                l.who(machine_id),
                l.heartbeat_at,
                LEASE_TTL.num_minutes()
            )));
        }
    };

    // 接管 = 删掉旧的 + 原子取得。两个进程同时接管时只有一个 rename 成功
    match std::fs::remove_file(&path) {
        Ok(()) => {}
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => return Err(super::CoreError::io_detail("移除过期的任务租约", &path, &e)),
    }
    if try_create(&path, &me)? {
        Ok(Held::start(path, me, timing, Some(note)))
    } else {
        Err(super::CoreError::Busy(
            "另一个进程刚刚抢先接管了这个拷卡任务的租约,本次不再重复接管;请在那边操作,或稍后再试"
                .into(),
        ))
    }
}

/// 只看不取:有没有**活着的别人**正持有这个任务的租约?返回描述,供报文点名。
///
/// 给「不由 worker 发起、却要写同一份清单」的路径用(启动补投自动转代理是一例)。
/// 读不懂但年轻的租约按「有人」算——那是正在初始化的。
pub fn live_holder(project_root: &Path, manifest_id: &str, machine_id: &str) -> Option<String> {
    let path = lease_path(project_root, manifest_id).ok()?;
    if !path.exists() {
        return None;
    }
    match read_lease(&path) {
        None if is_young(&path) => Some("一个正在开始的进程(租约刚写入)".into()),
        None => None,
        Some(l) if l.is_stale(chrono::Utc::now()) || l.is_dead_local(machine_id) => None,
        Some(l) => Some(l.who(machine_id)),
    }
}

/// 心跳线程与拷贝线程之间共享的状态。
#[derive(Debug)]
struct Shared {
    stop: AtomicBool,
    /// 最近一次**成功**心跳的 unix 秒。失败不推进——这正是「多久没成功」的判据。
    last_ok: AtomicI64,
    /// 租约已经不是我的了(别人合法接管),里面是对方的描述。
    lost: Mutex<Option<String>>,
    /// 最近一次心跳失败的原因(给 at-risk 报文用)。
    last_err: Mutex<Option<String>>,
}

/// 取得的租约。离开作用域(含 panic、`?` 早退)自动停心跳并释放;
/// 显式 [`Held::release`] 只是把这件事说得更清楚。
#[derive(Debug)]
pub struct Held {
    path: PathBuf,
    me: Lease,
    timing: Timing,
    shared: Arc<Shared>,
    thread: Option<std::thread::JoinHandle<()>>,
    released: bool,
    /// 接管了一份不是干净取得的租约(过期 / 读不懂 / 本机残留)——上层要发可见告警。
    pub took_over_stale: Option<String>,
}

/// 拷贝循环在文件边界轮询到的租约状态。
#[derive(Debug, PartialEq, Eq)]
pub enum LeaseStatus {
    Ok,
    /// **租约已经不是我们的了**(别人合法接管)。再写就是两个 worker 同时写同一份
    /// 清单——租约要防的正是这个。上层必须停。
    Lost(String),
    /// 心跳已经很久没成功:再过一会儿别人就有权接管,而我们还在写。上层应停下。
    AtRisk(String),
}

impl Held {
    fn start(path: PathBuf, me: Lease, timing: Timing, took_over_stale: Option<String>) -> Self {
        let shared = Arc::new(Shared {
            stop: AtomicBool::new(false),
            last_ok: AtomicI64::new(chrono::Utc::now().timestamp()),
            lost: Mutex::new(None),
            last_err: Mutex::new(None),
        });
        let thread = {
            let (path, me, shared) = (path.clone(), me.clone(), shared.clone());
            std::thread::Builder::new()
                .name("ocard-lease-heartbeat".into())
                .spawn(move || heartbeat_loop(&path, &me, timing, &shared))
                .ok()
        };
        Self {
            path,
            me,
            timing,
            shared,
            thread,
            released: false,
            took_over_stale,
        }
    }

    /// 文件边界上问一句:我还持有吗、心跳还健康吗。
    pub fn poll(&self) -> LeaseStatus {
        if let Some(who) = self.shared.lost.lock().unwrap().clone() {
            return LeaseStatus::Lost(who);
        }
        let since_ok = chrono::Utc::now().timestamp() - self.shared.last_ok.load(Ordering::Relaxed);
        if since_ok >= 0 && since_ok as u64 > self.timing.at_risk_after.as_secs() {
            let why = self
                .shared
                .last_err
                .lock()
                .unwrap()
                .clone()
                .unwrap_or_else(|| "心跳线程没有回报原因".into());
            return LeaseStatus::AtRisk(format!(
                "已有 {since_ok} 秒没有一次成功的心跳(最近一次失败:{why});再等下去别的进程就有权接管这个任务"
            ));
        }
        LeaseStatus::Ok
    }

    /// 释放之后租约文件是否还留在盘上(删不掉时上层据此告警)。
    pub fn path(&self) -> &Path {
        &self.path
    }

    /// 显式释放(`Drop` 也会做同一件事;这里只是让意图在代码里看得见)。
    pub fn release(mut self) {
        self.release_inner();
    }

    /// 停心跳;只删**自己的**那一份(按 token):别人接管之后不能把人家的删掉。
    fn release_inner(&mut self) {
        if self.released {
            return;
        }
        self.released = true;
        self.shared.stop.store(true, Ordering::SeqCst);
        if let Some(t) = self.thread.take() {
            let _ = t.join();
        }
        let mine = read_lease(&self.path).is_some_and(|l| l.token == self.me.token);
        if mine {
            if let Err(e) = std::fs::remove_file(&self.path) {
                if e.kind() != std::io::ErrorKind::NotFound {
                    // 删不掉只是让别人多等 TTL;上层会自查文件还在不在并告警
                    log::warn!("任务租约删不掉 {}: {e}", self.path.display());
                }
            }
        }
    }
}

impl Drop for Held {
    /// panic、`?` 早退、强退前的 unwind——凡是走得到析构的路径都会释放。
    /// (进程被 kill -9 / 断电走不到这里,那种残留由「同机 pid 不在」接管兜住。)
    fn drop(&mut self) {
        self.release_inner();
    }
}

/// 心跳线程主体。每一拍:读盘核对 token → 是自己的才写。
fn heartbeat_loop(path: &Path, me: &Lease, timing: Timing, shared: &Shared) {
    let tick = std::time::Duration::from_millis(50);
    let mut since_beat = std::time::Duration::ZERO;
    while !shared.stop.load(Ordering::SeqCst) {
        std::thread::sleep(tick);
        since_beat += tick;
        if since_beat < timing.heartbeat_every {
            continue;
        }
        since_beat = std::time::Duration::ZERO;

        match std::fs::read(path) {
            Ok(b) => {
                if let Ok(l) = serde_json::from_slice::<Lease>(&b) {
                    if l.token != me.token {
                        *shared.lost.lock().unwrap() = Some(l.who(&me.machine_id));
                        return; // 不再碰它,也不再尝试释放(release 会核对 token)
                    }
                }
                // 读不懂 = 写了一半的自己,照常覆盖
            }
            // 文件没了(有人手动删了):重建即可,仍是我们的
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => {
                *shared.last_err.lock().unwrap() = Some(super::error::explain_io(&e));
                continue;
            }
        }
        let mut beat = me.clone();
        beat.heartbeat_at = chrono::Utc::now().to_rfc3339();
        match serde_json::to_vec_pretty(&beat)
            .map_err(|e| e.to_string())
            .and_then(|b| {
                super::fsx::write_atomic(path, &b)
                    .map_err(|f| format!("{}{}", super::error::explain_io(&f.source), f.note()))
            }) {
            Ok(_) => {
                shared
                    .last_ok
                    .store(chrono::Utc::now().timestamp(), Ordering::Relaxed);
                *shared.last_err.lock().unwrap() = None;
            }
            Err(why) => *shared.last_err.lock().unwrap() = Some(why),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    const FAST: Timing = Timing {
        heartbeat_every: std::time::Duration::from_millis(120),
        at_risk_after: std::time::Duration::from_secs(1),
    };

    fn setup() -> (tempfile::TempDir, PathBuf, String) {
        let t = tempdir().unwrap();
        let root = t.path().join("project");
        std::fs::create_dir_all(super::super::manifest::manifest_dir(&root)).unwrap();
        let id = uuid::Uuid::new_v4().to_string();
        (t, root, id)
    }

    fn write_lease(root: &Path, id: &str, l: &Lease) {
        std::fs::write(
            lease_path(root, id).unwrap(),
            serde_json::to_vec(l).unwrap(),
        )
        .unwrap();
    }

    fn on_disk(root: &Path, id: &str) -> Lease {
        read_lease(&lease_path(root, id).unwrap()).expect("盘上应有一份可读的租约")
    }

    fn live(machine: &str, pid: u32, op: &str) -> Lease {
        Lease {
            machine_id: machine.into(),
            pid,
            token: uuid::Uuid::new_v4().to_string(),
            operator: op.into(),
            host: "他们的机器".into(),
            heartbeat_at: chrono::Utc::now().to_rfc3339(),
        }
    }

    fn stale(mut l: Lease) -> Lease {
        l.heartbeat_at =
            (chrono::Utc::now() - LEASE_TTL - chrono::Duration::minutes(1)).to_rfc3339();
        l
    }

    /// 一个肯定不存在的 pid。
    fn a_dead_pid() -> u32 {
        (u32::MAX - 1000..u32::MAX)
            .rev()
            .find(|p| !pid_alive(*p))
            .unwrap()
    }

    fn wait_until(what: &str, mut ok: impl FnMut() -> bool) {
        for _ in 0..100 {
            if ok() {
                return;
            }
            std::thread::sleep(std::time::Duration::from_millis(30));
        }
        panic!("等了 3 秒还没等到:{what}");
    }

    #[test]
    fn a_live_lease_from_another_machine_blocks_the_second_writer() {
        let (_t, root, id) = setup();
        write_lease(&root, &id, &live("MACHINE-B", 4242, "李四"));
        let err = acquire(&root, &id, "MACHINE-A", "王五").unwrap_err();
        let msg = err.to_string();
        assert!(
            matches!(err, super::super::CoreError::Busy(_)),
            "被别人占着是暂时冲突,要能转暂停,不是死路也不是 IO: {msg}"
        );
        assert!(msg.contains("正被"), "{msg}");
        assert!(msg.contains("李四"), "报文要说得出是谁占着: {msg}");
        assert!(
            msg.contains("他们的机器"),
            "要给主机名,UUID 用户认不出: {msg}"
        );
    }

    /// 同一个进程里第二次取得(两次并发续传):token 不同、pid 活着 → 拒绝。
    /// 这条堵的是「准备阶段没有 CAS」那个已知未修——两次 resume 不能都通过。
    #[test]
    fn a_second_acquire_from_the_same_process_is_refused_not_silently_shared() {
        let (_t, root, id) = setup();
        let _first = acquire(&root, &id, "MACHINE-A", "张三").unwrap();
        let err = acquire(&root, &id, "MACHINE-A", "张三").unwrap_err();
        let msg = err.to_string();
        assert!(matches!(err, super::super::CoreError::Busy(_)), "{msg}");
        assert!(msg.contains("本进程内的另一次续传"), "同进程要明说: {msg}");
    }

    /// 强退/崩溃后的形状:同机、pid 已经不存在、心跳却还新鲜。
    /// 只按心跳判会把续传锁死 30 分钟——这正是这个模块要修的场景里最常见的一幕。
    #[test]
    fn a_dead_local_process_lease_is_taken_over_immediately_and_explained() {
        let (_t, root, id) = setup();
        let dead_pid = a_dead_pid();
        write_lease(&root, &id, &live("MACHINE-A", dead_pid, "张三"));

        let held = acquire(&root, &id, "MACHINE-A", "张三").expect("本机残留必须能立刻接管");
        let note = held.took_over_stale.as_deref().expect("接管要有可见说明");
        assert!(note.contains("已经不存在"), "{note}");
        assert!(note.contains(&dead_pid.to_string()), "{note}");
        assert!(note.contains("断点"), "要安抚:进度都在,会接着拷: {note}");
        assert_eq!(
            on_disk(&root, &id).token,
            held.me.token,
            "接管后盘上必须是我们的"
        );
    }

    #[test]
    fn a_stale_lease_can_be_taken_over_but_says_so_out_loud() {
        let (_t, root, id) = setup();
        write_lease(&root, &id, &stale(live("MACHINE-B", 4242, "李四")));
        let held = acquire(&root, &id, "MACHINE-A", "张三").unwrap();
        let note = held
            .took_over_stale
            .as_deref()
            .expect("接管过期租约必须给出可见说明");
        assert!(note.contains("过期"), "{note}");
        assert!(
            note.contains("李四") || note.contains("MACHINE-B"),
            "{note}"
        );
    }

    /// 对方机器时钟快:心跳在未来。只用 `now - t > TTL` 判的话它永不过期,
    /// 任务永久不可续传,报文还在承诺「等 30 分钟」。
    #[test]
    fn a_lease_stamped_in_the_future_is_stale_not_immortal() {
        let (_t, root, id) = setup();
        let mut skewed = live("MACHINE-B", 4242, "李四");
        skewed.heartbeat_at = (chrono::Utc::now() + chrono::Duration::hours(1)).to_rfc3339();
        assert!(skewed.is_stale(chrono::Utc::now()), "未来时间戳必须当过期");
        write_lease(&root, &id, &skewed);
        let held = acquire(&root, &id, "MACHINE-A", "张三").expect("时钟不同步不能永久锁死任务");
        assert!(
            held.took_over_stale.as_deref().unwrap().contains("时钟"),
            "要提示时钟不准的可能"
        );
    }

    /// 自己上次崩溃留下的租约,pid 被系统复用成了现在这个、token 却是旧的:
    /// 过期 → 接管并报;不过期(pid 活着 = 我们自己)→ 这就是「同进程第二次」,拒绝。
    /// 两条路都不许**无声**把它当成自己的。
    #[test]
    fn our_own_stale_lease_is_reported_as_a_takeover_not_swallowed() {
        let (_t, root, id) = setup();
        write_lease(
            &root,
            &id,
            &stale(live("MACHINE-A", std::process::id(), "张三")),
        );
        let held = acquire(&root, &id, "MACHINE-A", "张三").unwrap();
        assert!(
            held.took_over_stale.is_some(),
            "自己的过期租约也是接管,不许静默"
        );
    }

    /// 取得是原子的:盘上绝不会出现「文件在、内容空」的窗口。
    /// 评审 P0:先 create_new 再写 JSON 的旧写法,第二个进程读到空文件当成
    /// 「读不懂」就接管了,两边都拿到租约。
    #[test]
    fn a_young_unreadable_lease_is_treated_as_someone_initialising_not_as_garbage() {
        let (_t, root, id) = setup();
        std::fs::write(lease_path(&root, &id).unwrap(), b"").unwrap();
        let err = acquire(&root, &id, "MACHINE-A", "张三").unwrap_err();
        assert!(matches!(err, super::super::CoreError::Busy(_)), "{err}");
        assert!(err.to_string().contains("刚被写入"), "{err}");
    }

    #[test]
    fn an_old_unreadable_lease_does_not_wedge_the_task_forever() {
        let (_t, root, id) = setup();
        let p = lease_path(&root, &id).unwrap();
        std::fs::write(&p, b"{ not json").unwrap();
        let old = std::time::SystemTime::now() - YOUNG_LEASE - std::time::Duration::from_secs(60);
        std::fs::File::options()
            .write(true)
            .open(&p)
            .unwrap()
            .set_times(std::fs::FileTimes::new().set_modified(old))
            .unwrap();
        let held = acquire(&root, &id, "MACHINE-A", "张三").unwrap();
        assert!(held.took_over_stale.is_some(), "接管坏租约也要说一声");
    }

    /// 两个进程同时发现同一份过期租约、同时接管:只能有一个成功。
    /// 「检查后覆盖」两个都会成功;「删除 + 原子取得」只有一个 rename 会赢。
    #[test]
    fn concurrent_takeover_of_a_stale_lease_lets_exactly_one_winner_through() {
        let (_t, root, id) = setup();
        write_lease(&root, &id, &stale(live("MACHINE-B", 4242, "李四")));
        let barrier = Arc::new(std::sync::Barrier::new(2));
        let mut hs = Vec::new();
        for op in ["甲", "乙"] {
            let (root, id, barrier) = (root.clone(), id.clone(), barrier.clone());
            hs.push(std::thread::spawn(move || {
                barrier.wait();
                acquire(&root, &id, "MACHINE-A", op)
                    .map(|h| h.me.token.clone())
                    .map_err(|e| e.to_string())
            }));
        }
        let results: Vec<_> = hs.into_iter().map(|h| h.join().unwrap()).collect();
        let winners: Vec<_> = results.iter().filter(|r| r.is_ok()).collect();
        assert_eq!(winners.len(), 1, "必须恰好一个接管成功: {results:?}");
        let loser = results
            .iter()
            .find(|r| r.is_err())
            .unwrap()
            .as_ref()
            .unwrap_err();
        assert!(
            loser.contains("抢先") || loser.contains("正被") || loser.contains("刚被写入"),
            "{loser}"
        );
    }

    #[test]
    fn live_holder_sees_a_foreign_live_lease_and_ignores_a_stale_or_dead_one() {
        let (_t, root, id) = setup();
        assert_eq!(
            live_holder(&root, &id, "MACHINE-A"),
            None,
            "没有租约时不该报占用"
        );

        write_lease(&root, &id, &live("MACHINE-B", 4242, "李四"));
        let who = live_holder(&root, &id, "MACHINE-A").expect("活着的别人必须被看见");
        assert!(who.contains("李四"), "{who}");

        write_lease(&root, &id, &stale(live("MACHINE-B", 4242, "李四")));
        assert_eq!(
            live_holder(&root, &id, "MACHINE-A"),
            None,
            "过期租约不该永久挡住别人"
        );

        write_lease(&root, &id, &live("MACHINE-A", a_dead_pid(), "张三"));
        assert_eq!(
            live_holder(&root, &id, "MACHINE-A"),
            None,
            "本机残留不该挡住别人"
        );

        std::fs::write(lease_path(&root, &id).unwrap(), b"").unwrap();
        assert!(
            live_holder(&root, &id, "MACHINE-A").is_some(),
            "刚写入的空租约按有人算"
        );
    }

    #[test]
    fn releasing_removes_only_our_own_lease() {
        let (_t, root, id) = setup();
        let held = acquire(&root, &id, "MACHINE-A", "张三").unwrap();
        // 别人已经接管了(我们的心跳早停了):不能把人家的租约删掉
        write_lease(&root, &id, &live("MACHINE-C", 999, "赵六"));
        held.release();
        assert!(
            lease_path(&root, &id).unwrap().is_file(),
            "把别人的租约删掉了——那等于第三个进程可以立刻进来一起写"
        );
    }

    /// 强退前的 unwind、panic、`?` 早退:凡是走得到析构的路径都必须释放。
    #[test]
    fn dropping_the_handle_releases_the_lease_even_on_panic() {
        let (_t, root, id) = setup();
        let p = lease_path(&root, &id).unwrap();
        let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let _held = acquire(&root, &id, "MACHINE-A", "张三").unwrap();
            assert!(p.is_file());
            panic!("模拟拷贝线程 panic");
        }));
        assert!(r.is_err());
        assert!(!p.exists(), "panic 之后租约没释放:续传会被自己锁住");
    }

    #[test]
    fn our_own_lease_is_reacquirable_after_release() {
        let (_t, root, id) = setup();
        acquire(&root, &id, "MACHINE-A", "张三").unwrap().release();
        assert!(!lease_path(&root, &id).unwrap().exists());
        let again = acquire(&root, &id, "MACHINE-A", "张三").unwrap();
        assert!(again.took_over_stale.is_none(), "干净取得不该报接管");
    }

    /// 心跳由独立线程推进:拷贝线程哪怕卡在一次几十 GB 的回读校验里,
    /// 盘上的心跳也在走。
    #[test]
    fn the_heartbeat_thread_advances_the_lease_without_the_copy_loop_calling_in() {
        let (_t, root, id) = setup();
        let held = acquire_with(&root, &id, "MACHINE-A", "张三", FAST).unwrap();
        let first = on_disk(&root, &id).heartbeat_at;
        wait_until("心跳时间戳推进", || {
            on_disk(&root, &id).heartbeat_at != first
        });
        assert_eq!(held.poll(), LeaseStatus::Ok);
    }

    /// 心跳停过、别人合法接管了:下一拍**不许**把人家的租约顶掉,
    /// 而且拷贝线程轮询到 Lost 之后必须停。
    #[test]
    fn a_taken_over_lease_is_noticed_and_never_clobbered() {
        let (_t, root, id) = setup();
        let held = acquire_with(&root, &id, "MACHINE-A", "张三", FAST).unwrap();
        let taker = live("MACHINE-B", 4242, "李四");
        write_lease(&root, &id, &taker);

        wait_until("轮询到 Lost", || {
            matches!(held.poll(), LeaseStatus::Lost(_))
        });
        if let LeaseStatus::Lost(who) = held.poll() {
            assert!(who.contains("李四"), "{who}");
        }
        assert_eq!(
            on_disk(&root, &id),
            taker,
            "把新持有者的租约顶掉了——两个 worker 会一起写清单"
        );
        // 丢了之后 drop 也不许去删人家的
        drop(held);
        assert!(lease_path(&root, &id).unwrap().is_file());
    }

    /// 心跳一直写不进去(目录被锁):不能一直拷下去装作还持有租约。
    #[test]
    #[cfg(unix)]
    fn a_lease_whose_heartbeat_keeps_failing_reports_itself_at_risk() {
        use std::os::unix::fs::PermissionsExt;
        if unsafe { libc::geteuid() } == 0 {
            panic!("本测试要求非 root(root 无视权限位,造不出这个场景)");
        }
        let (_t, root, id) = setup();
        let held = acquire_with(&root, &id, "MACHINE-A", "张三", FAST).unwrap();
        let dir = super::super::manifest::manifest_dir(&root);
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o500)).unwrap();
        let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            wait_until("轮询到 AtRisk", || {
                matches!(held.poll(), LeaseStatus::AtRisk(_))
            });
            if let LeaseStatus::AtRisk(why) = held.poll() {
                assert!(why.contains("没有一次成功的心跳"), "{why}");
            }
        }));
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700)).unwrap();
        drop(held);
        r.unwrap();
    }

    #[test]
    fn stale_detection_treats_an_unparseable_timestamp_as_stale() {
        let mut l = live("M", 1, "");
        l.heartbeat_at = "不是时间".into();
        assert!(
            l.is_stale(chrono::Utc::now()),
            "读不懂的时间戳当过期,否则一份坏租约能永久堵死这个任务"
        );
    }
}
