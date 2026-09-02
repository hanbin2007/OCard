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
//! 应用层已经装了 single-instance 兜住这一条;租约是第二道闸,并且能覆盖
//! single-instance 管不到的场景(异构挂载、以后真的支持多机协作)。
//!
//! # 机制
//!
//! `<项目>/.ocard/manifests/<id>.lease` 一个小 JSON,内容是持有者身份 + 心跳。
//! 取得靠 `create_new`(三平台都是原子的独占创建:O_EXCL / CREATE_NEW)。
//! 已存在时读它:心跳过期(进程被杀/断电)或本来就是自己的,可以接管并告警;
//! 否则拒绝,报文点名是谁占着。
//!
//! # 边界(如实声明)
//!
//! - 「读到过期 → 接管」之间有一个极窄的检查-改名窗口。两个进程同时发现同一个
//!   过期租约时可能都接管成功。窗口是毫秒级,而过期门槛是分钟级,要撞上需要
//!   两个进程在同一毫秒醒来;真撞上了,后果也只回到没有租约时的现状。
//! - 心跳靠拷卡循环推进。任务卡在一次超长的单文件读写里时心跳会停,超过过期
//!   门槛后别人可以接管。门槛取得比任何单文件操作都长得多(见 [`LEASE_TTL`])。

use super::Result;
use serde::{Deserialize, Serialize};
use std::io::Write;
use std::path::{Path, PathBuf};

/// 心跳多久不更新就算过期。
///
/// 要比「一次单文件拷贝可能耗时的上限」长得多:8K 素材单文件几十 GB,慢速
/// NAS 上跑十几分钟是正常的,期间心跳不会推进。取 30 分钟,宁可让一次真的
/// 崩溃多等半小时,也不要把一个正在好好干活的任务判成死的然后两个进程一起写。
pub const LEASE_TTL: chrono::Duration = chrono::Duration::minutes(30);

/// 心跳最短间隔:比这更频繁就不写了(逐文件调用,别给 NAS 添无谓的往返)。
const HEARTBEAT_EVERY: chrono::Duration = chrono::Duration::seconds(30);

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Lease {
    /// 持有者机器 ID(`core::machine::machine_id`)。
    pub machine_id: String,
    /// 持有者进程 ID。同机重复打开时靠它区分是不是自己。
    pub pid: u32,
    /// 操作人,报文里要说得出「是谁在拷」。
    #[serde(default)]
    pub operator: String,
    /// 最近一次心跳(RFC3339)。
    pub heartbeat_at: String,
}

impl Lease {
    fn now(machine_id: &str, operator: &str) -> Self {
        Self {
            machine_id: machine_id.to_string(),
            pid: std::process::id(),
            operator: operator.to_string(),
            heartbeat_at: chrono::Utc::now().to_rfc3339(),
        }
    }

    /// 心跳是不是已经过期(时间解析不出来也当过期:一份读不懂的租约不该
    /// 永久堵住一个任务)。
    pub fn is_stale(&self, now: chrono::DateTime<chrono::Utc>) -> bool {
        match chrono::DateTime::parse_from_rfc3339(&self.heartbeat_at) {
            Ok(t) => now - t.to_utc() > LEASE_TTL,
            Err(_) => true,
        }
    }

    /// 是不是本进程自己(同机同 pid)。重建/续传时会遇到自己留下的租约。
    fn is_self(&self, machine_id: &str) -> bool {
        self.machine_id == machine_id && self.pid == std::process::id()
    }

    fn who(&self) -> String {
        let op = if self.operator.trim().is_empty() {
            String::new()
        } else {
            format!("(操作人 {})", self.operator)
        };
        format!("机器 {}{op} 的进程 {}", self.machine_id, self.pid)
    }
}

pub fn lease_path(project_root: &Path, manifest_id: &str) -> PathBuf {
    super::manifest::manifest_dir(project_root).join(format!("{manifest_id}.lease"))
}

