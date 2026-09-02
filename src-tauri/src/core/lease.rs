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
//! - **接管**(过期 / 本机残留 / 陈旧到读不懂)、**心跳**、**释放**三条路径都在
//!   同一把**接管锁**(`<id>.lease.takeover` 目录,`create_dir` 三平台原子的
//!   「已存在即失败」)下动租约文件,互斥。拿到锁的那个进程**重读**租约再决定
//!   (锁之前读到的可能已经被别人换掉了),然后 `remove_file` + 原子取得。
//!   没有这把锁会出现「A 删旧的、A 建新的、B 删掉 A 刚建的、B 建自己的」——
//!   两边都成功(macOS CI 的 Barrier 测试真的抓到过);心跳的替换式写同样会
//!   顶掉刚接管成功的那份。锁目录崩溃残留按 mtime 过期回收。
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
use std::sync::atomic::{AtomicBool, Ordering};
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
        // 10 秒一拍:每拍只是一个几百字节的小文件。接管「按时钟过期」的租约前要
        // 观察一个心跳周期(见 acquire),拍子越短,一台真死掉的机器留下的任务
        // 就越快能在别处续上(约 15 秒,而不是 35 秒)
        heartbeat_every: std::time::Duration::from_secs(10),
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
        self.machine_id == machine_id && !pid_is_ocard(self.pid)
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

/// 这个 pid 现在是不是**一个 OCard 进程**(本机)。
///
/// 只看「pid 活着」不够:pid 会被系统复用(Windows 尤其快),自己上次崩溃留下的
/// pid 可能现在是别的程序——那时把它当成「本机另一个 OCard」拒绝续传 30 分钟,
/// 报文还指着一个不相干的进程。进程名不像 OCard 的,一律按「不在」算。
fn pid_is_ocard(pid: u32) -> bool {
    use sysinfo::{Pid, ProcessRefreshKind, RefreshKind, System};
    let s = System::new_with_specifics(
        RefreshKind::nothing().with_processes(ProcessRefreshKind::nothing()),
    );
    let Some(p) = s.process(Pid::from_u32(pid)) else {
        return false;
    };
    let name = p.name().to_string_lossy().to_ascii_lowercase();
    name.contains("ocard")
}

/// 租约文件落点。id 走与清单同一道形状闸(`manifest_child`),不裸拼。
pub fn lease_path(project_root: &Path, manifest_id: &str) -> Result<PathBuf> {
    super::manifest::manifest_child(project_root, manifest_id, "lease")
}

/// 原子地把一份租约放到 `path`:唯一临时文件(create_new,撞名换名)→ `rename_no_replace`。
/// 返回 `Ok(false)` = 目标已存在(有人持有);其它错误原样上抛。
/// 临时名用 [`super::fsx::TMP_SUFFIX`],崩溃残留由启动清扫回收。
fn try_create(path: &Path, lease: &Lease) -> Result<bool> {
    let dir = path.parent().unwrap_or(Path::new("."));
    let stem = path
        .file_name()
        .unwrap_or_default()
        .to_string_lossy()
        .to_string();
    let bytes = serde_json::to_vec_pretty(lease)?;
    let mut tmp = None;
    for _ in 0..3 {
        let cand = dir.join(format!(
            ".{stem}.{}{}",
            &uuid::Uuid::new_v4().simple().to_string()[..8],
            super::fsx::TMP_SUFFIX
        ));
        match std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&cand)
        {
            Ok(mut f) => {
                use std::io::Write as _;
                if let Err(e) = f.write_all(&bytes).and_then(|()| f.sync_all()) {
                    drop(f);
                    let _ = std::fs::remove_file(&cand);
                    return Err(super::CoreError::io_detail("写入任务租约", &cand, &e));
                }
                tmp = Some(cand);
                break;
            }
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(e) => {
                return Err(super::CoreError::io_detail(
                    "创建任务租约临时文件",
                    &cand,
                    &e,
                ))
            }
        }
    }
    let Some(tmp) = tmp else {
        return Err(super::CoreError::Invalid(
            "任务租约临时文件名连续三次撞车".into(),
        ));
    };
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
///
/// **拿不准一律算年轻**(fail-closed):mtime 由 NAS 服务端盖章、`now` 是本机——
/// 服务端时钟快(mtime 在未来)或 metadata 读失败时,答案是「不知道」,而
/// 「不知道」往「有人正在用」这边倒,顶多让人多等两分钟;往「垃圾」那边倒,
/// 就是把别人刚写下的租约当垃圾接管。
fn is_young(path: &Path) -> bool {
    match std::fs::metadata(path).and_then(|m| m.modified()) {
        Ok(t) => match std::time::SystemTime::now().duration_since(t) {
            Ok(age) => age < YOUNG_LEASE,
            Err(_) => true, // mtime 在未来:对方时钟快,按刚写的算
        },
        Err(_) => true,
    }
}

/// 接管锁:`<id>.lease.takeover` 目录 + 目录里一个一次性 **nonce 文件**。
///
/// `create_dir` 三平台都是原子的「已存在即失败」;接管、心跳、释放三条路径都
/// 在它下面动租约文件,互斥。
///
/// nonce 是回收残留锁的关键:只按 mtime 回收会互删——两个进程都看到同一个老锁,
/// A `rmdir` + `mkdir` 拿到锁,B 再 `rmdir` 删掉的是 A 刚建的(评审复现 4000 轮
/// 中 3 轮)。现在:锁目录里放 `<uuid>` 文件,`rmdir` 在它存在时必然失败;回收者
/// 先 `remove_file(它看到的那个 nonce)`——同一个 nonce 只有一个进程能删成——
/// 删成了才 `rmdir`。别人新建的锁带的是新 nonce,删不动。每个破坏性动作之前
/// 再问一句 [`still_mine`](TakeoverLock::still_mine):nonce 还在就是我的。
/// 离开作用域按 nonce 归属删掉;崩溃残留按 mtime 超过 [`YOUNG_LEASE`](双向)回收。
struct TakeoverLock {
    dir: PathBuf,
    nonce: PathBuf,
}

