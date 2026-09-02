//! 拷卡清单(manifest):记录每次拷卡任务的逐文件哈希与校验状态,
//! 既是审计凭证,也是断点续传的依据。存放于项目 `.ocard/manifests/`。

use super::project::{MANIFEST_DIR, STATE_DIR};
use super::Result;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ManifestEntry {
    /// 相对于拷卡目标文件夹的路径(统一 `/` 分隔,跨平台互通)。
    /// 口径固定为**目标**落点:断点续传认的就是它,扁平化改名后也不变。
    pub rel_path: String,
    pub size: u64,
    pub xxh3: String,
    /// 目标端回读校验是否通过。
    pub verified: bool,
}

/// 开拷前锁定的计划清单项(评审复核 P0:清单必须持久化,
/// 暂停期间源文件消失时续传必须发现「计划内未拷」而非静默漏拷)。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct PlannedFile {
    /// **目标**相对路径(相对拷卡目标文件夹)。续传身份用它,口径不可改。
    pub rel_path: String,
    pub size: u64,
    /// 源在卷内的相对路径。**空串 = 与 `rel_path` 相同**——老 manifest 没有
    /// 这个字段,整卷任务也不写它,反序列化后行为与改造前逐字节一致。
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub source_rel: String,
    /// 规划(或最近一次续传复查)时源文件的 mtime,纳秒;0 = 未知/老清单。
    ///
    /// 只比 size 的话「同大小、内容被换掉」完全无声(换了卡、别人动了源文件),
    /// 时间戳是唯一不用把整盘读一遍就能发现它的判据。老清单里没有这个字段,
    /// 反序列化为 0 = 「没有基线可比」,只影响能不能发现,不改变拷贝行为。
    #[serde(default, skip_serializing_if = "is_zero_u128")]
    pub source_mtime_ns: u128,
}

fn is_zero_u128(v: &u128) -> bool {
    *v == 0
}

fn is_zero_u64(v: &u64) -> bool {
    *v == 0
}

fn is_zero_u32(v: &u32) -> bool {
    *v == 0
}

/// 当前的**扫描策略版本**(源卷上「什么算素材」的口径版本)。
///
/// - `0`(清单里缺字段)= **旧口径**:以点开头的条目一律跳过。这一版会漏拷卡上
///   合法的点开头素材(`.clip.mov`、被误设隐藏属性的素材、用户自建的隐藏素材夹),
///   而整卷任务照样报 100% 与「本卡可格式化」——**漏拷却报成功**。
/// - `1` = 当前口径:只排除 `core::copy` 里明确列举的系统项(废纸篓、索引、
///   NAS 记账目录、本工具自己的临时名),其余点开头的条目照拷。
///
/// 口径**再变**就必须递增,并同步更新 `commands::policy_upgrade_caveat` 的措辞:
/// 这个数字是续传告警区分「策略升级」与「卡上真的变了」的唯一证据。
pub const SCAN_POLICY_VERSION: u32 = 1;

impl PlannedFile {
    /// 由引擎计划项生成持久化项:源与目标相同(整卷)时不落 `source_rel`,
    /// 让整卷任务的 manifest 与改造前保持同样的字节形态。
    pub fn from_plan(p: &super::copy::PlannedFile) -> Self {
        Self {
            rel_path: p.target_rel.clone(),
            size: p.size,
            source_rel: if p.source_rel == p.target_rel {
                String::new()
            } else {
                p.source_rel.clone()
            },
            source_mtime_ns: p.source_mtime_ns,
        }
    }

    /// 源相对路径:空串回退到 `rel_path`(老 manifest 向后兼容口径)。
    pub fn source(&self) -> &str {
        if self.source_rel.is_empty() {
            &self.rel_path
        } else {
            &self.source_rel
        }
    }