/// 取得的租约。**必须**在任务结束时 [`release`](Held::release);
/// 忘了也不会永久堵死(心跳过期后可接管),但会让别人白等最多 [`LEASE_TTL`]。
#[derive(Debug)]
pub struct Held {
    path: PathBuf,
    machine_id: String,
    operator: String,
    last_beat: chrono::DateTime<chrono::Utc>,
    /// 接管了一份过期租约(上一次是被异常终止的)——上层要发可见告警。
    pub took_over_stale: Option<String>,
}

/// 取得独占租约。已被**活着的**别人占着时返回 `Invalid`(死路,重试无益)。
pub fn acquire(
    project_root: &Path,
    manifest_id: &str,
    machine_id: &str,
    operator: &str,
) -> Result<Held> {
    let dir = super::manifest::manifest_dir(project_root);
    super::paths::ensure_dir_within_core(project_root, &dir)?;
    let path = lease_path(project_root, manifest_id);
    let me = Lease::now(machine_id, operator);
    let bytes = serde_json::to_vec_pretty(&me)?;

    // create_new = 三平台的原子独占创建(O_EXCL / CREATE_NEW)
    match std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&path)
    {
        Ok(mut f) => {
            f.write_all(&bytes)
                .and_then(|()| f.sync_all())
                .map_err(|e| super::CoreError::io_detail("写入任务租约", &path, &e))?;
            return Ok(held(path, machine_id, operator, None));
        }
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {}
        Err(e) => return Err(super::CoreError::io_detail("创建任务租约", &path, &e)),
    }

    // 已存在:读它决定能不能接管
    let existing: Option<Lease> = std::fs::read(&path)
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok());
    let now = chrono::Utc::now();
    let took_over = match &existing {
        // 读不懂的租约:当过期处理(否则一份坏文件能永久堵死一个任务)
        None => Some("上一份任务租约读不懂(可能是异常退出写了一半)".to_string()),
        Some(l) if l.is_self(machine_id) => None,
        Some(l) if l.is_stale(now) => Some(format!(
            "接管了一份过期的任务租约:{} 上次心跳 {},已超过 {} 分钟没有动静(多半是上次异常退出)",
            l.who(),
            l.heartbeat_at,
            LEASE_TTL.num_minutes()
        )),
        Some(l) => {
            return Err(super::CoreError::Invalid(format!(
                "这个拷卡任务正被 {} 执行中(心跳 {}),拒绝同时写同一份清单——两处同时写会让一方的记录被整份顶掉。请在那边操作,或等它结束/超过 {} 分钟无心跳后再试",
                l.who(),
                l.heartbeat_at,
                LEASE_TTL.num_minutes()
            )));
        }
    };

    super::fsx::write_atomic(&path, &bytes)
        .map_err(|f| super::CoreError::io_detail_retried("接管任务租约", &path, &f))?;
    Ok(held(path, machine_id, operator, took_over))
}

/// 只看不取:有没有**活着的别人**正持有这个任务的租约?返回描述,供报文点名。
///
/// 给「不由 worker 发起、却要写同一份清单」的路径用(续传前刷新计划就是一例:
/// 那一步发生在 worker 起来之前,但另一个进程的 worker 可能正跑着)。
pub fn live_holder(project_root: &Path, manifest_id: &str, machine_id: &str) -> Option<String> {
    let path = lease_path(project_root, manifest_id);
    let l: Lease = serde_json::from_slice(&std::fs::read(path).ok()?).ok()?;
    if l.is_self(machine_id) || l.is_stale(chrono::Utc::now()) {
        return None;
    }
    Some(l.who())
}

fn held(path: PathBuf, machine_id: &str, operator: &str, took_over_stale: Option<String>) -> Held {
    Held {
        path,
        machine_id: machine_id.to_string(),
        operator: operator.to_string(),
        last_beat: chrono::Utc::now(),
        took_over_stale,
    }
}