impl TakeoverLock {
    fn path_for(lease: &Path) -> PathBuf {
        lease.with_extension("lease.takeover")
    }

    /// 锁目录能不能回收。**两个方向都算过期**:一次接管只需几十毫秒,锁目录的
    /// mtime 离现在超过 [`YOUNG_LEASE`]——过去或未来(对方时钟快)——都不可能是
    /// 正在进行的接管。沿用 fail-closed 的 `is_young` 的话,一个 mtime 在未来的
    /// 崩溃残留会永远收不回。metadata 读不到仍按「不回收」(下一次再试)。
    fn is_reclaimable(dir: &Path) -> bool {
        let Ok(t) = std::fs::metadata(dir).and_then(|m| m.modified()) else {
            return false;
        };
        let skew = match std::time::SystemTime::now().duration_since(t) {
            Ok(age) => age,
            Err(e) => e.duration(),
        };
        skew > YOUNG_LEASE
    }

    /// mkdir 成功之后写 nonce。写不进去且目录已经不在 = 在 mkdir 与写 nonce 之间被
    /// 一个回收者当成「空的残留」删掉了(那是它的错,见 [`reclaim`](Self::reclaim)
    /// 的复查),按「没拿到」处理;目录还在却写不进去才是真错误。
    /// 错误路径**不**rmdir:目录可能已经是别人重新建的。
    fn make(dir: PathBuf) -> Result<Option<Self>> {
        let nonce = dir.join(uuid::Uuid::new_v4().simple().to_string());
        match std::fs::write(&nonce, b"") {
            Ok(()) => Ok(Some(Self { dir, nonce })),
            Err(_) if !dir.exists() => Ok(None),
            Err(e) => Err(super::CoreError::io_detail(
                "写入租约接管锁标记",
                &nonce,
                &e,
            )),
        }
    }

    /// 回收一个残留的锁目录:删掉**我看到的那个** nonce,删成了才 rmdir。
    /// 返回是否轮到我重试 create_dir。
    fn reclaim(dir: &Path) -> bool {
        let Ok(rd) = std::fs::read_dir(dir) else {
            return false;
        };
        let nonces: Vec<PathBuf> = rd.flatten().map(|e| e.path()).collect();
        if nonces.is_empty() {
            // 没有 nonce 的空目录有两种:mkdir 后写 nonce 前崩了的残留(老),
            // 或别人**此刻**刚 mkdir、还没来得及写 nonce(新)。调用方判断
            // 「可回收」看的可能是被换掉之前的那个目录,这里必须按目录本身再看一次
            if !Self::is_reclaimable(dir) {
                return false;
            }
            return std::fs::remove_dir(dir).is_ok();
        }
        let mut removed_any = false;
        for n in &nonces {
            match std::fs::remove_file(n) {
                Ok(()) => removed_any = true,
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {} // 别人抢先删了
                Err(e) => log::warn!("租约接管锁的残留标记删不掉 {}: {e}", n.display()),
            }
        }
        if !removed_any {
            return false; // 我一个都没删成:回收权归别人
        }
        match std::fs::remove_dir(dir) {
            Ok(()) => true,
            Err(e) => {
                // 目录里又有了新 nonce(别人在我删完到 rmdir 之间建了新锁)= 让路
                log::warn!("租约接管锁目录回收失败 {}: {e}", dir.display());
                false
            }
        }
    }

    fn try_take(lease: &Path) -> Result<Option<Self>> {
        let dir = Self::path_for(lease);
        for attempt in 0..2 {
            match std::fs::create_dir(&dir) {
                Ok(()) => return Self::make(dir),
                Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
                    // 别人正拿着;或是上次接管到一半崩了留下的——老的就回收再试一次
                    if attempt == 0 && Self::is_reclaimable(&dir) && Self::reclaim(&dir) {
                        continue;
                    }
                    return Ok(None);
                }
                Err(e) => return Err(super::CoreError::io_detail("创建租约接管锁", &dir, &e)),
            }
        }
        Ok(None)
    }

    /// 等一小会儿再试(给心跳/释放用:对面接管只需几十毫秒)。
    fn take_with_patience(lease: &Path, tries: u32) -> Result<Option<Self>> {
        for i in 0..tries {
            if let Some(g) = Self::try_take(lease)? {
                return Ok(Some(g));
            }
            if i + 1 < tries {
                std::thread::sleep(std::time::Duration::from_millis(50));
            }
        }
        Ok(None)
    }

    /// 锁还是不是我的(nonce 还在)。每个破坏性动作之前问一句。
    fn still_mine(&self) -> bool {
        self.nonce.exists()
    }
}