    /// 还原为引擎计划项(续传:持久化清单才是落点的权威)。
    pub fn to_plan(&self) -> super::copy::PlannedFile {
        super::copy::PlannedFile {
            source_rel: self.source().to_string(),
            target_rel: self.rel_path.clone(),
            size: self.size,
            source_mtime_ns: self.source_mtime_ns,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CopyManifest {
    pub id: String,
    /// 拷卡目标文件夹(相对项目根),如 `2. 原始素材/20260824_DJIRonin4D_B_ZS`。
    pub target_rel: String,
    /// 源卷标识(卷名/挂载点描述)。
    pub source_label: String,
    pub camera_code: String,
    pub operator: String,
    /// 摄影师+DIT 双确认的内容备注(新任务 = 标签拼串,保持人可读)。
    pub note: String,
    /// 内容标签(Notion 式;老 manifest 没有此字段,默认空)。
    #[serde(default)]
    pub tags: Vec<String>,
    /// 目的地路径(展示用,同时支撑项目统计里的目的地数)。
    #[serde(default)]
    pub destinations: Vec<String>,
    /// 开拷时刻的完整源清单(不可变);续传/重建以它为准判断「计划内未完成」。
    #[serde(default)]
    pub planned: Vec<PlannedFile>,
    /// 本次拷卡的源选择(相对卷根的文件夹列表)。空 = 整卷(老 manifest 同此)。
    /// 审计:事后要查得出「这次到底勾了哪几个夹子」。
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub source_selection: Vec<String>,
    /// 因重名被系统改写落点的文件。加前缀等于系统替用户改了文件名,
    /// 事后必须查得到「这个文件原来叫什么、来自哪个文件夹」。
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub renamed_files: Vec<super::copy::RenamedFile>,
    /// 扫描时被**系统项名单**排除的条目数(R7 引入,R11 收紧口径)。
    /// 现在只排除 `core::copy::SYSTEM_ITEM_NAMES` 明确列举的东西
    /// (`.Trashes`/`.fseventsd`/`System Volume Information` …);点开头的素材
    /// (`.clip.mov`、隐藏素材夹)已经不再排除,会照常拷贝。
    /// 被排除的条目从未进入计划、任务却会报 100%,所以事后必须查得到排除了多少。
    /// (字段名沿用 `hidden_*`:老清单的反序列化口径不能动。)
    #[serde(default, skip_serializing_if = "is_zero_u64")]
    pub hidden_skipped: u64,
    /// 上述条目的前几条路径(样例;完整列表不落盘,量可能很大)。
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub hidden_samples: Vec<String>,
    /// 源卡身份指纹(卡根 .ocard-volume-id);写保护卡为 None,退化为卷名匹配。
    #[serde(default)]
    pub source_uid: Option<String>,
    /// 锁定这份清单时用的**扫描策略版本**(见 [`SCAN_POLICY_VERSION`])。
    ///
    /// R13 C6:老清单没有这个字段,反序列化为 `0` = **旧口径**(「以点开头一律
    /// 跳过」)。它是唯一能把「点开头的条目这次才出现」的两种原因分开的证据:
    /// 策略升级 vs 卡上真的新增了文件。没有它,续传告警只能靠形状猜,而猜错的
    /// 那一半会让用户放过一次真实的源卷变更(说错原因比不说更糟)。
    ///
    /// 更要紧的是**升级前就已经 `completed: true`** 的整卷任务:它当时按旧口径
    /// 漏拷了点开头的素材、却报了 100% 与「本卡可格式化」。`rebuild_tasks` 只重建
    /// 未完成的清单,两条续传告警都够不到它——那一行「绿色」是旧口径留下的假绿。
    /// 版本号落在清单里并经 `CopyTaskDto.scan_policy_version` 暴露给前端,
    /// 界面才有可能把这类记录标注出来。
    #[serde(default, skip_serializing_if = "is_zero_u32")]
    pub scan_policy_version: u32,
    pub created_at: DateTime<Utc>,
    pub completed: bool,
    /// 拷完自动转代理意图(M3 T1.5;intent ID 即 manifest id)。
    #[serde(default)]
    pub auto_proxy: bool,
    /// 自动转代理整批完成标记(at-least-once 补投递的去重依据;
    /// 只有整批成功后置位,不宣称 exactly-once——skip 语义容忍重复)。
    #[serde(default)]
    pub proxy_completed: bool,
    /// 自动转代理已尝试次数(≥3 放弃并可见告知,防永久失败无限重投)。
    #[serde(default)]
    pub proxy_attempts: u32,
    pub entries: Vec<ManifestEntry>,
}

impl CopyManifest {
    pub fn new(
        target_rel: impl Into<String>,
        source_label: impl Into<String>,
        camera_code: impl Into<String>,
        operator: impl Into<String>,
        note: impl Into<String>,
    ) -> Self {
        Self {
            id: uuid::Uuid::new_v4().to_string(),
            target_rel: target_rel.into(),
            source_label: source_label.into(),
            camera_code: camera_code.into(),
            operator: operator.into(),
            note: note.into(),
            tags: Vec::new(),
            destinations: Vec::new(),
            planned: Vec::new(),
            source_selection: Vec::new(),
            renamed_files: Vec::new(),
            hidden_skipped: 0,
            hidden_samples: Vec::new(),
            source_uid: None,
            // 新清单一律记下当前口径:事后才分得清「点开头的条目为什么这次才出现」
            scan_policy_version: SCAN_POLICY_VERSION,
            created_at: Utc::now(),
            completed: false,
            auto_proxy: false,
            proxy_completed: false,
            proxy_attempts: 0,
            entries: Vec::new(),
        }
    }

    /// 断点续传判断:该文件是否已拷贝并通过校验(大小一致)。
    /// `rel_path` 一律是**目标**相对路径(扁平化改名后仍以落点为身份)。
    pub fn is_done(&self, rel_path: &str, size: u64) -> bool {
        self.entries
            .iter()
            .any(|e| e.rel_path == rel_path && e.size == size && e.verified)
    }

    pub fn upsert(&mut self, entry: ManifestEntry) {
        if let Some(e) = self
            .entries
            .iter_mut()
            .find(|e| e.rel_path == entry.rel_path)
        {
            *e = entry;
        } else {
            self.entries.push(entry);
        }
    }
}

pub fn manifest_dir(project_root: &Path) -> PathBuf {
    project_root.join(STATE_DIR).join(MANIFEST_DIR)
}

/// 清单落盘。**每拷完一个文件调一次**——所以它既是热路径,也是整个拷卡任务里
/// 唯一会把中断上抛成硬错误的 IO(逐文件的失败都收进 `FileStatus::Failed`)。
///
/// 0.4.3 事故:这里此前是固定临时名 + 裸 `fs::rename`,Windows 上目标只要被
/// 杀毒软件/索引开着就 `ACCESS_DENIED(5)`,整个任务当场中断,而报文只有
/// 「IO 错误: 拒绝访问。 (os error 5)」。现在走 [`fsx::write_atomic`](唯一临时名 +
/// 占用重试),真失败时报文带路径与下一步,并保持 IO 口径(可续传)。
///
/// # 已知边界:跨进程没有事务
///
/// 这是**整份覆盖**,不是读-改-写事务。同一个 manifest id 被两个进程同时写时
/// (唯一现实场景:同一个暂停任务在两台工作站上各点了一次「继续」),后写的
/// 整份顶掉先写的,`entries` / `completed` 都可能回退。
///
/// 唯一临时名修好了「互相截断出一份坏 JSON」——那个至少会当场报错;换来的是
/// 每次 rename 发布的都是一份**完整自洽**的快照,于是丢更新变得**安静**了。
/// 更干净,但也更难发现。真正的解法是给清单加 revision/CAS 或跨进程 owner
/// lease,覆盖整个「读取—修改—保存」;那是独立一轮的事,与本波混做会让评审
/// 无法归因。在那之前:**不要在两台机器上同时续同一个任务**。
/// (`manifest.rs` 的 owner lease 已在契约文档「已知未修」一节留档。)
pub fn save(project_root: &Path, m: &CopyManifest) -> Result<(super::fsx::WriteReport, PathBuf)> {
    let dir = manifest_dir(project_root);
    // R2 P0:`.ocard`/`manifests` 中间段防符号链接偷渡,落地闸后再写
    // 分类版:NAS 抖动/杀软占用要判成**可续传**的 IO,不是死路(见 paths::GateError)
    super::paths::ensure_dir_within_core(project_root, &dir)?;
    let path = manifest_path(project_root, &m.id)?;
    let bytes = serde_json::to_vec_pretty(m)?;
    match super::fsx::write_atomic(&path, &bytes) {
        Ok(r) => Ok((r, path)),
        // 报文带上「已重试 N 轮」:那是系统替用户排除掉「没有写权限」那一支的硬证据
        Err(f) => Err(super::CoreError::io_detail_retried(
            "写入拷卡清单",
            &path,
            &f,
        )),
    }
}

/// 由清单 id 拼出落点,并把 id 当**不可信输入**过闸。
///
/// `CopyManifest.id` 来自 NAS 上的 JSON——那是一份别人能改、也可能损坏的文件。
/// 此前它直接参与路径拼接,而 `save` 只检查了 `.ocard/manifests` 这个目录本身:
/// 一份 `id` 被改成 `../../..../x` 的清单,能让本进程把 JSON 原子覆盖到项目
/// 之外任何可写的位置。续传与启动补投都会读这个 id。
///
/// 三层闸:① id 必须是 UUID(引擎自己生成的形状);② 拼出来的必须仍是
/// `manifests/` 的直接子项;③ 最终路径过 `assert_within`。
fn manifest_path(project_root: &Path, id: &str) -> Result<PathBuf> {
    // 必须是**规范连字符形式**(36 位)。`Uuid::parse_str` 还接受 32 位无连字符、
    // `{...}` 花括号、以及 `urn:uuid:...`——后两种带着 `{}` 和 `:`,在 Windows 上
    // `:` 是备用数据流(ADS)的分隔符,落点会变成对另一个文件的流写入,
    // 报错方向完全指偏。引擎自己生成的一律是 36 位形式,收紧不影响任何真实清单。
    if id.len() != 36 || uuid::Uuid::parse_str(id).is_err() {
        return Err(super::CoreError::Invalid(format!(
            "拷卡清单 id 不是合法 UUID,拒绝按它拼路径(清单可能已损坏或被篡改): {id}"
        )));
    }
    let dir = manifest_dir(project_root);
    let path = dir.join(format!("{id}.json"));
    // UUID 里不可能有分隔符,这条按说到不了;留着是因为闸的价值在于
    // 「形状检查哪天被放宽了也还有人兜底」,而不是「现在正好够用」
    if path.parent() != Some(dir.as_path()) {
        return Err(super::CoreError::Invalid(format!(
            "拷卡清单落点逃出了清单目录,拒绝: {}",
            path.display()
        )));
    }
    super::paths::assert_within_core(project_root, &path)?;
    Ok(path)
}

pub fn load(project_root: &Path, id: &str) -> Result<CopyManifest> {
    // R4(终审 P0-3):清单读取过 canonical 只读闸(清单驱动 resume,是高危输入);
    // id 本身也是不可信输入,形状闸见 [`manifest_path`]
    let path = manifest_path(project_root, id)?;
    let bytes =
        fs::read(&path).map_err(|e| super::CoreError::io_detail("读取拷卡清单", &path, &e))?;
    let m: CopyManifest = serde_json::from_slice(&bytes)?;
    // 文件名与内容里的 id 必须一致:不一致说明这份清单被搬过/改过,而 `save`
    // 是按**内容里的 id** 定落点的——放行等于让一次读把后续的写引到别处
    if m.id != id {
        return Err(super::CoreError::Invalid(format!(
            "拷卡清单内容的 id({})与文件名({id})不一致,拒绝使用(清单可能已损坏或被篡改)",
            m.id
        )));
    }
    Ok(m)
}

/// 清单列表 + 健康度(损坏清单计数必须上报,零静默原则)。
#[derive(Debug, Default)]
pub struct ManifestList {
    pub manifests: Vec<CopyManifest>,
    /// 损坏/不可读被跳过的清单文件数。
    pub skipped: usize,
}

pub fn list(project_root: &Path) -> Result<ManifestList> {
    let dir = manifest_dir(project_root);
    let mut out = ManifestList::default();
    if !dir.exists() {
        return Ok(out);
    }
    // R5 终审:目录整段 + 逐文件闸——清单驱动 resume/统计/auto_proxy,
    // 任何一环经链接读入外部内容都不许
    super::paths::assert_within_core(project_root, &dir)?;
    for entry in fs::read_dir(dir)? {
        let path = entry?.path();
        if super::paths::is_symlink(&path) {
            out.skipped += 1; // 链接清单不读,按损坏口径计数上报
            continue;
        }
        if path.extension().is_some_and(|e| e == "json") {
            match fs::read(&path) {
                Ok(bytes) => match serde_json::from_slice::<CopyManifest>(&bytes) {
                    Ok(m) => out.manifests.push(m),
                    Err(_) => out.skipped += 1,
                },
                Err(_) => out.skipped += 1,
            }
        }
    }
    out.manifests.sort_by_key(|m| m.created_at);
    Ok(out)
}

#[cfg(test)]
mod tests {
    /// 0.4.3 现场:Windows 上这里失败,用户看到的全部信息是
    /// 「IO 错误: 拒绝访问。 (os error 5)」——哪个文件、该做什么,一个字都没有。
    /// `save` 退回裸 `fs::write` + `fs::rename`(即 `CoreError::Io`)时本测试红。
    #[test]
    #[cfg(unix)]
    fn save_failure_says_which_file_and_what_to_do() {
        use std::os::unix::fs::PermissionsExt;
        // root 无视权限位:0o500 拦不住它,save 会成功,unwrap_err() 就 panic。
        // CI 容器默认 root 时这条是定时炸弹(评审点名)。
        if unsafe { libc::geteuid() } == 0 {
            eprintln!("跳过:root 无视目录权限位,造不出这个场景");
            return;
        }
        let tmp = tempdir().unwrap();
        let project = tmp.path().join("project");
        let dir = manifest_dir(&project);
        std::fs::create_dir_all(&dir).unwrap();
        let m = sample();
        // 目录不可写 = 建不了临时文件,与 NAS 上拒绝访问同一条错误路径
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o500)).unwrap();

        let err = save(&project, &m).unwrap_err();
        // 恢复权限,免得 TempDir 清理失败
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700)).unwrap();

