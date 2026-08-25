//! 统一后台作业子系统(M3 W2,计划 D2/D3 协议):
//! 交付打包 / 转码 / AI 分析共用一套「长任务 + 进度 + 取消」骨架。
//!
//! 状态机(合法转移**仅限**,终态不可逆):
//! `queued → running | cancelled`,`running → done | failed | cancelled`。
//! 一切转移都在快照锁内完成(CAS 语义):取消与完成竞争先到先得,
//! 竞输方放弃发布。
//!
//! 队列:同 kind 串行(排队的作业处于 queued,可被取消);异 kind 并行。
//! 互斥 guard(OpsMutex 等)由**running worker** 在 `queued→running` 时获取,
//! 在终态快照生成后、事件发布回调前释放(先 transition 后 drop——语义上
//! guard 覆盖全部实际工作;绝不进入历史 Job 记录,计划 D2)。
//! 声明边界(R2):终态发布→guard 释放之间有微秒级窗口,期间新投递会通过
//! `has_active` 检查、在获取 guard 时失败——表现为一条带明确原因的失败作业
//! (「已有交付打包在进行中」),不产生数据风险;换序(先 drop 后 transition)
//! 会让 guard 在作业名义上仍 running 时旁落,更糟。
//!
//! 作业不持久化:幂等由输出语义承担(转码 already-transcoded skip、
//! 交付 verified-skip)。本模块 tauri 无关,事件发射由命令层包装。