impl Drop for TakeoverLock {
    fn drop(&mut self) {
        // 只删自己的:nonce 已经不在 = 被人回收了,目录现在是别人的
        match std::fs::remove_file(&self.nonce) {
            Ok(()) => {
                if let Err(e) = std::fs::remove_dir(&self.dir) {
                    log::warn!("租约接管锁目录删不掉 {}: {e}", self.dir.display());
                }
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => log::warn!("租约接管锁标记删不掉 {}: {e}", self.nonce.display()),
        }
    }
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

    // 快路径:没人持有时一步原子取得。写后回读复核 token:`rename_no_replace` 在
    // 不支持原子原语的文件系统上会退到「复查+改名」,两个快路径可能都以为自己赢了
    if try_create(&path, &me)? {
        match read_lease(&path) {
            Some(l) if l.token != me.token => {
                return Err(super::CoreError::Busy(format!(
                    "这个拷卡任务的租约刚刚被 {} 同时取得,本次让路;请在那边操作,或稍后再试",
                    l.who(machine_id)
                )));
            }
            _ => return Held::start(path, me, timing, None),
        }
    }

    // 已存在:能不能接管,要在**接管锁**下重读再判——锁之前读到的那份可能
    // 在我们判断的这一瞬间已经被别的接管者换成了新鲜的
    let guard = match TakeoverLock::try_take(&path)? {
        Some(g) => g,
        None => {
            return Err(super::CoreError::Busy(format!(
                "另一个进程正在接管这个拷卡任务的租约,本次不重复接管;请在那边操作,或稍后再试(若确认没有别的进程在跑,可删除锁目录解锁:{})",
                TakeoverLock::path_for(&path).display()
            )));
        }
    };
    let note = match classify_existing(&path, machine_id, chrono::Utc::now()) {
        Existing::Busy(msg) => return Err(super::CoreError::Busy(msg)),
        Existing::TakeOver(note) => Some(note),
        Existing::Fresh => None,
    };
    // 「按时钟过期」不能单独定罪:对方机器时钟偏差超过 TTL 时,一份**活着**的租约
    // 在我们眼里也是过期的。所以再用本机的单调时间观察一个心跳周期:心跳还在
    // 变,那就是活的,退 Busy;真死了才接管。本机残留(pid 不在)不用等。
    if let Some(l0) = read_lease(&path) {
        if l0.is_stale(chrono::Utc::now()) && !l0.is_dead_local(machine_id) {
            let margin = std::time::Duration::from_secs(5).min(timing.heartbeat_every);
            std::thread::sleep(timing.heartbeat_every + margin);
            if let Some(l1) = read_lease(&path) {
                if l1.heartbeat_at != l0.heartbeat_at || l1.token != l0.token {
                    return Err(super::CoreError::Busy(format!(
                        "这个拷卡任务正被 {} 执行中——它的心跳时间戳按本机时钟看已过期,但观察期间仍在推进,多半是那台机器的时钟与本机相差较大。请在那边操作,或先校准时钟",
                        l1.who(machine_id)
                    )));
                }
            }
        }
    }

    // 持锁期间接管者只有我们;快路径的 try_create 仍可能抢在 remove 与 create
    // 之间落一份新的——那就让它赢,我们退回 Busy(它是干净取得,不需要接管)
    // 删之前再确认锁还是我的:被回收了就等于没锁
    if !guard.still_mine() {
        return Err(super::CoreError::Busy(
            "接管锁在判断期间被别的进程回收,本次让路;请稍后再试".into(),
        ));
    }
    match std::fs::remove_file(&path) {
        Ok(()) => {}
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => return Err(super::CoreError::io_detail("移除过期的任务租约", &path, &e)),
    }
    if try_create(&path, &me)? {
        Held::start(path, me, timing, note)
    } else {
        Err(super::CoreError::Busy(
            "另一个进程刚刚抢先取得了这个拷卡任务的租约,本次不再重复接管;请在那边操作,或稍后再试"
                .into(),
        ))
    }
}

/// 对已存在的租约的裁决。
enum Existing {
    /// 活着的别人 / 正在初始化:拒绝,带报文。
    Busy(String),
    /// 可以接管,带给用户看的说明。
    TakeOver(String),
    /// 文件已经不在(上一个持有者刚干净释放):直接取得,不算接管。
    Fresh,
}

/// 判断顺序有讲究:先看过期,再看是不是本机残留——「同机 pid 是活着的 OCard 但
/// token 不同」在最后,那是真的有人在跑。
fn classify_existing(
    path: &Path,
    machine_id: &str,
    now: chrono::DateTime<chrono::Utc>,
) -> Existing {
    match read_lease(path) {
        // 上一个持有者在我们等锁期间干净释放了——正常竞态,不是接管,不发告警
        None if !path.exists() => Existing::Fresh,
        None if is_young(path) => Existing::Busy(
            "这个拷卡任务的租约刚被写入、还读不出内容(另一个进程正在开始或接管它),稍等片刻再试".into(),
        ),
        None => Existing::TakeOver(
            "上一份任务租约读不懂且已陈旧(可能是异常退出写了一半),已接管".to_string(),
        ),
        Some(l) if l.is_stale(now) => Existing::TakeOver(format!(
            "接管了一份过期的任务租约:{} 上次心跳 {},已超过 {} 分钟没有动静(多半是上次异常退出;若那台机器时钟不准也会这样)",
            l.who(machine_id),
            l.heartbeat_at,
            LEASE_TTL.num_minutes()
        )),
        Some(l) if l.is_dead_local(machine_id) => Existing::TakeOver(format!(
            "接管了本机上一个 OCard 进程(pid {})留下的任务租约:那个进程已经不存在了(或该 pid 已被别的程序复用),多半是上次强退或崩溃。上次的进度都在清单里,会从断点接着拷",
            l.pid
        )),
        Some(l) => Existing::Busy(format!(
            "这个拷卡任务正被 {} 执行中(心跳 {}),拒绝同时写同一份清单——两处同时写会让一方的记录被整份顶掉。请在那边操作,或等它结束/超过 {} 分钟无心跳后再续传",
            l.who(machine_id),
            l.heartbeat_at,
            LEASE_TTL.num_minutes()
        )),
    }
}

/// 只看不取:有没有**活着的别人**正持有这个任务的租约?返回描述,供报文点名。
///
/// 给「不由 worker 发起、却要写同一份清单」的路径用(启动补投自动转代理是一例)。
/// 拿不准(读不懂但年轻)按「有人」算——那是正在初始化的。
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
    /// 单调时钟基准。墙钟会被 NTP 回拨、被休眠前跳:回拨会让「多久没心跳」失明,
    /// 前跳会把一次合盖误报成心跳故障。
    epoch: std::time::Instant,
    /// 最近一次**成功**心跳距 `epoch` 的毫秒。失败不推进——这正是「多久没成功」的判据。
    last_ok_ms: std::sync::atomic::AtomicU64,
    /// 租约已经不是我的了(别人合法接管),里面是对方的描述。
    lost: Mutex<Option<String>>,
    /// 最近一次心跳失败的原因(给 at-risk 报文用)。
    last_err: Mutex<Option<String>>,
}