impl Held {
    /// 推进心跳。逐文件调用,自带节流([`HEARTBEAT_EVERY`])。
    ///
    /// 写失败**不打断拷贝**:租约是防并发写的,不是拷贝本身的前提;
    /// 为了它把一个正常的任务打断,代价远大于收益。但也不静默——失败会
    /// 上抛给调用方去发可见告警(过期后别人可能接管,用户有权知道)。
    pub fn heartbeat(&mut self) -> Result<bool> {
        let now = chrono::Utc::now();
        if now - self.last_beat < HEARTBEAT_EVERY {
            return Ok(false);
        }
        self.last_beat = now;
        let me = Lease::now(&self.machine_id, &self.operator);
        super::fsx::write_atomic(&self.path, &serde_json::to_vec_pretty(&me)?)
            .map_err(|f| super::CoreError::io_detail_retried("更新任务租约心跳", &self.path, &f))?;
        Ok(true)
    }

    /// 释放。只删**自己的**那一份:别人接管之后我们不能把人家的删掉。
    pub fn release(self) {
        let mine = std::fs::read(&self.path)
            .ok()
            .and_then(|b| serde_json::from_slice::<Lease>(&b).ok())
            .is_some_and(|l| l.is_self(&self.machine_id));
        if mine {
            if let Err(e) = std::fs::remove_file(&self.path) {
                if e.kind() != std::io::ErrorKind::NotFound {
                    // 删不掉只是让别人多等 TTL,不值得打断任何东西;落日志即可
                    log::warn!("任务租约删不掉 {}: {e}", self.path.display());
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    fn setup() -> (tempfile::TempDir, PathBuf, String) {
        let t = tempdir().unwrap();
        let root = t.path().join("project");
        std::fs::create_dir_all(super::super::manifest::manifest_dir(&root)).unwrap();
        let id = uuid::Uuid::new_v4().to_string();
        (t, root, id)
    }

    #[test]
    fn a_live_lease_from_another_process_blocks_the_second_writer() {
        let (_t, root, id) = setup();
        let _mine = acquire(&root, &id, "MACHINE-A", "张三").unwrap();

        // 伪造另一个进程的活租约(同机不同 pid = Windows 上双开的形状)
        let other = Lease {
            machine_id: "MACHINE-A".into(),
            pid: std::process::id() + 1,
            operator: "李四".into(),
            heartbeat_at: chrono::Utc::now().to_rfc3339(),
        };
        std::fs::write(lease_path(&root, &id), serde_json::to_vec(&other).unwrap()).unwrap();

        let err = acquire(&root, &id, "MACHINE-A", "王五").unwrap_err();
        let msg = err.to_string();
        assert!(
            !err.is_io(),
            "被别人占着是死路,不该判成可续传的 IO 问题: {msg}"
        );
        assert!(msg.contains("正被"), "{msg}");
        assert!(msg.contains("李四"), "报文要说得出是谁占着: {msg}");
        assert!(msg.contains(&other.pid.to_string()), "{msg}");
    }

    #[test]
    fn a_stale_lease_can_be_taken_over_but_says_so_out_loud() {
        let (_t, root, id) = setup();
        let dead = Lease {
            machine_id: "MACHINE-B".into(),
            pid: 4242,
            operator: "李四".into(),
            heartbeat_at: (chrono::Utc::now() - LEASE_TTL - chrono::Duration::minutes(1))
                .to_rfc3339(),
        };
        std::fs::write(lease_path(&root, &id), serde_json::to_vec(&dead).unwrap()).unwrap();

        let held = acquire(&root, &id, "MACHINE-A", "张三").unwrap();
        // 零静默:接管别人的租约是「系统替用户做了决定」,必须说出来
        let note = held.took_over_stale.expect("接管过期租约必须给出可见说明");
        assert!(note.contains("过期"), "{note}");
        assert!(
            note.contains("李四") || note.contains("MACHINE-B"),
            "{note}"
        );
    }

    #[test]
    fn an_unreadable_lease_does_not_wedge_the_task_forever() {
        let (_t, root, id) = setup();
        std::fs::write(lease_path(&root, &id), b"{ not json").unwrap();
        let held = acquire(&root, &id, "MACHINE-A", "张三").unwrap();
        assert!(held.took_over_stale.is_some(), "接管坏租约也要说一声");
    }

    #[test]
    fn live_holder_sees_a_foreign_live_lease_and_ignores_our_own_or_a_stale_one() {
        let (_t, root, id) = setup();
        assert_eq!(
            live_holder(&root, &id, "MACHINE-A"),
            None,
            "没有租约时不该报占用"
        );

        let _mine = acquire(&root, &id, "MACHINE-A", "张三").unwrap();
        assert_eq!(
            live_holder(&root, &id, "MACHINE-A"),
            None,
            "自己的租约不该把自己挡在外面"
        );

        let other = Lease {
            machine_id: "MACHINE-B".into(),
            pid: 4242,
            operator: "李四".into(),
            heartbeat_at: chrono::Utc::now().to_rfc3339(),
        };
        std::fs::write(lease_path(&root, &id), serde_json::to_vec(&other).unwrap()).unwrap();
        let who = live_holder(&root, &id, "MACHINE-A").expect("活着的别人必须被看见");
        assert!(who.contains("李四"), "{who}");

        let dead = Lease {
            heartbeat_at: (chrono::Utc::now() - LEASE_TTL - chrono::Duration::minutes(1))
                .to_rfc3339(),
            ..other
        };
        std::fs::write(lease_path(&root, &id), serde_json::to_vec(&dead).unwrap()).unwrap();
        assert_eq!(
            live_holder(&root, &id, "MACHINE-A"),
            None,
            "过期租约不该永久挡住别人"
        );
    }

    #[test]
    fn releasing_removes_only_our_own_lease() {
        let (_t, root, id) = setup();
        let held = acquire(&root, &id, "MACHINE-A", "张三").unwrap();
        // 别人已经接管了(我们的心跳早停了):不能把人家的租约删掉
        let other = Lease {
            machine_id: "MACHINE-C".into(),
            pid: 999,
            operator: "赵六".into(),
            heartbeat_at: chrono::Utc::now().to_rfc3339(),
        };
        std::fs::write(lease_path(&root, &id), serde_json::to_vec(&other).unwrap()).unwrap();
        held.release();
        assert!(
            lease_path(&root, &id).is_file(),
            "把别人的租约删掉了——那等于第三个进程可以立刻进来一起写"
        );
    }

    #[test]
    fn our_own_lease_is_reacquirable_after_release() {
        let (_t, root, id) = setup();
        acquire(&root, &id, "MACHINE-A", "张三").unwrap().release();
        assert!(!lease_path(&root, &id).exists());
        let again = acquire(&root, &id, "MACHINE-A", "张三").unwrap();
        assert!(again.took_over_stale.is_none(), "干净取得不该报接管");
    }

    #[test]
    fn heartbeat_is_throttled_but_does_advance() {
        let (_t, root, id) = setup();
        let mut held = acquire(&root, &id, "MACHINE-A", "张三").unwrap();
        assert!(
            !held.heartbeat().unwrap(),
            "刚取得就再写一次是白给 NAS 加往返"
        );
        held.last_beat = chrono::Utc::now() - HEARTBEAT_EVERY - chrono::Duration::seconds(1);
        assert!(held.heartbeat().unwrap(), "超过节流间隔必须真的推进心跳");
    }

    #[test]
    fn stale_detection_treats_an_unparseable_timestamp_as_stale() {
        let l = Lease {
            machine_id: "M".into(),
            pid: 1,
            operator: String::new(),
            heartbeat_at: "不是时间".into(),
        };
        assert!(
            l.is_stale(chrono::Utc::now()),
            "读不懂的时间戳当过期,否则一份坏租约能永久堵死这个任务"
        );
    }
}