use serde::Serialize;
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum JobKind {
    Delivery,
    Transcode,
    Analyze,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum JobState {
    Queued,
    Running,
    Done,
    Failed,
    Cancelled,
}

impl JobState {
    pub fn is_terminal(self) -> bool {
        matches!(
            self,
            JobState::Done | JobState::Failed | JobState::Cancelled
        )
    }
    /// 合法转移表(D2):其余一律拒绝。
    fn can_transition(self, to: JobState) -> bool {
        matches!(
            (self, to),
            (JobState::Queued, JobState::Running)
                | (JobState::Queued, JobState::Cancelled)
                | (JobState::Running, JobState::Done)
                | (JobState::Running, JobState::Failed)
                | (JobState::Running, JobState::Cancelled)
        )
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JobSnapshot {
    pub id: String,
    pub kind: JobKind,
    pub project_id: String,
    pub state: JobState,
    pub done: usize,
    pub total: usize,
    pub bytes_done: u64,
    /// 人可读的当前动作(如正在处理的文件名)。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    /// 单调递增修订号:前端乱序保护(沿 copy://progress 模式)。
    pub revision: u64,
    pub started_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub finished_at: Option<String>,
    /// 终态的 typed result(命令层定义具体 DTO,序列化存放)。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<serde_json::Value>,
    /// failed 终态的原因。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

pub struct JobHandle {
    snapshot: Mutex<JobSnapshot>,
    cancel: AtomicBool,
    revision: AtomicU64,
}

impl JobHandle {
    pub fn cancel_requested(&self) -> bool {
        self.cancel.load(Ordering::SeqCst)
    }

    pub fn snapshot(&self) -> JobSnapshot {
        self.lock().clone()
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, JobSnapshot> {
        self.snapshot.lock().unwrap_or_else(|p| p.into_inner())
    }

    /// 更新进度(仅 running 态生效;终态后静默忽略——竞输方无副作用)。
    pub fn progress(&self, done: usize, total: usize, bytes_done: u64, message: Option<String>) {
        let mut s = self.lock();
        if s.state != JobState::Running {
            return;
        }
        s.done = done;
        s.total = total;
        s.bytes_done = bytes_done;
        s.message = message;
        s.revision = self.revision.fetch_add(1, Ordering::SeqCst) + 1;
    }

    /// 终态原子裁决(R4 终审 P1):在**同一把快照锁内**读取消标志、写结果、
    /// 选择并发布终态——消除「检查取消 → 发布 Done」间隙里取消静默输掉的窗口。
    fn finish(&self, outcome: Result<serde_json::Value, String>) -> Option<JobSnapshot> {
        let mut s = self.lock();
        let to = if self.cancel.load(Ordering::SeqCst) {
            JobState::Cancelled
        } else {
            match &outcome {
                Ok(_) => JobState::Done,
                Err(_) => JobState::Failed,
            }
        };
        if !s.state.can_transition(to) {
            return None;
        }
        match outcome {
            Ok(result) if to == JobState::Done => s.result = Some(result),
            Ok(result) => s.result = Some(result), // 取消:保留已产出的部分结果
            Err(e) => s.error = Some(e),
        }
        s.state = to;
        s.revision = self.revision.fetch_add(1, Ordering::SeqCst) + 1;
        s.finished_at = Some(chrono::Utc::now().to_rfc3339());
        s.message = None;
        Some(s.clone())
    }

    /// 状态转移(合法表 + 终态不可逆,锁内 CAS)。成功返回新快照。
    fn transition(&self, to: JobState) -> Option<JobSnapshot> {
        let mut s = self.lock();
        if !s.state.can_transition(to) {
            return None;
        }
        s.state = to;
        s.revision = self.revision.fetch_add(1, Ordering::SeqCst) + 1;
        if to.is_terminal() {
            s.finished_at = Some(chrono::Utc::now().to_rfc3339());
            s.message = None;
        }
        Some(s.clone())
    }
}

#[derive(Default)]
pub struct JobManager {
    jobs: Mutex<HashMap<String, Arc<JobHandle>>>,
    /// 同 kind 串行:每个 kind 一把执行权互斥锁(排队即 queued)。
    lanes: Mutex<HashMap<JobKind, Arc<Mutex<()>>>>,
}

impl JobManager {
    pub fn create(&self, kind: JobKind, project_id: &str) -> Arc<JobHandle> {
        let id = uuid::Uuid::new_v4().to_string();
        let handle = Arc::new(JobHandle {
            snapshot: Mutex::new(JobSnapshot {
                id: id.clone(),
                kind,
                project_id: project_id.to_string(),
                state: JobState::Queued,
                done: 0,
                total: 0,
                bytes_done: 0,
                message: None,
                revision: 0,
                started_at: chrono::Utc::now().to_rfc3339(),
                finished_at: None,
                result: None,
                error: None,
            }),
            cancel: AtomicBool::new(false),
            revision: AtomicU64::new(0),
        });
        self.jobs
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .insert(id, handle.clone());
        self.prune();
        handle
    }

    pub fn get(&self, id: &str) -> Option<Arc<JobHandle>> {
        self.jobs
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .get(id)
            .cloned()
    }

    pub fn snapshots(&self) -> Vec<JobSnapshot> {
        let mut out: Vec<JobSnapshot> = self
            .jobs
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .values()
            .map(|h| h.snapshot())
            .collect();
        out.sort_by(|a, b| b.started_at.cmp(&a.started_at));
        out
    }

    /// 是否有未到终态的作业(安装更新/退出确认的安全闸,计划 D3)。
    pub fn any_active(&self) -> bool {
        self.jobs
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .values()
            .any(|h| !h.snapshot().state.is_terminal())
    }

    /// 同项目同 kind 是否已有未终态作业(命令层拒绝重复投递)。
    pub fn has_active(&self, kind: JobKind, project_id: &str) -> bool {
        self.jobs
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .values()
            .any(|h| {
                let s = h.snapshot();
                s.kind == kind && s.project_id == project_id && !s.state.is_terminal()
            })
    }

    /// 请求取消:queued 直接转 cancelled(无 worker 替它收尾);
    /// **running 只置标志**——终态由 worker 在安全点发布,guard 释放前
    /// `any_active` 保持为真(评审 P0-3:提前终态会放行更新闸/错乱前端互斥)。
    /// 返回请求后的快照(终态作业原样返回)。
    /// R2 P2:已终态的作业不再置取消标志——那会让「已完成」的作业带着
    /// 无意义的 cancel 位,调用方也能据 state 终态给出「无需取消」的真话反馈。
    pub fn request_cancel(&self, id: &str) -> Option<JobSnapshot> {
        let handle = self.get(id)?;
        // R5 终审:读状态、置取消标志、queued 直转终态在**同一把快照锁内**完成,
        // 与 finish 互斥——不存在「取消读到 Running、finish 读到 false」的交错
        let mut s = handle.lock();
        if s.state.is_terminal() {
            return Some(s.clone());
        }
        handle.cancel.store(true, Ordering::SeqCst);
        if s.state == JobState::Queued {
            s.state = JobState::Cancelled;
            s.revision = handle.revision.fetch_add(1, Ordering::SeqCst) + 1;
            s.finished_at = Some(chrono::Utc::now().to_rfc3339());
            s.message = None;
        }
        Some(s.clone())
    }

    fn lane(&self, kind: JobKind) -> Arc<Mutex<()>> {
        self.lanes
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .entry(kind)
            .or_default()
            .clone()
    }

    /// 终态历史保留上限(防无界增长;活跃作业永不淘汰)。
    fn prune(&self) {
        const KEEP: usize = 60;
        let mut map = self.jobs.lock().unwrap_or_else(|p| p.into_inner());
        if map.len() <= KEEP {
            return;
        }
        let mut finished: Vec<(String, String)> = map
            .iter()
            .filter(|(_, h)| h.snapshot().state.is_terminal())
            .map(|(k, h)| (k.clone(), h.snapshot().started_at))
            .collect();
        finished.sort_by(|a, b| a.1.cmp(&b.1));
        let excess = map.len().saturating_sub(KEEP);
        for (k, _) in finished.into_iter().take(excess) {
            map.remove(&k);
        }
    }

    /// 运行一个作业:排队(同 kind 串行)→ running → 执行体 → 终态。
    /// `acquire_guard` 在 queued→running 时调用(拿 OpsMutex 等互斥;失败=作业 failed);
    /// `body` 返回 Ok(result)=done、Err(msg)=failed;body 内部应在安全点检查
    /// `handle.cancel_requested()` 并尽早返回——worker 检测到取消后走 cancelled 终态。
    /// `on_change` 在每次状态转移后回调(命令层发事件)。panic 由 catch_unwind
    /// 兜底转 failed(终态必发)。
    pub fn run<G: Send + 'static>(
        self: &Arc<Self>,
        handle: Arc<JobHandle>,
        acquire_guard: impl FnOnce() -> Result<G, String> + Send + 'static,
        body: impl FnOnce(&JobHandle) -> Result<serde_json::Value, String> + Send + 'static,
        on_change: impl Fn(JobSnapshot) + Send + Sync + 'static,
    ) {
        let mgr = self.clone();
        std::thread::spawn(move || {
            // 排队:拿本 kind 的执行权(期间保持 queued,可被取消)
            let kind = handle.snapshot().kind;
            let lane = mgr.lane(kind);
            let _lane_guard = lane.lock().unwrap_or_else(|p| p.into_inner());
            if handle.cancel_requested() {
                // 排队期被取消:request_cancel 已发布 cancelled(或此刻补发)
                if let Some(s) = handle.transition(JobState::Cancelled) {
                    on_change(s);
                }
                return;
            }
            // 互斥 guard:仅 running worker 持有(D2)
            let _guard = match acquire_guard() {
                Ok(g) => g,
                Err(e) => {
                    // 互斥获取失败=可见失败:走合法路径 queued→running,
                    // 终态经统一的 finish 原子裁决(R5:不再旁路手写 Failed)
                    if handle.transition(JobState::Running).is_some() {
                        if let Some(s) = handle.finish(Err(e)) {
                            on_change(s);
                        }
                    }
                    return;
                }
            };
            let Some(s) = handle.transition(JobState::Running) else {
                return; // 已被取消(竞输,cancelled 已发布)
            };
            on_change(s);

            let body_result =
                std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| body(&handle)));
            let outcome = match body_result {
                Ok(r) => r,
                Err(_) => Err("作业线程异常终止(panic),已中断".into()),
            };
            // 终态发布:R4 终审 P1——取消标志读取、结果写入与状态转移在同一把
            // 快照锁内一次完成(finish),「检查后到达的取消」不再静默输给 Done
            let final_snap = handle.finish(outcome);
            drop(_guard); // 互斥 guard 在终态发布前释放(D2)——顺序:transition 已完成,发布=on_change
            if let Some(s) = final_snap {
                on_change(s);
            }
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc;
    use std::time::Duration;

    fn wait_terminal(h: &Arc<JobHandle>) -> JobSnapshot {
        for _ in 0..200 {
            let s = h.snapshot();
            if s.state.is_terminal() {
                return s;
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        panic!("作业未在 2s 内到达终态: {:?}", h.snapshot().state);
    }

    #[test]
    fn legal_transitions_only() {
        assert!(JobState::Queued.can_transition(JobState::Running));
        assert!(JobState::Queued.can_transition(JobState::Cancelled));
        assert!(JobState::Running.can_transition(JobState::Done));
        assert!(JobState::Running.can_transition(JobState::Failed));
        assert!(JobState::Running.can_transition(JobState::Cancelled));
        // 终态不可逆 + 非法转移全拒
        for from in [JobState::Done, JobState::Failed, JobState::Cancelled] {
            for to in [
                JobState::Queued,
                JobState::Running,
                JobState::Done,
                JobState::Failed,
                JobState::Cancelled,
            ] {
                assert!(!from.can_transition(to), "{from:?}→{to:?} 必须非法");
            }
        }
        assert!(!JobState::Queued.can_transition(JobState::Done));
        assert!(!JobState::Queued.can_transition(JobState::Failed));
    }

    #[test]
    fn done_flow_with_progress_and_revisions() {
        let mgr = Arc::new(JobManager::default());
        let h = mgr.create(JobKind::Delivery, "p1");
        let (tx, rx) = mpsc::channel::<JobSnapshot>();
        mgr.run(
            h.clone(),
            || Ok(()),
            |h| {
                h.progress(1, 3, 100, Some("a".into()));
                h.progress(2, 3, 200, None);
                Ok(serde_json::json!({"files": 3}))
            },
            move |s| {
                let _ = tx.send(s);
            },
        );
        let s = wait_terminal(&h);
        assert_eq!(s.state, JobState::Done);
        assert_eq!(s.result.as_ref().unwrap()["files"], 3);
        // revision 单调
        let mut last = 0;
        while let Ok(ev) = rx.try_recv() {
            assert!(ev.revision > last, "revision 必须单调递增");
            last = ev.revision;
        }
    }

    #[test]
    fn cancel_queued_job_never_runs() {
        let mgr = Arc::new(JobManager::default());
        // 先占住 lane
        let blocker = mgr.create(JobKind::Transcode, "p1");
        let (btx, brx) = mpsc::channel::<()>();
        mgr.run(
            blocker.clone(),
            || Ok(()),
            move |_| {
                let _ = brx.recv_timeout(Duration::from_secs(5));
                Ok(serde_json::Value::Null)
            },
            |_| {},
        );
        // 等 blocker 进入 running,再排一个
        for _ in 0..100 {
            if blocker.snapshot().state == JobState::Running {
                break;
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        let queued = mgr.create(JobKind::Transcode, "p1");
        let ran = Arc::new(AtomicBool::new(false));
        let ran2 = ran.clone();
        mgr.run(
            queued.clone(),
            || Ok(()),
            move |_| {
                ran2.store(true, Ordering::SeqCst);
                Ok(serde_json::Value::Null)
            },
            |_| {},
        );
        assert_eq!(queued.snapshot().state, JobState::Queued);
        let s = mgr.request_cancel(&queued.snapshot().id).unwrap();
        assert_eq!(s.state, JobState::Cancelled);
        btx.send(()).unwrap();
        wait_terminal(&blocker);
        std::thread::sleep(Duration::from_millis(50));
        assert!(!ran.load(Ordering::SeqCst), "被取消的排队作业绝不许执行");
        assert_eq!(queued.snapshot().state, JobState::Cancelled, "终态不可逆");
    }

    #[test]
    fn cancel_running_wins_over_late_completion() {
        let mgr = Arc::new(JobManager::default());
        let h = mgr.create(JobKind::Analyze, "p1");
        let (tx, rx) = mpsc::channel::<()>();
        let h2 = h.clone();
        mgr.run(
            h.clone(),
            || Ok(()),
            move |hh| {
                // 等取消请求到达后才「完成」——取消必须竞胜
                let _ = rx.recv_timeout(Duration::from_secs(5));
                assert!(hh.cancel_requested());
                Ok(serde_json::Value::Null)
            },
            |_| {},
        );
        for _ in 0..100 {
            if h2.snapshot().state == JobState::Running {
                break;
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        mgr.request_cancel(&h2.snapshot().id);
        tx.send(()).unwrap();
        let s = wait_terminal(&h);
        assert_eq!(s.state, JobState::Cancelled, "取消先到必须竞胜完成");
    }

    #[test]
    fn panic_in_body_becomes_failed_with_terminal_event() {
        let mgr = Arc::new(JobManager::default());
        let h = mgr.create(JobKind::Delivery, "p1");
        let (tx, rx) = mpsc::channel::<JobSnapshot>();
        mgr.run(
            h.clone(),
            || Ok(()),
            |_| panic!("boom"),
            move |s| {
                let _ = tx.send(s);
            },
        );
        let s = wait_terminal(&h);
        assert_eq!(s.state, JobState::Failed);
        assert!(s.error.as_ref().unwrap().contains("异常终止"));
        // 终态事件必发
        let mut got_terminal = false;
        while let Ok(ev) = rx.try_recv() {
            if ev.state.is_terminal() {
                got_terminal = true;
            }
        }
        assert!(got_terminal);
    }

    #[test]
    fn guard_failure_is_visible_failed() {
        let mgr = Arc::new(JobManager::default());
        let h = mgr.create(JobKind::Delivery, "p1");
        mgr.run(
            h.clone(),
            || Err::<(), String>("互斥被占".into()),
            |_| Ok(serde_json::Value::Null),
            |_| {},
        );
        let s = wait_terminal(&h);
        assert_eq!(s.state, JobState::Failed);
        assert!(s.error.as_ref().unwrap().contains("互斥"));
    }

    #[test]
    fn progress_after_terminal_is_ignored() {
        let mgr = Arc::new(JobManager::default());
        let h = mgr.create(JobKind::Delivery, "p1");
        mgr.run(
            h.clone(),
            || Ok(()),
            |_| Ok(serde_json::Value::Null),
            |_| {},
        );
        let s = wait_terminal(&h);
        let rev = s.revision;
        h.progress(9, 9, 9, Some("late".into()));
        let after = h.snapshot();
        assert_eq!(after.revision, rev, "终态后的进度更新必须被忽略");
        assert_eq!(after.done, s.done);
    }

    #[test]
    fn has_active_and_any_active() {
        let mgr = Arc::new(JobManager::default());
        assert!(!mgr.any_active());
        let h = mgr.create(JobKind::Delivery, "p1");
        assert!(mgr.any_active());
        assert!(mgr.has_active(JobKind::Delivery, "p1"));
        assert!(!mgr.has_active(JobKind::Delivery, "p2"));
        assert!(!mgr.has_active(JobKind::Transcode, "p1"));
        mgr.request_cancel(&h.snapshot().id);
        assert!(!mgr.any_active());
    }

    #[test]
    fn cancel_running_keeps_active_until_worker_finalizes() {
        // 评审 P0-3:running 取消期间 any_active 必须仍为真(更新闸依赖它)
        let mgr = Arc::new(JobManager::default());
        let h = mgr.create(JobKind::Delivery, "p1");
        let (tx, rx) = mpsc::channel::<()>();
        mgr.run(
            h.clone(),
            || Ok(()),
            move |_| {
                let _ = rx.recv_timeout(Duration::from_secs(5));
                Ok(serde_json::Value::Null)
            },
            |_| {},
        );
        for _ in 0..100 {
            if h.snapshot().state == JobState::Running {
                break;
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        let s = mgr.request_cancel(&h.snapshot().id).unwrap();
        assert_eq!(s.state, JobState::Running, "running 取消只置标志不终态");
        assert!(mgr.any_active(), "worker 收尾前必须仍算活跃");
        tx.send(()).unwrap();
        let fin = wait_terminal(&h);
        assert_eq!(fin.state, JobState::Cancelled);
        assert!(!mgr.any_active());
    }

    /// R4 终审 P1:body 返回 Ok 但取消标志已置——终态裁决必须在同一把锁内
    /// 判成 Cancelled(不许「检查后到达的取消」静默输给 Done),部分结果保留。
    #[test]
    fn cancel_flag_set_during_body_wins_over_done() {
        let mgr = Arc::new(JobManager::default());
        let h = mgr.create(JobKind::Analyze, "P");
        let mgr2 = mgr.clone();
        let id = h.snapshot().id.clone();
        mgr.run(
            h.clone(),
            || Ok(()),
            move |hh| {
                // body 收尾前一刻取消到达(running:只置标志)
                let _ = mgr2.request_cancel(&id);
                assert!(!hh.snapshot().state.is_terminal(), "running 取消只置标志");
                Ok(serde_json::json!({"partial": 3}))
            },
            |_| {},
        );
        let fin = wait_terminal(&h);
        assert_eq!(fin.state, JobState::Cancelled, "取消必须赢过 Done");
        assert_eq!(fin.result.as_ref().unwrap()["partial"], 3, "部分结果保留");
    }
}