impl Shared {
    fn now_ms(&self) -> u64 {
        self.epoch.elapsed().as_millis() as u64
    }
}

/// 中毒也照读:心跳线程若在持锁时 panic,拷贝线程不该跟着炸。
fn lock_or_recover<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|p| p.into_inner())
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
    /// 清单——租约要防的正是这个。上层必须停,而且**不再写清单**。
    Lost(String),
    /// 心跳已经很久没成功:再过一会儿别人就有权接管,而我们还在写。上层应停下。
    AtRisk(String),
}

/// 释放的结果。用户要的不是「文件还在」,是「为什么还在」——三种原因的下一步完全不同。
#[derive(Debug, PartialEq, Eq)]
pub enum Released {
    /// 删了(或早已不在)。
    Removed,
    /// 盘上那份不是我们的(别人合法接管了),没动它。
    TakenOver,
    /// 是我们的,但删不掉——别的机器要等 TTL、本机本次运行期间都续不了这个任务。
    RemoveFailed(String),
    /// 没拿到接管锁,**没敢删**(无保护地删可能删掉接管者刚建的那份)。后果同上。
    NoLock(String),
}

impl Held {
    fn start(
        path: PathBuf,
        me: Lease,
        timing: Timing,
        took_over_stale: Option<String>,
    ) -> Result<Self> {
        let shared = Arc::new(Shared {
            stop: AtomicBool::new(false),
            epoch: std::time::Instant::now(),
            last_ok_ms: std::sync::atomic::AtomicU64::new(0),
            lost: Mutex::new(None),
            last_err: Mutex::new(None),
        });
        let thread = {
            let (path, me, shared) = (path.clone(), me.clone(), shared.clone());
            std::thread::Builder::new()
                .name("ocard-lease-heartbeat".into())
                .spawn(move || heartbeat_loop(&path, &me, timing, &shared))
        };
        match thread {
            Ok(t) => Ok(Self {
                path,
                me,
                timing,
                shared,
                thread: Some(t),
                released: false,
                took_over_stale,
            }),
            Err(e) => {
                // 没有心跳的租约 30 分钟后就是别人的了,却还在装作持有:
                // 不如现在就把文件收回、如实报错
                let _ = std::fs::remove_file(&path);
                Err(super::CoreError::io_detail("启动租约心跳线程", &path, &e))
            }
        }
    }

    /// 文件边界上问一句:我还持有吗、心跳还健康吗。
    pub fn poll(&self) -> LeaseStatus {
        if let Some(who) = lock_or_recover(&self.shared.lost).clone() {
            return LeaseStatus::Lost(who);
        }
        let since_ok_ms = self
            .shared
            .now_ms()
            .saturating_sub(self.shared.last_ok_ms.load(Ordering::Relaxed));
        if since_ok_ms > self.timing.at_risk_after.as_millis() as u64 {
            let secs = since_ok_ms / 1000;
            let why = match lock_or_recover(&self.shared.last_err).clone() {
                Some(e) => format!("已有 {secs} 秒没有一次成功的心跳(最近一次失败:{e});再等下去别的进程就有权接管这个任务"),
                // 没有失败记录却很久没成功 = 心跳线程根本没跑到:本机休眠过、
                // 或时钟/调度出了问题,不是目录写不进去,别把人支去查权限
                None => format!("心跳线程已有 {secs} 秒没有推进(本机可能休眠过,或线程被卡住);再等下去别的进程就有权接管这个任务"),
            };
            return LeaseStatus::AtRisk(why);
        }
        LeaseStatus::Ok
    }

    /// 租约文件的落点(收尾自查用)。
    pub fn path(&self) -> &Path {
        &self.path
    }

    /// 显式释放并回报结果(`Drop` 也会释放,只是没人接结果)。
    pub fn release(mut self) -> Released {
        self.release_inner()
    }

