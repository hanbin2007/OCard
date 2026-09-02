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
//! ③ 心跳时间戳在**未来**超过 5 分钟([`FUTURE_SKEW_TOLERANCE`])也当过期(对方机器
//!   时钟快,否则那份租约永不过期;快几分钟以内当偏差,由观察期保护活着的持有者)。
//!
//! # 契约:进程名
//!
//! 「同机残留」的判定看 pid 对应的进程名是否含 `ocard`(`pid_is_ocard`)。这依赖
//! `tauri.conf.json` 的 `productName = "OCard"`(三平台可执行名 OCard / OCard.exe)。
//! 改产品名、或 IT 改名分发,会让同机**活着**的持有者被判成残留而被抢——改名时
//! 必须同步改这里。
//!
//! # 边界(如实声明)
//!
//! - 锁目录 / nonce / 租约文件的「年龄」用**存放它的那块盘自己的时钟**量(写探针
//!   读 mtime,见 `disk_now`),不用本机 now——多数 NAS 由服务端盖章,本机与 NAS 的
//!   时钟偏差就不影响回收判据。这是**尽力而为**:SMB 客户端持有写租约/oplock 时可能
//!   在关闭时用本机时钟盖 LastWriteTime,那种情况下探针退化成本机 now,偏差又回来了。
//!   租约文件那边的兜底是「拿不准算年轻」;锁目录的回收判据是**双向**过期(未来的
//!   mtime 也算老,否则时钟快的机器留下的残留永远收不回),所以混合盖章 + 偏差超过
//!   两分钟时,一次并发取锁会把一个**活着的**持有者的锁当残留回收——持有者在下一拍
//!   心跳 / 下一次栅栏复核锁标记时发现不是自己的,**可见地**中止一次;回收方因观察到的
//!   token 不一致拿不到租约,不会同时出现两个通过「token + 栅栏」核对的可信写者。
//!   不是「拿不准算年轻」,是「可见地被打断一次」。
//!   心跳时间戳(持有者用它自己的墙钟写)本来就受偏差影响,那一条靠观察期兜。
//!
//! - `rename_no_replace` 在既不支持原子原语、也建不了硬链接的文件系统上退到「发布锁 +
//!   复查 + rename」(见 `fsx`,有可见告警):目标路径上先用 `create_new` 拿发布锁,两个
//!   发布者互相覆盖的窗口由锁串行化。发布锁**不**按年龄在热路径回收(两个回收者能互删
//!   对方刚建的锁,回到互相覆盖):撞上就可见失败并点名锁文件;崩溃残留只由开拷前的清扫
//!   按 30 分钟(NAS 时钟)收,清扫删锁本身没有认领——三台机器同一路径、残留恰好过期、
//!   微秒级时序下理论上仍可双成功,如实声明。
//! - 接管锁靠 mtime 年龄回收(两分钟):没有存储端的原子 CAS,这是唯一能收回崩溃
//!   残留的办法,代价是**整机休眠 / 卡在一次 NAS 读写里超过两分钟**的持有者会被当成
//!   残留。后果**有界**(指:判定与进程内排队有界;一次卡在 NAS 内核里的系统调用本身
//!   可能无限阻塞,那段时间任务看起来「没有进度」而不是无声挂起——上层的进度事件停在
//!   当前文件、暂停按钮要到下一个回调才响应)且可见,但要分三种迟到的写入说清楚:
//!   * **迟到的心跳改名**(卡在 rename 系统调用里、或整机休眠,超过 TTL 才完成):会把
//!     接管者的租约整份盖回旧持有者的。让旧持有者停下的**不是** AtRisk(`poll` 用单调
//!     时钟,macOS / Linux 休眠期间不走,醒来时「多久没心跳」依然很小),而是心跳线程写完
//!     复核锁标记:锁已被回收 → 不可逆 Lost 并撤回自己那份;以及栅栏落盘前的 token 核对。
//!     接管者若恰在撤回之前读到旧 token → 报 Lost 并**可见地**转暂停,再点「继续」就能
//!     立刻接管(那份租约已被撤回或心跳陈旧)。代价是接管者白停一次,不丢数据。
//!   * **迟到的清单改名**(改名之前那一问栅栏已经过了,卡在 rename 里):会盖掉接管者
//!     刚写的清单。接管者还在跑就在它下一次落盘时修复;接管者已经跑完并释放了,盘上那份
//!     就退回旧进度——审计日志是追加写的、不受影响。若退回的那份带 `completed=true`
//!     而接管者本已把新增文件加进计划并写成 `completed=false`,后果不止「重算一遍哈希」:
//!     启动时任务重建会把它当已完成而不展示,启动补投的自动转代理也会按这份旧清单派发
//!     ——**未完成的工作可能被藏起来、后续阶段可能被提前触发**。旧持有者在写完复核时
//!     会发现栅栏已丢:发出「这次落盘不可信,请核对另一处」的通知,并在 NAS 上留下
//!     `.suspect` 不可信标记(任务重建按未完成展示、自动转代理不派发、跑完才清)。
//!   * **释放路径放手后才写完的一拍心跳**会自己撤回(见 `heartbeat_loop`;撤回删文件
//!     与接管者刚写入之间有微秒级窗口,删掉的话接管者的心跳下一拍按「文件没了」重建)。
//!
//!   真正的 fencing token 需要清单写入端做 CAS,SMB/NFS 上没有这种原语,这里如实声明。
//! - `.ocardpart` 临时名带**本次持有的 run 标签**(`<清单 id 前 8 位>-<token 前 8 位>`):
//!   一个休眠后恢复的旧持有者永远碰不到接管者的 part(名字不同),它删、改名、清理的
//!   只会是自己那一轮的路径。代价是上一轮的崩溃残留没人认得——所以持有租约的一方在
//!   开拷前按清单 id 前缀把别的 run 标签(含升级前不带标签的旧格式)的残留清掉,并把
//!   清了什么说出来。反方向如实声明:接管方的这次清扫**会**删掉一个仍在休眠中的旧持有者
//!   正在写的 part(它的标签不同,正落在认领范围内)——旧持有者醒来后回读校验读不到
//!   路径,那个文件可见地失败、续传按哈希修复;Windows 上删不掉(文件仍被占着)则进
//!   「没清成」的告警。引擎另在四处查
//!   租约:清理同名残留前、建 part 前(源哈希与逐目的地哈希那几分钟之后)、回读校验前、
//!   落位前;建 part 前那次在失败清理之外。
//! - 心跳线程与写栅栏在进程内排队,排队是**有界**的(三个心跳周期,不少于 2 秒):
//!   心跳等不到就跳过这一拍,栅栏等不到就按「没拿到锁」停下任务(可续传)——慢 NAS 上
//!   一拍心跳超过 30 秒会让任务转暂停,而不是无声挂起。
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
/// 心跳时间戳在**未来**多久以内还算「时钟偏差」而不是过期:对方机器时钟快几分钟是常态,
/// 快过这个数的时间戳当过期处理(观察期会保护真正活着的持有者)。
pub const FUTURE_SKEW_TOLERANCE: chrono::Duration = chrono::Duration::minutes(5);

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
    /// 心跳多久不更新就算过期(生产 = [`LEASE_TTL`];测试用短的,好造出
    /// 「看起来过期但其实活着」的持有者)。
    pub ttl: chrono::Duration,
}

impl Timing {
    pub const DEFAULT: Timing = Timing {
        // 10 秒一拍:每拍只是一个几百字节的小文件。接管「按时钟过期」的租约前要
        // 在锁外观察两个心跳周期(见 acquire),拍子越短,一台真死掉的机器留下的任务
        // 就越快能在别处续上(约 25 秒,而不是一分多钟)
        heartbeat_every: std::time::Duration::from_secs(10),
        // TTL 的一半:留足余量,在被接管**之前**停下
        at_risk_after: std::time::Duration::from_secs(15 * 60),
        ttl: LEASE_TTL,
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
        self.is_stale_by(now, LEASE_TTL)
    }