        let msg = err.to_string();
        assert!(err.is_io(), "仍须是 IO 口径(可续传): {msg}");
        assert!(msg.contains("写入拷卡清单"), "要说清是哪一步: {msg}");
        assert!(
            msg.contains(&format!("{}.json", m.id)),
            "要说清是哪个文件: {msg}"
        );
        let must_mention = if cfg!(windows) {
            "杀毒软件"
        } else {
            "权限"
        };
        assert!(msg.contains(must_mention), "要给下一步: {msg}");
        assert!(!msg.starts_with("IO 错误:"), "退回天书报文了: {msg}");
    }

    /// 清单 id 来自 NAS 上可被改写的 JSON,却参与路径拼接。
    /// 去掉 UUID 形状闸时本测试红——那一去就能让一份被改过的清单
    /// 把 JSON 原子覆盖到项目之外任何可写的位置。
    #[test]
    fn a_tampered_manifest_id_cannot_steer_the_write_out_of_the_project() {
        let tmp = tempdir().unwrap();
        let project = tmp.path().join("project");
        std::fs::create_dir_all(manifest_dir(&project)).unwrap();
        let outside = tmp.path().join("outside");
        std::fs::create_dir_all(&outside).unwrap();
        std::fs::write(outside.join("victim.json"), b"original").unwrap();

        for evil in [
            "../../outside/victim",
            "../../../outside/victim",
            "/etc/passwd",
            "not-a-uuid",
            // parse_str 接受的另外三种形状:32 位无连字符、花括号、URN。
            // 后两种带 `{}` / `:`,Windows 上 `:` 会变成 ADS 分隔符
            "urn:uuid:67e55044-10b1-426f-9247-bb680e5fe0c8",
            "{67e55044-10b1-426f-9247-bb680e5fe0c8}",
            "67e5504410b1426f9247bb680e5fe0c8",
        ] {
            let mut m = sample();
            m.id = evil.to_string();
            let err = save(&project, &m).unwrap_err();
            assert!(
                !err.is_io(),
                "路径逃逸是死路,不该被判成可续传的 IO 问题: {err}"
            );
            assert!(err.to_string().contains("拒绝"), "{err}");
        }
        assert_eq!(
            std::fs::read(outside.join("victim.json")).unwrap(),
            b"original",
            "项目外的文件被改写了"
        );
    }

    /// 文件名与内容里的 id 对不上时必须拒绝:`save` 是按**内容里的 id** 定落点的,
    /// 放行等于让一次读把后续的写引到别处。
    #[test]
    fn load_refuses_a_manifest_whose_inner_id_does_not_match_its_file_name() {
        let tmp = tempdir().unwrap();
        let mut m = sample();
        save(tmp.path(), &m).unwrap();
        let real_id = m.id.clone();
        // 把内容里的 id 换成另一个合法 UUID,文件名不动
        m.id = uuid::Uuid::new_v4().to_string();
        std::fs::write(
            manifest_dir(tmp.path()).join(format!("{real_id}.json")),
            serde_json::to_vec(&m).unwrap(),
        )
        .unwrap();

        let err = load(tmp.path(), &real_id).unwrap_err();
        assert!(err.to_string().contains("不一致"), "{err}");
    }

    /// 项目根整个不见了(NAS 掉线)= **可续传**的 IO 问题,不是死路。
    ///
    /// 这条钉的是路径闸的错误分类:`ensure_dir_within` 会做 `canonicalize` +
    /// `create_dir_all`,把它们的 IO 失败一律 `format!` 成 `Invalid` 时本测试红——
    /// 那一步会让「NAS 抖了一下」被判成任务终结,用户被迫整卡重拷。
    #[test]
    fn a_vanished_project_root_is_a_resumable_io_problem_not_a_dead_end() {
        let tmp = tempdir().unwrap();
        let project = tmp.path().join("gone");
        let err = save(&project, &sample()).unwrap_err();
        assert!(
            err.is_io(),
            "NAS 掉线必须判成可续传的 IO 中断,而不是死路: {err}"
        );
        let msg = err.to_string();
        assert!(msg.contains("重新挂载"), "要给下一步: {msg}");
        assert!(!msg.starts_with("根目录解析失败:"), "退回天书报文了: {msg}");
    }

    /// 临时文件不许留在 NAS 上(旧实现失败后 `<id>.json.tmp` 就那么躺着)。
    #[test]
    fn save_leaves_no_temp_file_behind() {
        let tmp = tempdir().unwrap();
        let m = sample();
        save(tmp.path(), &m).unwrap();
        let junk: Vec<String> = std::fs::read_dir(manifest_dir(tmp.path()))
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().to_string())
            .filter(|n| n != &format!("{}.json", m.id))
            .collect();
        assert!(junk.is_empty(), "清单目录里有残留: {junk:?}");
    }

    use super::*;
    use tempfile::tempdir;

    /// R3:save 的 `.ocard` 落地闸接线回归——中间段被换成指向项目外的
    /// 符号链接时必须拒写(在 save 里删掉 ensure_dir_within 调用本测试红)。
    #[cfg(unix)]
    #[test]
    fn save_refuses_symlinked_state_dir() {
        let tmp = tempdir().unwrap();
        let project = tmp.path().join("project");
        let outside = tmp.path().join("outside");
        fs::create_dir_all(&project).unwrap();
        fs::create_dir_all(&outside).unwrap();
        std::os::unix::fs::symlink(&outside, project.join(STATE_DIR)).unwrap();
        let m = CopyManifest::new("2. 原始素材/x", "card", "A7M4_A_ZS", "ZS", "");
        assert!(save(&project, &m).is_err(), "符号链接 .ocard 必须拒写");
        assert!(
            !outside.join(MANIFEST_DIR).exists(),
            "manifest 不得经链接写到项目外"
        );
    }

    fn sample() -> CopyManifest {
        let mut m = CopyManifest::new(
            "2. 原始素材/20260824_A7M4_A_ZS",
            "SDXC_01",
            "A7M4_A_ZS",
            "赵晋宇",
            "开幕式素材",
        );
        m.upsert(ManifestEntry {
            rel_path: "DCIM/100/IMG_0001.JPG".into(),
            size: 100,
            xxh3: "aa".into(),
            verified: true,
        });
        m
    }

    #[test]
    fn save_load_roundtrip_and_list() {
        let tmp = tempdir().unwrap();
        let m = sample();
        save(tmp.path(), &m).unwrap();
        let loaded = load(tmp.path(), &m.id).unwrap();
        assert_eq!(loaded.entries, m.entries);
        assert_eq!(loaded.camera_code, "A7M4_A_ZS");
        let l = list(tmp.path()).unwrap();
        assert_eq!(l.manifests.len(), 1);
        assert_eq!(l.skipped, 0);
    }

    #[test]
    fn is_done_requires_verified_and_size_match() {
        let mut m = sample();
        assert!(m.is_done("DCIM/100/IMG_0001.JPG", 100));
        assert!(!m.is_done("DCIM/100/IMG_0001.JPG", 101));
        assert!(!m.is_done("DCIM/100/IMG_0002.JPG", 100));
        m.upsert(ManifestEntry {
            rel_path: "DCIM/100/IMG_0001.JPG".into(),
            size: 100,
            xxh3: "aa".into(),
            verified: false,
        });
        assert!(!m.is_done("DCIM/100/IMG_0001.JPG", 100));
        assert_eq!(m.entries.len(), 1, "upsert 应覆盖同路径条目");
    }

    /// 老 manifest(改造前落盘、不含 `source_rel`/`source_selection`/`renamed_files`)
    /// 反序列化后必须与改造前行为一致:源路径回退到 `rel_path`,口径按整卷。
    /// 删掉 `PlannedFile::source()` 的空串回退本测试必红。
    #[test]
    fn legacy_manifest_without_source_rel_falls_back_to_rel_path() {
        // 逐字节取自改造前的落盘格式
        let legacy = r#"{
          "id": "3f0e1f4a-0000-4000-8000-000000000001",
          "target_rel": "2. 原始素材/20260824_A7M4_A_ZS",
          "source_label": "SDXC_01",
          "camera_code": "A7M4_A_ZS",
          "operator": "赵晋宇",
          "note": "开幕式素材",
          "tags": ["开幕式"],
          "destinations": ["/nas/2. 原始素材/20260824_A7M4_A_ZS"],
          "planned": [
            { "rel_path": "DCIM/100MSDCF/IMG_0001.JPG", "size": 100 },
            { "rel_path": "CLIP0001.MP4", "size": 200 }
          ],
          "source_uid": null,
          "created_at": "2026-08-24T01:02:03Z",
          "completed": false,
          "auto_proxy": false,
          "proxy_completed": false,
          "proxy_attempts": 0,
          "entries": [
            { "rel_path": "DCIM/100MSDCF/IMG_0001.JPG", "size": 100, "xxh3": "aa", "verified": true }
          ]
        }"#;
        let m: CopyManifest = serde_json::from_str(legacy).unwrap();
        assert!(m.source_selection.is_empty(), "老清单必须按整卷解读");
        assert!(m.renamed_files.is_empty());
        for p in &m.planned {
            assert_eq!(p.source(), p.rel_path, "空 source_rel = 与 rel_path 相同");
            let item = p.to_plan();
            assert_eq!(item.source_rel, item.target_rel);
            assert_eq!(item.size, p.size);
        }
        // 续传身份不变:仍按目标(= 老口径的唯一 rel)认已完成
        assert!(m.is_done("DCIM/100MSDCF/IMG_0001.JPG", 100));
        assert!(!m.is_done("CLIP0001.MP4", 200));
    }

    /// 整卷任务的清单**字节形态**保持与改造前一致:三个新字段都不落盘。
    /// (新字段一旦无条件写出,老版本 OCard 读同一个 NAS 上的清单就会多出
    ///  永远为空的噪声字段;把「没有选择/没有改名」写成缺席才是同一件事。)
    #[test]
    fn whole_volume_manifest_keeps_legacy_json_shape() {
        let mut m = sample();
        m.planned = vec![PlannedFile::from_plan(&super::super::copy::PlannedFile {
            source_rel: "DCIM/100/IMG_0001.JPG".into(),
            target_rel: "DCIM/100/IMG_0001.JPG".into(),
            size: 100,
            source_mtime_ns: 0,
        })];
        let json = serde_json::to_string(&m).unwrap();
        for key in ["source_rel", "source_selection", "renamed_files"] {
            assert!(!json.contains(key), "整卷清单不该出现 {key}: {json}");
        }
    }

    /// 按文件夹拷时,审计痕迹必须真的落盘并读得回来
    /// (加前缀等于系统替用户改了文件名,事后要查得到原名与来源夹)。
    #[test]
    fn folder_selection_audit_trail_roundtrips() {
        let tmp = tempdir().unwrap();
        let mut m = sample();
        m.source_selection = vec!["DCIM/100MSDCF".into(), "DCIM/101MSDCF".into()];
        m.renamed_files = vec![super::super::copy::RenamedFile {
            source_rel: "DCIM/101MSDCF/DSC1.JPG".into(),
            target_rel: "101MSDCF_DSC1.JPG".into(),
        }];
        m.planned = vec![PlannedFile::from_plan(&super::super::copy::PlannedFile {
            source_rel: "DCIM/101MSDCF/DSC1.JPG".into(),
            target_rel: "101MSDCF_DSC1.JPG".into(),
            size: 42,
            source_mtime_ns: 0,
        })];
        save(tmp.path(), &m).unwrap();
        let loaded = load(tmp.path(), &m.id).unwrap();
        assert_eq!(loaded.source_selection, m.source_selection);
        assert_eq!(loaded.renamed_files, m.renamed_files);
        assert_eq!(loaded.planned[0].rel_path, "101MSDCF_DSC1.JPG");
        assert_eq!(loaded.planned[0].source(), "DCIM/101MSDCF/DSC1.JPG");
    }

    /// R4 终审 P0-3:`.ocard` 被换成指向项目外的链接时,清单**读取**也必须拒
    /// (清单驱动 resume,经链接注入外部清单=任意路径读写的前菜)。
    #[cfg(unix)]
    #[test]
    fn load_refuses_symlinked_state_dir() {
        let tmp = tempfile::tempdir().unwrap();
        let project = tmp.path().join("project");
        let outside = tmp.path().join("outside");
        std::fs::create_dir_all(&project).unwrap();
        // 外部造一份「合法清单」
        std::fs::create_dir_all(outside.join("manifests")).unwrap();
        let m = CopyManifest::new("1. 待分类/x", "SD", "A7M4_A_ZS", "ZS", "");
        let mid = m.id.clone();
        std::fs::write(
            outside.join("manifests").join(format!("{mid}.json")),
            serde_json::to_vec(&m).unwrap(),
        )
        .unwrap();
        std::os::unix::fs::symlink(&outside, project.join(super::super::project::STATE_DIR))
            .unwrap();
        assert!(
            load(&project, &mid).is_err(),
            "链接 .ocard 下的清单读取必须被拒"
        );
    }

    /// R5 终审:整目录闸之外,**单个清单文件**是链接也不许读(计入 skipped)。
    #[cfg(unix)]
    #[test]
    fn list_skips_symlinked_manifest_file() {
        let tmp = tempfile::tempdir().unwrap();
        let project = tmp.path().join("project");
        std::fs::create_dir_all(manifest_dir(&project)).unwrap();
        let outside = tmp.path().join("outside.json");
        let m = CopyManifest::new("1. 待分类/x", "SD", "A7M4_A_ZS", "ZS", "");
        std::fs::write(&outside, serde_json::to_vec(&m).unwrap()).unwrap();
        std::os::unix::fs::symlink(&outside, manifest_dir(&project).join("evil.json")).unwrap();
        let list = list(&project).unwrap();
        assert!(list.manifests.is_empty(), "链接清单不得读入");
        assert_eq!(list.skipped, 1, "跳过必须计数上报");
    }
}