    /// 停心跳;只删**自己的**那一份(按 token):别人接管之后不能把人家的删掉。
    fn release_inner(&mut self) -> Released {
        if self.released {
            return Released::Removed;
        }
        self.released = true;
        self.shared.stop.store(true, Ordering::SeqCst);
        if let Some(t) = self.thread.take() {
            // 心跳线程可能正卡在半死 NAS 的一次读写里(SMB 硬挂载可阻塞很久):
            // 有界地等,等不到就放手——多写一拍租约比整个任务停不下来可接受
            let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
            while !t.is_finished() && std::time::Instant::now() < deadline {
                std::thread::sleep(std::time::Duration::from_millis(20));
            }
            if t.is_finished() {
                let _ = t.join();
            } else {
                log::warn!("租约心跳线程 5 秒内没有退出(可能卡在 NAS 读写上),不再等待");
            }
        }
        if lock_or_recover(&self.shared.lost).is_some() {
            return Released::TakenOver; // 早就知道不是我们的了,不碰
        }
        // 在接管锁下读+删:否则读到「是我的」之后、删之前,接管者可能刚把他的换上来。
        // 收尾路径可以多等一会儿(2 秒);仍拿不到就**不删**——无保护地删可能删掉
        // 接管者刚建的那份。不删的代价是别人多等 TTL,上层会把这件事说出来
        let tries = (self.timing.heartbeat_every.as_millis() as u32 * 4 / 50).clamp(4, 40);
        let guard = match TakeoverLock::take_with_patience(&self.path, tries) {
            Ok(Some(g)) => g,
            Ok(None) => {
                return Released::NoLock(
                    "释放时没能拿到接管锁(别的进程正在接管,或锁目录残留)".into(),
                )
            }
            Err(e) => return Released::NoLock(e.to_string()),
        };
        // 读失败不等于「不是我的」:NAS 抖一下、杀软短暂锁住都会读失败。我们从没
        // 观察到别人接管过,手里的 token 是权威;重试几次仍读不出就按自己的删——
        // 留着它会让本进程与本机都自锁 30 分钟(pid 活着,不算残留)
        let mut verdict: Option<bool> = None;
        for _ in 0..3 {
            match std::fs::read(&self.path) {
                Ok(b) => {
                    verdict = Some(
                        serde_json::from_slice::<Lease>(&b)
                            .map(|l| l.token == self.me.token)
                            .unwrap_or(true), // 读得出文件但解析不了:写了一半的自己
                    );
                    break;
                }
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Released::Removed,
                Err(_) => std::thread::sleep(std::time::Duration::from_millis(100)),
            }
        }
        if verdict == Some(false) {
            return Released::TakenOver;
        }
        if !guard.still_mine() {
            return Released::NoLock("接管锁在释放期间被别的进程回收".into());
        }
        match std::fs::remove_file(&self.path) {
            Ok(()) => Released::Removed,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Released::Removed,
            Err(e) => {
                log::warn!("任务租约删不掉 {}: {e}", self.path.display());
                Released::RemoveFailed(super::error::explain_io(&e))
            }
        }
    }
}

impl Drop for Held {
    /// panic、`?` 早退、强退前的 unwind——凡是走得到析构的路径都会释放。
    /// (进程被 kill -9 / 断电走不到这里,那种残留由「同机 pid 不在」接管兜住。)
    fn drop(&mut self) {
        let _ = self.release_inner();
    }
}