    fn is_stale_by(&self, now: chrono::DateTime<chrono::Utc>, ttl: chrono::Duration) -> bool {
        match chrono::DateTime::parse_from_rfc3339(&self.heartbeat_at) {
            Ok(t) => {
                let age = now - t.to_utc();
                // 未来超过 FUTURE_SKEW_TOLERANCE 就当过期(而不是超过一个 TTL):一份写在
                // 「现在 + 20 分钟」的死租约按 -ttl 判要 50 分钟才能接管,报文却承诺 30 分钟;
                // 活着的持有者时钟快几分钟无妨——它的心跳还在推进,观察期会放过它
                age > ttl || age < -FUTURE_SKEW_TOLERANCE.min(ttl)
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

/// 探针结果的复用窗口:回收门槛是两分钟,几秒内的答案完全够用;不缓存的话一次
/// 有竞争的取锁(几十次重试)就要写-读-删几十个探针文件。
const DISK_NOW_CACHE: std::time::Duration = std::time::Duration::from_secs(5);

/// 给别的模块用的「这块盘现在几点」(启动期清扫按 NAS 时钟量临时文件的年龄)。
pub fn nas_now(dir: &Path) -> Option<std::time::SystemTime> {
    disk_now(dir)
}

/// 「这块盘现在几点」:写一个探针文件读它的 mtime。年龄判断一律用它,不用本机 now。
/// 同一目录几秒内复用上次的答案(加上本机单调时钟走过的量)。
fn disk_now(dir: &Path) -> Option<std::time::SystemTime> {
    if let Some((at, t)) = lock_or_recover(disk_now_cache()).get(dir).copied() {
        if at.elapsed() < DISK_NOW_CACHE {
            return Some(t + at.elapsed());
        }
    }
    disk_now_fresh(dir)
}

type DiskNowCache = std::collections::HashMap<PathBuf, (std::time::Instant, std::time::SystemTime)>;

fn disk_now_cache() -> &'static Mutex<DiskNowCache> {
    static CACHE: std::sync::OnceLock<Mutex<DiskNowCache>> = std::sync::OnceLock::new();
    CACHE.get_or_init(Default::default)
}

/// 强制写新探针(并刷新缓存)。
fn disk_now_fresh(dir: &Path) -> Option<std::time::SystemTime> {
    let probe = dir.join(format!(
        ".clock.{}{}",
        &uuid::Uuid::new_v4().simple().to_string()[..8],
        super::fsx::TMP_SUFFIX
    ));
    std::fs::write(&probe, b"").ok()?;
    let t = std::fs::metadata(&probe).and_then(|m| m.modified()).ok();
    if let Err(e) = std::fs::remove_file(&probe) {
        // 落在交付 / 清单目录里的探针残留:开拷前的清扫按 30 分钟收走;删不掉至少要说
        log::warn!("时钟探针没删掉 {}: {e}", probe.display());
        super::fsx::note_leftover_temp(&probe);
    }
    if let Some(t) = t {
        lock_or_recover(disk_now_cache()).insert(dir.to_path_buf(), (std::time::Instant::now(), t));
    }
    t
}

/// acquire 因锁目录异常(链接 / 异物)而拒绝时报文的前缀:上层据此把通知换成
/// 「需人工清理」的 code,而不是「任务正被别的进程执行」。
pub const LOCK_DIR_BROKEN_PREFIX: &str = "租约锁目录异常";
/// 锁目录不是普通目录(符号链接 / junction / 文件):不回收、不删、也不会自己好。
const LOCK_DIR_NOT_A_DIR: &str = "不是普通目录(是符号链接 / junction 或文件)";
/// 锁目录里有不是 OCard 写的条目:同上。
const LOCK_DIR_HAS_FOREIGN_ENTRIES: &str = "里有不认识的条目(不是 OCard 写的标记)";

/// 锁目录形状检查的两种「不合法」:读不出(让路、下次再看)与异物(拒绝、要说)。
enum ShapeIssue {
    /// 锁目录在我们看它的这一瞬间**没了**(mkdir 说已存在,read_dir 却说不在):别人刚
    /// 释放并 rmdir(Windows 上 delete-pending 更常见)——不是读不出,是该立刻重试 create_dir
    Vanished,
    /// 枚举 / 读条目类型失败(带 IO 原因)。瞬时的让路;持续的要告诉用户是权限 / 存储问题,
    /// 而不是「别的进程正在接管」
    Unreadable(String),
    Foreign(&'static str),
}

/// 回收残留锁目录的结果:收回了 / 让路(带「本来能回收却删不掉」的原因,若有)。
enum Reclaimed {
    Yes,
    No(Option<String>),
}

impl Reclaimed {
    #[cfg(test)]
    fn yes(&self) -> bool {
        matches!(self, Reclaimed::Yes)
    }
}

/// 取接管锁的三种结果。`Held` 可以等;`Refused` 等多久都没用,必须说出来。
enum Take {
    Got(TakeoverLock),
    /// 别人正拿着(或残留还没到回收时间)。带上「本来能回收却删不掉」的原因(若有):
    /// 用户不该被告知「等两分钟」然后等一个永远不来的两分钟。
    Held(Option<String>),
    /// 锁目录不是我们能碰的东西,原因见 [`LOCK_DIR_NOT_A_DIR`] / [`LOCK_DIR_HAS_FOREIGN_ENTRIES`]。
    Refused(&'static str),
    /// 锁目录读不出(权限 / 存储),带 IO 原因。可以稍后再试,但要如实说,不是「别人在接管」。
    Unreadable(String),
}

/// 文件是不是「年轻」(最近才写的)。读不懂的年轻文件当作正在初始化。
///
/// **拿不准一律算年轻**(fail-closed):mtime 由 NAS 服务端盖章、`now` 是本机——
/// 服务端时钟快(mtime 在未来)或 metadata 读失败时,答案是「不知道」,而
/// 「不知道」往「有人正在用」这边倒,顶多让人多等两分钟;往「垃圾」那边倒,
/// 就是把别人刚写下的租约当垃圾接管。
fn is_young(path: &Path) -> bool {
    let Ok(t) = std::fs::symlink_metadata(path).and_then(|m| m.modified()) else {
        return true;
    };
    let Some(now) = path.parent().and_then(disk_now) else {
        return true;
    };
    match now.duration_since(t) {
        Ok(age) => age < YOUNG_LEASE,
        Err(_) => true, // mtime 在未来(同一块盘上不该发生):拿不准按年轻算
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
#[derive(Debug)]
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
    fn is_reclaimable(target: &Path) -> bool {
        Self::is_reclaimable_by(target, &disk_now)
    }

    fn is_reclaimable_by(
        target: &Path,
        now_of: &dyn Fn(&Path) -> Option<std::time::SystemTime>,
    ) -> bool {
        // 年龄用**存放它的那块盘自己的时钟**量:mtime 是 NAS 服务端盖的,本机 now
        // 与它可能相差几分钟(甚至几年);拿本机 now 去减,NAS 时钟快两分钟时每一个
        // 刚建的锁都「可回收」。往旁边写一个探针文件读它的 mtime,就是 NAS 的 now
        let Ok(meta) = std::fs::symlink_metadata(target) else {
            return false;
        };
        if meta.file_type().is_symlink() {
            return false; // 链接不碰:沿着它删就是删目录外的东西
        }
        let Ok(t) = meta.modified() else {
            return false;
        };
        // 探针写在 manifests 目录里,**绝不能写进锁目录**:nonce 的 parent 就是锁目录,
        // 探针落在那儿会被别的回收者当成「不认识的条目」而让路,两边都让 → 没人拿到;
        // 还会让 rmdir 失败、让 make() 的「只有我一个」复核误退
        let probe_dir = match target.parent() {
            Some(d) if d.extension().is_some_and(|e| e == "takeover") => d.parent(),
            other => other,
        };
        let Some(dir) = probe_dir else {
            return false;
        };
        let Some(now) = now_of(dir) else {
            return false;
        };
        let skew = match now.duration_since(t) {
            Ok(age) => age,
            Err(e) => e.duration(),
        };
        skew > YOUNG_LEASE
    }

    /// 目录里是不是**只有我的那个** nonce。数个数不够:A 写完 nonce 停了两分钟以上,
    /// B 回收重建后目录里恰好只有 B 的——个数是 1,却不是我的。枚举出错也算「不是」。
    fn alone_in(dir: &Path, nonce: &Path) -> bool {
        let Ok(rd) = std::fs::read_dir(dir) else {
            return false;
        };
        let mut n = 0usize;
        let mut mine = false;
        for e in rd {
            let Ok(e) = e else {
                return false;
            };
            n += 1;
            mine |= e.path() == nonce;
        }
        n == 1 && mine
    }

    /// 锁目录里有没有不是 OCard 写的条目。只读、不看年龄:一个刚落下的 `desktop.ini`
    /// 也该立刻被说出来,而不是先当「别人正在接管」等两分钟。
    #[cfg(test)]
    fn foreign_shape(dir: &Path) -> Option<&'static str> {
        match Self::inspect_lock_shape(dir) {
            Err(ShapeIssue::Foreign(why)) => Some(why),
            _ => None,
        }
    }

    /// 锁目录在看的一瞬间没了要判成 Vanished(而不是「读不出」):acquire 据此立刻重试。
    #[cfg(test)]
    fn shape_vanished(dir: &Path) -> bool {
        matches!(Self::inspect_lock_shape(dir), Err(ShapeIssue::Vanished))
    }

    /// 锁目录的形状:**唯一**的判据,预判(`try_take`)与回收(`reclaim`)共用,两边不会
    /// 一个放行一个拒绝。合法条目 = 名字是 32 位十六进制、且是**普通文件**(不跟链接):
    /// 一个 32 位十六进制的子目录或链接,按名字放行、回收时 `remove_file` 失败,结果是
    /// 真正的 nonce 已被删掉、异物还在、报文却说「别人正在接管」(codex r8)。
    /// 枚举出错(NAS 抖一下)不算异物,按「读不出」让路,下一次再看。
    fn inspect_lock_shape(dir: &Path) -> std::result::Result<Vec<PathBuf>, ShapeIssue> {
        let rd = std::fs::read_dir(dir).map_err(|e| {
            if e.kind() == std::io::ErrorKind::NotFound {
                ShapeIssue::Vanished
            } else {
                ShapeIssue::Unreadable(super::error::explain_io(&e))
            }
        })?;
        let mut nonces = Vec::new();
        for e in rd {
            let e = e.map_err(|e| ShapeIssue::Unreadable(super::error::explain_io(&e)))?;
            let name = e.file_name();
            let name = name.to_string_lossy();
            let shaped = name.len() == 32 && name.bytes().all(|b| b.is_ascii_hexdigit());
            // DirEntry::file_type 不跟链接:链接就是链接,不是文件
            let kind = e
                .file_type()
                .map_err(|e| ShapeIssue::Unreadable(super::error::explain_io(&e)))?;
            if !shaped || !kind.is_file() {
                return Err(ShapeIssue::Foreign(LOCK_DIR_HAS_FOREIGN_ENTRIES));
            }
            nonces.push(e.path());
        }
        Ok(nonces)
    }

    /// 目录里的条目若**全部**是本进程记在案的残留 nonce,就地删掉并 rmdir。返回是否
    /// 轮到调用方重试 create_dir。
    fn reclaim_my_orphans(entries: &[PathBuf], dir: &Path) -> bool {
        let names: Vec<String> = entries
            .iter()
            .filter_map(|p| p.file_name().map(|n| n.to_string_lossy().into_owned()))
            .collect();
        {
            let orphans = lock_or_recover(my_orphaned_nonces());
            if names.is_empty() || !names.iter().all(|n| orphans.contains(n)) {
                return false;
            }
        }
        let mut all_gone = true;
        for (p, n) in entries.iter().zip(&names) {
            match super::fsx::retry_contended(|| std::fs::remove_file(p)) {
                Ok(_) => {
                    lock_or_recover(my_orphaned_nonces()).remove(n);
                }
                Err(f) if f.source.kind() == std::io::ErrorKind::NotFound => {
                    lock_or_recover(my_orphaned_nonces()).remove(n);
                }
                Err(_) => all_gone = false,
            }
        }
        all_gone && super::fsx::retry_contended(|| std::fs::remove_dir(dir)).is_ok()
    }

    /// mkdir 成功之后写 nonce。写不进去且目录已经不在 = 在 mkdir 与写 nonce 之间被
    /// 一个回收者当成「空的残留」删掉了(那是它的错,见 [`reclaim`](Self::reclaim)
    /// 的复查),按「没拿到」处理;目录还在却写不进去才是真错误。
    /// 错误路径**不**rmdir:目录可能已经是别人重新建的。
    fn make(dir: PathBuf) -> Result<Option<Self>> {
        let nonce = dir.join(uuid::Uuid::new_v4().simple().to_string());
        match std::fs::write(&nonce, b"") {
            Ok(()) => {
                // 复核:目录里只该有我这一个 nonce。慢 NAS 上 mkdir 与写 nonce 之间
                // 可能超过回收门槛,目录被别人收走重建——我的 nonce 就落进了别人的
                // 目录,两边 still_mine 都为真。那就撤回自己的,按没拿到处理
                // 「只有我一个」必须是**我的那个**:A 写完 nonce 停了两分钟以上,B 回收
                // 重建后目录里恰好只有 B 的 nonce——数个数是 1,却不是我的(codex r6)。
                // 枚举出错也按「不是只有我」处理(fail-closed)
                if Self::alone_in(&dir, &nonce) {
                    Ok(Some(Self { dir, nonce }))
                } else {
                    let _ = std::fs::remove_file(&nonce);
                    // 双方互退 / read_dir 瞬时失败会留下一个空目录没人持有:顺手 rmdir
                    // (里面若还有别人的 nonce,rmdir 自然失败,无害)
                    let _ = std::fs::remove_dir(&dir);
                    Ok(None)
                }
            }
            Err(_) if !dir.exists() => Ok(None),
            Err(e) => Err(super::CoreError::io_detail(
                "写入租约接管锁标记",
                &nonce,
                &e,
            )),
        }
    }

    /// 回收一个残留的锁目录:删掉**我看到的那个** nonce,删成了才 rmdir。
    /// `Ok(true)` = 轮到我重试 create_dir;`Ok(false)` = 让路(别人的、新鲜的、或我没删成);
    /// `Err(why)` = **拒绝**碰这个目录,而且它不会自己好——不是普通目录、或里面有不认识
    /// 的条目。调用方必须把它说出来:这种锁目录只能人工清,等多久都没用(零静默)。
    fn reclaim(dir: &Path) -> std::result::Result<Reclaimed, &'static str> {
        // 锁目录被换成符号链接 / junction 时,顺着它枚举再逐个删 = 删目录外的东西。拒绝
        match std::fs::symlink_metadata(dir) {
            Ok(m) if m.file_type().is_dir() => {}
            Ok(_) => return Err(LOCK_DIR_NOT_A_DIR),
            Err(_) => return Ok(Reclaimed::No(None)), // 已经不在了(别人回收完了)或读不到:让路
        }
        // 只认形状像我们自己写的 nonce(32 位十六进制的普通文件)的条目;别的一律不碰、
        // 不回收。判据与 try_take 的预判是同一个函数
        let entries = match Self::inspect_lock_shape(dir) {
            Ok(entries) => entries,
            Err(ShapeIssue::Foreign(why)) => {
                log::warn!("租约接管锁目录里有不认识的条目,不回收: {}", dir.display());
                return Err(why);
            }
            Err(ShapeIssue::Unreadable(_)) | Err(ShapeIssue::Vanished) => {
                return Ok(Reclaimed::No(None))
            }
        };
        // 破坏性判定**强制写一个新探针**(不吃 5 秒缓存:缓存建立后 NAS 时钟若跳了两分钟
        // 以上,按缓存算刚建的锁会立刻「可回收」),但一次 reclaim 只写这一个——锁目录
        // 与它里面的 nonce 的探针都落在同一个 manifests 目录,答案是同一个
        let fresh = std::cell::OnceCell::new();
        let now_of = |d: &Path| *fresh.get_or_init(|| disk_now_fresh(d));
        let nonces = entries;
        if nonces.is_empty() {
            // 没有 nonce 的空目录有两种:mkdir 后写 nonce 前崩了的残留(老),
            // 或别人**此刻**刚 mkdir、还没来得及写 nonce(新)。调用方判断
            // 「可回收」看的可能是被换掉之前的那个目录,这里必须按目录本身再看一次
            if !Self::is_reclaimable_by(dir, &now_of) {
                return Ok(Reclaimed::No(None));
            }
            return Ok(
                match super::fsx::retry_contended(|| std::fs::remove_dir(dir)) {
                    Ok(_) => Reclaimed::Yes,
                    // 「非空」= 别人在我判断之后刚 mkdir+写了 nonce(正常竞态);「不在」= 别人
                    // 抢先收走了。两种都是让路,不是「删不掉」——否则 acquire 会报「请检查权限 /
                    // 杀软」,而真相是另一个进程正在接管(fable 终审)
                    Err(f)
                        if matches!(
                            f.source.kind(),
                            std::io::ErrorKind::DirectoryNotEmpty | std::io::ErrorKind::NotFound
                        ) || f.source.raw_os_error() == Some(145) =>
                    {
                        Reclaimed::No(None)
                    }
                    Err(f) => Reclaimed::No(Some(format!(
                        "空的残留锁目录删不掉:{}",
                        super::error::explain_io(&f.source)
                    ))),
                },
            );
        }
        // 判据下沉到 nonce **自己**的年龄:调用方看到的「老目录」可能在它判断之后
        // 已经被别人回收重建——那个新目录里的 nonce 一定是新鲜的。真实的崩溃残留
        // nonce 一定是老的(它在取锁那一刻创建)。看到任何一个新鲜 nonce 就让路
        if nonces.iter().any(|n| !Self::is_reclaimable_by(n, &now_of)) {
            return Ok(Reclaimed::No(None));
        }
        let mut removed_any = false;
        let mut last_err: Option<String> = None;
        for n in &nonces {
            // 删残留同样走占用重试(杀软扫描窗口)
            match super::fsx::retry_contended(|| std::fs::remove_file(n)) {
                Ok(_) => removed_any = true,
                Err(f) if f.source.kind() == std::io::ErrorKind::NotFound => {} // 别人抢先删了
                Err(f) => {
                    log::warn!("租约接管锁的残留标记删不掉 {}: {}", n.display(), f.source);
                    last_err = Some(format!(
                        "残留标记删不掉:{}",
                        super::error::explain_io(&f.source)
                    ));
                }
            }
        }
        if !removed_any {
            return Ok(Reclaimed::No(last_err)); // 我一个都没删成:回收权归别人,或删不掉
        }
        match super::fsx::retry_contended(|| std::fs::remove_dir(dir)) {
            Ok(_) => Ok(Reclaimed::Yes),
            Err(f) => {
                // 目录里又有了新 nonce(别人在我删完到 rmdir 之间建了新锁)= 让路
                log::warn!("租约接管锁目录回收失败 {}: {}", dir.display(), f.source);
                Ok(Reclaimed::No(None))
            }
        }
    }

    fn try_take(lease: &Path) -> Result<Take> {
        let dir = Self::path_for(lease);
        for attempt in 0..2 {
            match std::fs::create_dir(&dir) {
                Ok(()) => return Ok(Self::make(dir)?.map_or(Take::Held(None), Take::Got)),
                Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
                    if attempt > 0 {
                        return Ok(Take::Held(None));
                    }
                    // 别人正拿着;或是上次接管到一半崩了留下的——老的就回收再试一次。
                    // 「不是普通目录」先于年龄判:is_reclaimable 对链接一律答「不可回收」,
                    // 只看它的话一个链接会被当成「别人正在接管」,永远等下去、永远没人说
                    if let Ok(m) = std::fs::symlink_metadata(&dir) {
                        if !m.file_type().is_dir() {
                            return Ok(Take::Refused(LOCK_DIR_NOT_A_DIR));
                        }
                    }
                    // 异物同样先于年龄判:否则新鲜的异物要先当「别人正在接管」等两分钟。
                    // 读不出的也单独说:持续读不出(权限 / 存储)不是「别的进程正在接管」
                    match Self::inspect_lock_shape(&dir) {
                        Err(ShapeIssue::Foreign(why)) => return Ok(Take::Refused(why)),
                        Err(ShapeIssue::Unreadable(e)) => return Ok(Take::Unreadable(e)),
                        // 刚被别人 rmdir 了:立刻再 create_dir(Windows CI 上并发接管真的撞到过:
                        // 输家把这一瞬报成「锁目录读不出」)
                        Err(ShapeIssue::Vanished) => continue,
                        Ok(entries) => {
                            // 目录里**全是**本进程自己没删掉的 nonce(随机名,不可能是别人的):
                            // 立刻回收,不必等两分钟的年龄门槛
                            if !entries.is_empty() && Self::reclaim_my_orphans(&entries, &dir) {
                                continue;
                            }
                            // 空目录且是本进程 rmdir 失败留下的:直接 rmdir
                            let mine_recently = entries.is_empty() && {
                                let mut dirs = lock_or_recover(my_orphaned_dirs());
                                match dirs.get(&dir) {
                                    Some(expires_at) if std::time::Instant::now() < *expires_at => {
                                        true
                                    }
                                    Some(_) => {
                                        dirs.remove(&dir); // 过期的记录不再算数
                                        false
                                    }
                                    None => false,
                                }
                            };
                            if mine_recently && remove_dir_patiently(&dir).is_ok() {
                                lock_or_recover(my_orphaned_dirs()).remove(&dir);
                                continue;
                            }
                        }
                    }
                    if !Self::is_reclaimable(&dir) {
                        return Ok(Take::Held(None));
                    }
                    match Self::reclaim(&dir) {
                        Ok(Reclaimed::Yes) => continue,
                        Ok(Reclaimed::No(reason)) => return Ok(Take::Held(reason)),
                        Err(why) => return Ok(Take::Refused(why)),
                    }
                }
                Err(e) => return Err(super::CoreError::io_detail("创建租约接管锁", &dir, &e)),
            }
        }
        Ok(Take::Held(None))
    }

    /// 等一小会儿再试(给心跳/释放用:对面接管只需几十毫秒)。被**拒绝**的不等:
    /// 那种锁目录不会自己好。按 **deadline** 而不是按次数:一次 try_take 里的回收若撞上
    /// 删不掉(占用重试一轮 1.5 秒),按次数算会把「5 秒耐心」放大成两分半——拷贝线程卡在
    /// 栅栏里、进度不动、暂停无响应(fable 终审)。
    fn take_with_patience(lease: &Path, patience: std::time::Duration) -> Result<Take> {
        let deadline = std::time::Instant::now() + patience;
        loop {
            let got = Self::try_take(lease)?;
            match got {
                // Held 可以等;Unreadable 多半是瞬时的,也再等等——到点了把最后一次的原因带回去
                Take::Held(_) | Take::Unreadable(_) => {
                    if std::time::Instant::now() >= deadline {
                        return Ok(got);
                    }
                }
                decided => return Ok(decided),
            }
            std::thread::sleep(std::time::Duration::from_millis(50));
        }
    }

    /// 锁还是不是我的(nonce 还在)。每个破坏性动作之前问一句。
    fn still_mine(&self) -> bool {
        // fail-closed:读不到就当不是我的。锁是破坏性动作(写清单 / 删租约)前的
        // 最后一道关,NAS 抖一下时让路(这一拍不写 / 这次落盘停下,可续传)比
        // 「装作还持有」便宜得多;此前除 NotFound 外的错误一律算「还是我的」(codex r6)
        std::fs::symlink_metadata(&self.nonce).is_ok()
    }
}

/// 本进程写过、却没删掉的 nonce 文件名(Windows 上杀软/索引器在 close 之后仍短暂持有
/// 句柄——0.4.3 事故的同一个根因搬到了锁目录上)。它们不可能是别人的(随机 32 位),
/// 下一次取锁看到目录里**全是**这些,立刻回收,不必等两分钟。
fn my_orphaned_nonces() -> &'static Mutex<std::collections::HashSet<String>> {
    static ORPHANS: std::sync::OnceLock<Mutex<std::collections::HashSet<String>>> =
        std::sync::OnceLock::new();
    ORPHANS.get_or_init(Default::default)
}

/// 本进程 nonce 删成了、目录却 rmdir 失败留下的**空**锁目录。Windows 上杀软/索引器多以
/// FILE_SHARE_DELETE 打开:DeleteFile 成功但名字 delete-pending,紧接着 rmdir 报
/// ERROR_DIR_NOT_EMPTY——句柄一放目录就成了一个崭新的空锁目录,按年龄要等两分钟(fable 终审)。
fn my_orphaned_dirs() -> &'static Mutex<std::collections::HashMap<PathBuf, std::time::Instant>> {
    static ORPHANS: std::sync::OnceLock<
        Mutex<std::collections::HashMap<PathBuf, std::time::Instant>>,
    > = std::sync::OnceLock::new();
    ORPHANS.get_or_init(Default::default)
}

/// 「本进程留下的空锁目录」这条记录多久内有效:delete-pending 的窗口是几百毫秒到几秒,
/// 记录永不过期的话,之后本进程任何一次取锁撞上同一路径上**别人**刚 mkdir 还没写 nonce 的
/// 空目录,都会把它 rmdir 掉——对方得到一次假的「另一个进程正在接管」(fable 终审)。
const ORPHAN_DIR_TTL: std::time::Duration = std::time::Duration::from_secs(600);

/// rmdir 的有界重试:delete-pending 的子项几百毫秒内就会消失。
fn remove_dir_patiently(dir: &Path) -> std::io::Result<()> {
    let mut last = None;
    for _ in 0..6 {
        match std::fs::remove_dir(dir) {
            Ok(()) => return Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
            Err(e) => {
                let transient = e.kind() == std::io::ErrorKind::DirectoryNotEmpty
                    || matches!(e.raw_os_error(), Some(145))
                    || e.kind() == std::io::ErrorKind::PermissionDenied;
                last = Some(e);
                if !transient {
                    break;
                }
                std::thread::sleep(std::time::Duration::from_millis(100));
            }
        }
    }
    Err(last.unwrap_or_else(|| std::io::Error::other("rmdir")))
}

impl Drop for TakeoverLock {
    fn drop(&mut self) {
        // 只删自己的:nonce 已经不在 = 被人回收了,目录现在是别人的。
        // 删也走占用重试:一次共享冲突就把自己的新鲜 nonce 留在盘上,接下来两分钟内
        // 每一次落盘都会「拿不到锁」而中止(fable 终审)
        match super::fsx::retry_contended(|| match std::fs::remove_file(&self.nonce) {
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            r => r,
        }) {
            Ok(_) => {
                if let Err(e) = remove_dir_patiently(&self.dir) {
                    // 「非空」有两种:别人已放了新 nonce(正常,不记),或 delete-pending 的
                    // 自己的 nonce 还没消失(Windows)——只有后者值得记成本进程残留;分不出来
                    // 时按「记,但带 TTL」:下次取锁看到它**空着**才直接 rmdir
                    let not_empty = e.kind() == std::io::ErrorKind::DirectoryNotEmpty
                        || e.raw_os_error() == Some(145);
                    if not_empty {
                        log::warn!(
                            "租约接管锁目录删不掉 {}: {e}(已记为本进程残留,{} 秒内取锁若空着立即回收)",
                            self.dir.display(),
                            ORPHAN_DIR_TTL.as_secs()
                        );
                        // 盘上此刻确实多了个目录:进程内残留表能自愈,但用户也要知道
                        super::fsx::note_leftover_temp(&self.dir);
                        // 存「到期时刻」(加法):测试与判定都不从 Instant 减——Windows 的 Instant
                        // 自开机起算,开机不足 TTL 时减法会 panic(fable 抓到)
                        lock_or_recover(my_orphaned_dirs())
                            .insert(self.dir.clone(), std::time::Instant::now() + ORPHAN_DIR_TTL);
                    } else {
                        log::warn!("租约接管锁目录删不掉 {}: {e}", self.dir.display());
                        // 进程内的残留表能自愈(下次取锁回收),但用户也要知道盘上多了个目录
                        super::fsx::note_leftover_temp(&self.dir);
                    }
                }
            }
            Err(f) => {
                log::warn!(
                    "租约接管锁标记删不掉 {}: {}(已记为本进程残留,下次取锁立即回收)",
                    self.nonce.display(),
                    f.source
                );
                if let Some(name) = self.nonce.file_name() {
                    lock_or_recover(my_orphaned_nonces())
                        .insert(name.to_string_lossy().into_owned());
                }
                // 这可能是本进程最后一次取这把锁(释放路径):进程内的残留表没机会自愈,
                // 别的机器两分钟内会被它挡成「接管锁被别的进程持有」——本机用户要知道
                super::fsx::note_leftover_temp(&self.nonce);
            }
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

    // 没有「绕开接管锁的快路径」:租约文件不在时也要在接管锁下取得。否则一个仍持着写栅栏
    // 的持有者(它的租约文件被别的进程的迟到写入盖掉又撤回,此刻是空缺)会与一个走快路径
    // 的第三者同时成为「可信写者」——栅栏的目录锁正是要把这段窗口串行化(codex 第三轮 P0)。
    // 锁内 classify_existing 对「文件不在」答 Fresh,publish(evict=false) 走不替换式创建

    // 「按时钟过期」不能单独定罪:对方机器时钟偏差超过 TTL 时,一份**活着**的租约
    // 在我们眼里也是过期的。所以先用本机的单调时间观察一个心跳周期:心跳还在
    // 变,那就是活的,退 Busy;真死了才接管。本机残留(pid 不在)不用等。
    //
    // **必须在取接管锁之前观察**:对方的心跳每一拍都要先拿这把锁,我们持锁睡
    // 一个周期等于把它的心跳一起锁死——盘上的时间戳一个字节都不会变,于是永远
    // 判成「死了」。评审抓到这条时,守卫是 100% 不生效的死代码。
    // 观察结果带进锁内:锁内的 classify 用**新的** now 独立重判,对方偏差恰好落在
    // TTL 门槛附近时会出现「锁外不过期(跳过观察)→ 锁内过期(直接接管)」的窄窗
    let mut observed: Option<(String, String)> = None;
    if let Some(l0) = read_lease(&path) {
        if l0.is_stale_by(chrono::Utc::now(), timing.ttl) && !l0.is_dead_local(machine_id) {
            // 观察**两个**心跳周期:一个周期太紧——对方 NAS 卡一拍、或调度慢一拍,
            // 一份活着的租约就被偷走(macOS CI 真的撞到过)。默认 10s 一拍 → 约 25s
            let margin = std::time::Duration::from_secs(5).min(timing.heartbeat_every);
            std::thread::sleep(timing.heartbeat_every * 2 + margin);
            if let Some(l1) = read_lease(&path) {
                if l1.token != l0.token {
                    // 观察期间被别人合法取得/接管了——与时钟无关,别把人支去校时
                    return Err(super::CoreError::Busy(format!(
                        "观察期间这个拷卡任务已被 {} 取得,本次让路;请在那边操作,或稍后再试",
                        l1.who(machine_id)
                    )));
                }
                if l1.heartbeat_at != l0.heartbeat_at {
                    return Err(super::CoreError::Busy(format!(
                        "这个拷卡任务正被 {} 执行中——它的心跳时间戳按本机时钟看已过期,但观察期间仍在推进,多半是那台机器的时钟与本机相差较大。请在那边操作,或先校准时钟",
                        l1.who(machine_id)
                    )));
                }
                observed = Some((l1.token.clone(), l1.heartbeat_at.clone()));
            }
        }
    }

    // 已存在:能不能接管,要在**接管锁**下重读再判——锁之前读到的那份可能
    // 在我们判断的这一瞬间已经被别的接管者换成了新鲜的
    // 取得也带一点耐心(约 2 秒;测试节奏 200ms):快路径去掉之后这里落在每一次取得的热路径上,
    // Windows 杀软刚把上一把锁的 nonce 置成 delete-pending、或对方正处在几十毫秒的接管中,
    // 立即放弃会把「几百毫秒后就能拿到」说成「另一个进程正在接管」(fable 第六轮)
    let patience = (timing.heartbeat_every / 5).clamp(
        std::time::Duration::from_millis(200),
        std::time::Duration::from_secs(2),
    );
    let guard = match TakeoverLock::take_with_patience(&path, patience)? {
        Take::Got(g) => g,
        Take::Held(reason) => {
            return Err(super::CoreError::Busy(match reason {
                Some(r) => format!(
                    "这个拷卡任务的租约接管锁目录里有崩溃残留,本来可以回收但删不掉({r}),本次不接管;请检查该目录的权限 / 是否被杀毒软件占着:{}",
                    TakeoverLock::path_for(&path).display()
                ),
                None => format!(
                    "另一个进程正在接管这个拷卡任务的租约,本次不重复接管;请在那边操作,或稍后再试(若确认没有别的进程在跑,可删除锁目录解锁:{})",
                    TakeoverLock::path_for(&path).display()
                ),
            }));
        }
        Take::Unreadable(e) => {
            return Err(super::CoreError::Busy(format!(
                "这个拷卡任务的租约锁目录读不出({e}),本次不接管;稍后再试,持续出现请检查该目录的权限与存储:{}",
                TakeoverLock::path_for(&path).display()
            )));
        }
        // 零静默:这种锁目录不会自己好,说成「别人正在接管」会让人去别的机器上白找。
        // 报文以 LOCK_DIR_BROKEN_PREFIX 开头:上层据此换一个通知 code / 标题
        Take::Refused(why) => {
            return Err(super::CoreError::Busy(format!(
                "{LOCK_DIR_BROKEN_PREFIX}:这个拷卡任务的租约接管锁目录{why},已拒绝回收;这种情况不会自己好,请人工检查并清理该目录后再试:{}",
                TakeoverLock::path_for(&path).display()
            )));
        }
    };
    let note = match classify_existing(&path, machine_id, chrono::Utc::now(), timing.ttl) {
        Existing::Busy(msg) => return Err(super::CoreError::Busy(msg)),
        Existing::TakeOverByClock(note) => {
            // 只按时钟过期就接管的,必须是刚才观察过、且观察后没变过的那一份;
            // 没观察过(锁外那一瞬还没过期)就不接管,下一次尝试会走到观察期
            let same = read_lease(&path)
                .map(|l| observed.as_ref() == Some(&(l.token.clone(), l.heartbeat_at.clone())))
                .unwrap_or(false);
            if !same {
                return Err(super::CoreError::Busy(
                    "这个拷卡任务的租约刚跨过过期门槛(或在观察后又变了),本次不接管;稍后再试会先观察两个心跳周期".into(),
                ));
            }
            Some(note)
        }
        Existing::TakeOver(note) => Some(note),
        Existing::Fresh => None,
    };
    // 持锁期间接管者只有我们;（历史上的不拿锁快路径已去掉,这里的复核仍保留:）它曾可能抢在 remove 与 create
    // 之间落一份新的——那就让它赢,我们退回 Busy(它是干净取得,不需要接管)
    // 删之前再确认锁还是我的:被回收了就等于没锁
    if !guard.still_mine() {
        return Err(super::CoreError::Busy(
            "接管锁在判断期间被别的进程回收,本次让路;请稍后再试".into(),
        ));
    }
    if publish(&path, &me, note.is_some())? {
        // 写后复核:publish 里的删 + 建可能卡在 NAS 上超过两分钟,
        // 期间锁被回收、别人接管并发布了——我们迟到的删 + 建会把它的顶掉,然后两边都
        // 以为自己赢了(codex 终审 P0)。锁不是自己的了就撤回并让路;回读不是自己的也让路
        if !guard.still_mine() {
            if matches!(read_lease(&path), Some(l) if l.token == me.token) {
                let _ = std::fs::remove_file(&path);
            }
            return Err(super::CoreError::Busy(
                "接管期间接管锁被别的进程回收(本机这一步卡了超过两分钟),本次让路;请稍后再试".into(),
            ));
        }
        match read_lease(&path) {
            Some(l) if l.token == me.token => Held::start(path, me, timing, note),
            Some(l) => Err(super::CoreError::Busy(format!(
                "接管刚完成就被 {} 顶掉,本次让路;请在那边操作,或稍后再试",
                l.who(machine_id)
            ))),
            None => Err(super::CoreError::Busy(format!(
                "刚写入的任务租约读不回来(存储可能正在抖动):{}。稍后再试",
                path.display()
            ))),
        }
    } else {
        Err(super::CoreError::Busy(
            "另一个进程刚刚抢先取得了这个拷卡任务的租约,本次不再重复接管;请在那边操作,或稍后再试"
                .into(),
        ))
    }
}

/// 在锁下把自己的租约放上去。`evict` = 先把盘上那份(已判定为可接管的)删掉。
///
/// Fresh(文件已不在)时必须 `evict = false`:取得现在一律在锁下,但心跳的「文件没了 → 重建」也在锁下用不替换式创建,不删就不会误伤;历史上曾有不拿锁的快路径
/// 刚原子建好自己的租约,删了等于把一份合法的干净取得抹掉。直接去建,建不成
/// 就是它赢——这条语义单独成函数,好被直接考。
fn publish(path: &Path, me: &Lease, evict: bool) -> Result<bool> {
    if evict {
        match std::fs::remove_file(path) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(super::CoreError::io_detail("移除过期的任务租约", path, &e)),
        }
    }
    try_create(path, me)
}

/// 对已存在的租约的裁决。
enum Existing {
    /// 活着的别人 / 正在初始化:拒绝,带报文。
    Busy(String),
    /// 可以接管(本机残留 / 读不懂且陈旧),带给用户看的说明。
    TakeOver(String),
    /// **只**因为心跳按时钟看过期而可接管——必须与锁外观察到的那份一致才算数。
    TakeOverByClock(String),
    /// 文件已经不在(上一个持有者刚干净释放):直接取得,不算接管。
    Fresh,
}

/// 判断顺序有讲究:**先判本机残留,再判按时钟过期**——残留不走观察期(acquire
/// 也跳过它),先判过期会把一份心跳也超过 TTL 的残留落到 TakeOverByClock,而它没被
/// 观察过 → 「观察结果一致」那道闸永远不满足 → 永久 Busy,任务在本机再也续不上
/// (第八轮评审抓到的回归;`a_dead_local_lease_older_than_the_ttl_is_still_taken_over_immediately`
/// 守着它)。「同机 pid 是活着的 OCard 但 token 不同」在最后,那是真的有人在跑。
fn classify_existing(
    path: &Path,
    machine_id: &str,
    now: chrono::DateTime<chrono::Utc>,
    ttl: chrono::Duration,
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
        // 本机残留**先于**「按时钟过期」判:残留不用观察期(acquire 也跳过它),
        // 若先判过期,一份心跳也超过 TTL 的残留会落到 TakeOverByClock,而它没被观察过
        // → 永远 Busy,任务在本机再也续不上(第八轮评审抓到的回归)
        Some(l) if l.is_dead_local(machine_id) => Existing::TakeOver(format!(
            "接管了本机上一个 OCard 进程(pid {})留下的任务租约:那个进程已经不存在了(或该 pid 已被别的程序复用),多半是上次强退或崩溃。上次的进度都在清单里,会从断点接着拷",
            l.pid
        )),
        Some(l) if l.is_stale_by(now, ttl) => Existing::TakeOverByClock(format!(
            "接管了一份过期的任务租约:{} 上次心跳 {},已超过 {} 分钟没有动静(多半是上次异常退出;若那台机器时钟不准也会这样)",
            l.who(machine_id),
            l.heartbeat_at,
            LEASE_TTL.num_minutes()
        )),
        Some(l) => Existing::Busy(format!(
            "这个拷卡任务正被 {} 执行中(心跳 {}),拒绝同时写同一份清单——两处同时写会让一方的记录被整份顶掉。请在那边操作,或等它结束/超过 {} 分钟无心跳后再续传",
            l.who(machine_id),
            l.heartbeat_at,
            LEASE_TTL.num_minutes()
        )),
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
    /// 进程内的「谁在用目录锁」:心跳线程与写栅栏共用同一把接管锁,不在进程内排队
    /// 就是自己和自己抢——慢 NAS 上心跳一拍就能耗尽栅栏的耐心。
    io_busy: Mutex<bool>,
    io_free: std::sync::Condvar,
    /// 心跳线程上发生的降级(线程局部的标记随线程消亡,没人取就丢了):线程退出前收进
    /// 这里,释放路径连同释放判定一起报给用户(带任务 scope)。心跳卡死没退出的那种,
    /// 这些也一起丢,与「心跳线程没退出」的告警同时发生。
    hb_fallback: AtomicBool,
    hb_leftovers: Mutex<Vec<PathBuf>>,
    hb_retries: std::sync::atomic::AtomicU64,
    /// 释放路径等心跳线程 5 秒没等到、放手了(卡在 NAS 上):释放判定不一定带着这件事,
    /// 这里记下来让上层统一说
    hb_stuck: AtomicBool,
    /// 释放路径已经读走了上面三项:之后才退出的心跳线程要把自己攒的交到全局登记
    /// [`LATE_HEARTBEAT`],由下一个收尾钩子按租约文件名(= 清单 id)带 scope 报出来
    read_out: AtomicBool,
    lease_path: PathBuf,
    /// 上层(有通知出口的一方)登记的「迟到的心跳降级」直达出口:有它就直接报,不进全局
    /// 登记——登记要等下一个收尾钩子,应用退出前可能再也没有钩子(codex 终审 r17)
    late_reporter: Mutex<LateReporterSlot>,
}

/// 「迟到的心跳线程」降级的直达出口:`(清单 id, 降级)`。
pub type LateReporter = Box<dyn Fn(&str, HeartbeatDegradations) + Send + Sync>;

/// 闭包装不进 `#[derive(Debug)]`,包一层。
#[derive(Default)]
struct LateReporterSlot(Option<LateReporter>);

impl std::fmt::Debug for LateReporterSlot {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(if self.0.is_some() {
            "LateReporter(set)"
        } else {
            "LateReporter(none)"
        })
    }
}

/// 释放之后才退出的心跳线程留下的降级:`(清单 id, 降级)`。进程内的登记——心跳线程没有
/// 通知出口,而它退出时 `Held` 已经没了;任何一个收尾钩子取走并报出。
static LATE_HEARTBEAT: Mutex<Vec<(String, HeartbeatDegradations)>> = Mutex::new(Vec::new());

/// 取走所有「迟到的心跳线程」攒下的降级(取走即清空)。
pub fn take_late_heartbeat_degradations() -> Vec<(String, HeartbeatDegradations)> {
    std::mem::take(&mut *lock_or_recover(&LATE_HEARTBEAT))
}

/// 测试用:模拟一条迟到的心跳交接。
#[cfg(test)]
pub(crate) fn push_late_heartbeat_for_test(id: &str, d: HeartbeatDegradations) {
    lock_or_recover(&LATE_HEARTBEAT).push((id.to_string(), d));
}

fn new_shared(lease_path: PathBuf) -> Arc<Shared> {
    Arc::new(Shared {
        stop: AtomicBool::new(false),
        epoch: std::time::Instant::now(),
        last_ok_ms: std::sync::atomic::AtomicU64::new(0),
        lost: Mutex::new(None),
        last_err: Mutex::new(None),
        io_busy: Mutex::new(false),
        io_free: std::sync::Condvar::new(),
        hb_fallback: AtomicBool::new(false),
        hb_leftovers: Mutex::new(Vec::new()),
        hb_retries: std::sync::atomic::AtomicU64::new(0),
        hb_stuck: AtomicBool::new(false),
        read_out: AtomicBool::new(false),
        lease_path,
        late_reporter: Mutex::new(LateReporterSlot::default()),
    })
}

/// 读走(并清空)心跳线程攒下的降级。
fn drain_degradations(shared: &Shared) -> HeartbeatDegradations {
    HeartbeatDegradations {
        fallback_used: shared.hb_fallback.swap(false, Ordering::SeqCst),
        leftovers: std::mem::take(&mut *lock_or_recover(&shared.hb_leftovers)),
        retried_writes: shared.hb_retries.swap(0, Ordering::SeqCst),
        heartbeat_stuck: shared.hb_stuck.swap(false, Ordering::SeqCst),
    }
}

/// 心跳线程退出前的交接:先把本线程的标记收进共享区;释放路径若**已经**读走了(它只等
/// 5 秒),再读一次交到全局登记——两边都是「取走即清空」,谁读到谁报,不会丢也不会重。
fn hand_off_heartbeat_degradations(shared: &Shared) {
    absorb_thread_degradations(shared);
    if shared.read_out.load(Ordering::SeqCst) {
        let d = drain_degradations(shared);
        if d.any() {
            let id = shared
                .lease_path
                .file_stem()
                .map(|s| s.to_string_lossy().into_owned())
                .unwrap_or_default();
            // 有直达出口就直接报(不等下一个钩子);没有(测试 / 未登记)才进全局登记
            let reporter = lock_or_recover(&shared.late_reporter);
            match reporter.0.as_ref() {
                Some(report) => report(&id, d),
                None => lock_or_recover(&LATE_HEARTBEAT).push((id, d)),
            }
        }
    }
}

/// 心跳线程上攒下的降级,随释放判定一起交给上层(见 [`Lease::release_reported`])。
#[derive(Debug, Default)]
pub struct HeartbeatDegradations {
    pub fallback_used: bool,
    pub leftovers: Vec<PathBuf>,
    pub retried_writes: u64,
    /// 释放时心跳线程 5 秒没退出(卡在 NAS 上)。
    pub heartbeat_stuck: bool,
}

impl HeartbeatDegradations {
    pub fn any(&self) -> bool {
        self.fallback_used
            || !self.leftovers.is_empty()
            || self.retried_writes > 0
            || self.heartbeat_stuck
    }
}

/// 把**本线程**的降级标记收进共享区(心跳线程退出前调用)。
fn absorb_thread_degradations(shared: &Shared) {
    if super::fsx::take_unsafe_fallback_flag() {
        shared.hb_fallback.store(true, Ordering::Relaxed);
    }
    let left = super::fsx::take_leftover_sources();
    if !left.is_empty() {
        lock_or_recover(&shared.hb_leftovers).extend(left);
    }
    let r = super::fsx::take_retried_writes();
    if r > 0 {
        shared.hb_retries.fetch_add(r, Ordering::Relaxed);
    }
}

impl Shared {
    fn now_ms(&self) -> u64 {
        self.epoch.elapsed().as_millis() as u64
    }