/// 心跳线程主体。每一拍:拿接管锁 → 读盘核对 token → 是自己的才写 → 写完回读复核。
///
/// 为什么要拿锁:心跳的写是替换式 rename。不拿锁的话,「读到是自己的 → 写」之间
/// 接管者可能完成了 remove+create,我们那一写就把新持有者整份顶掉,两边都以为
/// 自己持有。接管、释放、心跳三方共用同一把锁,互斥。
fn heartbeat_loop(path: &Path, me: &Lease, timing: Timing, shared: &Shared) {
    let tick = std::time::Duration::from_millis(50);
    let mut since_beat = std::time::Duration::ZERO;
    let fail = |why: String| *lock_or_recover(&shared.last_err) = Some(why);
    while !shared.stop.load(Ordering::SeqCst) {
        std::thread::sleep(tick);
        since_beat += tick;
        if since_beat < timing.heartbeat_every {
            continue;
        }
        since_beat = std::time::Duration::ZERO;

        let guard = match TakeoverLock::take_with_patience(path, 3) {
            Ok(Some(g)) => g,
            Ok(None) => {
                // 有人正在接管(多半因为我们的心跳已经停了很久):这一拍不写,
                // 下一拍再看盘上是谁的
                fail("接管锁被别的进程持有,本拍跳过".into());
                continue;
            }
            Err(e) => {
                fail(e.to_string());
                continue;
            }
        };

        match std::fs::read(path) {
            Ok(b) => {
                if let Ok(l) = serde_json::from_slice::<Lease>(&b) {
                    if l.token != me.token {
                        *lock_or_recover(&shared.lost) = Some(l.who(&me.machine_id));
                        return; // 不再碰它,也不再尝试释放(release 会核对 token)
                    }
                }
                // 读不懂 = 写了一半的自己,照常覆盖
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                // 文件没了(有人手动删了 / 接管者删了还没建):**不替换式地**重建。
                // 建不成 = 别人已经建了他的 → 回读判 Lost
                let mut beat = me.clone();
                beat.heartbeat_at = chrono::Utc::now().to_rfc3339();
                match try_create(path, &beat) {
                    Ok(true) => {
                        shared.last_ok_ms.store(shared.now_ms(), Ordering::Relaxed);
                        *lock_or_recover(&shared.last_err) = None;
                    }
                    Ok(false) => match read_lease(path) {
                        Some(l) if l.token != me.token => {
                            *lock_or_recover(&shared.lost) = Some(l.who(&me.machine_id));
                            return;
                        }
                        Some(_) => {}
                        // 别人建了一份、内容却读不懂:这一拍没续上,而且不是「线程没跑」
                        None => fail("租约文件已被别的进程建立但内容读不懂,本拍没能续上".into()),
                    },
                    Err(e) => fail(e.to_string()),
                }
                continue;
            }
            Err(e) => {
                fail(super::error::explain_io(&e));
                continue;
            }
        }
        if !guard.still_mine() {
            fail("接管锁在本拍期间被回收,本拍跳过".into());
            continue;
        }
        let mut beat = me.clone();
        beat.heartbeat_at = chrono::Utc::now().to_rfc3339();
        let written = serde_json::to_vec_pretty(&beat)
            .map_err(|e| e.to_string())
            .and_then(|b| {
                super::fsx::write_atomic(path, &b)
                    .map_err(|f| format!("{}{}", super::error::explain_io(&f.source), f.note()))
            });
        match written {
            Ok(_) => {
                // 写完回读复核:锁之外唯一能插进来的是快路径的干净取得,而那只在
                // 文件不存在时成功——理论上到不了,但复核只花一次小读,值得
                match read_lease(path) {
                    Some(l) if l.token != me.token => {
                        *lock_or_recover(&shared.lost) = Some(l.who(&me.machine_id));
                        return;
                    }
                    _ => {
                        shared.last_ok_ms.store(shared.now_ms(), Ordering::Relaxed);
                        *lock_or_recover(&shared.last_err) = None;
                    }
                }
            }
            Err(why) => fail(why),
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
            .find(|p| !pid_is_ocard(*p))
            .unwrap()
    }

    /// 打开一个**目录**以便改它的时间戳。Windows 上 `File::open` 打开目录会
    /// ACCESS_DENIED,得带 FILE_FLAG_BACKUP_SEMANTICS(CI 实测)。
    fn open_dir_for_times(dir: &Path) -> std::fs::File {
        let mut o = std::fs::OpenOptions::new();
        #[cfg(windows)]
        {
            use std::os::windows::fs::OpenOptionsExt;
            // 改时间戳要 FILE_WRITE_ATTRIBUTES;只 read 打开会 ACCESS_DENIED(CI 实测)。
            // access_mode 会覆盖 read/write 标志,所以这里不再 .read(true)
            o.access_mode(0x0100); // FILE_WRITE_ATTRIBUTES
            o.custom_flags(0x0200_0000); // FILE_FLAG_BACKUP_SEMANTICS:允许打开目录
        }
        #[cfg(not(windows))]
        {
            o.read(true);
        }
        o.open(dir).expect("打开目录改时间戳")
    }

    fn set_dir_mtime(dir: &Path, t: std::time::SystemTime) {
        open_dir_for_times(dir)
            .set_times(std::fs::FileTimes::new().set_modified(t))
            .expect("改目录 mtime");
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

    /// pid 被系统复用给了别的程序:那不是 OCard,当然也不持有这份租约。
    /// 只看「pid 活着」会把任务锁 30 分钟,报文还指着一个不相干的进程。
    #[test]
    #[cfg(unix)]
    fn a_reused_pid_that_is_not_ocard_counts_as_dead_local() {
        let (_t, root, id) = setup();
        // cargo test 的 runner:活着,但不是 ocard。前置用硬断言而不是「跳过」:
        // 静默跳过会让「判定退化成只看 pid 活着」的回退变异照样全绿——那正是
        // 这条测试要抓的东西
        let ppid = unsafe { libc::getppid() as u32 };
        assert!(
            !pid_is_ocard(ppid),
            "前置:父进程(pid {ppid})不该被识别成 OCard;若真是,说明进程名判定退化了"
        );
        write_lease(&root, &id, &live("MACHINE-A", ppid, "张三"));
        let held = acquire(&root, &id, "MACHINE-A", "张三").expect("复用的 pid 必须按残留接管");
        assert!(held.took_over_stale.as_deref().unwrap().contains("复用"));
    }

    #[test]
    fn a_stale_lease_can_be_taken_over_but_says_so_out_loud() {
        let (_t, root, id) = setup();
        write_lease(&root, &id, &stale(live("MACHINE-B", 4242, "李四")));
        let held = acquire_with(&root, &id, "MACHINE-A", "张三", FAST).unwrap();
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

    /// 对方时钟偏差超过 TTL:它的租约按本机时钟看已经「过期」,但它明明活着、
    /// 心跳还在走。接管前先用本机单调时间观察一个心跳周期,心跳变了就不许接管。
    #[test]
    fn a_live_lease_that_merely_looks_stale_by_clock_is_not_stolen() {
        let (_t, root, id) = setup();
        let p = lease_path(&root, &id).unwrap();
        let mut skewed = live("MACHINE-B", 4242, "李四");
        let base = chrono::Utc::now() - LEASE_TTL - chrono::Duration::hours(2);
        skewed.heartbeat_at = base.to_rfc3339();
        write_lease(&root, &id, &skewed);
        // 模拟对方的心跳线程:按它那套慢时钟**持续**推进 heartbeat_at(原子写,
        // 免得观察者读到半截文件),直到我们这边的 acquire 返回
        let stop = Arc::new(AtomicBool::new(false));
        let pusher = {
            let (p, mut beat, stop) = (p.clone(), skewed.clone(), stop.clone());
            std::thread::spawn(move || {
                let mut n = 0i64;
                while !stop.load(Ordering::SeqCst) {
                    std::thread::sleep(std::time::Duration::from_millis(20));
                    n += 1;
                    beat.heartbeat_at = (base + chrono::Duration::seconds(n)).to_rfc3339();
                    let _ =
                        super::super::fsx::write_atomic(&p, &serde_json::to_vec(&beat).unwrap());
                }
            })
        };
        let err = acquire_with(&root, &id, "MACHINE-A", "张三", FAST).unwrap_err();
        stop.store(true, Ordering::SeqCst);
        pusher.join().unwrap();
        assert!(matches!(err, super::super::CoreError::Busy(_)), "{err}");
        assert!(err.to_string().contains("时钟"), "{err}");
        assert_eq!(
            on_disk(&root, &id).token,
            skewed.token,
            "活着的租约被偷走了"
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
        let held = acquire_with(&root, &id, "MACHINE-A", "张三", FAST)
            .expect("时钟不同步不能永久锁死任务");
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
        let held = acquire_with(&root, &id, "MACHINE-A", "张三", FAST).unwrap();
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
                // 把 Held 整个带回来:线程里一返回就 Drop 的话,先赢者释放、
                // 后者干净取得,「两个都 Ok」反而是合法的,测试就测不到竞态了
                acquire_with(&root, &id, "MACHINE-A", op, FAST).map_err(|e| e.to_string())
            }));
        }
        let results: Vec<std::result::Result<Held, String>> =
            hs.into_iter().map(|h| h.join().unwrap()).collect();
        let winners = results.iter().filter(|r| r.is_ok()).count();
        assert_eq!(
            winners,
            1,
            "必须恰好一个接管成功: {:?}",
            results
                .iter()
                .map(|r| r.as_ref().map(|h| h.me.token.clone()))
                .collect::<Vec<_>>()
        );
        let loser = results
            .iter()
            .find(|r| r.is_err())
            .unwrap()
            .as_ref()
            .unwrap_err();
        assert!(
            loser.contains("抢先")
                || loser.contains("正在接管")
                || loser.contains("正被")
                || loser.contains("刚被写入"),
            "{loser}"
        );
    }

    /// 上次接管到一半崩了,锁目录留在盘上:老的必须能被回收,否则这个任务永远
    /// 接管不了;新鲜的(别人正在接管)则要让路。
    #[test]
    fn a_crashed_takeover_lock_is_reclaimed_when_old_but_respected_when_fresh() {
        let (_t, root, id) = setup();
        write_lease(&root, &id, &stale(live("MACHINE-B", 4242, "李四")));
        let lock = TakeoverLock::path_for(&lease_path(&root, &id).unwrap());

        std::fs::create_dir(&lock).unwrap();
        let err = acquire_with(&root, &id, "MACHINE-A", "张三", FAST).unwrap_err();
        assert!(
            err.to_string().contains("正在接管"),
            "新鲜的锁要让路: {err}"
        );
        assert!(matches!(err, super::super::CoreError::Busy(_)));

        let old = std::time::SystemTime::now() - YOUNG_LEASE - std::time::Duration::from_secs(60);
        set_dir_mtime(&lock, old);
        let held =
            acquire_with(&root, &id, "MACHINE-A", "张三", FAST).expect("老的锁目录必须能回收");
        assert!(held.took_over_stale.is_some());
        assert!(!lock.exists(), "接管完成后锁目录要删掉");
    }

    /// 锁目录的 mtime 在**未来**(NAS 时钟快)也必须能回收:一次接管只要几十毫秒,
    /// 离现在超过两分钟——不管哪个方向——都不可能是正在进行的接管。
    /// 沿用租约文件那套 fail-closed 判断的话,这个任务会永远接管不了。
    #[test]
    fn a_crashed_takeover_lock_stamped_in_the_future_is_still_reclaimed() {
        let (_t, root, id) = setup();
        write_lease(&root, &id, &stale(live("MACHINE-B", 4242, "李四")));
        let lock = TakeoverLock::path_for(&lease_path(&root, &id).unwrap());
        std::fs::create_dir(&lock).unwrap();
        set_dir_mtime(
            &lock,
            std::time::SystemTime::now() + std::time::Duration::from_secs(3600),
        );
        let held = acquire_with(&root, &id, "MACHINE-A", "张三", FAST)
            .expect("未来时间戳的残留锁目录必须能回收");
        assert!(held.took_over_stale.is_some());
        assert!(!lock.exists());
    }

    /// 接管者持锁期间,心跳**这一拍**不许写(写了就把接管者的顶掉);锁放开后照常。
    #[test]
    fn heartbeat_yields_while_someone_holds_the_takeover_lock() {
        let (_t, root, id) = setup();
        let held = acquire_with(&root, &id, "MACHINE-A", "张三", FAST).unwrap();
        let lock = TakeoverLock::path_for(&lease_path(&root, &id).unwrap());
        std::fs::create_dir(&lock).unwrap();
        let before = on_disk(&root, &id).heartbeat_at;
        std::thread::sleep(FAST.heartbeat_every * 4);
        assert_eq!(
            on_disk(&root, &id).heartbeat_at,
            before,
            "持锁期间心跳不许写"
        );
        std::fs::remove_dir(&lock).unwrap();
        wait_until("锁放开后心跳恢复", || {
            on_disk(&root, &id).heartbeat_at != before
        });
        assert_eq!(held.poll(), LeaseStatus::Ok);
    }

    /// 两个进程同时回收同一个残留锁目录:只能有一个拿到锁。只按 mtime 回收会互删
    /// (A rmdir+mkdir 拿到锁,B 再 rmdir 删掉的是 A 刚建的),评审 4000 轮复现 3 次。
    #[test]
    fn concurrent_reclaim_of_a_stale_takeover_lock_admits_exactly_one() {
        let (_t, root, id) = setup();
        let lease = lease_path(&root, &id).unwrap();
        let dir = TakeoverLock::path_for(&lease);
        for round in 0..30 {
            std::fs::create_dir(&dir).unwrap();
            std::fs::write(dir.join("stale-nonce"), b"").unwrap();
            set_dir_mtime(
                &dir,
                std::time::SystemTime::now() - YOUNG_LEASE - std::time::Duration::from_secs(60),
            );
            let barrier = Arc::new(std::sync::Barrier::new(2));
            let hs: Vec<_> = (0..2)
                .map(|_| {
                    let (lease, barrier) = (lease.clone(), barrier.clone());
                    std::thread::spawn(move || {
                        barrier.wait();
                        TakeoverLock::try_take(&lease).unwrap()
                    })
                })
                .collect();
            let got: Vec<Option<TakeoverLock>> =
                hs.into_iter().map(|h| h.join().unwrap()).collect();
            let holders = got.iter().filter(|g| g.is_some()).count();
            assert_eq!(
                holders, 1,
                "第 {round} 轮:同时回收一个残留锁目录,持有者必须恰好一个"
            );
            let holder = got.into_iter().flatten().next().unwrap();
            assert!(holder.still_mine(), "第 {round} 轮:赢家的锁被输家回收了");
            drop(holder);
            assert!(!dir.exists(), "第 {round} 轮:释放后锁目录要删掉");
        }
    }

    /// 回收残留锁的**空目录**分支必须按目录本身再看一次年龄:一个刚 mkdir、还没写
    /// nonce 的新锁看起来也是空的,直接 rmdir 就把别人正在取得的锁删了(并发测试
    /// 只有 1/15 的概率撞上这个窗口,所以这里直接考分支)。
    #[test]
    fn reclaim_leaves_a_fresh_empty_lock_dir_alone_but_takes_an_old_one() {
        let t = tempdir().unwrap();
        let dir = t.path().join("x.lease.takeover");
        std::fs::create_dir(&dir).unwrap();
        assert!(
            !TakeoverLock::reclaim(&dir),
            "刚建的空目录是别人正在取得的锁,不许回收"
        );
        assert!(dir.exists());
        set_dir_mtime(
            &dir,
            std::time::SystemTime::now() - YOUNG_LEASE - std::time::Duration::from_secs(60),
        );
        assert!(
            TakeoverLock::reclaim(&dir),
            "老的空目录(mkdir 后崩了)要能回收"
        );
        assert!(!dir.exists());
    }

    /// 等锁期间上一个持有者干净释放、文件已经不在:那不是接管,不许标成接管。
    /// (快路径拿不到这一支——文件不在时快路径直接成功——所以直接考分类函数。)
    #[test]
    fn a_vanished_lease_classifies_as_fresh_not_takeover() {
        let t = tempdir().unwrap();
        let gone = t.path().join("gone.lease");
        assert!(matches!(
            classify_existing(&gone, "MACHINE-A", chrono::Utc::now()),
            Existing::Fresh
        ));
    }

    /// 上一个持有者干净释放后再取得:那是正常竞态,不是接管,不许发告警。
    #[test]
    fn a_cleanly_released_lease_is_acquired_without_a_takeover_notice() {
        let (_t, root, id) = setup();
        acquire(&root, &id, "MACHINE-A", "张三").unwrap().release();
        let held = acquire(&root, &id, "MACHINE-A", "李四").unwrap();
        assert!(held.took_over_stale.is_none(), "干净取得不该报接管");
    }

    /// 释放时拿不到接管锁:**不删**,并回报 NoLock——无保护地删可能删掉接管者刚建的那份。
    #[test]
    fn release_without_the_takeover_lock_refuses_to_delete_and_says_so() {
        let (_t, root, id) = setup();
        let held = acquire(&root, &id, "MACHINE-A", "张三").unwrap();
        let lock = TakeoverLock::path_for(&lease_path(&root, &id).unwrap());
        std::fs::create_dir(&lock).unwrap();
        std::fs::write(lock.join("someone-else"), b"").unwrap();
        let r = held.release();
        assert!(matches!(r, Released::NoLock(_)), "{r:?}");
        assert!(
            lease_path(&root, &id).unwrap().is_file(),
            "拿不到锁不许删租约"
        );
        std::fs::remove_file(lock.join("someone-else")).unwrap();
        std::fs::remove_dir(&lock).unwrap();
    }

    /// 释放要回报**为什么**文件还在:被接管 ≠ 删不掉,两者的下一步完全不同。
    #[test]
    fn release_reports_taken_over_versus_removed_distinctly() {
        let (_t, root, id) = setup();
        let held = acquire(&root, &id, "MACHINE-A", "张三").unwrap();
        assert_eq!(held.release(), Released::Removed);

        let held = acquire(&root, &id, "MACHINE-A", "张三").unwrap();
        write_lease(&root, &id, &live("MACHINE-C", 999, "赵六"));
        assert_eq!(held.release(), Released::TakenOver);
        assert!(lease_path(&root, &id).unwrap().is_file());
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

    /// 「年轻」判断拿不准时必须往「有人正在用」倒:mtime 在未来(NAS 时钟快)、
    /// metadata 读不到,都不许把别人刚写的租约当垃圾接管。
    #[test]
    fn freshness_fails_closed_on_clock_skew_and_missing_metadata() {
        let t = tempdir().unwrap();
        let f = t.path().join("x");
        std::fs::write(&f, b"").unwrap();
        let future = std::time::SystemTime::now() + std::time::Duration::from_secs(3600);
        std::fs::File::options()
            .write(true)
            .open(&f)
            .unwrap()
            .set_times(std::fs::FileTimes::new().set_modified(future))
            .unwrap();
        assert!(is_young(&f), "mtime 在未来 = 对方时钟快,按刚写的算");
        assert!(
            is_young(&t.path().join("nope")),
            "读不到 metadata 也按年轻算(fail-closed)"
        );
        let old = std::time::SystemTime::now() - YOUNG_LEASE - std::time::Duration::from_secs(1);
        std::fs::File::options()
            .write(true)
            .open(&f)
            .unwrap()
            .set_times(std::fs::FileTimes::new().set_modified(old))
            .unwrap();
        assert!(!is_young(&f), "真的老了才算老");
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