    /// 排到本进程内使用目录锁的轮次。**有界**等待:持轮次的那一方可能正卡在半死
    /// 的 SMB 上几分钟,无界等会让栅栏无声挂起——没有进度、没有通知、暂停也轮询不到。
    /// 超时返回 `None`,调用方按「没拿到锁」如实处理。
    fn take_turn(self: &Arc<Self>, patience: std::time::Duration) -> Option<IoTurn> {
        let deadline = std::time::Instant::now() + patience;
        let mut busy = lock_or_recover(&self.io_busy);
        while *busy {
            let left = deadline.saturating_duration_since(std::time::Instant::now());
            if left.is_zero() {
                return None;
            }
            busy = self
                .io_free
                .wait_timeout(busy, left)
                .unwrap_or_else(|p| p.into_inner())
                .0;
        }
        *busy = true;
        Some(IoTurn(self.clone()))
    }
}

/// 进程内的轮次凭证,drop 即让出。
#[derive(Debug)]
struct IoTurn(Arc<Shared>);

impl Drop for IoTurn {
    fn drop(&mut self) {
        *lock_or_recover(&self.0.io_busy) = false;
        self.0.io_free.notify_one();
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

/// 持有中的写栅栏(见 [`Held::fence`])。存在期间接管、心跳、释放都进不来。
#[derive(Debug)]
pub struct SaveFence {
    guard: TakeoverLock,
    /// 进程内的轮次:声明在 guard 之后 → 先还目录锁,再让心跳线程上
    _turn: IoTurn,
    /// 租约文件与本次持有的 token:复核不能只看锁标记,还要看盘上的租约是不是自己的——
    /// 锁标记还在、租约却已被迟到的写入换成别人的(或被撤回成空缺),照样不可信
    path: PathBuf,
    token: String,
}

impl SaveFence {
    /// 落盘**之后**再问一句:栅栏还是不是我的。锁标记不在了(被外部回收)、或盘上的租约
    /// 不再是自己的 token(被迟到的写入盖掉 / 撤回)= 这次落盘期间可能有别人接管,
    /// 调用方应停下并说明。
    pub fn still_mine(&self) -> bool {
        self.guard.still_mine()
            && matches!(read_lease(&self.path), Some(l) if l.token == self.token)
    }
}

impl super::copy::SaveFenceGuard for SaveFence {
    fn still_mine(&self) -> bool {
        SaveFence::still_mine(self)
    }
}

/// 释放的结果。用户要的不是「文件还在」,是「为什么还在」——三种原因的下一步完全不同。
#[derive(Debug, PartialEq, Eq)]
pub enum Released {
    /// 删了(或早已不在)。
    Removed,
    /// 删了,但本机的心跳线程 5 秒内没退出(多半卡在存储的一次读写上)。它醒来会先看
    /// 停止标志,不会再写;只是这次收尾比平时慢。上层如实说一句即可——**不是**「没敢删」,
    /// 混进 Unverified 会拼出「租约已删除……没有删除」这种自相矛盾的话
    RemovedHeartbeatStuck,
    /// 盘上那份不是我们的(别人合法接管了),没动它。
    TakenOver,
    /// 是我们的,但删不掉——别的机器要等 TTL、本机本次运行期间都续不了这个任务。
    RemoveFailed(String),
    /// 没拿到接管锁,**没敢删**(无保护地删可能删掉接管者刚建的那份)。后果同上。
    NoLock(String),
    /// 没拿到接管锁,而且本机的心跳线程 5 秒内没退出——多半是它还持着锁(卡在存储上)。
    /// 它醒来**如果**正卡在写租约的那一拍上会自删;卡在别处(取锁、探针、读)则直接退出,
    /// 租约会留到 TTL。上层要如实说这两种可能,不许承诺「不必手动处理」。
    NoLockHeartbeatStuck(String),
    /// 读不出/读不懂盘上那份,**没敢删**:它可能已经是接管方的。后果同上。
    Unverified(String),
    /// 释放时才**第一次**发现盘上是别人的(心跳线程没来得及报 Lost)。上层要说。
    TakenOverUnnoticed,
}

impl Held {
    fn start(
        path: PathBuf,
        me: Lease,
        timing: Timing,
        took_over_stale: Option<String>,
    ) -> Result<Self> {
        let shared = new_shared(path.to_path_buf());
        let thread = {
            let (path, me, shared) = (path.clone(), me.clone(), shared.clone());
            std::thread::Builder::new()
                .name("ocard-lease-heartbeat".into())
                .spawn(move || {
                    heartbeat_loop(&path, &me, timing, &shared);
                    hand_off_heartbeat_degradations(&shared);
                })
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
                // 不如现在就把文件收回、如实报错。收不回也要说——盘上会留一份
                // 永远不心跳的租约,别人要等 TTL
                let leftover = match std::fs::remove_file(&path) {
                    Ok(()) => String::new(),
                    Err(re) => format!(
                        "(且租约文件没能收回:{re},别的机器续这个任务要等 {} 分钟)",
                        LEASE_TTL.num_minutes()
                    ),
                };
                Err(super::CoreError::IoDetail(format!(
                    "启动租约心跳线程失败: {} —— {}{leftover}",
                    path.display(),
                    super::error::explain_io(&e)
                )))
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

    /// 登记「迟到的心跳降级」的直达出口(上层有通知出口的一方在取得之后立刻登记)。
    pub fn set_late_reporter(
        &self,
        report: impl Fn(&str, HeartbeatDegradations) + Send + Sync + 'static,
    ) {
        lock_or_recover(&self.shared.late_reporter).0 = Some(Box::new(report));
    }

    /// **写栅栏**:拿接管锁、核对盘上 token 还是自己的,把锁交给调用方持有到写完。
    ///
    /// `poll()` 只是看心跳线程的缓存;从它说「还是我的」到 `manifest::save` 落盘
    /// 之间,接管者完全可以完成一次接管——那一次 save 就把新持有者的进度整份顶掉。
    /// 接管、心跳、释放都在这把锁下动租约,save 也在锁下,窗口就没了。
    /// 拿不到锁 / 不是自己的 → `Err(Busy)`,调用方按丢租约处理(不写)。
    pub fn fence(&self) -> Result<SaveFence> {
        // 先排**本进程内**的队:心跳线程与栅栏抢的是同一把目录锁。不排队就是自己和
        // 自己抢——慢 NAS 上心跳一拍(读→写→回读)就能耗尽栅栏的耐心,任务无故中止,
        // 报文还把人支去别的机器查进度(第八轮评审)。排了队,目录锁只剩别的进程来抢
        // 三个心跳周期,但不少于 2 秒:测试节奏(120ms)下 360ms 装不下一拍带 fsync 的心跳
        let patience = (self.timing.heartbeat_every * 3).max(std::time::Duration::from_secs(2));
        let Some(turn) = self.shared.take_turn(patience) else {
            return Err(super::CoreError::Busy(
                "落盘前排队等本机心跳线程让出租约锁超时(它多半卡在存储的一次读写上),本次不写;为安全起见已停下,进度保存到上一个文件,可续传".into(),
            ));
        };
        // 约 5 秒耐心(默认节奏):别的进程一次接管只要几十毫秒;残留的锁目录两分钟
        // 才可回收,那种情况等不到,只能停下(可续传)——但要如实说,不是「被接管」
        // 约 5 秒(默认节奏);测试节奏下 400ms
        let patience = (self.timing.heartbeat_every / 2).clamp(
            std::time::Duration::from_millis(400),
            std::time::Duration::from_secs(5),
        );
        let guard = match TakeoverLock::take_with_patience(&self.path, patience)? {
            Take::Got(g) => g,
            Take::Held(reason) => {
                // 锁被别的进程占着。锁外只读看一眼盘上是谁的:已经是别人的 = 确实被接管;
                // 还是我的 / 读不到 = **不知道**,只能说「没拿到锁」,不许断言「被接管」
                return Err(match read_lease(&self.path) {
                    Some(l) if l.token != self.me.token => {
                        let who = l.who(&self.me.machine_id);
                        *lock_or_recover(&self.shared.lost) = Some(who.clone());
                        super::CoreError::Busy(format!("落盘前发现租约已被 {who} 接管,本次不写"))
                    }
                    _ => super::CoreError::Busy(match reason {
                        Some(r) => format!(
                            "落盘前没能拿到本任务的租约锁,本次不写:锁目录里的崩溃残留本来可以回收但删不掉({r})。为安全起见已停下,进度保存到上一个文件,可续传;请检查该目录的权限 / 是否被杀毒软件占着:{}",
                            TakeoverLock::path_for(&self.path).display()
                        ),
                        None => format!(
                            "落盘前没能拿到本任务的租约锁,本次不写:锁目录被占着(别的进程可能正在接管;也可能是存储卡住,或崩溃残留的锁目录还没到回收时间)。为安全起见已停下,进度保存到上一个文件,可续传。锁目录:{}",
                            TakeoverLock::path_for(&self.path).display()
                        ),
                    }),
                });
            }
            Take::Unreadable(e) => {
                return Err(super::CoreError::Busy(format!(
                    "落盘前租约锁目录读不出({e}),本次不写;为安全起见已停下,可续传;持续出现请检查该目录的权限与存储:{}",
                    TakeoverLock::path_for(&self.path).display()
                )));
            }
            Take::Refused(why) => {
                return Err(super::CoreError::Busy(format!(
                    "{LOCK_DIR_BROKEN_PREFIX}:落盘前发现租约接管锁目录{why},已拒绝回收,本次不写;这种情况不会自己好,请人工检查该目录:{}",
                    TakeoverLock::path_for(&self.path).display()
                )));
            }
        };
        match read_lease(&self.path) {
            Some(l) if l.token == self.me.token => {
                // 破坏性动作(写清单)之前再问一句锁还是不是我的——本模块的规矩
                if !guard.still_mine() {
                    return Err(super::CoreError::Busy(
                        "接管锁在核对期间被回收(存储的时钟或锁目录被外部动过),本次不写".into(),
                    ));
                }
                Ok(SaveFence {
                    guard,
                    _turn: turn,
                    path: self.path.clone(),
                    token: self.me.token.clone(),
                })
            }
            Some(l) => {
                *lock_or_recover(&self.shared.lost) = Some(l.who(&self.me.machine_id));
                Err(super::CoreError::Busy(format!(
                    "落盘前发现租约已被 {} 接管,本次不写",
                    l.who(&self.me.machine_id)
                )))
            }
            None => Err(super::CoreError::Busy(
                "落盘前读不到自己的租约(文件不在或读不懂),本次不写".into(),
            )),
        }
    }

    /// 租约文件的落点(收尾自查用)。
    pub fn path(&self) -> &Path {
        &self.path
    }

    /// 本次持有的短标识(token 前 8 位),给报文 / 日志用。
    pub fn run_tag(&self) -> String {
        self.me.token.chars().take(8).collect()
    }

    /// 显式释放并回报结果(`Drop` 也会释放,只是没人接结果)。
    /// [`release`](Self::release) 加上心跳线程攒下的降级:释放路径(会 join 心跳线程)
    /// 之后才读,读到的是完整的。上层用带任务 scope 的通知说出来。
    pub fn release_reported(self) -> (Released, HeartbeatDegradations) {
        let shared = self.shared.clone();
        let released = self.release();
        // 先声明「读走了」再读:之后才退出的心跳线程看到这个标记就把自己攒的交到全局登记;
        // 反过来(先读再标)会让它在两步之间收进来的那份没人读
        shared.read_out.store(true, Ordering::SeqCst);
        let degraded = drain_degradations(&shared);
        (released, degraded)
    }

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
        let mut heartbeat_stuck = false;
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
                // 线程还卡在 NAS 上:它醒来后会先查 stop 再动手,不会复活租约;
                // 但这次释放就不能说得太干净
                log::warn!("租约心跳线程 5 秒内没有退出(可能卡在 NAS 读写上),不再等待");
                heartbeat_stuck = true;
                self.shared.hb_stuck.store(true, Ordering::SeqCst);
            }
        }
        if lock_or_recover(&self.shared.lost).is_some() {
            return Released::TakenOver; // 早就知道不是我们的了,不碰
        }
        // 在接管锁下读+删:否则读到「是我的」之后、删之前,接管者可能刚把他的换上来。
        // 收尾路径可以多等一会儿(2 秒);仍拿不到就**不删**——无保护地删可能删掉
        // 接管者刚建的那份。不删的代价是别人多等 TTL,上层会把这件事说出来
        // 约 2 秒(默认节奏);测试节奏下 200ms
        let patience = (self.timing.heartbeat_every / 5).clamp(
            std::time::Duration::from_millis(200),
            std::time::Duration::from_secs(2),
        );
        let guard = match TakeoverLock::take_with_patience(&self.path, patience) {
            Ok(Take::Got(g)) => g,
            Ok(Take::Held(_)) if heartbeat_stuck => return Released::NoLockHeartbeatStuck(
                "释放时没能拿到接管锁,而本机的心跳线程 5 秒内没退出——多半是它还持着锁(卡在存储上)"
                    .into(),
            ),
            Ok(Take::Held(reason)) => {
                return Released::NoLock(match reason {
                    Some(r) => format!("释放时没能拿到接管锁:锁目录里的崩溃残留删不掉({r})"),
                    None => "释放时没能拿到接管锁(别的进程正在接管,或锁目录残留)".into(),
                })
            }
            Ok(Take::Unreadable(e)) => {
                return Released::NoLock(format!(
                    "释放时租约锁目录读不出({e});持续出现请检查该目录的权限与存储:{}",
                    TakeoverLock::path_for(&self.path).display()
                ))
            }
            Ok(Take::Refused(why)) => {
                return Released::NoLock(format!(
                    "{LOCK_DIR_BROKEN_PREFIX}:接管锁目录{why},已拒绝回收;请人工检查该目录:{}",
                    TakeoverLock::path_for(&self.path).display()
                ))
            }
            Err(e) => return Released::NoLock(e.to_string()),
        };
        // 读失败不等于「不是我的」:NAS 抖一下、杀软短暂锁住都会读失败。我们从没
        // 观察到别人接管过,手里的 token 是权威;重试几次仍读不出就按自己的删——
        // 留着它会让本进程与本机都自锁 30 分钟(pid 活着,不算残留)
        // 只有明确读到自己的 token 才删。读失败 / 读不懂都**不删**:盘上那份可能已经
        // 是接管方的,删了就是把一个正在拷卡的进程的租约抹掉。代价是本进程这次运行
        // 期间续不了这个任务、别的机器要等 TTL——上层会把这件事说出来
        let mut last_err = String::new();
        for _ in 0..3 {
            match std::fs::read(&self.path) {
                Ok(b) => match serde_json::from_slice::<Lease>(&b) {
                    Ok(l) if l.token == self.me.token => {
                        last_err.clear();
                        break;
                    }
                    Ok(_) => return Released::TakenOverUnnoticed,
                    Err(e) => return Released::Unverified(format!("租约文件内容读不懂:{e}")),
                },
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Released::Removed,
                Err(e) => {
                    last_err = super::error::explain_io(&e);
                    std::thread::sleep(std::time::Duration::from_millis(100));
                }
            }
        }
        if !last_err.is_empty() {
            return Released::Unverified(last_err);
        }
        if !guard.still_mine() {
            return Released::NoLock("接管锁在释放期间被别的进程回收".into());
        }
        match std::fs::remove_file(&self.path) {
            Ok(()) if heartbeat_stuck => Released::RemovedHeartbeatStuck,
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
fn heartbeat_loop(path: &Path, me: &Lease, timing: Timing, shared: &Arc<Shared>) {
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

        // 与栅栏(清单落盘)在进程内排队,别自己和自己抢目录锁;等不到就下一拍再来
        // (回到循环顶先看 stop)
        let patience = (timing.heartbeat_every * 3).max(std::time::Duration::from_secs(2));
        let Some(_turn) = shared.take_turn(patience) else {
            fail("等本进程的清单落盘让出租约锁超时,本拍跳过".into());
            continue;
        };
        let guard = match TakeoverLock::take_with_patience(
            path,
            std::time::Duration::from_millis(150),
        ) {
            Ok(Take::Got(g)) => g,
            Ok(Take::Held(reason)) => {
                // 有人正在接管(多半因为我们的心跳已经停了很久):这一拍不写,
                // 下一拍再看盘上是谁的
                fail(match reason {
                    Some(r) => format!("接管锁目录里的崩溃残留删不掉({r}),本拍跳过"),
                    None => "接管锁被别的进程持有,本拍跳过".into(),
                });
                continue;
            }
            Ok(Take::Unreadable(e)) => {
                fail(format!(
                    "租约锁目录读不出({e}),本拍跳过;持续出现请检查该目录的权限与存储:{}",
                    TakeoverLock::path_for(path).display()
                ));
                continue;
            }
            Ok(Take::Refused(why)) => {
                // 不会自己好:每拍都失败,at_risk_after 之后上层会停下并把这句话说出来
                fail(format!(
                    "{LOCK_DIR_BROKEN_PREFIX}:接管锁目录{why},已拒绝回收,本拍跳过;需要人工清理该目录:{}",
                    TakeoverLock::path_for(path).display()
                ));
                continue;
            }
            Err(e) => {
                fail(e.to_string());
                continue;
            }
        };

        if shared.stop.load(Ordering::SeqCst) {
            return; // 拿锁可能等了很久;释放路径已经放手不等我们了,不许再写
        }
        match std::fs::read(path) {
            Ok(b) => match serde_json::from_slice::<Lease>(&b) {
                Ok(l) if l.token == me.token => {}
                Ok(l) => {
                    *lock_or_recover(&shared.lost) = Some(l.who(&me.machine_id));
                    return; // 不再碰它,也不再尝试释放(release 会核对 token)
                }
                // 读不懂:不确定是不是自己的,这一拍不写(写了可能盖掉别人的)
                Err(_) => {
                    fail("租约文件内容读不懂,本拍不写".into());
                    continue;
                }
            },
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                // 文件没了(有人手动删了 / 接管者删了还没建 / **release 刚删掉**):
                // 停止标志置了就不重建——否则被放手的旧线程会把已释放的租约复活
                if shared.stop.load(Ordering::SeqCst) {
                    return;
                }
                // 锁还是不是我的:被回收了(休眠超过两分钟)就不许重建——此刻可能有人
                // 正在接管,重建会顶掉它刚要建的那份
                if !guard.still_mine() {
                    fail("接管锁在本拍期间被回收,本拍不重建".into());
                    continue;
                }
                // **不替换式地**重建。建不成 = 别人已经建了他的 → 回读判 Lost
                let mut beat = me.clone();
                beat.heartbeat_at = chrono::Utc::now().to_rfc3339();
                match try_create(path, &beat) {
                    Ok(true) => {
                        // 与正常写那一支同样的撤回:释放路径已经放手(等不到卡在 NAS 上
                        // 的我们),这一拍建出来的租约会挡别人 30 分钟——还是我的就删
                        if shared.stop.load(Ordering::SeqCst) {
                            if matches!(read_lease(path), Some(l) if l.token == me.token) {
                                let _ = std::fs::remove_file(path);
                            }
                            return;
                        }
                        // 同上:重建期间锁被回收 = 不可逆 Lost,并撤回
                        if !guard.still_mine() {
                            *lock_or_recover(&shared.lost) = Some(
                                "别的进程(接管锁在本机重建租约期间已被回收,本机建出的那份已撤回)"
                                    .into(),
                            );
                            if matches!(read_lease(path), Some(l) if l.token == me.token) {
                                let _ = std::fs::remove_file(path);
                            }
                            return;
                        }
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
            Ok(report) => {
                // 重试后成功也要说:记到心跳线程的线程局部,退出时收进共享区
                super::fsx::note_retried_writes(report.retries as u64);
                // 写完回读复核:取得现在一律在锁下,锁之外理论上没人能插进来;但复核只花一次小读,值得。历史上快路径的干净取得只在
                // 文件不存在时成功——理论上到不了,但复核只花一次小读,值得。
                // 回读不到自己的**不算成功**(fail-closed)
                match read_lease(path) {
                    Some(l) if l.token == me.token => {
                        // 释放路径等不到我们(卡在存储上超过 5 秒)、已经把租约删了,
                        // 而这一拍在那之后才写完:它复活了一份已释放的租约——别人会被
                        // 它挡 30 分钟,或接管者刚写的那份被它盖掉。撤回:回读确认还是
                        // 我的就删。锁可能已被回收(两分钟门槛),这一删是尽力而为;
                        // 万一删掉的是接管者刚换上的,它的心跳下一拍会按「文件没了」重建
                        if shared.stop.load(Ordering::SeqCst) {
                            let _ = std::fs::remove_file(path);
                            return;
                        }
                        // 锁在这一拍期间被回收(整机休眠超过两分钟才醒)= 这一拍可能盖掉了
                        // 接管者刚写的租约。**不可逆**地判 Lost、不刷新 last_ok_ms——否则
                        // 旧持有者读回自己的 token 会以为一切正常,继续写清单(codex r9);
                        // 回读还是我的就撤回
                        if !guard.still_mine() {
                            *lock_or_recover(&shared.lost) = Some(
                                "别的进程(接管锁在本机写心跳期间已被回收,本机这一拍可能盖掉了它的租约,已撤回)".into(),
                            );
                            let _ = std::fs::remove_file(path);
                            return;
                        }
                        shared.last_ok_ms.store(shared.now_ms(), Ordering::Relaxed);
                        *lock_or_recover(&shared.last_err) = None;
                    }
                    Some(l) => {
                        *lock_or_recover(&shared.lost) = Some(l.who(&me.machine_id));
                        return;
                    }
                    None => fail("心跳写完回读不到自己的租约,本拍不算成功".into()),
                }
            }
            Err(why) => fail(why),
        }
    }
}

#[cfg(test)]
mod tests {
    /// 释放路径只等心跳线程 5 秒:之后才退出的心跳线程攒下的降级不能丢——释放已经读走
    /// (`read_out`)时交到全局登记,由下一个收尾钩子报;释放还没读时留在共享区给释放读。
    #[test]
    fn a_late_heartbeat_hands_its_degradations_to_the_registry_only_after_release_read() {
        let _ = take_late_heartbeat_degradations();
        let shared = new_shared(PathBuf::from("/nas/proj/.ocard/copies/abc-123.lease"));
        // 释放还没读:交接只是收进共享区
        crate::core::fsx::note_retried_writes(2);
        hand_off_heartbeat_degradations(&shared);
        assert!(
            take_late_heartbeat_degradations().is_empty(),
            "释放还没读走,不该进登记"
        );
        assert_eq!(shared.hb_retries.load(Ordering::SeqCst), 2);
        // 释放读走了(先标后读),之后心跳线程才退出:它攒的要进登记,带清单 id
        shared.read_out.store(true, Ordering::SeqCst);
        let first = drain_degradations(&shared);
        assert_eq!(first.retried_writes, 2);
        crate::core::fsx::note_leftover_temp(Path::new(
            "/nas/proj/.ocard/copies/.clock.deadbeef.ocardtmp",
        ));
        hand_off_heartbeat_degradations(&shared);
        let late = take_late_heartbeat_degradations();
        assert_eq!(late.len(), 1, "{late:?}");
        assert_eq!(late[0].0, "abc-123");
        assert_eq!(late[0].1.leftovers.len(), 1);
        assert!(take_late_heartbeat_degradations().is_empty(), "取走即清空");
    }

    /// 登记了直达出口的租约:迟到的交接直接报出,不进全局登记(应用退出前可能再没有钩子)。
    #[test]
    fn a_late_heartbeat_reports_through_the_registered_outlet_instead_of_the_registry() {
        let _ = take_late_heartbeat_degradations();
        let shared = new_shared(PathBuf::from("/nas/proj/.ocard/copies/def-456.lease"));
        let got: Arc<Mutex<Vec<(String, HeartbeatDegradations)>>> =
            Arc::new(Mutex::new(Vec::new()));
        let sink = got.clone();
        lock_or_recover(&shared.late_reporter).0 =
            Some(Box::new(move |id: &str, d: HeartbeatDegradations| {
                lock_or_recover(&sink).push((id.to_string(), d));
            }));
        shared.read_out.store(true, Ordering::SeqCst);
        crate::core::fsx::note_retried_writes(1);
        hand_off_heartbeat_degradations(&shared);
        let got = lock_or_recover(&got);
        assert_eq!(got.len(), 1, "直达出口要被调用");
        assert_eq!(got[0].0, "def-456");
        assert_eq!(got[0].1.retried_writes, 1);
        assert!(
            take_late_heartbeat_degradations().is_empty(),
            "有直达出口就不进登记"
        );
    }

    use super::*;
    use tempfile::tempdir;

    const FAST: Timing = Timing {
        heartbeat_every: std::time::Duration::from_millis(120),
        at_risk_after: std::time::Duration::from_secs(1),
        ttl: LEASE_TTL,
    };
    /// 观察者视角的「短 TTL」:让一个每 120ms 心跳的**真实**持有者看起来像过期。
    /// 取 1 微秒:任何一次读到的心跳都「过期」,观察分支必然被走到——否则读得
    /// 正巧撞上刚打完的一拍时,会走普通的「活着 → Busy」分支,考不到观察期。
    const SUSPICIOUS: Timing = Timing {
        // 只决定观察者睡多久(2×600+600 = 1.8s),持有者仍每 ~150ms 一拍:
        // Windows 15.6ms 定时器粒度下节拍会拖到 ~230ms,窗口要留足余量
        heartbeat_every: std::time::Duration::from_millis(600),
        at_risk_after: std::time::Duration::from_secs(1),
        ttl: chrono::Duration::microseconds(1),
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

    fn set_file_mtime(file: &Path, t: std::time::SystemTime) {
        std::fs::OpenOptions::new()
            .write(true)
            .open(file)
            .expect("打开文件改时间戳")
            .set_times(std::fs::FileTimes::new().set_modified(t))
            .expect("改文件 mtime");
    }

    fn long_ago() -> std::time::SystemTime {
        std::time::SystemTime::now() - YOUNG_LEASE - std::time::Duration::from_secs(60)
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
    /// 这条堵的是「准备阶段没有 CAS」(0.4.4 前的已知未修)——两次 resume 不能都通过。
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
        // 一个**真实**的持有者:它的心跳线程每拍都要拿接管锁——这正是评审抓到的
        // 那条:观察期若在锁内跑,对方一拍都打不出来,永远判成「死了」。
        // 用假 pusher 绕开锁写文件的测试,绿得毫无意义
        let holder = acquire_with(&root, &id, "MACHINE-B", "李四", FAST).unwrap();
        let holder_token = holder.me.token.clone();
        // 观察者的 TTL 极短:持有者的心跳在它眼里永远「过期」——正是时钟偏差的形状
        let err = acquire_with(&root, &id, "MACHINE-A", "张三", SUSPICIOUS).unwrap_err();
        assert!(matches!(err, super::super::CoreError::Busy(_)), "{err}");
        assert!(err.to_string().contains("时钟"), "{err}");
        assert_eq!(
            on_disk(&root, &id).token,
            holder_token,
            "活着的租约被偷走了"
        );
        assert_eq!(holder.poll(), LeaseStatus::Ok, "持有者不该被这次尝试打扰");
    }

    /// 观察期间租约换了主人(token 变了)= 别人合法取得/接管了。这与时钟无关:
    /// 报文必须说「已被谁取得」,不能把人支去校时;盘上那份也不许动。
    #[test]
    fn a_lease_taken_by_someone_else_during_observation_is_not_blamed_on_the_clock() {
        let (_t, root, id) = setup();
        // 一份别的机器的、按 SUSPICIOUS 的 ttl 看已过期的活租约 → 观察者进入观察期
        write_lease(&root, &id, &live("MACHINE-B", 4242, "李四"));
        let theirs = live("MACHINE-C", 4343, "王五");
        let taker = {
            let (root, id, theirs) = (root.clone(), id.clone(), theirs.clone());
            std::thread::spawn(move || {
                // 观察期约 3 个心跳周期;在中途换成王五的
                std::thread::sleep(SUSPICIOUS.heartbeat_every);
                write_lease(&root, &id, &theirs);
            })
        };
        let err = acquire_with(&root, &id, "MACHINE-A", "张三", SUSPICIOUS).unwrap_err();
        taker.join().unwrap();
        assert!(matches!(err, super::super::CoreError::Busy(_)), "{err}");
        let msg = err.to_string();
        assert!(msg.contains("观察期间"), "{msg}");
        assert!(msg.contains("王五") || msg.contains("MACHINE-C"), "{msg}");
        assert!(!msg.contains("校准"), "换了主人不是时钟问题: {msg}");
        assert_eq!(on_disk(&root, &id).token, theirs.token, "王五的租约被动了");
    }

    /// 未来的时间戳超过几分钟就当过期,不是超过一个 TTL:一份写在「现在 + 20 分钟」的死租约
    /// 按 -TTL 判要 50 分钟才能接管,报文却承诺 30 分钟。
    #[test]
    fn a_lease_stamped_twenty_minutes_ahead_is_stale_not_fifty_minutes_away() {
        let mut l = live("MACHINE-B", 4242, "李四");
        let now = chrono::Utc::now();
        l.heartbeat_at = (now + chrono::Duration::minutes(20)).to_rfc3339();
        assert!(
            l.is_stale_by(now, LEASE_TTL),
            "未来 20 分钟 > 5 分钟容差,必须算过期"
        );
        l.heartbeat_at = (now + chrono::Duration::minutes(2)).to_rfc3339();
        assert!(
            !l.is_stale_by(now, LEASE_TTL),
            "未来 2 分钟是时钟偏差,不算过期"
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
        // 输家能拿到的合法拒绝有好几种:被抢先、锁被占、观察期间被取得、刚跨过
        // 过期门槛……都对。要紧的是「恰好一个赢家」,上面已经断言了
        assert!(
            [
                "抢先",
                "正在接管",
                "正被",
                "刚被写入",
                "观察期间",
                "门槛",
                "让路"
            ]
            .iter()
            .any(|k| loser.contains(k)),
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
            let stale_nonce = dir.join("deadbeefdeadbeefdeadbeefdeadbeef");
            std::fs::write(&stale_nonce, b"").unwrap();
            // 真实残留:nonce 本身也是老的(它在取锁那一刻创建)
            std::fs::File::options()
                .write(true)
                .open(&stale_nonce)
                .unwrap()
                .set_times(std::fs::FileTimes::new().set_modified(
                    std::time::SystemTime::now() - YOUNG_LEASE - std::time::Duration::from_secs(60),
                ))
                .unwrap();
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
                        match TakeoverLock::try_take(&lease).unwrap() {
                            Take::Got(g) => Some(g),
                            _ => None,
                        }
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
            !TakeoverLock::reclaim(&dir).unwrap().yes(),
            "刚建的空目录是别人正在取得的锁,不许回收"
        );
        assert!(dir.exists());
        set_dir_mtime(
            &dir,
            std::time::SystemTime::now() - YOUNG_LEASE - std::time::Duration::from_secs(60),
        );
        assert!(
            TakeoverLock::reclaim(&dir).unwrap().yes(),
            "老的空目录(mkdir 后崩了)要能回收"
        );
        assert!(!dir.exists());
    }

    /// 锁目录被换成符号链接:顺着它枚举再删就是删目录外的东西。一律不回收。
    #[test]
    #[cfg(unix)]
    fn a_symlinked_lock_dir_is_never_reclaimed() {
        let t = tempdir().unwrap();
        let outside = t.path().join("outside");
        std::fs::create_dir(&outside).unwrap();
        let victim = outside.join("deadbeefdeadbeefdeadbeefdeadbeef");
        std::fs::write(&victim, "重要文件".as_bytes()).unwrap();
        // 外面的文件和目录都做旧:新鲜的会被年龄判据挡住,链接守卫拿掉了测试照样绿
        set_file_mtime(&victim, long_ago());
        set_dir_mtime(&outside, long_ago());
        let dir = t.path().join("x.lease.takeover");
        std::os::unix::fs::symlink(&outside, &dir).unwrap();
        assert!(
            TakeoverLock::reclaim(&dir).is_err(),
            "链接不许回收,而且要说出来"
        );
        assert!(victim.exists(), "顺着链接把外面的文件删了");
        assert!(!TakeoverLock::is_reclaimable(&dir), "链接不许判可回收");
    }

    /// 写栅栏:持锁核对 token。租约被接管后栅栏必须拒绝,持有期间接管者拿不到锁。
    #[test]
    fn save_fence_refuses_once_the_lease_belongs_to_someone_else() {
        let (_t, root, id) = setup();
        let held = acquire_with(&root, &id, "MACHINE-A", "张三", FAST).unwrap();
        {
            let _f = held.fence().expect("自己的租约要能拿到栅栏");
            let lock = TakeoverLock::path_for(&lease_path(&root, &id).unwrap());
            assert!(lock.exists(), "栅栏持有期间接管锁应被占着");
        }
        write_lease(&root, &id, &live("MACHINE-B", 4242, "李四"));
        let err = held.fence().unwrap_err();
        assert!(matches!(err, super::super::CoreError::Busy(_)), "{err}");
        // 要的是「已被李四接管」这个原因;「没拿到锁」那条报文也含「接管」二字,
        // FAST 节奏下心跳每 120ms 抢一次锁,断言太宽会为错误的原因通过
        assert!(
            err.to_string().contains("李四") || err.to_string().contains("MACHINE-B"),
            "{err}"
        );
        assert!(
            matches!(held.poll(), LeaseStatus::Lost(_)),
            "栅栏发现被接管后 poll 也要说 Lost"
        );
    }

    /// 进程内的排队是**有界**的:持轮次的一方卡在存储上时,第二个栅栏不能无声挂起
    /// (没有进度、没有通知、暂停也轮询不到),要在有限时间内按「没拿到锁」如实报错。
    /// 同线程先后取两次栅栏就是最直接的复现。
    #[test]
    fn a_second_fence_while_the_first_is_held_times_out_instead_of_hanging() {
        let (_t, root, id) = setup();
        let held = acquire_with(&root, &id, "MACHINE-A", "张三", FAST).unwrap();
        let _first = held.fence().expect("第一道栅栏要能拿到");
        let started = std::time::Instant::now();
        let err = held.fence().unwrap_err();
        // 耐心 = max(3 个心跳周期, 2 秒);放弃要在这个上界之内,不许挂起
        assert!(
            started.elapsed() < std::time::Duration::from_secs(2) + FAST.heartbeat_every * 10,
            "第二道栅栏必须在有限时间内放弃,不许挂起: {:?}",
            started.elapsed()
        );
        assert!(matches!(err, super::super::CoreError::Busy(_)), "{err}");
        assert!(
            err.to_string().contains("超时"),
            "要如实说是排队超时: {err}"
        );
        assert!(
            !err.to_string().contains("被接管"),
            "没有人接管,不许这么说: {err}"
        );
    }

    /// 本机残留 + 心跳也超过了 TTL(下班回来 / 重启后再开):必须**立刻**接管。
    /// 第八轮评审抓到的回归:分类先判「过期」→ TakeOverByClock,而残留不走观察期,
    /// 「观察结果一致」那道闸永远不满足 → 永久 Busy,任务在本机再也续不上。
    #[test]
    fn a_dead_local_lease_older_than_the_ttl_is_still_taken_over_immediately() {
        let (_t, root, id) = setup();
        let dead_pid = a_dead_pid();
        write_lease(&root, &id, &stale(live("MACHINE-A", dead_pid, "张三")));
        let started = std::time::Instant::now();
        let held = acquire_with(&root, &id, "MACHINE-A", "张三", FAST)
            .expect("本机残留且超过 TTL:必须能立刻接管,不许永久 Busy");
        // 回归的判别点是上面的 expect(永久 Busy)与下面的解释口径;时间只作粗略佐证——
        // Windows CI 负载高时进程存活探测 + 接管锁 + 时钟探针本身就能超过两拍(3bdb05c 偶发红)
        assert!(
            started.elapsed() < FAST.heartbeat_every * 2 + std::time::Duration::from_secs(1),
            "粗略上限:本机残留的接管不该耗时到秒级"
        );
        let note = held.took_over_stale.as_deref().unwrap();
        assert!(
            note.contains("已经不存在"),
            "要按本机残留解释,不是按时钟: {note}"
        );
    }

    /// 锁目录被换成链接:acquire 必须说「请人工检查」,不能说「别人正在接管」——
    /// 后者会让人去别的机器上白找,而这种目录等多久都不会自己好(零静默)。
    #[test]
    #[cfg(unix)]
    fn a_symlinked_lock_dir_makes_acquire_ask_for_manual_cleanup() {
        let (_t, root, id) = setup();
        write_lease(&root, &id, &stale(live("MACHINE-B", 4242, "李四")));
        let p = lease_path(&root, &id).unwrap();
        let outside = root.join("outside");
        std::fs::create_dir(&outside).unwrap();
        std::os::unix::fs::symlink(&outside, TakeoverLock::path_for(&p)).unwrap();
        let err = acquire_with(&root, &id, "MACHINE-A", "张三", FAST).unwrap_err();
        let msg = err.to_string();
        assert!(msg.contains("人工检查"), "{msg}");
        assert!(!msg.contains("另一个进程正在接管"), "不是别人在接管: {msg}");
        // 跨模块契约:commands 层靠这个前缀把通知换成「需人工清理」的抬头
        assert!(msg.starts_with(LOCK_DIR_BROKEN_PREFIX), "{msg}");
    }

    /// 锁目录里躺着不认识的东西(杀软 / 备份软件落的文件),而且已经老了:同上。
    #[test]
    fn a_lock_dir_with_foreign_entries_makes_acquire_ask_for_manual_cleanup() {
        let (_t, root, id) = setup();
        write_lease(&root, &id, &stale(live("MACHINE-B", 4242, "李四")));
        let p = lease_path(&root, &id).unwrap();
        let dir = TakeoverLock::path_for(&p);
        std::fs::create_dir(&dir).unwrap();
        std::fs::write(dir.join("desktop.ini"), b"[.ShellClassInfo]").unwrap();
        set_file_mtime(&dir.join("desktop.ini"), long_ago());
        set_dir_mtime(&dir, long_ago());
        let err = acquire_with(&root, &id, "MACHINE-A", "张三", FAST).unwrap_err();
        let msg = err.to_string();
        assert!(
            msg.contains("人工检查") && msg.contains("不认识的条目"),
            "{msg}"
        );
        assert!(msg.starts_with(LOCK_DIR_BROKEN_PREFIX), "{msg}");
        assert!(dir.join("desktop.ini").exists(), "不认识的文件被删了");
    }

    /// Windows 上更现实的形状是 junction(备份软件、`mklink /J`):`is_symlink()` 对
    /// 挂载点也返回 true、`is_dir()` 返回 false,守卫应同样生效——这里守着它。
    #[test]
    #[cfg(windows)]
    fn a_junction_lock_dir_is_never_reclaimed() {
        let t = tempdir().unwrap();
        let outside = t.path().join("outside");
        std::fs::create_dir(&outside).unwrap();
        let victim = outside.join("deadbeefdeadbeefdeadbeefdeadbeef");
        std::fs::write(&victim, b"important").unwrap();
        set_file_mtime(&victim, long_ago());
        set_dir_mtime(&outside, long_ago());
        let dir = t.path().join("x.lease.takeover");
        let st = std::process::Command::new("cmd")
            .args(["/C", "mklink", "/J"])
            .arg(&dir)
            .arg(&outside)
            .status()
            .expect("前置:能运行 cmd mklink");
        assert!(st.success(), "前置:建 junction 失败(不许静默跳过)");
        assert!(TakeoverLock::reclaim(&dir).is_err(), "junction 不许回收");
        assert!(victim.exists(), "顺着 junction 把外面的文件删了");
        assert!(!TakeoverLock::is_reclaimable(&dir), "junction 不许判可回收");
    }

    /// 栅栏持有期间租约文件被撤回成空缺:第三者的取得**不能**绕开接管锁溜进来。
    /// (此前有一条不拿锁的快路径,文件不在就直接建;codex 第三轮抓到它能与一个仍持栅栏的
    /// 持有者同时成为「可信写者」。)
    #[test]
    fn a_fresh_acquire_cannot_slip_in_while_someone_holds_a_fence() {
        let (_t, root, id) = setup();
        let held = acquire_with(&root, &id, "MACHINE-A", "张三", FAST).unwrap();
        let fence = held.fence().unwrap();
        // 模拟迟到写入盖掉又撤回:租约文件消失
        std::fs::remove_file(lease_path(&root, &id).unwrap()).unwrap();
        let err = acquire_with(&root, &id, "MACHINE-C", "王五", FAST).unwrap_err();
        assert!(matches!(err, super::super::CoreError::Busy(_)), "{err}");
        assert!(
            !lease_path(&root, &id).unwrap().exists(),
            "第三者不许在别人持栅栏期间建出租约"
        );
        drop(fence);
    }

    /// 栅栏复核要看 token:锁标记还在、盘上租约却换成了别人的,不算「还是我的」。
    #[test]
    fn a_fence_is_not_mine_once_the_lease_on_disk_belongs_to_someone_else() {
        let (_t, root, id) = setup();
        let held = acquire_with(&root, &id, "MACHINE-A", "张三", FAST).unwrap();
        let fence = held.fence().unwrap();
        assert!(fence.still_mine());
        write_lease(&root, &id, &live("MACHINE-B", 4242, "李四"));
        assert!(!fence.still_mine(), "盘上已是李四的,栅栏不能说还是自己的");
        std::fs::remove_file(lease_path(&root, &id).unwrap()).unwrap();
        assert!(!fence.still_mine(), "租约被撤回成空缺,同样不算自己的");
    }

    /// Fresh 路径绝不删文件:文件在我们判断之后又出现了 = 有人(心跳重建 / 历史上的快路径)刚干净取得,
    /// 那份必须留着,我们让路。
    #[test]
    fn publishing_without_evict_never_removes_a_lease_that_appeared_meanwhile() {
        let (_t, root, id) = setup();
        let p = lease_path(&root, &id).unwrap();
        let theirs = live("MACHINE-B", 4242, "李四");
        write_lease(&root, &id, &theirs);
        let me = Lease::fresh("MACHINE-A", "张三", &uuid::Uuid::new_v4().to_string());
        assert!(
            !publish(&p, &me, false).unwrap(),
            "文件已在,不 evict 就不许赢"
        );
        assert_eq!(on_disk(&root, &id), theirs, "别人刚建好的租约被删了");
        // 对照:判定为可接管(evict)时才允许顶掉
        assert!(publish(&p, &me, true).unwrap());
        assert_eq!(on_disk(&root, &id).token, me.token);
    }

    /// 锁目录里出现不像 nonce 的条目(名字不是 32 位十六进制):不是我们写的东西,
    /// 一律不回收、不删——回收只能动自己认识的形状。
    #[test]
    fn reclaim_refuses_a_lock_dir_holding_anything_it_did_not_write() {
        let t = tempdir().unwrap();
        let dir = t.path().join("x.lease.takeover");
        std::fs::create_dir(&dir).unwrap();
        std::fs::write(dir.join("notes.txt"), b"someone's file").unwrap();
        // 条目和目录都要**老**:新鲜的条目本来就被年龄判据挡住,形状守卫拿掉了
        // 测试照样绿(变异复核抓到的)。老的、不认识的,才只剩形状这一道关
        set_file_mtime(&dir.join("notes.txt"), long_ago());
        set_dir_mtime(&dir, long_ago());
        assert!(
            TakeoverLock::reclaim(&dir).is_err(),
            "不认识的条目,不回收,而且要说出来"
        );
        assert!(dir.join("notes.txt").exists(), "把不认识的文件删了");
    }

    /// `make()` 的「只有我一个」必须是我的那个:目录里只剩别人的 nonce(我的已被回收)
    /// 时数个数也是 1。此前按个数判,会交出一个 nonce 已不存在的锁(codex r6)。
    #[test]
    fn make_does_not_hand_out_a_lock_when_the_only_nonce_is_someone_elses() {
        let t = tempdir().unwrap();
        let dir = t.path().join("x.lease.takeover");
        std::fs::create_dir(&dir).unwrap();
        // 别人的 nonce 先在;我的 nonce 写进去后目录里有两个 → 复核失败、撤回自己的。
        // 用只读目录让「写我的 nonce」失败不可移植,这里考的是复核这一支
        std::fs::write(dir.join("cafebabecafebabecafebabecafebabe"), b"").unwrap();
        let got = TakeoverLock::make(dir.clone()).unwrap();
        assert!(got.is_none(), "目录里不止我一个,不许拿到锁");
        let left: Vec<_> = std::fs::read_dir(&dir).unwrap().flatten().collect();
        assert_eq!(left.len(), 1, "撤回时只许删自己的 nonce");
        assert!(dir.join("cafebabecafebabecafebabecafebabe").exists());
    }

    /// `alone_in` 的三种形状:只有我的 → 是;只有别人的 → 不是(个数也是 1!);
    /// 两个都在 → 不是。「只有别人的」正是 make() 此前按个数判会放行的那一种。
    #[test]
    fn alone_in_requires_the_single_entry_to_be_my_own_nonce() {
        let t = tempdir().unwrap();
        let dir = t.path().join("x.lease.takeover");
        std::fs::create_dir(&dir).unwrap();
        let mine = dir.join("deadbeefdeadbeefdeadbeefdeadbeef");
        let theirs = dir.join("cafebabecafebabecafebabecafebabe");
        std::fs::write(&theirs, b"").unwrap();
        assert!(
            !TakeoverLock::alone_in(&dir, &mine),
            "目录里只有别人的 nonce:个数是 1,但不是我的"
        );
        std::fs::write(&mine, b"").unwrap();
        assert!(!TakeoverLock::alone_in(&dir, &mine), "两个都在");
        std::fs::remove_file(&theirs).unwrap();
        assert!(TakeoverLock::alone_in(&dir, &mine), "只有我的");
    }

    /// 异物不用等两分钟:刚落下的 `desktop.ini` 也要立刻被说成「请人工检查」,
    /// 而不是先当「别人正在接管」——那两分钟里用户会去别的机器上白找。
    #[test]
    fn a_fresh_foreign_entry_in_the_lock_dir_is_refused_without_waiting() {
        let (_t, root, id) = setup();
        write_lease(&root, &id, &stale(live("MACHINE-B", 4242, "李四")));
        let dir = TakeoverLock::path_for(&lease_path(&root, &id).unwrap());
        std::fs::create_dir(&dir).unwrap();
        std::fs::write(dir.join("desktop.ini"), b"[.ShellClassInfo]").unwrap(); // 新鲜的
        let err = acquire_with(&root, &id, "MACHINE-A", "张三", FAST).unwrap_err();
        let msg = err.to_string();
        assert!(
            msg.contains("人工检查") && msg.contains("不认识的条目"),
            "{msg}"
        );
        assert!(!msg.contains("另一个进程正在接管"), "{msg}");
    }

    /// 本进程自己没删掉的 nonce(Windows 共享冲突)不必等两分钟:下一次取锁看到目录里
    /// 全是它们,立刻回收——否则接下来两分钟里每一次落盘都会「拿不到锁」而中止。
    #[test]
    fn my_own_orphaned_nonces_are_reclaimed_without_waiting_two_minutes() {
        let t = tempdir().unwrap();
        let lease = t.path().join("x.lease");
        let dir = TakeoverLock::path_for(&lease);
        std::fs::create_dir(&dir).unwrap();
        let orphan = "0123456789abcdef0123456789abcdef";
        std::fs::write(dir.join(orphan), b"").unwrap(); // 新鲜的
        lock_or_recover(my_orphaned_nonces()).insert(orphan.into());
        match TakeoverLock::try_take(&lease).unwrap() {
            Take::Got(g) => {
                assert!(g.still_mine());
                assert!(!dir.join(orphan).exists(), "自己的残留要被清掉");
                assert!(
                    !lock_or_recover(my_orphaned_nonces()).contains(orphan),
                    "清掉之后要从残留名单里删"
                );
            }
            _ => panic!("自己的残留不该被当成「别人正在接管」"),
        }
        // 对照:同样新鲜、但**不是**本进程记在案的 nonce → 老老实实当别人的
        let dir2 = TakeoverLock::path_for(&t.path().join("y.lease"));
        std::fs::create_dir(&dir2).unwrap();
        std::fs::write(dir2.join("fedcba9876543210fedcba9876543210"), b"").unwrap();
        assert!(matches!(
            TakeoverLock::try_take(&t.path().join("y.lease")).unwrap(),
            Take::Held(_)
        ));
    }

    /// nonce 删成了、目录却 rmdir 失败留下的空目录:记在案的话下次取锁直接 rmdir。
    #[test]
    fn my_own_orphaned_empty_lock_dir_is_reclaimed_immediately() {
        let t = tempdir().unwrap();
        let lease = t.path().join("z.lease");
        let dir = TakeoverLock::path_for(&lease);
        std::fs::create_dir(&dir).unwrap(); // 新鲜、空
        lock_or_recover(my_orphaned_dirs())
            .insert(dir.clone(), std::time::Instant::now() + ORPHAN_DIR_TTL);
        match TakeoverLock::try_take(&lease).unwrap() {
            Take::Got(g) => {
                assert!(g.still_mine());
                assert!(!lock_or_recover(my_orphaned_dirs()).contains_key(&dir));
            }
            _ => panic!("自己留下的空锁目录不该被当成「别人正在接管」"),
        }
        // 过期的记录不算数:10 分钟前记的、现在撞上同路径的新鲜空目录,那是别人刚 mkdir 的
        let dir3 = TakeoverLock::path_for(&t.path().join("v.lease"));
        std::fs::create_dir(&dir3).unwrap();
        // 「到期时刻 = 现在」即已过期;不从 Instant 减(Windows 开机不足 TTL 会 panic)
        lock_or_recover(my_orphaned_dirs()).insert(dir3.clone(), std::time::Instant::now());
        assert!(matches!(
            TakeoverLock::try_take(&t.path().join("v.lease")).unwrap(),
            Take::Held(_)
        ));
        assert!(
            !lock_or_recover(my_orphaned_dirs()).contains_key(&dir3),
            "过期记录要顺手清掉"
        );
        // 对照:同样新鲜的空目录、不在案 → 别人刚 mkdir 还没写 nonce,老实等
        let dir2 = TakeoverLock::path_for(&t.path().join("w.lease"));
        std::fs::create_dir(&dir2).unwrap();
        assert!(matches!(
            TakeoverLock::try_take(&t.path().join("w.lease")).unwrap(),
            Take::Held(_)
        ));
    }

    /// 读不出的锁目录(权限)要如实说「读不出」,不能说「另一个进程正在接管」——
    /// 后者会让人去别的机器上白找,而这个目录只要权限不改就永远读不出。
    #[test]
    #[cfg(unix)]
    fn an_unreadable_lock_dir_is_reported_as_unreadable_not_as_a_takeover_in_progress() {
        use std::os::unix::fs::PermissionsExt;
        // root 无视权限位,这条测试在 root 下考不到东西:硬断言,不许静默跳过
        assert_ne!(unsafe { libc::geteuid() }, 0, "前置:不能以 root 跑这条测试");
        let (_t, root, id) = setup();
        write_lease(&root, &id, &stale(live("MACHINE-B", 4242, "李四")));
        let dir = TakeoverLock::path_for(&lease_path(&root, &id).unwrap());
        std::fs::create_dir(&dir).unwrap();
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o000)).unwrap();
        let err = acquire_with(&root, &id, "MACHINE-A", "张三", FAST).unwrap_err();
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o755)).unwrap();
        let msg = err.to_string();
        assert!(msg.contains("读不出") && msg.contains("权限"), "{msg}");
        assert!(!msg.contains("另一个进程正在接管"), "{msg}");
    }

    /// 锁目录不在 = Vanished,不是「读不出」:并发接管时输家看到的就是这一瞬,要立刻重试而
    /// 不是报「锁目录读不出,请检查权限」。
    #[test]
    fn a_vanished_lock_dir_is_a_retry_not_an_unreadable_error() {
        let t = tempdir().unwrap();
        let dir = t.path().join("gone.lease.takeover");
        assert!(TakeoverLock::shape_vanished(&dir));
    }

    /// 名字像 nonce 的**子目录 / 链接**也是异物:预判与回收用的是同一套形状判据——
    /// 此前预判只看名字,回收先删掉真正的 nonce 再对异物 `remove_file` 失败,持有者的
    /// 锁就这样被无声抹掉。
    #[test]
    fn a_hex_named_subdir_inside_the_lock_dir_is_an_alien_not_a_nonce() {
        let t = tempdir().unwrap();
        let dir = t.path().join("x.lease.takeover");
        std::fs::create_dir(&dir).unwrap();
        let real = dir.join("deadbeefdeadbeefdeadbeefdeadbeef");
        std::fs::write(&real, b"").unwrap();
        std::fs::create_dir(dir.join("cafebabecafebabecafebabecafebabe")).unwrap();
        // 三者都做旧:子目录新鲜的话「只看名字」的旧实现会先因它新鲜而让路,
        // 根本走不到「先删真 nonce、再对异物 remove_file 失败」那一步
        set_file_mtime(&real, long_ago());
        set_dir_mtime(&dir.join("cafebabecafebabecafebabecafebabe"), long_ago());
        set_dir_mtime(&dir, long_ago());
        assert!(TakeoverLock::reclaim(&dir).is_err(), "异物目录,不回收,要说");
        assert!(real.exists(), "真正的 nonce 被删了——持有者的锁被无声抹掉");
        assert_eq!(
            TakeoverLock::foreign_shape(&dir),
            Some(LOCK_DIR_HAS_FOREIGN_ENTRIES),
            "预判与回收要一致"
        );
    }

    /// 老目录里躺着一个**新鲜**的 nonce = 别人刚回收重建、正在持有:不许再回收。
    /// 只按目录年龄判的话,回收者会删掉别人刚写的 nonce 然后 rmdir——双持有者。
    #[test]
    fn reclaim_backs_off_when_the_nonce_inside_is_fresh() {
        let t = tempdir().unwrap();
        let dir = t.path().join("x.lease.takeover");
        std::fs::create_dir(&dir).unwrap();
        std::fs::write(dir.join("cafebabecafebabecafebabecafebabe"), b"").unwrap();
        set_dir_mtime(
            &dir,
            std::time::SystemTime::now() - YOUNG_LEASE - std::time::Duration::from_secs(60),
        );
        assert!(
            !TakeoverLock::reclaim(&dir).unwrap().yes(),
            "nonce 是新鲜的,目录再老也不许回收"
        );
        assert!(
            dir.join("cafebabecafebabecafebabecafebabe").exists(),
            "别人的 nonce 被删了"
        );
    }

    /// 等锁期间上一个持有者干净释放、文件已经不在:那不是接管,不许标成接管。
    /// (直接考分类函数:acquire 里这一支被 publish 的结果盖住,不好单独观察。)
    #[test]
    fn a_vanished_lease_classifies_as_fresh_not_takeover() {
        let t = tempdir().unwrap();
        let gone = t.path().join("gone.lease");
        assert!(matches!(
            classify_existing(&gone, "MACHINE-A", chrono::Utc::now(), LEASE_TTL),
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
        // 心跳线程(默认 10s 一拍)还没来得及发现,释放时才第一次看到是别人的:
        // 要区分「早已知道」和「释放时才发现」——后者上层要补一条通知
        assert_eq!(held.release(), Released::TakenOverUnnoticed);
        assert!(lease_path(&root, &id).unwrap().is_file());
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
