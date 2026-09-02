//! 拷卡引擎:单次读源、并行写多目的地、xxh3 校验、断点续传。
//!
//! 可靠性设计(PRD §5.3 / §6.4):
//! - 写入始终先落 `.ocardpart` 临时名,回读校验通过后才改名——NAS 断连不会留半个文件;
//! - 每完成一个文件就持久化 manifest,任务中断后按 manifest 续拷;
//! - 单文件失败只标记该文件,不作废整个任务。

use super::hash;
use super::manifest::{self, CopyManifest, ManifestEntry};
use super::Result;
use std::fs::{self, File};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

const BUF_SIZE: usize = 4 * 1024 * 1024;
const PART_SUFFIX: &str = ".ocardpart";

#[derive(Debug, Clone)]
pub struct CopyRequest {
    /// 源(存储卡挂载点或其子目录)。
    pub source_root: PathBuf,
    /// 目的地:各「拷卡目标文件夹」绝对路径(NAS 主 + 备份盘),≥1 个。
    pub destinations: Vec<PathBuf>,
    /// 任务标识:让临时文件名任务唯一,杜绝跨任务/跨工作站同写一个 part 文件。
    pub task_tag: String,
    /// 本次任务的源选择口径。清单是可被篡改的持久化输入,引擎按它复核每一项
    /// 的源路径是否在用户当初勾选的范围内(整卷则要求源=目标),不符即拒。
    pub selection: SourceSelection,
}

#[derive(Debug, Clone, PartialEq)]
pub enum FileStatus {
    /// 本次拷贝并校验通过。
    Copied,
    /// manifest 中已验证,断点续传跳过。
    SkippedResume,
    Failed(String),
}

#[derive(Debug, Clone)]
pub struct FileReport {
    /// **目标**相对路径(= manifest 与快照的文件标识)。
    pub rel_path: String,
    /// 源在卷内的相对路径(整卷时与 `rel_path` 相同);失败审计要点名卡上的真实文件。
    pub source_rel: String,
    pub size: u64,
    pub status: FileStatus,
}

#[derive(Debug)]
pub struct CopyOutcome {
    pub files: Vec<FileReport>,
    pub bytes_copied: u64,
    /// 全部文件均已验证(含续传跳过的)。为 true 才提示「本卡可格式化」。
    pub all_verified: bool,
    /// 因暂停请求提前停止(文件边界处停,manifest 可续传)。
    pub paused: bool,
    /// 因租约原因(被接管 / 心跳久未成功)在文件边界停下,并**跳过了随后的落盘**。
    /// 用 outcome 而不是 Err 承载:收尾(已失败文件的审计、占用总账)必须照跑,
    /// 否则那几条「哪个文件为什么失败」的记录就跟着 Err 一起消失了。
    pub aborted: bool,
    /// 写清单时为躲开「目标被占用」而重试的总轮数(见 [`Progress::Contention`])。
    pub write_retries: u32,
    /// **素材文件**落位改名时同样原因的重试总轮数。分开记是因为两者的分量不同:
    /// 清单重写得起,素材落不了位才是要命的。
    pub material_retries: u32,
}

/// 进度事件里的 `rel_path` 一律是**目标**相对路径:它同时是 manifest 键与
/// UI 快照的文件 id,扁平化改名后也只有它能把三边对上号。
#[derive(Debug)]
pub enum Progress<'a> {
    Scanned {
        total_files: usize,
        total_bytes: u64,
    },
    FileStarted {
        rel_path: &'a str,
        index: usize,
        total: usize,
    },
    /// 单文件内的增量字节(每个读写块回调一次,大文件进度靠它)。
    BytesCopied { rel_path: &'a str, delta: u64 },
    FileFinished {
        rel_path: &'a str,
        status: &'a FileStatus,
    },
    /// 落盘时被别的程序占着,重试 `retries` 轮后**成功**。`what` 说明是哪一步
    /// (写清单 / 素材落位),`path` 是被占的那个文件——「把目录加进杀软排除项」
    /// 这条建议,没有路径用户就不知道该加哪个目录。
    ///
    /// 结果是对的,所以它不是失败;但它解释了为什么慢,更预告了下一次可能
    /// 直接中断整个任务——0.4.3 那次 Windows 中断就是这条没被提前说出来。
    /// 零静默要求「第一次就说」,不是「任务做完再说」:一场两小时的拷卡里
    /// 攒 500 次重试等于悄悄多花十几分钟,用户全程不知道为什么慢。
    ///
    /// 走任务级管道而不是进程级 static:后者会被拷卡/分类/转码三条路径互相
    /// 抢走计数,并行两张卡时告警还会归因到错误的那张。
    Contention {
        kind: ContentionKind,
        path: &'a Path,
        retries: u32,
    },
    /// 马上要写清单了。回调在这里回 [`CopyControl::Abort`] 就**不写**——租约状态
    /// 在这一刻问,比在上一个块级回调问更准:丢租约与落盘之间不再有窗口。
    AboutToSave { rel_path: &'a str },
}

/// 哪一步被占用了。两种的分量不同(清单重写得起,素材落不了位才要命),
/// 通知也要各用各的 code——共用一个会在 30 秒合并窗口里互相顶掉正文。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum ContentionKind {
    Manifest,
    Material,
}

/// 素材落位一步的占用记录:轮数 + 最近被占的那个**最终文件**。
/// 报给用户的必须是被占的文件本身,不是目的地根——两个目的地时根会指错一个。
#[derive(Debug, Default)]
pub struct ContentionTally {
    pub retries: u32,
    pub last_path: Option<PathBuf>,
}

/// 进度回调的返回值:在文件边界处响应暂停请求。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CopyControl {
    Continue,
    Pause,
    /// 立刻停,而且**不再写清单**:租约已被别的进程接管(或马上会被接管),
    /// 再写一次就是把人家记下的进度整份顶掉——租约存在的唯一理由就是防这个。
    /// 跳过最后那次落盘不丢进度:接管方会按哈希重新核对已落位的文件。
    Abort,
}

thread_local! {
    /// 扫描期跳过的符号链接计数(R2 P0:`metadata()` 跟随链接会把卡外目录树
    /// 卷进拷贝清单,甚至链接环死循环)。零静默:命令层取走后聚合为可见 warning。
    ///
    /// **按线程**计数(双路评审):扫描与随后的 take 永远在同一个命令函数体里,
    /// 而进程级全局计数会被并发的另一次扫描抢走——浏览文件夹时顺手偷走拷卡的
    /// 跳过数,拷卡那条告警就静默消失了,正是零静默要堵的洞。
    static SCAN_SYMLINKS_SKIPPED: std::cell::Cell<u64> = const { std::cell::Cell::new(0) };

    /// 扫描期排除的**系统项**(计数 + 前几条路径)。
    ///
    /// R11:排除口径已从「以点开头一律跳过」收紧成 [`SYSTEM_ITEM_NAMES`] 明确列举
    /// (理由见那里)。但即便排除的东西再确定不是素材,也必须报到用户面前:
    /// 配上「整卷 100% 完成 → 本卡可格式化」这句话,静默排除等于引导用户
    /// 格式化掉没备份的东西。
    static SCAN_SYSTEM_SKIPPED: std::cell::RefCell<(u64, Vec<String>)> =
        const { std::cell::RefCell::new((0, Vec::new())) };
}

/// 可见化告警里最多留几条样例路径(够用户认出「哦是系统残留」即可)。
const SYSTEM_SAMPLE_CAP: usize = 5;

/// 扫描时排除的**系统项**:明确列举,逐条给理由。
///
/// R11 裁决:这是**备份工具**。此前的「以点开头一律跳过」是形状判据,会把卡上
/// 合法的素材(某些机型的 `.clip.mov`、被误设隐藏属性的素材、用户自建的隐藏
/// 素材夹)整个挡在计划之外,而整卷任务照样报 100% 完成并给出「本卡可格式化」
/// 的信号——**漏拷却报成功**是这个工具最不能接受的失败形态。可见告警只能缓解,
/// 不能替代拷对。所以只排除下面这些「确定不是素材」的东西,其余点开头的条目照拷。
///
/// 每一项都写成 [`target_name_key`] 归一后的形态(Unicode 规范等价 + 大小写折叠):
/// exFAT/APFS 上 `.ds_store` 与 `.DS_Store` 是同一个文件,比对必须大小写不敏感,
/// 不能按字节比。`system_item_names_are_already_normalized` 这个测试守住这条
/// 不变式——写了个大写条目却永不命中,是最难发现的一类失效。
///
/// **加条目的门槛(方向性)**:这张表加错的方向是**漏拷**,所以门槛是「确定不是
/// 素材」**且**「现实中真的会出现在扫描范围里」。据此复核后**没有**加入
/// `LOST.DIR`(Android fsck 恢复目录)与 `FOUND.000`/`*.CHK`(chkdsk 恢复片段)
/// ——它们里面可能就是恢复出来的素材片段,多拷不是漏拷。
const SYSTEM_ITEM_NAMES: &[&str] = &[
    // ---- macOS 在卷上留下的系统目录/文件:全是操作系统自己的记账,没有素材 ----
    ".trashes", // `.Trashes`:卷级废纸篓,里面是用户**已经删掉**的东西
    // `$topdir/.Trash/$uid`:freedesktop.org Trash Specification 给可移动盘定义的
    // **共享**回收站(与按 uid 分的 `.Trash-$uid` 并列,是规范里的另一半)。漏掉它
    // 的后果不是多拷:已删除的素材连同 `.trashinfo` 会被当素材备份、甚至交付出去
    // ——既是隐私泄漏(用户明确删掉的东西又回来了)也是容量膨胀。
    ".trash",
    ".fseventsd",              // `.fseventsd`:FSEvents 文件系统事件日志数据库
    ".spotlight-v100",         // `.Spotlight-V100`:Spotlight 索引数据库
    ".temporaryitems",         // `.TemporaryItems`:系统临时文件暂存区
    ".documentrevisions-v100", // `.DocumentRevisions-V100`:文档版本(自动保存)数据库
    ".ds_store",               // `.DS_Store`:Finder 记的窗口大小/图标位置,纯显示设置
    // ---- Windows 在卡上留下的系统目录:不以点开头,但性质完全一样,同表维护 ----
    "system volume information", // 卷影副本/索引服务的元数据;常带 ACL 读不动
    "$recycle.bin",              // 回收站(Vista 之后)
    "recycler",                  // 回收站(XP 时代;老卡格式化后还留着这个名字)
    "thumbs.db",                 // 资源管理器的缩略图缓存
    "desktop.ini",               // 文件夹显示设置(图标/名称),纯显示配置
    // ---- NAS / 网络共享上的记账目录 ----
    // 本名单同时被交付打包(`core::packaging`)复用,它扫的是 NAS 上的项目目录。
    // 卡上不会有这些名字,NAS 上却遍地都是——不列举就会被打进交付包。
    "@eadir",        // 群晖为每个文件建的元数据/缩略图目录
    ".@__thumb",     // 群晖缩略图缓存目录
    ".appledouble",  // netatalk(AFP/SMB 共享)存放资源分支的目录
    ".appledb",      // netatalk 的 AFP 数据库
    ".appledesktop", // netatalk 的 AFP 桌面数据库
    ".apdisk",       // macOS 写在共享卷根的 AFP/Time Machine 卷配置
    // ---- 本工具自己在卡上/项目里的落盘:必须**精确名**,不能写成 `.ocard` 前缀 ----
    // R13 P0:`.ocard` 曾经躺在 `SYSTEM_ITEM_PREFIXES` 里,于是卡上的
    // `.ocardinal.mov`、`.ocard-notes.txt`、`.ocard_backup/` 整个不进计划,
    // 而告警还断言它们「不是素材」、整卷任务照样给「本卡可格式化」——正是
    // 「形状判据兜底 → 漏拷却报成功」这条铁律禁止的东西,只是范围小了一点。
    // 本工具真正会落在扫描范围里的名字只有下面两个,逐个列全即可。
    // (本工具的**临时**文件名走 `SYSTEM_ITEM_SUFFIXES`,身份写在尾巴上。)
    ".ocard",           // 项目元数据目录(manifest/journal/trash/settings)
    ".ocard-volume-id", // 卡根的身份指纹文件
];

/// 真·前缀式的系统项:尾巴是**原文件名**,长什么样完全由用户决定,除了前缀之外
/// 没有任何可校验的形状。同样是归一后([`target_name_key`])的形态。
///
/// 这张表只允许放「尾巴不可预测」的条目——尾巴有规范形状的一律去
/// [`SYSTEM_ITEM_TAILED`],只比前缀就是 `.ocard` 那条 P0 的同型错误。
const SYSTEM_ITEM_PREFIXES: &[&str] = &[
    // `._DSC0001.JPG`:AppleDouble 伴生文件。macOS 往非 HFS 卷(exFAT 卡)写文件时,
    // 把资源分支与扩展属性拆出来存进 `._` + **原文件名** 的文件里。尾巴就是素材自己
    // 的名字(`DSC0001.JPG`),没有任何形状可校验,所以只能按前缀认——这也是它
    // 与 `.ocard` 的根本区别。它是**伴生元数据**、不是素材本体,拷到目的地也没有
    // 对应语义,只会凭空多出一堆同名影子文件。
    "._",
];

/// 「命名空间前缀 + 规范定死的尾巴」式系统项。
///
/// 与 [`SYSTEM_ITEM_PREFIXES`] 的区别:这些条目的尾巴是**机器生成的令牌**,
/// 形状由各自的规范/实现定死。既然形状是已知的,就必须一并校验——只比前缀会把
/// `.trash-notes.txt`、`.nfs-交接单.txt` 这类用户文件一起静默吞掉,而那正是
/// R13 P0(`.ocard` 前缀)的同型错误。
///
/// 每条给出:前缀、尾巴允许的字符集、尾巴最短长度。
const SYSTEM_ITEM_TAILED: &[(&str, TailShape, usize)] = &[
    // `.Trash-1000`:freedesktop.org Trash Specification 里按 uid 分的回收站。
    // 规范写死尾巴就是 `$uid`——纯十进制数字,一位起。
    (".trash-", TailShape::Digits, 1),
    // `.smbdeleteAAA0f4a.4`:SMB 上删除一个仍被打开的文件时,服务端先把它改名挂着。
    // 尾巴是 Samba 自己拼的不透明令牌(字母/数字/点),不同版本长度不同,故只约束
    // 字符集与最短长度。它是**已经被删掉**的东西的残骸,不是素材。
    (".smbdelete", TailShape::AlnumDot, 4),
    // `.nfs0000000000e1a3`:NFS 客户端的 silly-rename(删一个仍被打开的文件)。
    // Linux 实现拼的是 `.nfs` + 定长十六进制,故尾巴必须全是十六进制且不短于 8 位
    // ——`.nfs` 三个字母太短,不加形状约束会误伤用户文件。
    (".nfs", TailShape::Hex, 8),
];

/// 系统项尾巴允许的字符集(判据作用在 [`target_name_key`] 归一后的键上,
/// 因此只需覆盖小写形态)。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum TailShape {
    /// 纯十进制数字(freedesktop 的 `$uid`)
    Digits,
    /// 十六进制数字(NFS silly-rename 的定长令牌)
    Hex,
    /// 字母/数字/点(Samba 的不透明令牌)
    AlnumDot,
}

impl TailShape {
    fn allows(self, c: char) -> bool {
        match self {
            Self::Digits => c.is_ascii_digit(),
            Self::Hex => c.is_ascii_hexdigit(),
            Self::AlnumDot => c.is_ascii_alphanumeric() || c == '.',
        }
    }
}

/// 后缀式的系统项:**本工具自己在 NAS 项目目录里落下的半截文件**。名字前半段是
/// 用户的文件名或一个 uuid(可变),身份只写在尾巴上,只能按后缀认。
///
/// 为什么必须列进来(R12):这两种临时名是「写入先落临时名、回读校验通过再改名」
/// 这套零覆盖写法的**设计产物**——NAS 断连/断电时它们**按设计**留在项目目录里,
/// 内容是**不完整的**。而这份名单同时被交付打包(`core::packaging`)和分类计数
/// (`core::sorting`)复用:不排除的话,一个半截文件会被算进分类计数,更糟的是
/// 被原样打进交付包发给客户——**交付一个截断的文件**比漏掉它还坏。
///
/// 卡上不会出现这两种名字(相机只写 `.MP4`/`.JPG`/`.ARW`),所以放进共享名单
/// 不会误伤拷卡侧;而落点占用这个命名空间本来就被规划期的保留字检查挡着
/// (见 [`target_name_key`] 的注释),口径是一致的。
const SYSTEM_ITEM_SUFFIXES: &[&str] = &[
    // `CLIP0001.MP4.<task_tag>.ocardpart`:拷卡引擎的写入临时名(见 `PART_SUFFIX`)。
    ".ocardpart",
    // `.<uuid>.curatepart`:精选复制(`core::sorting::curate_assets`)的落地临时名。
    // 它就落在「精选/待修」里,而「待修」正是分类计数与「待修→已修」流转提示
    // 扫描的目录——不排除会让计数在复制过程中跳动、崩溃后永久多出一个幽灵。
    ".curatepart",
];

/// 这个目录项是不是「确定不是素材」的系统项(见 [`SYSTEM_ITEM_NAMES`])。
///
/// 三处扫描(整卷递归 `walk`、列可勾选文件夹 `collect_folders`、列直接子文件
/// `list_direct_files`)共用这**一份**口径:各写一份迟早会分叉,而分叉的后果是
/// 「选择器里看得见、拷贝时却不拷」或反之,两种都是静默漏拷。
///
/// 交付打包(`core::packaging`)也复用它:拷卡既然把 `.clip.mov` 拷进了素材夹,
/// 打包时再按别的口径把它筛掉,就是在交付环节静默漏掉一个素材。
///
/// R12 起 NAS 侧的三条路径也共用它——分类计数(`core::sorting::count_files`)、
/// 转码取源(`commands::transcode_cmds`)、成片校验与流转提示
/// (`commands::finalcut_cmds`)。它们此前各写一份「以点开头一律跳过」,
/// 于是 `.clip.mov` 拷得进 NAS、在分类界面看得见、能被移进交付目录,
/// 却转不了码、算不进计数、进不了成片校验——**看得见却处理不了**的静默不一致。
///
/// **判据是按「名字」比的,不是按路径。** 调用方必须把它用在**扫描起点的每一级
/// 目录项名**上:项目自身的 `.ocard/`(清单、日志、回收站、分析缓存)不落在上面
/// 那几条路径的扫描起点之下(它们分别扎在「N. 分类夹」「2. 原始素材」「6. 成片」
/// 「精选/待修|已修」里,`.ocard` 是项目根的同级兄弟),这是第一道保证;
/// 万一将来有人把扫描起点上提到项目根,`SYSTEM_ITEM_NAMES` 里的精确名 `.ocard`
/// 是第二道。两道都在,才敢说项目元数据不会被当素材打进交付包。
pub(crate) fn is_system_item(name: &str) -> bool {
    // 大小写/Unicode 归一走 target_name_key(与落点撞名判定同一把尺子):
    // 卡上是 `.DS_Store` 还是 `.ds_store`,在 exFAT/APFS 上都是同一个东西
    let key = target_name_key(name);
    SYSTEM_ITEM_NAMES.contains(&key.as_str())
        || SYSTEM_ITEM_PREFIXES.iter().any(|p| key.starts_with(p))
        || SYSTEM_ITEM_SUFFIXES.iter().any(|s| key.ends_with(s))
        || SYSTEM_ITEM_TAILED
            .iter()
            .any(|&(prefix, shape, min_len)| matches_tailed(&key, prefix, shape, min_len))
}

/// 「命名空间前缀 + 规范定死的尾巴」的判定(见 [`SYSTEM_ITEM_TAILED`])。
/// 尾巴必须**整段**符合形状:形状对不上就说明这是个用户文件,必须照拷。
fn matches_tailed(key: &str, prefix: &str, shape: TailShape, min_len: usize) -> bool {
    let Some(tail) = key.strip_prefix(prefix) else {
        return false;
    };
    tail.chars().count() >= min_len && tail.chars().all(|c| shape.allows(c))
}

/// 记一个被跳过的符号链接。**每一处扫描都必须用它**(而不是各自静默跳过):
/// 计数由 `commands::notice_scan_skips` 统一取走并聚合成可见告警。
pub(crate) fn note_symlink_skipped() {
    SCAN_SYMLINKS_SKIPPED.with(|c| c.set(c.get() + 1));
}

/// 取走本线程扫描期的符号链接跳过数(取走即清零)。
pub fn take_scan_symlinks_skipped() -> u64 {
    SCAN_SYMLINKS_SKIPPED.with(|c| c.replace(0))
}

/// 记一条被排除的系统项(`rel` 相对卷根,目录也算一条)。
fn note_system_item_skipped(rel: String) {
    SCAN_SYSTEM_SKIPPED.with(|c| {
        let mut c = c.borrow_mut();
        c.0 += 1;
        if c.1.len() < SYSTEM_SAMPLE_CAP {
            c.1.push(rel);
        }
    });
}

/// 取走本线程扫描期排除的系统项(总数, 前几条路径);取走即清零。
pub fn take_scan_system_skipped() -> (u64, Vec<String>) {
    SCAN_SYSTEM_SKIPPED.with(|c| std::mem::take(&mut *c.borrow_mut()))
}

/// 把取走的计数放回去(调用方需要先读一眼再由统一的告警出口取走时用)。
/// 只在计数已被清空时放回,避免把两次扫描的数字叠加成假数。
pub fn restore_scan_system_skipped(v: (u64, Vec<String>)) {
    SCAN_SYSTEM_SKIPPED.with(|c| {
        let mut c = c.borrow_mut();
        if c.0 == 0 {
            *c = v;
        }
    });
}

/// 源选择:整盘,或卡内若干文件夹(只取各自的**直接子文件**,不递归)。
///
/// DIT 常见诉求是「只要 100MSDCF 和 CLIP 里的素材」,而不是整张卡;
/// 且落到目标夹时不要相机那层目录名。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SourceSelection {
    /// 整盘递归(历史行为,保留目录结构)
    WholeVolume,
    /// 选中的文件夹(相对卷根、`/` 分隔;空串代表卷根自身)。
    /// 只取每个文件夹下的直接子文件,子目录需要另行勾选。
    Folders(Vec<String>),
}

impl SourceSelection {
    /// 空列表 = 整卷(契约:前端不传/传空数组都按整卷处理,老客户端行为不变)。
    pub fn from_folders(folders: Vec<String>) -> Self {
        if folders.is_empty() {
            Self::WholeVolume
        } else {
            Self::Folders(folders)
        }
    }

    /// 持久化形态(manifest 审计用):整卷 = 空列表。
    pub fn to_folders(&self) -> Vec<String> {
        match self {
            Self::WholeVolume => Vec::new(),
            Self::Folders(f) => f.clone(),
        }
    }

    /// 这条计划项是否符合本次选择的口径。清单经 NAS 持久化后可被篡改,
    /// 引擎按此复核:
    /// - 整卷:源即目标(保留原层级),任何源≠目标都说明清单被动过;
    /// - 选文件夹:源必须是**所选文件夹的直接子文件**,目标必须是扁平文件名。
    pub fn allows(&self, source_rel: &str, target_rel: &str) -> bool {
        match self {
            Self::WholeVolume => source_rel == target_rel,
            Self::Folders(folders) => {
                let parent = match source_rel.rfind('/') {
                    Some(i) => &source_rel[..i],
                    None => "",
                };
                !target_rel.contains('/') && folders.iter().any(|f| f == parent)
            }
        }
    }
}

/// 扫描到的一个源文件。
///
/// `mtime_ns` 是「同大小、内容被替换」的唯一廉价判据(哈希要把整盘读一遍):
/// 暂停期间有人换了卡或改了文件,尺寸常常一模一样,只有时间戳会动。
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
pub struct ScannedFile {
    /// 相对卷根,`/` 分隔
    pub rel: String,
    pub size: u64,
    /// mtime 的纳秒表示;取不到按 0(退化为「无身份信息」,不阻断)
    pub mtime_ns: u128,
}

impl ScannedFile {
    fn new(rel: String, meta: &fs::Metadata) -> Self {
        Self {
            rel,
            size: meta.len(),
            mtime_ns: super::media::mtime_nanos(meta),
        }
    }
}

/// 一个待拷文件:源相对路径(相对卷根)与它在目标夹里的落点。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PlannedFile {
    /// 卷内真实位置,如 `DCIM/100MSDCF/DSC001.JPG`
    pub source_rel: String,
    /// 目标夹内的相对落点。扁平化后通常就是文件名;重名时按下述规则加前缀
    pub target_rel: String,
    pub size: u64,
    /// 规划时刻源文件的 mtime(纳秒;0 = 未知/老清单)。持久化后用于发现
    /// 「同大小但内容被换掉」——只比 size 的话这种替换完全无声。
    pub source_mtime_ns: u128,
}

/// 因重名而被改写落点的文件(必须让用户看见——系统改了文件名,不许静默)
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct RenamedFile {
    pub source_rel: String,
    pub target_rel: String,
}

/// 整卷清单 → 计划项:源即目标,保留原目录结构(历史行为)。
pub fn plan_whole_volume(files: &[ScannedFile]) -> Vec<PlannedFile> {
    files
        .iter()
        .map(|f| PlannedFile {
            source_rel: f.rel.clone(),
            target_rel: f.rel.clone(),
            size: f.size,
            source_mtime_ns: f.mtime_ns,
        })
        .collect()
}

/// 计划摘要的版本前缀。口径变了就换版本号:老令牌会被判成「无法识别」并要求
/// 重新确认(fail-closed),而不是被误判成「没变」。
const PLAN_DIGEST_PREFIX: &str = "ocard-plan-v3";

/// 规范化后的源选择(摘要与快照共用一把尺子):排序 + 去重后的文件夹列表。
/// 整卷 = 空列表。摘要按它算,`ApprovedPlans` 也存它——两边分叉就会出现
/// 「摘要说选择变了、快照却比不出差异」这种自相矛盾的报文。
pub fn normalized_selection(selection: &SourceSelection) -> Vec<String> {
    let mut folders = selection.to_folders();
    folders.sort();
    folders.dedup();
    folders
}

/// 计划摘要:把「用户在双确认屏批准的到底是哪一份计划」压成一个可回传的短串。
///
/// R5:批准的是 L1、执行的是重扫得到的 L2,窗口内换卡/别的进程写入/文件被删
/// 都会让两者不同——被删的已确认文件从新计划里消失后,剩下的照样能
/// `all_verified = true`。
///
/// **形态是分段的**(`ocard-plan-v3:<卷>:<选择>:<文件集>:<修改时间>`),对前端仍是
/// 一个不透明字符串原样回传,但后端比对时能按段定位**变化原因**:
/// - `<卷>` = 卷身份(挂载点 + 卷名 + 卡指纹)——识别「换了一张卡」;
/// - `<选择>` = 规范化并排序后的源选择——识别「提交的勾选范围不是确认时那一份」;
/// - `<文件集>` = 排序后的 `(source_rel, target_rel, size)` 三元组——识别
///   「增删/改大小/落点被重新规划」;
/// - `<修改时间>` = 排序后的 `(source_rel, source_mtime_ns)`——识别
///   **同大小、内容被替换**,这正是 size-only 摘要漏掉的那一类,而它在换卡场景里
///   完全可能发生。令牌的全部意义是「你批准的就是将要执行的」,漏掉这一类就白立了。
///
/// R13 C1(P0):`<选择>` 从 `<文件集>` 里**独立出来**。此前两者共用一段,于是
/// 「卡完全没变、只是提交选择 B 时误带了选择 A 的令牌」这种纯前端状态错配,
/// 会被逐条 diff 报成「A 被删、B 新增」,报文断言「卡上的文件变了」——把前端
/// 错配说成有人动了卡。说错原因比不说更糟。
///
/// 分段不是为了让前端解析,而是为了让报错说得出**对的**原因:
/// 「多了 3 个文件」和「有 2 个文件被改动过」指向完全不同的排查方向。
pub fn plan_digest(
    selection: &SourceSelection,
    plan: &[PlannedFile],
    volume_identity: &str,
) -> String {
    let mut vol = xxhash_rust::xxh3::Xxh3::new();
    vol.update(b"volume\0");
    vol.update(volume_identity.as_bytes());

    // 选择规范化(排序 + 去重)后再喂:同一批夹子换个勾选顺序不该判成「计划变了」
    let mut sel = xxhash_rust::xxh3::Xxh3::new();
    sel.update(b"selection\0");
    for f in &normalized_selection(selection) {
        sel.update(f.as_bytes());
        sel.update(b"\0");
    }

    let mut set = xxhash_rust::xxh3::Xxh3::new();
    set.update(b"files\0");
    let mut items: Vec<(&str, &str, u64)> = plan
        .iter()
        .map(|p| (p.source_rel.as_str(), p.target_rel.as_str(), p.size))
        .collect();
    items.sort();
    for (src, dst, size) in items {
        set.update(src.as_bytes());
        set.update(b"\0");
        set.update(dst.as_bytes());
        set.update(b"\0");
        set.update(size.to_string().as_bytes());
        set.update(b"\n");
    }

    // mtime 原值(含「取不到 = 0」)照喂:两次扫描相隔几秒、走的是同一段代码同一个
    // 文件系统,取不到就两次都取不到,不会因此抖动。`diff_plans` 那边逐条比对时
    // 才需要「一侧为 0 就不算数」的保守判据(点名一个其实没变的文件是纯误报)。
    let mut mt = xxhash_rust::xxh3::Xxh3::new();
    mt.update(b"mtimes\0");
    let mut times: Vec<(&str, u128)> = plan
        .iter()
        .map(|p| (p.source_rel.as_str(), p.source_mtime_ns))
        .collect();
    times.sort();
    for (src, ns) in times {
        mt.update(src.as_bytes());
        mt.update(b"\0");
        mt.update(ns.to_string().as_bytes());
        mt.update(b"\n");
    }

    format!(
        "{PLAN_DIGEST_PREFIX}:{:016x}:{:016x}:{:016x}:{:016x}",
        vol.digest(),
        sel.digest(),
        set.digest(),
        mt.digest()
    )
}

/// 令牌对不上时的**原因**定性。报错必须说对原因——说错原因比不说更糟,
/// 会把人引向错误的排查方向(去数文件 vs 去找是谁动了卡)。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PlanChange {
    /// 两份摘要逐段相同
    None,
    /// 令牌不是本版本的形态:老客户端缓存的旧令牌,或回传路上被改写
    Unrecognized,
    /// 源卷身份变了 = 不是确认时的那张卡(优先级最高:换卡能解释后面所有差异)
    Volume,
    /// 提交的**勾选范围**与确认时那一份不是同一套(R13 C1:与文件集分开定性,
    /// 否则纯前端状态错配会被报成「卡上的文件变了」——把错配说成有人动卡)
    Selection,
    /// 文件集变了:增/删/大小变/落点重新规划
    FileSet,
    /// 文件集一模一样,只有修改时间变了 = 同大小、内容被替换
    ContentReplaced,
}

/// 逐段比对两份摘要,定位变化原因。`approved` 是前端回传的、`fresh` 是现算的。
///
/// 比对顺序 = 解释力从强到弱:换卡 → 换了勾选范围 → 文件集 → 修改时间。
/// 前面的原因能解释后面所有差异,先说它才不会把人引向错误的排查方向。
/// **选择必须排在文件集之前**:勾选范围换了,文件集当然跟着不同,这时候说
/// 「卡上的文件变了」就是在冤枉这张卡。
pub fn classify_plan_change(approved: &str, fresh: &str) -> PlanChange {
    let parse = |s: &str| -> Option<[String; 4]> {
        let parts: Vec<&str> = s.split(':').collect();
        if parts.len() != 5 || parts[0] != PLAN_DIGEST_PREFIX {
            return None;
        }
        Some([
            parts[1].to_string(),
            parts[2].to_string(),
            parts[3].to_string(),
            parts[4].to_string(),
        ])
    };
    // 任一侧形态不对都判「无法识别」:现算的那份形态不对说明代码自身出了问题,
    // 这种时候更不能放行(fail-closed)
    let (Some(a), Some(b)) = (parse(approved), parse(fresh)) else {
        return PlanChange::Unrecognized;
    };
    if a[0] != b[0] {
        PlanChange::Volume
    } else if a[1] != b[1] {
        PlanChange::Selection
    } else if a[2] != b[2] {
        PlanChange::FileSet
    } else if a[3] != b[3] {
        PlanChange::ContentReplaced
    } else {
        PlanChange::None
    }
}

/// 两份计划的逐条差异(全部以 `source_rel` 点名——用户要在卡上找的是它)。
///
/// 只有摘要的话,报错只能说出「哪一类变了」;要说出「多了哪几个」还得有确认时
/// 的那份计划。差异分类彼此互斥,一个文件只会落进一个桶。
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct PlanDiff {
    /// 确认之后卡上多出来的
    pub added: Vec<String>,
    /// 确认时有、现在从卡上消失了的
    pub removed: Vec<String>,
    /// 还在,但大小变了
    pub resized: Vec<String>,
    /// 还在、大小也一样,但落点被重新规划了(多半是新出现的同名文件改了前缀)
    pub retargeted: Vec<String>,
    /// 还在、大小一样、落点一样,只有修改时间变了 —— 同大小内容被替换
    pub retimed: Vec<String>,
}

impl PlanDiff {
    /// 文件集层面有没有变(增/删/大小/落点)。
    pub fn file_set_changed(&self) -> bool {
        !self.added.is_empty()
            || !self.removed.is_empty()
            || !self.resized.is_empty()
            || !self.retargeted.is_empty()
    }

    /// 一处差异都没有(此时摘要若仍不同,差异只可能来自卷身份或勾选范围)。
    pub fn is_empty(&self) -> bool {
        !self.file_set_changed() && self.retimed.is_empty()
    }
}

/// 逐条比对「确认时的计划」与「现在重扫出来的计划」。
pub fn diff_plans(approved: &[PlannedFile], fresh: &[PlannedFile]) -> PlanDiff {
    use std::collections::{HashMap, HashSet};
    let old: HashMap<&str, &PlannedFile> = approved
        .iter()
        .map(|p| (p.source_rel.as_str(), p))
        .collect();
    let mut d = PlanDiff::default();
    for f in fresh {
        match old.get(f.source_rel.as_str()) {
            None => d.added.push(f.source_rel.clone()),
            Some(o) if o.size != f.size => d.resized.push(f.source_rel.clone()),
            Some(o) if o.target_rel != f.target_rel => d.retargeted.push(f.source_rel.clone()),
            // mtime 只在两侧都取得到时才算数:取不到按 0,把「读不到时间」判成
            // 「内容被换了」是纯误报
            Some(o)
                if o.source_mtime_ns != 0
                    && f.source_mtime_ns != 0
                    && o.source_mtime_ns != f.source_mtime_ns =>
            {
                d.retimed.push(f.source_rel.clone())
            }
            Some(_) => {}
        }
    }
    let now: HashSet<&str> = fresh.iter().map(|p| p.source_rel.as_str()).collect();
    for o in approved {
        if !now.contains(o.source_rel.as_str()) {
            d.removed.push(o.source_rel.clone());
        }
    }
    // 报文里的样例必须稳定可复现(同一次拒绝重试两遍不该点名不同的文件)
    d.added.sort();
    d.removed.sort();
    d.resized.sort();
    d.retargeted.sort();
    d.retimed.sort();
    d
}

/// 一个可勾选的源文件夹(相对卷根,`/` 分隔;空串 = 卷根自身)。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SourceFolder {
    pub rel_path: String,
    /// **直接子文件**数(不含子目录内的)
    pub file_count: usize,
    pub total_bytes: u64,
    /// 是否还有子目录(子目录自身另有独立条目)
    pub has_subfolders: bool,
}

/// 把父目录相对路径与条目名拼成相对卷根的路径(父为空串 = 卷根)。
fn join_rel(parent: &str, name: &str) -> String {
    if parent.is_empty() {
        name.to_string()
    } else {
        format!("{parent}/{name}")
    }
}

/// 把 `/` 分隔的相对路径接到根上(空串 = 根自身)。
fn rel_join(root: &Path, rel: &str) -> PathBuf {
    if rel.is_empty() {
        root.to_path_buf()
    } else {
        root.join(rel_to_native(rel))
    }
}

/// 目录读取失败的人话翻译。零静默:源卷半死/无权限时绝不能吞成空列表,
/// 用户会当成「卡是空的」而去格式化。
fn dir_error(rel: &str, dir: &Path, e: &std::io::Error) -> super::CoreError {
    let what = if rel.is_empty() {
        "源卷根目录".to_string()
    } else {
        format!("文件夹「{rel}」")
    };
    let msg = match e.kind() {
        std::io::ErrorKind::NotFound => format!(
            "{what}不存在(卡可能已被拔出,或内容在选择之后发生了变化): {}",
            dir.display()
        ),
        std::io::ErrorKind::PermissionDenied => format!(
            "没有读取{what}的权限,请在系统的隐私/磁盘访问设置中授权 OCard 后重试: {}",
            dir.display()
        ),
        // 选中项其实是文件时报「挂载点断开」会把人引到完全错误的方向
        _ if dir.is_file() => format!("{what}不是文件夹,不能作为拷贝范围: {}", dir.display()),
        _ => format!(
            "读取{what}失败(挂载点可能已断开,建议重新插拔存储卡): {} — {e}",
            dir.display()
        ),
    };
    super::CoreError::Invalid(msg)
}

/// 列文件夹时读不动的目录(权限/ACL 问题)。不让它废掉整个选择器,但**必须**
/// 逐条报到用户面前——残缺的文件夹列表比报错更危险。
///
/// (Windows 格式化留下的 `System Volume Information`/`$RECYCLE.BIN` 从 R11 起
/// 由系统项白名单在打开之前就排除,不会走到这里变成噪声告警。)
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UnreadableFolder {
    pub rel_path: String,
    pub reason: String,
}

/// 列出卷内可勾选的文件夹(含卷根 `""`)。排序:`rel_path` 字典序,卷根恒第一。
/// 只列**含直接子文件**或**含已列出子目录**的,纯空目录树不列——勾了也拷不出
/// 东西,还会把真正的素材夹淹在噪声里。
/// 系统项与符号链接与拷贝口径一致:一律跳过(见 [`is_system_item`]),计数供上层告警。
///
/// 卷根读不动 = 硬错(吞成空列表会被读成「卡是空的」);**子目录**读不动只跳过
/// 该子树,连同原因一起回给调用方去告警——一个带 ACL 的目录不该让整张卡选不了。
pub fn list_source_folders(root: &Path) -> Result<(Vec<SourceFolder>, Vec<UnreadableFolder>)> {
    let mut out = Vec::new();
    let mut bad = Vec::new();
    // 卷根本身失败原样上抛(人话已在 dir_error 里)
    collect_folders(root, "", &mut out, &mut bad)?;
    // "" 在字典序里天然最小,卷根自动排第一
    out.sort_by(|a, b| a.rel_path.cmp(&b.rel_path));
    bad.sort_by(|a, b| a.rel_path.cmp(&b.rel_path));
    Ok((out, bad))
}

/// 返回「本文件夹是否入列」。`has_subfolders` 只在**真有子条目入列**时为 true:
/// 报了却点不出东西,等于骗用户去空文件夹里找素材。
fn collect_folders(
    root: &Path,
    rel: &str,
    out: &mut Vec<SourceFolder>,
    bad: &mut Vec<UnreadableFolder>,
) -> Result<bool> {
    let dir = rel_join(root, rel);
    let mut file_count = 0usize;
    let mut total_bytes = 0u64;
    let mut subs: Vec<String> = Vec::new();
    for entry in fs::read_dir(&dir).map_err(|e| dir_error(rel, &dir, &e))? {
        let entry = entry.map_err(|e| dir_error(rel, &dir, &e))?;
        let name = entry.file_name();
        let name = name.to_string_lossy().to_string();
        if is_system_item(&name) {
            note_system_item_skipped(join_rel(rel, &name));
            continue;
        }
        let ft = entry.file_type().map_err(|e| dir_error(rel, &dir, &e))?;
        if ft.is_symlink() {
            note_symlink_skipped();
            continue;
        }
        let meta = entry.metadata().map_err(|e| dir_error(rel, &dir, &e))?;
        if meta.is_dir() {
            subs.push(join_rel(rel, &name));
        } else if meta.is_file() {
            file_count += 1;
            total_bytes += meta.len();
        }
    }
    let mut has_subfolders = false;
    for sub in subs {
        match collect_folders(root, &sub, out, bad) {
            Ok(listed) => has_subfolders |= listed,
            // 跳过读不动的子树:不入列(勾不了就别显示),但要带原因回去告警
            Err(e) => bad.push(UnreadableFolder {
                rel_path: sub,
                reason: e.to_string(),
            }),
        }
    }
    let listed = file_count > 0 || has_subfolders;
    if listed {
        out.push(SourceFolder {
            rel_path: rel.to_string(),
            file_count,
            total_bytes,
            has_subfolders,
        });
    }
    Ok(listed)
}

/// 列出某个文件夹下的**直接子文件**(不递归)。规则与 `walk` 一致:
/// 跳过系统项([`is_system_item`])与符号链接。
fn list_direct_files(root: &Path, folder: &str) -> Result<Vec<ScannedFile>> {
    let dir = rel_join(root, folder);
    let mut out = Vec::new();
    for entry in fs::read_dir(&dir).map_err(|e| dir_error(folder, &dir, &e))? {
        let entry = entry.map_err(|e| dir_error(folder, &dir, &e))?;
        let name = entry.file_name();
        let name = name.to_string_lossy().to_string();
        if is_system_item(&name) {
            note_system_item_skipped(join_rel(folder, &name));
            continue;
        }
        let ft = entry.file_type().map_err(|e| dir_error(folder, &dir, &e))?;
        if ft.is_symlink() {
            note_symlink_skipped();
            continue;
        }
        let meta = entry.metadata().map_err(|e| dir_error(folder, &dir, &e))?;
        if !meta.is_file() {
            continue;
        }
        out.push(ScannedFile::new(join_rel(folder, &name), &meta));
    }
    Ok(out)
}

/// 把「源相对路径」列表规划成扁平的目标落点,并解决重名。
///
/// 重名规则(用户选定):不改动不冲突的文件名;只给冲突的那些**从最深一级
/// 目录名开始、逐级向上追加**,直到该组内唯一——即「最短可区分前缀」。
/// 例:`100MSDCF/DSC1.JPG` 与 `101MSDCF/DSC1.JPG` → `100MSDCF_DSC1.JPG`
/// 与 `101MSDCF_DSC1.JPG`;若两侧目录名也相同则继续向上取一段。
/// 加完前缀仍与**别的组**撞名时补 `_2`、`_3`(见函数内的全局唯一性兜底)。
///
/// 撞名判定按 [`target_name_key`](大小写 + Unicode NFC 归一):目的地常是
/// APFS/exFAT/SMB,`DSC1.JPG` 与 `dsc1.jpg`、NFC 的 `é.mov` 与 NFD 的 `é.mov`
/// 在那儿都是同一个文件——按字节比较会规划出两个「不冲突」的落点,拷到第二个
/// 时才炸(或同内容时静默并成一个,两个源最终只剩一个目录项)。
///
/// 排序稳定(按 source_rel),保证同一次选择的规划结果可复现——
/// manifest 与断点续传依赖 target_rel 稳定。
pub fn plan_flat_targets(files: &[ScannedFile]) -> (Vec<PlannedFile>, Vec<RenamedFile>) {
    use std::collections::{HashMap, HashSet};

    let mut by_name: HashMap<String, Vec<&str>> = HashMap::new();
    for f in files {
        by_name
            .entry(target_name_key(base_name(&f.rel)))
            .or_default()
            .push(&f.rel);
    }

    let mut planned = Vec::with_capacity(files.len());

    for f in files {
        let rel = &f.rel;
        let base = base_name(rel);
        let group = &by_name[&target_name_key(base)];
        if group.len() == 1 {
            planned.push(PlannedFile {
                source_rel: rel.clone(),
                target_rel: base.to_string(),
                size: f.size,
                source_mtime_ns: f.mtime_ns,
            });
            continue;
        }
        // 冲突:逐级向上追加目录名,直到在该组内唯一
        let segs: Vec<&str> = rel.split('/').collect();
        let dirs = &segs[..segs.len().saturating_sub(1)];
        let mut target = base.to_string();
        for depth in 1..=dirs.len() {
            let prefix = dirs[dirs.len() - depth..].join("_");
            let candidate = format!("{prefix}_{base}");
            let unique = group.iter().filter(|other| **other != rel).all(|other| {
                let osegs: Vec<&str> = other.split('/').collect();
                let odirs = &osegs[..osegs.len().saturating_sub(1)];
                if odirs.len() < depth {
                    return true;
                }
                target_name_key(&odirs[odirs.len() - depth..].join("_")) != target_name_key(&prefix)
            });
            target = candidate;
            if unique {
                break;
            }
        }
        planned.push(PlannedFile {
            source_rel: rel.clone(),
            target_rel: target,
            size: f.size,
            source_mtime_ns: f.mtime_ns,
        });
    }

    planned.sort_by(|a, b| a.source_rel.cmp(&b.source_rel));

    // ---- 全局唯一性兜底 ----
    // 分组各自算前缀只保证**组内**唯一,跨组仍可能撞车(卡根本来就有个
    // `100MSDCF_DSC1.JPG`,而 `100MSDCF/DSC1.JPG` 恰好被改写成同名);
    // 更隐蔽的是**没有目录层级可加**的那些(卷根下的 `DSC1.JPG` 与 `dsc1.jpg`):
    // 它们分在同一组、`for depth in 1..=0` 一次都不跑,两者都保留原名 → 折叠后同键。
    //
    // 因此兜底必须覆盖**全部**项,不能像旧实现那样把「一个字没改」的直接 continue
    // ——那些项永不参与冲突消解,规划器会安静地产出两个同键落点,任务开拷即被
    // 引擎预检 Err 掉(还报成「清单被篡改」,把规划器的锅甩给用户)。
    //
    // 优先级:先让「一个字没改」的原名占位(素材名是相机连号,能不改就不改),
    // 同名多个时按 source_rel 序第一个留名;其余(含让位者)统一补 `_2`、`_3`,
    // 并且**必须**进 renamed_files——系统改了名就得明示。
    let mut taken: HashSet<String> = HashSet::with_capacity(planned.len());
    let mut needs_suffix: Vec<usize> = Vec::new();
    for (i, p) in planned.iter().enumerate() {
        if p.target_rel == base_name(&p.source_rel) && taken.insert(target_name_key(&p.target_rel))
        {
            continue; // 原名占位成功,这一项定案
        }
        needs_suffix.push(i);
    }
    for i in needs_suffix {
        let p = &mut planned[i];
        if taken.insert(target_name_key(&p.target_rel)) {
            continue;
        }
        let (stem, ext) = split_ext(&p.target_rel);
        for n in 2.. {
            let candidate = if ext.is_empty() {
                format!("{stem}_{n}")
            } else {
                format!("{stem}_{n}.{ext}")
            };
            if taken.insert(target_name_key(&candidate)) {
                p.target_rel = candidate;
                break;
            }
        }
    }

    // 只有落盘名与原文件名不同的才算「被改写」(契约:清单只含被改写的)
    let renamed = planned
        .iter()
        .filter(|p| p.target_rel != base_name(&p.source_rel))
        .map(|p| RenamedFile {
            source_rel: p.source_rel.clone(),
            target_rel: p.target_rel.clone(),
        })
        .collect();
    (planned, renamed)
}

/// `a/b/c.JPG` → `c.JPG`
pub(crate) fn base_name(rel: &str) -> &str {
    rel.rsplit('/').next().unwrap_or(rel)
}

/// 落点身份键(TargetNameKey):判断「这两个落点在目的地上是不是同一个文件」的
/// **唯一**一把尺子。规划、全计划预检、目标占用检查、`.ocardpart` 保留字检查
/// 四处必须用同一个函数,任何一处用别的口径都会漏出一个静默覆盖/静默合并的洞。
///
/// 两层归一,缺一不可:
/// - **Unicode 规范等价**:macOS 上 `é.mov` 可能是 NFC(U+00E9)也可能是 NFD
///   (`e` + U+0301),两串字节不同,APFS/HFS+ 却视为同一个文件名。不归一就会
///   规划出两个「不冲突」的落点,内容相同时第二个直接复用第一个的物理文件并
///   报 all_verified——**两个源最终只剩一个目录项,用户以为都备份了**。
/// - **Unicode 大小写折叠**:目的地常是 APFS/exFAT/SMB,`DSC1.JPG` 与 `dsc1.jpg`
///   是同一个文件。
///
/// ## 为什么是 case folding 而不是 `to_lowercase()`(R13 P0)
///
/// APFS 的大小写不敏感比较按 **Unicode 折叠**实现,要求 `σ` / `ς` / `Σ` 三者等价。
/// `to_lowercase()` 做不到两件事:
/// 1. `ς`(希腊词尾 sigma)**本来就是小写**,`to_lowercase()` 原样留下它,于是
///    大小写敏感的源卷上 `σ.mov` 与 `ς.mov` 折出两个不同的键;
/// 2. Rust 的 `str::to_lowercase` 还实现了 Final_Sigma 位置规则
///    (`ΟΔΟΣ` → `οδο` + **ς**),同一个名字的大小写变体因此折出不同的键。
///
/// 两条都与刚修的 NFC 那条**完全同形**:两遍唯一性与全计划预检都认为它们不同,
/// 内容相同时第二项复用第一项的物理文件并报 `all_verified`,两个源只落一个目录项。
///
/// 用的是 Unicode **默认(full)大小写折叠**(CaseFolding.txt 的 C + F 类,
/// `caseless::default_case_fold_str`),不是 simple 折叠:full 会把 `ß` → `ss`、
/// `ﬁ` → `fi` 这类一对多映射也折平。方向上 full 比 simple **更容易判成同名**,
/// 而本函数的安全方向正是「宁可多判成撞名(多一次可见改名)也不漏判(静默合并)」。
///
/// 顺序按 Unicode 的 canonical caseless matching:先 NFD(折叠表按分解形定义,
/// 且要吃掉 NFC/NFD 的写法差异),再折叠,最后 NFC 收成一个稳定、可比较的键
/// (`NFC(fold(NFD(x)))` 与 `NFD(fold(NFD(x)))` 一一对应,取哪个都行,NFC 更短)。
pub(crate) fn target_name_key(name: &str) -> String {
    use unicode_normalization::UnicodeNormalization;
    let nfd: String = name.nfd().collect();
    let folded = caseless::default_case_fold_str(&nfd);
    folded.nfc().collect()
}

/// 拆主名与扩展名(无扩展名或以点开头时 ext 为空)。
fn split_ext(name: &str) -> (&str, &str) {
    match name.rfind('.') {
        Some(i) if i > 0 => (&name[..i], &name[i + 1..]),
        _ => (name, ""),
    }
}

/// 按选择扫描源。整盘 = 历史行为(递归、保留结构);
/// 选文件夹 = 只取直接子文件、扁平落点(重名按最短前缀区分)。
pub fn scan_selection(
    root: &Path,
    selection: &SourceSelection,
) -> Result<(Vec<PlannedFile>, Vec<RenamedFile>, u64)> {
    match selection {
        SourceSelection::WholeVolume => {
            let files = scan_source(root)?;
            let total = files.iter().map(|f| f.size).sum();
            Ok((plan_whole_volume(&files), Vec::new(), total))
        }
        SourceSelection::Folders(folders) => {
            let mut files = Vec::new();
            for f in folders {
                // 闸放在扫描入口而不是只放在命令层:续传时选择来自可被改写的
                // manifest,`../` 会让复扫越过卷根去读卡外的目录
                if !f.is_empty() && !super::paths::is_safe_rel(f) {
                    return Err(super::CoreError::Invalid(format!(
                        "源文件夹路径非法,拒绝扫描: {f}"
                    )));
                }
                files.extend(list_direct_files(root, f)?);
            }
            files.sort();
            files.dedup();
            let total = files.iter().map(|f| f.size).sum();
            let (planned, renamed) = plan_flat_targets(&files);
            Ok((planned, renamed, total))
        }
    }
}

/// 扫描源:递归列出全部普通文件(相对路径统一 `/` 分隔)。
/// 只跳过明确列举的系统项([`is_system_item`]:`.Trashes`/`.fseventsd`/
/// `System Volume Information` …),**其余点开头的条目照拷**——卡上的 `.clip.mov`
/// 是素材,不是垃圾;符号链接不跟随(存储卡不产生合法链接),跳过并计数供上层告警。
pub fn scan_source(root: &Path) -> Result<Vec<ScannedFile>> {
    let mut out = Vec::new();
    walk(root, root, &mut out)?;
    out.sort();
    Ok(out)
}

/// 把 `dir` 下的条目相对 `root` 表述成 `/` 分隔的相对路径。
fn rel_of(root: &Path, path: &Path) -> String {
    path.strip_prefix(root)
        .unwrap_or(path)
        .components()
        .map(|c| c.as_os_str().to_string_lossy())
        .collect::<Vec<_>>()
        .join("/")
}

fn walk(root: &Path, dir: &Path, out: &mut Vec<ScannedFile>) -> Result<()> {
    for entry in fs::read_dir(dir)? {
        let entry = entry?;
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if is_system_item(&name) {
            note_system_item_skipped(rel_of(root, &entry.path()));
            continue;
        }
        let path = entry.path();
        // file_type() 不跟随链接;链接一律跳过+计数(跟随会把根外树卷进来或死循环)
        let ft = entry.file_type()?;
        if ft.is_symlink() {
            note_symlink_skipped();
            continue;
        }
        let meta = entry.metadata()?;
        if meta.is_dir() {
            walk(root, &path, out)?;
        } else if meta.is_file() {
            out.push(ScannedFile::new(rel_of(root, &path), &meta));
        }
    }
    Ok(())
}

/// 轻量完成预判(UI 快照/任务重建用):只看 manifest 与目的地存在+尺寸,
/// **不做哈希**——权威裁决只在引擎的 [`file_done`] 一处(R5:消除预统计与
/// 正式复制的双重全量哈希)。`rel` 是**目标**相对路径(与 manifest 同口径)。
pub fn file_done_light(m: &CopyManifest, rel: &str, size: u64, destinations: &[PathBuf]) -> bool {
    if !m.is_done(rel, size) {
        return false;
    }
    destinations.iter().all(|d| {
        let p = d.join(rel_to_native(rel));
        !super::paths::is_symlink(&p)
            && fs::metadata(&p)
                .map(|meta| meta.is_file() && meta.len() == size)
                .unwrap_or(false)
    })
}

/// 续传跳过的一次性裁决(R4 哈希重验 → R5 终审收口):manifest 已验证 **且**
/// - **源**:非链接、canonical 在源根内、xxh3 与清单一致(R5:源被同大小
///   篡改时旧目标虽与清单一致,但新内容会被漏拷——必须重拷并走冲突可见);
/// - **每个目的地**:目的地根非链接、目标 canonical 在该根内(中间祖先链接
///   同拒)、非链接、尺寸一致、绕缓存回读 xxh3 与清单一致。
///
/// 清单条目一律按**目标**相对路径认(扁平化后源与目标不同名,断点续传的
/// 身份必须是落盘位置,否则改了名的文件每次续传都会被判成没拷过)。
///
/// 任何一条不满足=不算完成,引擎按正常路径重拷(既有目标不同内容=可见冲突)。
pub fn file_done(
    m: &CopyManifest,
    source_root: &Path,
    source_rel: &str,
    target_rel: &str,
    size: u64,
    destinations: &[PathBuf],
) -> bool {
    let Some(entry) = m
        .entries
        .iter()
        .find(|e| e.rel_path == target_rel && e.verified && e.size == size)
    else {
        return false;
    };
    let src = source_root.join(rel_to_native(source_rel));
    if super::paths::is_symlink(&src) || super::paths::assert_within(source_root, &src).is_err() {
        return false;
    }
    let src_ok = hash::xxh3_file(&src)
        .map(|h| h == entry.xxh3)
        .unwrap_or(false);
    if !src_ok {
        return false;
    }
    destinations.iter().all(|d| {
        if super::paths::is_symlink(d) {
            return false;
        }
        let p = d.join(rel_to_native(target_rel));
        // R5:中间祖先链接同样拒(canonical 断言),不只看末节点
        if super::paths::is_symlink(&p) || super::paths::assert_within(d, &p).is_err() {
            return false;
        }
        let size_ok = fs::metadata(&p)
            .map(|meta| meta.is_file() && meta.len() == size)
            .unwrap_or(false);
        if !size_ok {
            return false;
        }
        hash::xxh3_file_uncached(&p)
            .map(|h| h == entry.xxh3)
            .unwrap_or(false)
    })
}

/// 执行拷卡。`plan` 为调用方预先规划好的清单(与 UI 快照/manifest 同源,
/// 避免两次扫描产生分歧):每项自带**源**相对路径与**目标**相对路径,
/// 整卷时两者相同,选文件夹扁平化时两者分离。
/// `project_root` 用于逐文件持久化 manifest(断点续传依据)。
/// 回调返回 [`CopyControl::Pause`] 时在当前文件完成后停下,manifest 保证可续传。
pub fn run_copy(
    req: &CopyRequest,
    plan: &[PlannedFile],
    m: &mut CopyManifest,
    project_root: &Path,
    mut progress: impl FnMut(Progress) -> CopyControl,
) -> Result<CopyOutcome> {
    assert!(!req.destinations.is_empty(), "至少需要一个目的地");
    // 全计划预检,闸先于任何副作用:清单可能来自被改写的 manifest。
    // ① 落点必须两两不同(按目的地文件系统的大小写口径):两项共用一个落点时,
    //    第二项会被续传判定当成「已完成」跳过,整批却仍报完成 = 静默漏拷;
    // ② 落点不许占用引擎内部的 `.ocardpart` 命名空间:临时文件与正式文件同目录,
    //    别人的正式文件正好叫某项的 part 名时,会被那项的残留清理删掉。
    {
        // 保留字与判重都走同一把尺子 [`target_name_key`]:目的地大小写/NFC 不敏感时,
        // `FOO.OCARDPART` 与 `foo.ocardpart` 是同一个名字,只按字节比会漏。
        let part_key = target_name_key(PART_SUFFIX);
        let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
        for p in plan {
            if target_name_key(&p.target_rel).ends_with(&part_key) {
                return Err(super::CoreError::Invalid(format!(
                    "清单落点占用了引擎内部临时后缀 {PART_SUFFIX},拒绝执行: {}",
                    p.target_rel
                )));
            }
            if !seen.insert(target_name_key(&p.target_rel)) {
                return Err(super::CoreError::Invalid(format!(
                    "清单里有两个文件规划到同一个落点,拒绝执行(会互相覆盖): {}",
                    p.target_rel
                )));
            }
        }
    }
    let total_bytes: u64 = plan.iter().map(|p| p.size).sum();
    let mut control = progress(Progress::Scanned {
        total_files: plan.len(),
        total_bytes,
    });

    let mut reports = Vec::with_capacity(plan.len());
    let mut bytes_copied = 0u64;
    let mut paused = false;
    // 连续 IO 失败视为基础设施故障(NAS 断连),转入暂停而非全部标失败(评审复核 P1)
    let mut consecutive_io = 0usize;
    // 写清单被占用后重试成功的总轮数(结果是对的,但要报给用户看,见 CopyOutcome)
    let mut write_retries = 0u32;
    // 素材文件落位改名被占用后重试的总轮数(同上,但这条是素材,更要紧)
    let mut material_retries = 0u32;
    // 租约丢了(或马上要丢):从此一个字节都不许再写进清单
    let mut abort_writes = false;
    let mut aborted = false;
    let total = plan.len();

    for (index, item) in plan.iter().enumerate() {
        let (src_rel, rel, size) = (&item.source_rel, &item.target_rel, item.size);
        if control == CopyControl::Abort {
            aborted = true;
            break;
        }
        if control == CopyControl::Pause {
            paused = true;
            break;
        }
        // 本文件素材落位的占用记录(累加进 material_retries 并逐次上报)
        let mut file_tally = ContentionTally::default();
        control = progress(Progress::FileStarted {
            rel_path: rel,
            index,
            total,
        });
        if control == CopyControl::Pause {
            paused = true;
            break;
        }

        // 清单来自持久化存储(NAS 上可被改写):源路径必须仍落在用户当初勾选的
        // 范围内,否则等于拿旧任务的授权去读别处的文件——拒绝并可见记为失败
        let status = if !req.selection.allows(src_rel, rel) {
            FileStatus::Failed(format!(
                "清单项与本次源选择不符,拒绝执行: {src_rel} → {rel}(任务清单可能已损坏或被篡改,请重新发起拷贝)"
            ))
        } else {
            // R5 三票 P1:时间戳快照在 file_done 的源哈希**之前**采集——
            // 修复目标场景里,验证读同样会刷新源 atime
            let pre_meta = fs::metadata(req.source_root.join(rel_to_native(src_rel))).ok();
            if file_done(m, &req.source_root, src_rel, rel, size, &req.destinations) {
                FileStatus::SkippedResume
            } else {
                match copy_one(
                    &req.source_root,
                    src_rel,
                    rel,
                    pre_meta,
                    &req.destinations,
                    &req.task_tag,
                    &mut |delta| {
                        // 块级进度只上报,普通暂停不在文件中途停;但租约 Abort 要在
                        // 块边界就停——接管方已经在拷同一份计划,把手上这个几十 GB
                        // 的文件拷完只会和它互删 part、刷一串假失败
                        if progress(Progress::BytesCopied {
                            rel_path: rel,
                            delta,
                        }) == CopyControl::Abort
                        {
                            abort_writes = true;
                            return false;
                        }
                        true
                    },
                    &mut file_tally,
                ) {
                    Ok(xxh3) => {
                        consecutive_io = 0;
                        m.upsert(ManifestEntry {
                            rel_path: rel.clone(),
                            size,
                            xxh3,
                            verified: true,
                        });
                        bytes_copied += size;
                        FileStatus::Copied
                    }
                    Err(e) => {
                        if e.is_io() {
                            consecutive_io += 1;
                        } else {
                            consecutive_io = 0;
                        }
                        m.upsert(ManifestEntry {
                            rel_path: rel.clone(),
                            size,
                            xxh3: String::new(),
                            verified: false,
                        });
                        FileStatus::Failed(e.to_string())
                    }
                }
            }
        };
        if file_tally.retries > 0 {
            material_retries += file_tally.retries;
            // 报被占的那个文件;拿不到(不该发生)就退回目的地根,总好过空串
            let fallback = req.destinations.first().cloned().unwrap_or_default();
            let path = file_tally.last_path.as_deref().unwrap_or(&fallback);
            let _ = progress(Progress::Contention {
                kind: ContentionKind::Material,
                path,
                retries: file_tally.retries,
            });
        }
        if abort_writes
            || control == CopyControl::Abort
            || progress(Progress::AboutToSave { rel_path: rel }) == CopyControl::Abort
        {
            // 这个文件的结果仍要进 reports(它已经拷完/失败了,审计要记),只是不落盘
            reports.push(FileReport {
                rel_path: rel.clone(),
                source_rel: src_rel.clone(),
                size,
                status,
            });
            aborted = true;
            break;
        }
        // 逐文件落盘,任意时刻中断都可续传
        let (wr, mpath) = manifest::save(project_root, m)?;
        if wr.retries > 0 {
            write_retries += wr.retries;
            // 零静默:第一次就报,不等任务结束(见 Progress::WriteContention)
            let _ = progress(Progress::Contention {
                kind: ContentionKind::Manifest,
                path: &mpath,
                retries: wr.retries,
            });
        }
        control = progress(Progress::FileFinished {
            rel_path: rel,
            status: &status,
        });
        reports.push(FileReport {
            rel_path: rel.clone(),
            source_rel: src_rel.clone(),
            size,
            status,
        });
        if consecutive_io >= 3 {
            paused = true;
            break;
        }
    }

    let all_verified = !paused
        && !aborted
        && reports.len() == total
        && !reports.is_empty()
        && reports
            .iter()
            .all(|r| !matches!(r.status, FileStatus::Failed(_)));
    m.completed = all_verified;
    if aborted
        || abort_writes
        || progress(Progress::AboutToSave { rel_path: "" }) == CopyControl::Abort
    {
        return Ok(CopyOutcome {
            files: reports,
            bytes_copied,
            all_verified: false,
            paused: true,
            aborted: true,
            write_retries,
            material_retries,
        });
    }
    let (wr, mpath) = manifest::save(project_root, m)?;
    if wr.retries > 0 {
        write_retries += wr.retries;
        let _ = progress(Progress::Contention {
            kind: ContentionKind::Manifest,
            path: &mpath,
            retries: wr.retries,
        });
    }

    Ok(CopyOutcome {
        files: reports,
        bytes_copied,
        all_verified,
        paused,
        aborted: false,
        write_retries,
        material_retries,
    })
}

/// 因租约原因停机时的错误:`Busy` → 任务落「暂停」,可续传。
/// `copy_one` 在块边界用它中止当前文件;`run_worker` 在收尾(审计、总账)跑完之后
/// 用它把任务落到「暂停」——中途不用它掀桌子,不然已失败文件的记录就没了。
pub fn lease_abort() -> super::CoreError {
    super::CoreError::Busy(
        "本任务的租约已不再由本进程持有(或心跳久未成功、随时会被接管),已在文件边界停下并放弃写回清单——继续写会把接管方记下的进度整份顶掉。请确认另一处的进度后再决定在哪边续传".into(),
    )
}

/// 拷贝单个文件到全部目的地。核心安全语义(评审 F1/P0-2):
/// **绝不覆盖已存在的最终文件**——目标已存在时比对哈希:
/// 内容相同视为该目的地已完成(复用),内容不同报 Conflict 交人工裁决。
/// 临时文件名带任务标识,杜绝跨任务/跨工作站互写。
/// 流程:读一次源、边读边算哈希、写缺失目的地的临时文件,
/// 逐目的地回读校验,全部通过后统一改名。返回源文件 xxh3。
// 参数确实多,但每一个都是这一步真正需要的输入,打包成结构体只会多一层间接;
// 唯一的「新增」是 retried,而它是零静默要求的出参。
#[allow(clippy::too_many_arguments)]
fn copy_one(
    source_root: &Path,
    source_rel: &str,
    target_rel: &str,
    src_meta: Option<fs::Metadata>,
    destinations: &[PathBuf],
    task_tag: &str,
    // 每写完一块调一次;返回 false = 立刻停(租约 Abort),part 由失败清理路径删掉
    on_chunk: &mut dyn FnMut(u64) -> bool,
    // 素材落位时为躲开占用而重试的记录,累加进来(零静默:上层要报给用户看)
    retried: &mut ContentionTally,
) -> Result<String> {
    // R2 P0:两条 rel 都可能来自持久化清单(resume),被篡改为 `../../…` 即任意
    // 读写——源侧越界=任意读,目标侧越界=任意写,两侧都必须过闸。
    // 引擎层兜底闸:非法相对路径直接拒绝(入口处 resume 合并另有前置校验)。
    for rel in [source_rel, target_rel] {
        if !super::paths::is_safe_rel(rel) {
            return Err(super::CoreError::Invalid(format!(
                "清单相对路径非法,拒绝执行: {rel}"
            )));
        }
    }
    let src_path = source_root.join(rel_to_native(source_rel));
    // 扫描已跳过链接;这里再挡一道(清单项可能指向后来被替换成链接的路径)
    if super::paths::is_symlink(&src_path) {
        return Err(super::CoreError::Invalid(format!(
            "源文件是符号链接,拒绝拷贝: {source_rel}"
        )));
    }
    // R4(终审 P0-2):末节点检查挡不住**祖先**链接(DCIM → 外部目录时,
    // planned 项经 resume 并回后仍会读到卡外)——canonical 断言真实位置在源根内
    super::paths::assert_within_core(source_root, &src_path)?;

    // 时间戳快照由调用方在 file_done 源哈希之前采集传入(R5 三票 P1);
    // 获取失败计入保留失败聚合告警
    if src_meta.is_none() {
        super::fsx::note_times_preserve_failures(destinations.len() as u64);
    }

    // 落点用**目标** rel:扁平化后它与源路径不同(通常只是文件名)
    let finals: Vec<PathBuf> = destinations
        .iter()
        .map(|d| d.join(rel_to_native(target_rel)))
        .collect();

    // 目的地已有同名最终文件 → 先算源哈希,再逐一比对。
    // R4(终审 P0-2):裁决前先过闸——既有目标是链接或实际位置在目的地根外时,
    // 经链接 exists/hash 会把外部文件误当包内既有文件采信
    for (i, f) in finals.iter().enumerate() {
        if f.exists() {
            if super::paths::is_symlink(f) {
                return Err(super::CoreError::Invalid(format!(
                    "目标位置是符号链接,拒绝采信/写入: {}",
                    f.display()
                )));
            }
            super::paths::assert_within_core(&destinations[i], f)?;
        }
    }
    let pre_existing: Vec<usize> = finals
        .iter()
        .enumerate()
        .filter(|(_, f)| f.exists())
        .map(|(i, _)| i)
        .collect();

    let mut known_src_hash: Option<String> = None;
    if !pre_existing.is_empty() {
        let src_hash = hash::xxh3_file(&src_path)?;
        for &i in &pre_existing {
            let existing_hash = hash::xxh3_file(&finals[i])?;
            if existing_hash != src_hash {
                return Err(super::CoreError::Invalid(format!(
                    "目标已存在且内容不同,拒绝覆盖: {} (源 {src_hash} / 已有 {existing_hash})。\
                     可能是同名重复拷卡,请人工核对",
                    finals[i].display()
                )));
            }
        }
        if pre_existing.len() == finals.len() {
            // 所有目的地都已有同内容文件:无需写入;顺带清理本任务可能的残留 part(终验 #4)
            for f in &finals {
                let _ = fs::remove_file(f.with_file_name(format!(
                    "{}.{task_tag}{PART_SUFFIX}",
                    f.file_name().unwrap().to_string_lossy()
                )));
            }
            on_chunk(fs::metadata(&src_path)?.len());
            return Ok(src_hash);
        }
        known_src_hash = Some(src_hash);
    }

    // 只为缺失的目的地写临时文件
    let missing: Vec<usize> = (0..finals.len())
        .filter(|i| !pre_existing.contains(i))
        .collect();
    let parts: Vec<PathBuf> = missing
        .iter()
        .map(|&i| {
            finals[i].with_file_name(format!(
                "{}.{task_tag}{PART_SUFFIX}",
                finals[i].file_name().unwrap().to_string_lossy()
            ))
        })
        .collect();

    let mut src = File::open(&src_path)?;
    let result = (|| -> Result<String> {
        let mut writers = Vec::with_capacity(parts.len());
        for (part, &i) in parts.iter().zip(&missing) {
            if let Some(parent) = part.parent() {
                // R2 P0:目的地中间目录可能被预置为符号链接,把写入导向根外——
                // 走 canonicalize 落地闸(闸在副作用之前),不再裸 create_dir_all。
                // 目的地根是任务级已验证的用户目标(validate_dest_layout),
                // 可能尚不存在:拒链接后创建,再对根下段落闸
                let root = &destinations[i];
                if super::paths::is_symlink(root) {
                    return Err(super::CoreError::Invalid(format!(
                        "目的地根是符号链接,拒绝写入: {}",
                        root.display()
                    )));
                }
                fs::create_dir_all(root)?;
                super::paths::ensure_dir_within_core(root, parent)?;
            }
            // 同任务崩溃残留的 part 是自己的,清掉;create_new 拦截跨任务冲突
            let _ = fs::remove_file(part);
            writers.push(
                fs::OpenOptions::new()
                    .write(true)
                    .create_new(true)
                    .open(part)?,
            );
        }

        let mut hasher = xxhash_rust::xxh3::Xxh3::new();
        let mut buf = vec![0u8; BUF_SIZE];
        loop {
            let n = src.read(&mut buf)?;
            if n == 0 {
                break;
            }
            hasher.update(&buf[..n]);
            for w in &mut writers {
                w.write_all(&buf[..n])?;
            }
            if !on_chunk(n as u64) {
                return Err(lease_abort());
            }
        }
        for mut w in writers {
            w.flush()?;
            w.sync_all()?;
        }
        let src_hash = format!("{:016x}", hasher.digest());
        if let Some(known) = &known_src_hash {
            if known != &src_hash {
                return Err(super::CoreError::Invalid(format!(
                    "源文件在两次读取之间发生变化: {source_rel}"
                )));
            }
        }

        // 逐目的地回读校验(绕页缓存,尽量读介质而非内存,M2 技术债)
        for part in &parts {
            let dest_hash = hash::xxh3_file_uncached(part)?;
            if dest_hash != src_hash {
                return Err(super::CoreError::Invalid(format!(
                    "校验不一致: {} (源 {src_hash} / 目标 {dest_hash})",
                    part.display()
                )));
            }
        }
        // 全部通过,原子防覆盖落位;落位后保留源时间戳
        // (mtime/atime 三平台;创建时间 mac/win——用户明确要求,Linux btime
        //  不可设置为声明边界;失败计数聚合为可见 warning,不阻塞拷贝;
        //  快照在读源之前采集,见 copy_one 开头)
        for (part, &i) in parts.iter().zip(&missing) {
            finalize_no_replace(part, &finals[i], retried)?;
            if let Some(m) = &src_meta {
                super::fsx::preserve_times_counted(m, &finals[i]);
            }
        }
        Ok(src_hash)
    })();

    if result.is_err() {
        for part in &parts {
            let _ = fs::remove_file(part);
        }
    }
    result
}

/// 原子防覆盖落位(评审复核 P0:`rename` 会替换已存在目标,check→rename 有竞态窗口)。
/// 优先 `hard_link`:目标已存在时原子失败,不可能覆盖;成功后删除 part 名。
/// 文件系统不支持硬链接(部分 SMB/exFAT)时回退「存在性复查 + rename」,
/// 该回退窗口为微秒级且长窗口已被入口 pre_existing 检查夹住。
fn finalize_no_replace(part: &Path, fin: &Path, retried: &mut ContentionTally) -> Result<()> {
    // 平台原生 no-replace 原子改名(renamex_np/renameat2/MoveFileEx),
    // 逐级回退见 fsx 模块(M2 技术债:替代此前的 hard_link 方案)。
    //
    // **占用重试**:这里撞的是与 `manifest::save` 完全相同的 Windows 根因——
    // `.ocardpart` 是刚写完刚关闭的新文件,实时杀毒软件正是这时候扑上去扫它,
    // 改名就报 ACCESS_DENIED(5)/SHARING_VIOLATION(32)。而这条路径上的是**素材
    // 文件**,比清单更要紧:连撞三次才转暂停,中间那两个文件会被标成失败。
    //
    // `AlreadyExists` 绝不重试:那是「目标已经被别人写了」,重试等于不停去撞
    // 同一堵墙,而这堵墙本身就是零覆盖保障。
    match super::fsx::retry_contended(|| super::fsx::rename_no_replace(part, fin)) {
        Ok(retries) => {
            if retries > 0 {
                retried.retries += retries;
                retried.last_path = Some(fin.to_path_buf());
            }
            Ok(())
        }
        Err(f) if f.source.kind() == std::io::ErrorKind::AlreadyExists => {
            Err(super::CoreError::Invalid(format!(
                "目标在拷贝期间被其他任务写入,拒绝覆盖: {}",
                fin.display()
            )))
        }
        Err(f) => {
            // 天书报文的另一半:此前这里抛的是裸 Io,逐文件失败原因就是
            // 那句「IO 错误: 拒绝访问。 (os error 5)」
            // 最终失败的轮数**不**进成功总账,路径也**不**记进 last_path:那条总账
            // 的正文说的是「重试后成功、结果不受影响」,多目标时前一个目标成功、
            // 后一个失败,把失败的路径挂在成功的轮数上等于把失败报成成功。
            // 失败自己带着轮数和路径走 FileStatus::Failed 的报文(io_detail_retried)
            Err(super::CoreError::io_detail_retried(
                "把临时文件改名为最终文件",
                fin,
                &f,
            ))
        }
    }
}

/// 把 `/` 分隔的相对路径转为本平台路径。
fn rel_to_native(rel: &str) -> PathBuf {
    rel.split('/').collect()
}

#[cfg(test)]
mod tests {

    fn f(rel: &str) -> ScannedFile {
        ScannedFile {
            rel: rel.to_string(),
            size: 1,
            mtime_ns: 0,
        }
    }

    #[test]
    fn flat_plan_keeps_unique_names_untouched() {
        let (planned, renamed) = plan_flat_targets(&[f("100MSDCF/A.JPG"), f("CLIP/B.MP4")]);
        assert_eq!(planned[0].target_rel, "A.JPG");
        assert_eq!(planned[1].target_rel, "B.MP4");
        // 不冲突就一个字都不改——素材文件名是相机连号,改了就对不上号
        assert!(renamed.is_empty());
    }

    #[test]
    fn flat_plan_disambiguates_only_the_clashing_ones() {
        let (planned, renamed) = plan_flat_targets(&[
            f("100MSDCF/DSC1.JPG"),
            f("101MSDCF/DSC1.JPG"),
            f("100MSDCF/ONLY.JPG"),
        ]);
        let t = |src: &str| {
            planned
                .iter()
                .find(|p| p.source_rel == src)
                .unwrap()
                .target_rel
                .clone()
        };
        assert_eq!(t("100MSDCF/DSC1.JPG"), "100MSDCF_DSC1.JPG");
        assert_eq!(t("101MSDCF/DSC1.JPG"), "101MSDCF_DSC1.JPG");
        // 没冲突的保持原名
        assert_eq!(t("100MSDCF/ONLY.JPG"), "ONLY.JPG");
        // 只有被改写的进入回执清单(要显式告诉用户)
        assert_eq!(renamed.len(), 2);
    }

    #[test]
    fn flat_plan_walks_further_up_when_parent_names_also_collide() {
        // 两侧最深一级目录名都叫 CLIP:加一级还撞,必须继续向上取
        let (planned, _) = plan_flat_targets(&[f("A/CLIP/C1.MP4"), f("B/CLIP/C1.MP4")]);
        let t: Vec<&str> = planned.iter().map(|p| p.target_rel.as_str()).collect();
        assert_eq!(t, vec!["A_CLIP_C1.MP4", "B_CLIP_C1.MP4"]);
        // 关键:两个落点必须互不相同,否则就是覆盖
        assert_ne!(planned[0].target_rel, planned[1].target_rel);
    }

    #[test]
    fn flat_plan_is_deterministic() {
        // 断点续传按 target_rel 认文件:同一组输入必须每次规划出同样的结果
        let input = [f("B/x.JPG"), f("A/x.JPG"), f("A/y.JPG")];
        let (p1, _) = plan_flat_targets(&input);
        let (p2, _) = plan_flat_targets(&input);
        assert_eq!(p1, p2);
    }

    #[test]
    fn scan_selection_takes_direct_children_only() {
        let tmp = tempdir().unwrap();
        let root = tmp.path();
        std::fs::create_dir_all(root.join("CLIP/SUB")).unwrap();
        std::fs::write(root.join("CLIP/a.mp4"), b"aa").unwrap();
        std::fs::write(root.join("CLIP/SUB/deep.mp4"), b"bbb").unwrap();
        std::fs::write(root.join("other.txt"), b"c").unwrap();

        let (planned, renamed, total) =
            scan_selection(root, &SourceSelection::Folders(vec!["CLIP".into()])).unwrap();
        // 子目录不递归(它自己是另一个可勾选项),卷根的文件也不带进来
        assert_eq!(planned.len(), 1);
        assert_eq!(planned[0].source_rel, "CLIP/a.mp4");
        assert_eq!(planned[0].target_rel, "a.mp4");
        assert_eq!(total, 2);
        assert!(renamed.is_empty());
    }

    #[test]
    fn scan_selection_whole_volume_keeps_structure() {
        let tmp = tempdir().unwrap();
        let root = tmp.path();
        std::fs::create_dir_all(root.join("DCIM/100")).unwrap();
        std::fs::write(root.join("DCIM/100/a.jpg"), b"a").unwrap();

        let (planned, renamed, _) = scan_selection(root, &SourceSelection::WholeVolume).unwrap();
        // 整盘仍是历史行为:保留目录结构,不改名
        assert_eq!(planned[0].source_rel, "DCIM/100/a.jpg");
        assert_eq!(planned[0].target_rel, "DCIM/100/a.jpg");
        assert!(renamed.is_empty());
    }
    use super::*;
    use tempfile::tempdir;

    /// 造一张模拟存储卡。
    fn make_card(root: &Path) {
        fs::create_dir_all(root.join("DCIM/100MSDCF")).unwrap();
        fs::create_dir_all(root.join(".Trashes")).unwrap();
        fs::write(root.join("DCIM/100MSDCF/IMG_0001.JPG"), vec![1u8; 3000]).unwrap();
        fs::write(root.join("DCIM/100MSDCF/IMG_0002.JPG"), vec![2u8; 5000]).unwrap();
        fs::write(root.join("CLIP0001.MP4"), vec![3u8; 9000]).unwrap();
        fs::write(root.join(".Trashes/junk"), b"x").unwrap();
    }

    fn setup() -> (tempfile::TempDir, CopyRequest, CopyManifest, PathBuf) {
        let tmp = tempdir().unwrap();
        let card = tmp.path().join("card");
        make_card(&card);
        let dest1 = tmp.path().join("nas/2. 原始素材/20260824_A7M4_A_ZS");
        let dest2 = tmp.path().join("backup/20260824_A7M4_A_ZS");
        let project = tmp.path().join("project");
        fs::create_dir_all(&project).unwrap();
        let req = CopyRequest {
            source_root: card,
            destinations: vec![dest1, dest2],
            task_tag: "t1".into(),
            selection: SourceSelection::WholeVolume,
        };
        let m = CopyManifest::new(
            "2. 原始素材/20260824_A7M4_A_ZS",
            "card",
            "A7M4_A_ZS",
            "ZS",
            "",
        );
        (tmp, req, m, project)
    }

    /// 租约丢了之后**一个字节都不许再写进清单**——租约存在的唯一理由就是防这个。
    /// 此前 Lost 只置 pause_requested,当前文件拷完照样 save 一次、收尾再 save 一次,
    /// 把接管方记下的进度整份顶掉;而 task-lease-lost 的报文还向用户承诺「已停下」。
    #[test]
    fn abort_stops_at_the_file_boundary_without_touching_the_manifest() {
        let (_t, req, mut m, project) = setup();
        let plan = plan_whole_volume(&scan_source(&req.source_root).unwrap());
        assert!(plan.len() >= 2, "前置:至少两个文件才谈得上「第一个之后停」");
        let manifest_file = manifest::manifest_dir(&project).join(format!("{}.json", m.id));

        let mut saves_asked = 0usize;
        let out = run_copy(&req, &plan, &mut m, &project, |p| match p {
            // 第一次要写清单的那一刻说「租约没了」
            Progress::AboutToSave { .. } => {
                saves_asked += 1;
                CopyControl::Abort
            }
            _ => CopyControl::Continue,
        })
        .expect("Abort 用 outcome 承载,收尾要照跑,不是 Err");
        assert!(out.aborted && out.paused, "要标成 aborted + paused");
        assert!(!out.all_verified, "中途停下不许报全部通过");
        assert_eq!(
            out.files.len(),
            1,
            "已拷完的那个文件的结果要进 reports(审计靠它)"
        );
        assert_eq!(saves_asked, 1, "必须停在第一次落盘之前");
        assert!(
            !manifest_file.exists(),
            "Abort 之后仍然写了清单——这正是租约要防的整份覆盖"
        );
        // 已经拷好的那个文件不能因此丢:接管方会按哈希重新核对它
        let landed = req.destinations[0].join(&plan[0].target_rel);
        assert!(landed.is_file(), "第一个文件应已落位: {}", landed.display());

        // 对照:没有 Abort 时清单是会写的(否则上面的断言是恒真)
        let (_t2, req2, mut m2, project2) = setup();
        let plan2 = plan_whole_volume(&scan_source(&req2.source_root).unwrap());
        run_copy(&req2, &plan2, &mut m2, &project2, |_| CopyControl::Continue).unwrap();
        assert!(manifest::manifest_dir(&project2)
            .join(format!("{}.json", m2.id))
            .exists());
    }

    /// 在 FileFinished 上才说 Abort:那一次落盘已经发生(它在回调之前),
    /// 但下一个文件的落盘必须停——窗口最多一次,且那一次在 Abort 之前。
    #[test]
    fn abort_at_file_finished_stops_before_the_next_save() {
        let (_t, req, mut m, project) = setup();
        let plan = plan_whole_volume(&scan_source(&req.source_root).unwrap());
        let mut saves = 0usize;
        let out = run_copy(&req, &plan, &mut m, &project, |p| match p {
            Progress::AboutToSave { .. } => {
                saves += 1;
                CopyControl::Continue
            }
            Progress::FileFinished { .. } => CopyControl::Abort,
            _ => CopyControl::Continue,
        })
        .unwrap();
        assert!(out.aborted);
        assert_eq!(saves, 1, "FileFinished 上的 Abort 只允许它之前那一次落盘");
    }

    /// 文件**中途**(块级回调)收到 Abort 也要算数:拷完这个文件后不许落盘。
    #[test]
    fn abort_signalled_mid_file_is_honoured_before_the_next_manifest_write() {
        let (_t, req, mut m, project) = setup();
        let plan = plan_whole_volume(&scan_source(&req.source_root).unwrap());
        let manifest_file = manifest::manifest_dir(&project).join(format!("{}.json", m.id));
        let out = run_copy(&req, &plan, &mut m, &project, |p| match p {
            Progress::BytesCopied { .. } => CopyControl::Abort,
            _ => CopyControl::Continue,
        })
        .unwrap();
        assert!(out.aborted);
        assert!(
            !manifest_file.exists(),
            "文件中途收到 Abort,拷完后仍写了清单"
        );
        // 块边界就停:当前文件按失败记(part 已清),不是拷完
        assert!(
            matches!(
                out.files.first().map(|f| &f.status),
                Some(FileStatus::Failed(_))
            ),
            "中途 Abort 的文件应记为失败并停在块边界: {:?}",
            out.files.first().map(|f| &f.status)
        );
        let part_left = std::fs::read_dir(&req.destinations[0])
            .map(|rd| {
                rd.flatten()
                    .any(|e| e.file_name().to_string_lossy().contains(".ocardpart"))
            })
            .unwrap_or(false);
        assert!(!part_left, "中途停下要清掉自己的 .ocardpart");
    }

    /// 素材落位最终失败时,失败的路径**不许**记进「重试后成功」的总账:多目标时
    /// 前一个目标成功、后一个失败,把失败的路径挂在成功的轮数上等于把失败报成成功。
    #[test]
    #[cfg(unix)]
    fn a_final_finalize_failure_does_not_enter_the_success_tally() {
        use std::os::unix::fs::PermissionsExt;
        if unsafe { libc::geteuid() } == 0 {
            panic!("本测试要求非 root(root 无视权限位,造不出这个场景)");
        }
        let tmp = tempdir().unwrap();
        let src_dir = tmp.path().join("src");
        let dst_dir = tmp.path().join("dst");
        fs::create_dir_all(&src_dir).unwrap();
        fs::create_dir_all(&dst_dir).unwrap();
        let part = src_dir.join("a.ocardpart");
        fs::write(&part, b"x").unwrap();
        // 目标目录不可写:改名进不去,一路重试到底还是失败
        fs::set_permissions(&dst_dir, fs::Permissions::from_mode(0o500)).unwrap();
        let mut tally = ContentionTally::default();
        let r = finalize_no_replace(&part, &dst_dir.join("a.bin"), &mut tally);
        fs::set_permissions(&dst_dir, fs::Permissions::from_mode(0o700)).unwrap();
        assert!(r.is_err());
        assert_eq!(tally.retries, 0, "最终失败的轮数不进成功总账");
        assert!(tally.last_path.is_none(), "失败的路径不许挂在成功总账上");
    }

    #[test]
    fn scan_skips_system_items_and_sorts() {
        let tmp = tempdir().unwrap();
        make_card(tmp.path());
        let files = scan_source(tmp.path()).unwrap();
        let names: Vec<&str> = files.iter().map(|f| f.rel.as_str()).collect();
        assert_eq!(
            names,
            vec![
                "CLIP0001.MP4",
                "DCIM/100MSDCF/IMG_0001.JPG",
                "DCIM/100MSDCF/IMG_0002.JPG"
            ]
        );
    }

    #[test]
    fn copies_to_all_destinations_with_verify() {
        let (_tmp, req, mut m, project) = setup();
        let mut events = 0usize;
        let out = run_copy(
            &req,
            &plan_whole_volume(&scan_source(&req.source_root).unwrap()),
            &mut m,
            &project,
            |_| {
                events += 1;
                CopyControl::Continue
            },
        )
        .unwrap();

        assert!(out.all_verified);
        assert_eq!(out.files.len(), 3);
        assert_eq!(out.bytes_copied, 17000);
        assert!(events >= 7, "Scanned + 每文件 Started/Finished");
        for d in &req.destinations {
            assert!(d.join("DCIM/100MSDCF/IMG_0001.JPG").is_file());
            assert!(d.join("CLIP0001.MP4").is_file());
        }
        // 无残留临时文件
        for d in &req.destinations {
            let mut found_part = false;
            let mut stack = vec![d.clone()];
            while let Some(p) = stack.pop() {
                for e in fs::read_dir(&p).unwrap() {
                    let e = e.unwrap().path();
                    if e.is_dir() {
                        stack.push(e);
                    } else if e.to_string_lossy().ends_with(PART_SUFFIX) {
                        found_part = true;
                    }
                }
            }
            assert!(!found_part);
        }
        // manifest 已完成、全部验证
        let saved = manifest::load(&project, &m.id).unwrap();
        assert!(saved.completed);
        assert!(saved.entries.iter().all(|e| e.verified));
    }

    #[test]
    fn resume_skips_verified_files() {
        let (_tmp, req, mut m, project) = setup();
        run_copy(
            &req,
            &plan_whole_volume(&scan_source(&req.source_root).unwrap()),
            &mut m,
            &project,
            |_| CopyControl::Continue,
        )
        .unwrap();

        // 第二次执行:全部续传跳过,拷贝字节为 0
        let out = run_copy(
            &req,
            &plan_whole_volume(&scan_source(&req.source_root).unwrap()),
            &mut m,
            &project,
            |_| CopyControl::Continue,
        )
        .unwrap();
        assert!(out
            .files
            .iter()
            .all(|f| f.status == FileStatus::SkippedResume));
        assert_eq!(out.bytes_copied, 0);
        assert!(out.all_verified);
    }

    #[test]
    fn same_name_different_content_is_conflict_never_overwrite() {
        // 评审 F1/P0-2 的核心场景:同名不同内容绝不覆盖
        let (_tmp, req, mut m, project) = setup();
        run_copy(
            &req,
            &plan_whole_volume(&scan_source(&req.source_root).unwrap()),
            &mut m,
            &project,
            |_| CopyControl::Continue,
        )
        .unwrap();
        let original = fs::read(req.destinations[0].join("CLIP0001.MP4")).unwrap();

        // 换卡:同名文件、不同内容(相机格式化后计数器重置)
        fs::write(req.source_root.join("CLIP0001.MP4"), vec![9u8; 12000]).unwrap();
        let mut m2 = CopyManifest::new(
            "2. 原始素材/20260824_A7M4_A_ZS",
            "card2",
            "A7M4_A_ZS",
            "ZS",
            "",
        );
        let out = run_copy(
            &req,
            &plan_whole_volume(&scan_source(&req.source_root).unwrap()),
            &mut m2,
            &project,
            |_| CopyControl::Continue,
        )
        .unwrap();

        let clip = out
            .files
            .iter()
            .find(|f| f.rel_path == "CLIP0001.MP4")
            .unwrap();
        assert!(
            matches!(&clip.status, FileStatus::Failed(e) if e.contains("拒绝覆盖")),
            "同名不同内容必须报冲突,实际: {:?}",
            clip.status
        );
        assert!(!out.all_verified, "有冲突绝不能给出可格式化信号");
        // 两个目的地上的旧素材都毫发无损
        for d in &req.destinations {
            assert_eq!(fs::read(d.join("CLIP0001.MP4")).unwrap(), original);
        }
    }

    #[test]
    fn same_name_same_content_reuses_without_rewrite() {
        // 重复拷同一张卡:同内容直接确认,不重写、不报错
        let (_tmp, req, mut m, project) = setup();
        run_copy(
            &req,
            &plan_whole_volume(&scan_source(&req.source_root).unwrap()),
            &mut m,
            &project,
            |_| CopyControl::Continue,
        )
        .unwrap();

        let mut m2 = CopyManifest::new(
            "2. 原始素材/20260824_A7M4_A_ZS",
            "card-again",
            "A7M4_A_ZS",
            "ZS",
            "",
        );
        let out = run_copy(
            &req,
            &plan_whole_volume(&scan_source(&req.source_root).unwrap()),
            &mut m2,
            &project,
            |_| CopyControl::Continue,
        )
        .unwrap();
        assert!(out.all_verified);
        assert!(out.files.iter().all(|f| f.status == FileStatus::Copied));
    }

    #[test]
    fn resume_recopies_when_target_file_deleted() {
        // 评审 H2/P0-1:manifest 说已验证,但备份盘上的文件没了 → 必须补拷,不能假绿灯
        let (_tmp, req, mut m, project) = setup();
        run_copy(
            &req,
            &plan_whole_volume(&scan_source(&req.source_root).unwrap()),
            &mut m,
            &project,
            |_| CopyControl::Continue,
        )
        .unwrap();
        fs::remove_file(req.destinations[1].join("CLIP0001.MP4")).unwrap();

        let out = run_copy(
            &req,
            &plan_whole_volume(&scan_source(&req.source_root).unwrap()),
            &mut m,
            &project,
            |_| CopyControl::Continue,
        )
        .unwrap();
        let clip = out
            .files
            .iter()
            .find(|f| f.rel_path == "CLIP0001.MP4")
            .unwrap();
        assert_eq!(clip.status, FileStatus::Copied, "目标缺失必须重拷而非跳过");
        assert!(req.destinations[1].join("CLIP0001.MP4").is_file());
        assert!(out.all_verified);
    }

    #[test]
    fn write_failure_marks_file_failed_but_continues() {
        let (_tmp, req, mut m, project) = setup();
        // 目标位置被同名目录占据 → 该文件写入失败,其余文件应不受影响
        fs::create_dir_all(req.destinations[0].join("CLIP0001.MP4")).unwrap();

        let out = run_copy(
            &req,
            &plan_whole_volume(&scan_source(&req.source_root).unwrap()),
            &mut m,
            &project,
            |_| CopyControl::Continue,
        )
        .unwrap();
        let clip = out
            .files
            .iter()
            .find(|f| f.rel_path == "CLIP0001.MP4")
            .unwrap();
        assert!(matches!(clip.status, FileStatus::Failed(_)));
        assert!(!out.all_verified);
        // 其他文件不受影响
        assert!(out
            .files
            .iter()
            .filter(|f| f.rel_path != "CLIP0001.MP4")
            .all(|f| f.status == FileStatus::Copied));
        // manifest 里失败文件未验证 → 下次续传会重试
        let saved = manifest::load(&project, &m.id).unwrap();
        let e = saved
            .entries
            .iter()
            .find(|e| e.rel_path == "CLIP0001.MP4")
            .unwrap();
        assert!(!e.verified);
        assert!(!saved.completed);
    }

    #[test]
    fn bytes_progress_covers_all_copied_bytes() {
        let (_tmp, req, mut m, project) = setup();
        let mut bytes = 0u64;
        run_copy(
            &req,
            &plan_whole_volume(&scan_source(&req.source_root).unwrap()),
            &mut m,
            &project,
            |p| {
                if let Progress::BytesCopied { delta, .. } = p {
                    bytes += delta;
                }
                CopyControl::Continue
            },
        )
        .unwrap();
        assert_eq!(bytes, 17000);
    }

    #[test]
    fn pause_stops_at_file_boundary_and_resume_finishes() {
        let (_tmp, req, mut m, project) = setup();
        // 第一个文件完成后请求暂停
        let mut finished = 0usize;
        let out = run_copy(
            &req,
            &plan_whole_volume(&scan_source(&req.source_root).unwrap()),
            &mut m,
            &project,
            |p| {
                if matches!(p, Progress::FileFinished { .. }) {
                    finished += 1;
                    if finished >= 1 {
                        return CopyControl::Pause;
                    }
                }
                CopyControl::Continue
            },
        )
        .unwrap();
        assert!(out.paused);
        assert!(!out.all_verified);
        assert_eq!(out.files.len(), 1);
        let saved = manifest::load(&project, &m.id).unwrap();
        assert!(!saved.completed);

        // 续传:剩余文件补齐,已拷的跳过
        let out2 = run_copy(
            &req,
            &plan_whole_volume(&scan_source(&req.source_root).unwrap()),
            &mut m,
            &project,
            |_| CopyControl::Continue,
        )
        .unwrap();
        assert!(!out2.paused);
        assert!(out2.all_verified);
        assert_eq!(
            out2.files
                .iter()
                .filter(|f| f.status == FileStatus::SkippedResume)
                .count(),
            1
        );
        assert_eq!(
            out2.files
                .iter()
                .filter(|f| f.status == FileStatus::Copied)
                .count(),
            2
        );
    }
}

#[cfg(test)]
mod review_regression_tests {
    use super::*;
    use crate::core::manifest::{self, CopyManifest};
    use tempfile::tempdir;

    fn make_card(root: &Path) {
        fs::create_dir_all(root.join("DCIM")).unwrap();
        fs::write(root.join("DCIM/IMG_0001.JPG"), vec![1u8; 3000]).unwrap();
        fs::write(root.join("DCIM/IMG_0002.JPG"), vec![2u8; 5000]).unwrap();
        fs::write(root.join("CLIP0001.MP4"), vec![3u8; 9000]).unwrap();
    }

    fn setup() -> (tempfile::TempDir, CopyRequest, CopyManifest, PathBuf) {
        let tmp = tempdir().unwrap();
        let card = tmp.path().join("card");
        make_card(&card);
        let req = CopyRequest {
            source_root: card,
            destinations: vec![
                tmp.path().join("nas/target"),
                tmp.path().join("backup/target"),
            ],
            task_tag: "regr".into(),
            selection: SourceSelection::WholeVolume,
        };
        let project = tmp.path().join("project");
        fs::create_dir_all(&project).unwrap();
        let m = CopyManifest::new("target", "card", "X_A_Y", "ZS", "");
        (tmp, req, m, project)
    }

    #[test]
    fn leftover_own_part_is_cleaned_and_recopied() {
        // 复核 #17:同任务崩溃残留的 part 不阻塞重拷,且不残留
        let (_tmp, req, mut m, project) = setup();
        let part_name = format!("CLIP0001.MP4.{}{}", req.task_tag, PART_SUFFIX);
        fs::create_dir_all(&req.destinations[0]).unwrap();
        fs::write(req.destinations[0].join(&part_name), b"stale junk").unwrap();

        let files = scan_source(&req.source_root).unwrap();
        let out = run_copy(&req, &plan_whole_volume(&files), &mut m, &project, |_| {
            CopyControl::Continue
        })
        .unwrap();
        assert!(out.all_verified);
        assert!(!req.destinations[0].join(&part_name).exists());
        assert_eq!(
            fs::read(req.destinations[0].join("CLIP0001.MP4")).unwrap(),
            vec![3u8; 9000]
        );
    }

    #[test]
    fn vanished_planned_file_fails_not_silently_skipped() {
        // 复核 P0:计划内文件从源消失(续传场景)必须显式失败,绝不 all_verified
        let (_tmp, req, mut m, project) = setup();
        let mut files = scan_source(&req.source_root).unwrap();
        files.push(ScannedFile {
            rel: "GONE.MP4".to_string(),
            size: 4242,
            mtime_ns: 0,
        });
        files.sort();

        let out = run_copy(&req, &plan_whole_volume(&files), &mut m, &project, |_| {
            CopyControl::Continue
        })
        .unwrap();
        let gone = out.files.iter().find(|f| f.rel_path == "GONE.MP4").unwrap();
        assert!(matches!(gone.status, FileStatus::Failed(_)));
        assert!(!out.all_verified, "有计划内文件缺失绝不能给可格式化信号");
    }

    #[test]
    fn consecutive_io_failures_pause_instead_of_failing_all() {
        // 复核 P1:目的地不可写(NAS 断连形态)→ 连续 IO 失败转入暂停
        let (tmp, mut req, mut m, project) = setup();
        let blocked = tmp.path().join("blocked-parent");
        fs::write(&blocked, b"i am a file").unwrap();
        req.destinations = vec![blocked.join("sub")];

        let files = scan_source(&req.source_root).unwrap();
        let out = run_copy(&req, &plan_whole_volume(&files), &mut m, &project, |_| {
            CopyControl::Continue
        })
        .unwrap();
        assert!(out.paused, "连续 IO 失败应转入可续传的暂停,而非终态 failed");
        assert!(!out.all_verified);
        let saved = manifest::load(&project, &m.id).unwrap();
        assert!(!saved.completed);
    }

    /// R2 变异复核:删掉 copy_one 落位后的 preserve_times_counted,本测试必红。
    #[test]
    fn copy_preserves_source_mtime_end_to_end() {
        let (_tmp, req, mut m, project) = setup();
        let src = req.source_root.join("CLIP0001.MP4");
        let old = std::time::SystemTime::now() - std::time::Duration::from_secs(86400 * 30);
        let f = fs::OpenOptions::new().write(true).open(&src).unwrap();
        f.set_times(fs::FileTimes::new().set_modified(old)).unwrap();
        drop(f);
        run_copy(
            &req,
            &plan_whole_volume(&scan_source(&req.source_root).unwrap()),
            &mut m,
            &project,
            |_| CopyControl::Continue,
        )
        .unwrap();
        for d in &req.destinations {
            let dm = fs::metadata(d.join("CLIP0001.MP4"))
                .unwrap()
                .modified()
                .unwrap();
            let diff = dm
                .duration_since(old)
                .unwrap_or_else(|e| e.duration())
                .as_secs();
            assert!(diff <= 2, "拷贝产物 mtime 必须保留源值(差 {diff}s)");
        }
    }

    /// R2 P0:扫描不得跟随符号链接(卡外树/链接环),跳过要计数(供告警)。
    #[cfg(unix)]
    #[test]
    fn scan_skips_symlinks_and_counts() {
        let tmp = tempdir().unwrap();
        make_card(tmp.path());
        std::os::unix::fs::symlink(tmp.path().join("DCIM"), tmp.path().join("LINKDIR")).unwrap();
        std::os::unix::fs::symlink(tmp.path().join("CLIP0001.MP4"), tmp.path().join("LINK.MP4"))
            .unwrap();
        let files = scan_source(tmp.path()).unwrap();
        assert!(
            files.iter().all(|f| !f.rel.contains("LINK")),
            "符号链接不得进入拷贝清单: {files:?}"
        );
        assert!(take_scan_symlinks_skipped() >= 2, "跳过必须计数");
    }

    /// R2 P0:清单(可被篡改的持久化输入)里的 `../` 项必须被引擎拒绝,
    /// 且不得在目的地根外产生任何写入。
    /// R3 修订:逃逸源文件必须真实存在,且断言闸缺席时写入实际会落到的
    /// 解析位置——否则源不存在时 File::open 一样失败,断言恒真,
    /// 闸被回退也测不红(R2 点名的恒真机理同型)。
    #[test]
    fn manifest_rel_escape_is_refused_by_engine() {
        let (tmp, req, mut m, project) = setup();
        // card/../escape.bin = tmp/escape.bin,真实存在(与清单里的 size 一致)
        fs::write(tmp.path().join("escape.bin"), b"boom").unwrap();
        let mut files = scan_source(&req.source_root).unwrap();
        files.push(ScannedFile {
            rel: "../escape.bin".into(),
            size: 4,
            mtime_ns: 0,
        });
        let out = run_copy(&req, &plan_whole_volume(&files), &mut m, &project, |_| {
            CopyControl::Continue
        })
        .unwrap();
        assert!(!out.all_verified);
        assert!(
            out.files.iter().any(|f| f.rel_path == "../escape.bin"
                && matches!(f.status, FileStatus::Failed(_))),
            "逃逸项必须记为失败: {:?}",
            out.files
        );
        // dest.join("../escape.bin") 的解析位置:两个目的地根的上一级
        assert!(
            !tmp.path().join("nas/2. 原始素材/escape.bin").exists()
                && !tmp.path().join("backup/escape.bin").exists(),
            "目的地根外不得出现任何写入"
        );
    }

    /// R2 P0:目的地中间目录被预置为符号链接时必须拒写(canonical 落地闸),
    /// 根外目录不得收到文件。
    #[cfg(unix)]
    #[test]
    fn dest_symlinked_middle_dir_is_refused() {
        let (tmp, req, mut m, project) = setup();
        let outside = tmp.path().join("outside");
        fs::create_dir_all(&outside).unwrap();
        fs::create_dir_all(&req.destinations[0]).unwrap();
        std::os::unix::fs::symlink(&outside, req.destinations[0].join("DCIM")).unwrap();
        let out = run_copy(
            &req,
            &plan_whole_volume(&scan_source(&req.source_root).unwrap()),
            &mut m,
            &project,
            |_| CopyControl::Continue,
        )
        .unwrap();
        assert!(!out.all_verified, "经链接的写入必须失败");
        assert!(
            !outside.join("100MSDCF").exists(),
            "不得经符号链接把素材写到目的地根外"
        );
    }

    /// R2 P0:清单项指向符号链接源文件时拒拷(不追踪链接目标)。
    #[cfg(unix)]
    #[test]
    fn symlinked_source_file_is_refused() {
        let (_tmp, req, mut m, project) = setup();
        std::os::unix::fs::symlink(
            req.source_root.join("CLIP0001.MP4"),
            req.source_root.join("ALIAS.MP4"),
        )
        .unwrap();
        let mut files = scan_source(&req.source_root).unwrap();
        assert!(files.iter().all(|f| f.rel != "ALIAS.MP4"), "扫描已跳过");
        files.push(ScannedFile {
            rel: "ALIAS.MP4".into(),
            size: 9000,
            mtime_ns: 0,
        });
        let out = run_copy(&req, &plan_whole_volume(&files), &mut m, &project, |_| {
            CopyControl::Continue
        })
        .unwrap();
        assert!(out
            .files
            .iter()
            .any(|f| f.rel_path == "ALIAS.MP4" && matches!(f.status, FileStatus::Failed(_))));
        assert!(!req.destinations[0].join("ALIAS.MP4").exists());
    }

    /// R4 终审 P0-1:目标被替换成**同大小不同内容**后,file_done 不许再判完成
    /// (只查存在+尺寸的旧实现对这条必绿——哈希重验是变异判别点)。
    #[test]
    fn resume_skip_reverifies_hash_not_just_size() {
        let (_t, req, mut m, project) = setup();
        run_copy(
            &req,
            &plan_whole_volume(&scan_source(&req.source_root).unwrap()),
            &mut m,
            &project,
            |_| CopyControl::Continue,
        )
        .unwrap();
        assert!(file_done(
            &m,
            &req.source_root,
            "CLIP0001.MP4",
            "CLIP0001.MP4",
            9000,
            &req.destinations
        ));
        // 同大小篡改:内容换、长度不变
        let victim = req.destinations[1].join("CLIP0001.MP4");
        let mut bytes = fs::read(&victim).unwrap();
        bytes[0] ^= 0xFF;
        fs::write(&victim, &bytes).unwrap();
        assert!(
            !file_done(
                &m,
                &req.source_root,
                "CLIP0001.MP4",
                "CLIP0001.MP4",
                9000,
                &req.destinations
            ),
            "同大小篡改必须让完成判定失效(哈希重验)"
        );
    }

    /// R5 终审:源文件被**同大小**篡改后,resume 不许再跳过——旧目标与清单
    /// 一致但新内容会被漏拷;file_done 必须重验源哈希。
    #[test]
    fn resume_skip_reverifies_source_hash() {
        let (_t, req, mut m, project) = setup();
        run_copy(
            &req,
            &plan_whole_volume(&scan_source(&req.source_root).unwrap()),
            &mut m,
            &project,
            |_| CopyControl::Continue,
        )
        .unwrap();
        assert!(file_done(
            &m,
            &req.source_root,
            "CLIP0001.MP4",
            "CLIP0001.MP4",
            9000,
            &req.destinations
        ));
        let src = req.source_root.join("CLIP0001.MP4");
        let mut bytes = fs::read(&src).unwrap();
        bytes[100] ^= 0xFF;
        fs::write(&src, &bytes).unwrap();
        assert!(
            !file_done(
                &m,
                &req.source_root,
                "CLIP0001.MP4",
                "CLIP0001.MP4",
                9000,
                &req.destinations
            ),
            "源被同大小篡改后不得跳过(会漏拷新内容)"
        );
    }

    /// R5 终审:目的地**中间祖先**是链接时,file_done 不许把链下文件当已完成。
    #[cfg(unix)]
    #[test]
    fn file_done_rejects_dest_ancestor_symlink() {
        let (tmp, req, mut m, project) = setup();
        run_copy(
            &req,
            &plan_whole_volume(&scan_source(&req.source_root).unwrap()),
            &mut m,
            &project,
            |_| CopyControl::Continue,
        )
        .unwrap();
        let rel = "DCIM/IMG_0001.JPG";
        assert!(
            file_done(&m, &req.source_root, rel, rel, 3000, &req.destinations),
            "基线:正常拷完必须判完成"
        );
        // 把 dest0 的 DCIM 换成指向外部同构树的链接(链下同内容文件)
        let outside = tmp.path().join("outside-tree");
        fs::create_dir_all(&outside).unwrap();
        fs::copy(req.destinations[0].join(rel), outside.join("IMG_0001.JPG")).unwrap();
        let dcim = req.destinations[0].join("DCIM");
        fs::remove_dir_all(&dcim).unwrap();
        std::os::unix::fs::symlink(&outside, &dcim).unwrap();
        assert!(
            !file_done(&m, &req.source_root, rel, rel, 3000, &req.destinations),
            "目的地中间祖先为链接时不得判完成(经链接读的是外部文件)"
        );
    }

    /// R4 终审 P0-2:源**祖先**目录被换成指向卡外的链接时,清单项必须被拒
    /// (末节点 is_symlink 挡不住这条)。
    #[cfg(unix)]
    #[test]
    fn source_ancestor_symlink_is_refused() {
        let (tmp, req, mut m, project) = setup();
        let outside = tmp.path().join("outside-src");
        fs::create_dir_all(&outside).unwrap();
        fs::write(outside.join("EVIL.MP4"), vec![7u8; 64]).unwrap();
        // 卡上放一个指向卡外的目录链接,清单项穿过它
        std::os::unix::fs::symlink(&outside, req.source_root.join("LINKED")).unwrap();
        let mut files = scan_source(&req.source_root).unwrap();
        files.push(ScannedFile {
            rel: "LINKED/EVIL.MP4".into(),
            size: 64,
            mtime_ns: 0,
        });
        let out = run_copy(&req, &plan_whole_volume(&files), &mut m, &project, |_| {
            CopyControl::Continue
        })
        .unwrap();
        assert!(out
            .files
            .iter()
            .any(|f| f.rel_path == "LINKED/EVIL.MP4" && matches!(f.status, FileStatus::Failed(_))));
        assert!(
            !req.destinations[0].join("LINKED/EVIL.MP4").exists(),
            "卡外文件不得经祖先链接被拷贝"
        );
    }

    /// R4 终审 P0-2:既有目标是符号链接时必须拒绝「采信为已完成」——
    /// 经链接做 exists/hash 会把外部文件误当包内既有文件。
    #[cfg(unix)]
    #[test]
    fn existing_target_via_symlink_is_not_adjudicated() {
        let (tmp, req, mut m, project) = setup();
        let outside = tmp.path().join("outside-dst");
        fs::create_dir_all(&outside).unwrap();
        // 外部同内容文件 + 目的地同名链接指过去(同内容→旧逻辑会静默当已完成)
        fs::write(outside.join("CLIP0001.MP4"), vec![3u8; 9000]).unwrap();
        fs::create_dir_all(&req.destinations[0]).unwrap();
        std::os::unix::fs::symlink(
            outside.join("CLIP0001.MP4"),
            req.destinations[0].join("CLIP0001.MP4"),
        )
        .unwrap();
        let out = run_copy(
            &req,
            &plan_whole_volume(&scan_source(&req.source_root).unwrap()),
            &mut m,
            &project,
            |_| CopyControl::Continue,
        )
        .unwrap();
        assert!(
            out.files
                .iter()
                .any(|f| f.rel_path == "CLIP0001.MP4" && matches!(f.status, FileStatus::Failed(_))),
            "链接目标必须显式失败,不许当作已交付: {:?}",
            out.files
        );
    }
}

/// 「按文件夹多选 + 落盘扁平化」贯通到引擎的回归网。
/// 关注点:源/目标分离、落点锁定后的续传身份、清单被篡改时的 fail-closed。
#[cfg(test)]
mod folder_selection_tests {
    use super::*;
    use crate::core::manifest::{self, CopyManifest};
    use tempfile::tempdir;

    /// 一张两个相机夹、且**跨夹重名**的卡(扁平化的典型冲突场景)。
    fn make_card(root: &Path) {
        fs::create_dir_all(root.join("DCIM/100MSDCF")).unwrap();
        fs::create_dir_all(root.join("DCIM/101MSDCF")).unwrap();
        fs::create_dir_all(root.join("EMPTY")).unwrap();
        fs::write(root.join("DCIM/100MSDCF/DSC1.JPG"), vec![1u8; 1000]).unwrap();
        fs::write(root.join("DCIM/100MSDCF/ONLY.JPG"), vec![2u8; 2000]).unwrap();
        fs::write(root.join("DCIM/101MSDCF/DSC1.JPG"), vec![3u8; 3000]).unwrap();
        fs::write(root.join("ROOT.MP4"), vec![4u8; 4000]).unwrap();
    }

    fn setup(
        selection: SourceSelection,
    ) -> (tempfile::TempDir, CopyRequest, CopyManifest, PathBuf) {
        let tmp = tempdir().unwrap();
        let card = tmp.path().join("card");
        make_card(&card);
        let project = tmp.path().join("project");
        fs::create_dir_all(&project).unwrap();
        let req = CopyRequest {
            source_root: card,
            destinations: vec![tmp.path().join("nas/target"), tmp.path().join("bak/target")],
            task_tag: "fsel".into(),
            selection,
        };
        let m = CopyManifest::new("target", "card", "A7M4_A_ZS", "ZS", "");
        (tmp, req, m, project)
    }

    fn folders(list: &[&str]) -> SourceSelection {
        SourceSelection::Folders(list.iter().map(|s| s.to_string()).collect())
    }

    #[test]
    fn empty_selection_is_whole_volume() {
        // 契约:不传/传空数组 = 整卷(老客户端一个字都不用改)
        assert_eq!(
            SourceSelection::from_folders(Vec::new()),
            SourceSelection::WholeVolume
        );
        let tmp = tempdir().unwrap();
        make_card(tmp.path());
        let (a, _, ta) =
            scan_selection(tmp.path(), &SourceSelection::from_folders(Vec::new())).unwrap();
        let (b, _, tb) = scan_selection(tmp.path(), &SourceSelection::WholeVolume).unwrap();
        assert_eq!(a, b);
        assert_eq!(ta, tb);
        assert!(
            a.iter().all(|p| p.source_rel == p.target_rel),
            "整卷源即目标"
        );
    }

    #[test]
    fn folder_selection_flattens_and_separates_source_from_target() {
        let (_t, req, mut m, project) = setup(folders(&["DCIM/100MSDCF"]));
        let (plan, renamed, total) = scan_selection(&req.source_root, &req.selection).unwrap();
        assert_eq!(total, 3000);
        assert!(renamed.is_empty(), "只勾一个夹子不会撞名");
        m.planned = plan.iter().map(manifest::PlannedFile::from_plan).collect();

        let out = run_copy(&req, &plan, &mut m, &project, |_| CopyControl::Continue).unwrap();
        assert!(out.all_verified);
        for d in &req.destinations {
            // 落盘扁平:不带 DCIM/100MSDCF 这层
            assert!(d.join("DSC1.JPG").is_file());
            assert!(d.join("ONLY.JPG").is_file());
            assert!(!d.join("DCIM").exists(), "不得保留源目录结构");
        }
        // 源路径没被当成目标用,目标路径也没被当成源用
        let saved = manifest::load(&project, &m.id).unwrap();
        let mut keys: Vec<&str> = saved.entries.iter().map(|e| e.rel_path.as_str()).collect();
        keys.sort();
        assert_eq!(keys, vec!["DSC1.JPG", "ONLY.JPG"], "清单键必须是目标落点");
        let p = saved
            .planned
            .iter()
            .find(|p| p.rel_path == "DSC1.JPG")
            .unwrap();
        assert_eq!(p.source(), "DCIM/100MSDCF/DSC1.JPG");
    }

    #[test]
    fn renamed_file_resume_is_recognized_by_target_rel() {
        // 核心断言:落点被改写后,续传要按**目标** rel 认出它已经拷过——
        // 按源 rel 认的话每次续传都会重拷(且第二次会撞上「目标已存在」)
        let (_t, req, mut m, project) = setup(folders(&["DCIM/100MSDCF", "DCIM/101MSDCF"]));
        let (plan, renamed, _) = scan_selection(&req.source_root, &req.selection).unwrap();
        assert_eq!(renamed.len(), 2, "两个 DSC1.JPG 必须都被改写并留痕");
        m.planned = plan.iter().map(manifest::PlannedFile::from_plan).collect();
        m.source_selection = req.selection.to_folders();
        m.renamed_files = renamed.clone();

        let out = run_copy(&req, &plan, &mut m, &project, |_| CopyControl::Continue).unwrap();
        assert!(out.all_verified);
        for d in &req.destinations {
            assert!(d.join("100MSDCF_DSC1.JPG").is_file());
            assert!(d.join("101MSDCF_DSC1.JPG").is_file());
            assert!(d.join("ONLY.JPG").is_file());
        }

        // 续传:同一份锁定的计划再跑一遍,必须全部跳过、零字节
        let saved = manifest::load(&project, &m.id).unwrap();
        let resumed: Vec<PlannedFile> = saved.planned.iter().map(|p| p.to_plan()).collect();
        assert_eq!(resumed, plan, "持久化的计划必须能原样还原");
        let out2 = run_copy(&req, &resumed, &mut m, &project, |_| CopyControl::Continue).unwrap();
        assert!(
            out2.files
                .iter()
                .all(|f| f.status == FileStatus::SkippedResume),
            "改名后的续传必须按目标 rel 认出已完成: {:?}",
            out2.files
        );
        assert_eq!(out2.bytes_copied, 0);
        assert!(out2.all_verified);
    }

    #[test]
    fn plan_item_outside_selection_is_refused() {
        // 清单存在 NAS 上可被改写:把源指到没勾选的夹子 = 拿旧授权读别处的文件
        let (_t, req, mut m, project) = setup(folders(&["DCIM/100MSDCF"]));
        let (mut plan, _, _) = scan_selection(&req.source_root, &req.selection).unwrap();
        plan.push(PlannedFile {
            source_rel: "DCIM/101MSDCF/DSC1.JPG".into(),
            target_rel: "偷渡.JPG".into(),
            size: 3000,
            source_mtime_ns: 0,
        });
        let out = run_copy(&req, &plan, &mut m, &project, |_| CopyControl::Continue).unwrap();
        assert!(
            out.files
                .iter()
                .any(|f| f.rel_path == "偷渡.JPG" && matches!(f.status, FileStatus::Failed(_))),
            "未勾选目录的文件必须显式失败: {:?}",
            out.files
        );
        assert!(!out.all_verified, "有拒绝项绝不能给可格式化信号");
        assert!(!req.destinations[0].join("偷渡.JPG").exists());
    }

    #[test]
    fn whole_volume_plan_must_keep_source_equal_target() {
        // 整卷口径下源≠目标只可能来自清单被动过手脚:拒绝,不许悄悄改落点
        let (_t, req, mut m, project) = setup(SourceSelection::WholeVolume);
        let plan = vec![PlannedFile {
            source_rel: "ROOT.MP4".into(),
            target_rel: "改过的名字.MP4".into(),
            size: 4000,
            source_mtime_ns: 0,
        }];
        let out = run_copy(&req, &plan, &mut m, &project, |_| CopyControl::Continue).unwrap();
        assert!(matches!(out.files[0].status, FileStatus::Failed(_)));
        assert!(!req.destinations[0].join("改过的名字.MP4").exists());
    }

    /// 目标带目录段(越出扁平口径)必须被**选择闸**拒下——这条测的是
    /// `SourceSelection::allows`;`copy_one` 自己的目标侧路径闸另有直击测试
    /// (`copy_one_refuses_escaping_target_rel`)。
    #[test]
    fn target_rel_escape_is_refused_by_engine() {
        let (tmp, req, mut m, project) = setup(folders(&[""]));
        let plan = vec![PlannedFile {
            source_rel: "ROOT.MP4".into(),
            target_rel: "../逃逸.MP4".into(),
            size: 4000,
            source_mtime_ns: 0,
        }];
        let out = run_copy(&req, &plan, &mut m, &project, |_| CopyControl::Continue).unwrap();
        assert!(matches!(out.files[0].status, FileStatus::Failed(_)));
        assert!(
            !tmp.path().join("nas/逃逸.MP4").exists() && !tmp.path().join("bak/逃逸.MP4").exists(),
            "目的地根外不得出现任何写入"
        );
    }

    #[test]
    fn list_source_folders_orders_root_first_and_skips_empty_dirs() {
        let tmp = tempdir().unwrap();
        make_card(tmp.path());
        // 只含空子目录的树同样不该出现:点进去什么都没有
        fs::create_dir_all(tmp.path().join("EMPTY/更空")).unwrap();
        fs::create_dir_all(tmp.path().join(".Trashes")).unwrap();
        fs::write(tmp.path().join(".Trashes/junk"), b"x").unwrap();
        let (list, unreadable) = list_source_folders(tmp.path()).unwrap();
        assert!(unreadable.is_empty(), "正常卡不该有读不动的目录");
        let rels: Vec<&str> = list.iter().map(|f| f.rel_path.as_str()).collect();
        assert_eq!(
            rels,
            vec!["", "DCIM", "DCIM/100MSDCF", "DCIM/101MSDCF"],
            "卷根恒第一、字典序;空目录与隐藏项不列"
        );
        let root = &list[0];
        assert_eq!(root.file_count, 1, "卷根只算直接子文件");
        assert_eq!(root.total_bytes, 4000);
        assert!(root.has_subfolders);
        let dcim = &list[1];
        assert_eq!(dcim.file_count, 0, "DCIM 自身没有直接子文件");
        assert!(dcim.has_subfolders, "只有子目录也要列出来,否则点不进去");
        assert_eq!(list[2].file_count, 2);
        assert_eq!(list[2].total_bytes, 3000);
        assert!(!list[2].has_subfolders);
    }

    /// 修复:分组内各算前缀,**跨组**仍可能撞到同一个落点
    /// (根目录本来就有 `100MSDCF_DSC1.JPG`,而 `100MSDCF/DSC1.JPG` 恰好被改成同名)。
    /// 两个源规划到同一落点 = 后者覆盖前者,必须补序号错开。
    #[test]
    fn cross_group_target_collision_never_lands_on_one_file() {
        let f = |rel: &str| ScannedFile {
            rel: rel.to_string(),
            size: 1,
            mtime_ns: 0,
        };
        let (planned, renamed) = plan_flat_targets(&[
            f("100MSDCF/DSC1.JPG"),
            f("101MSDCF/DSC1.JPG"),
            f("100MSDCF_DSC1.JPG"),
        ]);
        let targets: Vec<&str> = planned.iter().map(|p| p.target_rel.as_str()).collect();
        let uniq: std::collections::HashSet<&&str> = targets.iter().collect();
        assert_eq!(uniq.len(), targets.len(), "落点必须互不相同: {targets:?}");
        // 没被改动的原名优先级最高:卡根那个文件一个字都不改
        let root = planned
            .iter()
            .find(|p| p.source_rel == "100MSDCF_DSC1.JPG")
            .unwrap();
        assert_eq!(root.target_rel, "100MSDCF_DSC1.JPG");
        // 让路的那个补序号,并且必须出现在改名清单里(不许静默)
        let moved = planned
            .iter()
            .find(|p| p.source_rel == "100MSDCF/DSC1.JPG")
            .unwrap();
        assert_eq!(moved.target_rel, "100MSDCF_DSC1_2.JPG");
        assert!(renamed
            .iter()
            .any(|r| r.target_rel == "100MSDCF_DSC1_2.JPG"));
    }

    /// 修复:落盘名与原名相同的不算「被改写」,不能混进改名清单
    /// (契约:`renamed_files` 只含被改写的;否则双确认屏会出现
    ///  「DSC1.JPG → DSC1.JPG」这种没意义还吓人的条目)。
    #[test]
    fn unchanged_name_is_never_reported_as_renamed() {
        let f = |rel: &str| ScannedFile {
            rel: rel.to_string(),
            size: 1,
            mtime_ns: 0,
        };
        // 卡根的 DSC1.JPG 与 100MSDCF/DSC1.JPG 同名:根那个没有目录可加,保持原名
        let (planned, renamed) = plan_flat_targets(&[f("DSC1.JPG"), f("100MSDCF/DSC1.JPG")]);
        let root = planned.iter().find(|p| p.source_rel == "DSC1.JPG").unwrap();
        assert_eq!(root.target_rel, "DSC1.JPG");
        assert_eq!(renamed.len(), 1, "只有真被改名的那个进清单: {renamed:?}");
        assert_eq!(renamed[0].source_rel, "100MSDCF/DSC1.JPG");
        assert_eq!(renamed[0].target_rel, "100MSDCF_DSC1.JPG");
    }

    /// 双路评审 P0/P1:目的地(APFS/exFAT/SMB)通常大小写不敏感,
    /// 按字节判重会规划出两个「不冲突」的落点,拷到第二个时才炸。
    #[test]
    fn case_only_difference_counts_as_a_clash() {
        let f = |rel: &str| ScannedFile {
            rel: rel.to_string(),
            size: 1,
            mtime_ns: 0,
        };
        let (planned, renamed) = plan_flat_targets(&[f("A/DSC1.JPG"), f("B/dsc1.jpg")]);
        let targets: Vec<&str> = planned.iter().map(|p| p.target_rel.as_str()).collect();
        assert_eq!(
            targets,
            vec!["A_DSC1.JPG", "B_dsc1.jpg"],
            "必须当成撞名各自加前缀"
        );
        assert_eq!(renamed.len(), 2, "两个都被改写,都要进清单");
    }

    /// 清单可被改写:两项共用一个落点时,第二项会被续传判定当成「已完成」跳过,
    /// 整批却仍报完成 = 静默漏拷。闸必须在任何副作用之前。
    #[test]
    fn duplicate_targets_in_plan_are_refused_before_any_write() {
        let (_t, req, mut m, project) = setup(folders(&["DCIM/100MSDCF", "DCIM/101MSDCF"]));
        let plan = vec![
            PlannedFile {
                source_rel: "DCIM/100MSDCF/DSC1.JPG".into(),
                target_rel: "X.JPG".into(),
                size: 1000,
                source_mtime_ns: 0,
            },
            PlannedFile {
                source_rel: "DCIM/101MSDCF/DSC1.JPG".into(),
                target_rel: "x.jpg".into(), // 大小写不同 = 同一个落点
                size: 3000,
                source_mtime_ns: 0,
            },
        ];
        let e = run_copy(&req, &plan, &mut m, &project, |_| CopyControl::Continue).unwrap_err();
        assert!(e.to_string().contains("同一个落点"), "{e}");
        assert!(!req.destinations[0].exists(), "拒绝要发生在任何写入之前");
    }

    /// 落点不许占用引擎内部的 `.ocardpart` 命名空间:临时文件与正式文件同目录,
    /// 别人的正式文件正好叫某项的 part 名时会被残留清理删掉。
    #[test]
    fn target_using_internal_part_suffix_is_refused() {
        let (_t, req, mut m, project) = setup(folders(&[""]));
        let plan = vec![PlannedFile {
            source_rel: "ROOT.MP4".into(),
            target_rel: format!("ROOT.MP4.{}{}", req.task_tag, PART_SUFFIX),
            size: 4000,
            source_mtime_ns: 0,
        }];
        let e = run_copy(&req, &plan, &mut m, &project, |_| CopyControl::Continue).unwrap_err();
        assert!(e.to_string().contains(PART_SUFFIX), "{e}");
    }

    /// 目标侧路径闸的**直击**测试:反斜杠段过得了 `allows`(不含 `/`),
    /// 但过不了 `is_safe_rel`——删掉 copy_one 里目标侧那道闸,本测试必红。
    #[test]
    fn copy_one_refuses_escaping_target_rel() {
        let (_t, req, mut m, project) = setup(folders(&[""]));
        let plan = vec![PlannedFile {
            source_rel: "ROOT.MP4".into(),
            target_rel: r"..\逃逸.MP4".into(),
            size: 4000,
            source_mtime_ns: 0,
        }];
        assert!(
            req.selection.allows("ROOT.MP4", r"..\逃逸.MP4"),
            "前置断言:这条要能过选择闸,才谈得上测目标侧路径闸"
        );
        let out = run_copy(&req, &plan, &mut m, &project, |_| CopyControl::Continue).unwrap();
        assert!(
            matches!(&out.files[0].status, FileStatus::Failed(e) if e.contains("清单相对路径非法")),
            "必须被目标侧路径闸拒: {:?}",
            out.files[0].status
        );
    }

    /// 零静默 + 可用性:卡上一个读不动的**素材**目录(权限/ACL 问题)不该让整个
    /// 文件夹选择器不可用,但它必须逐条报出来——不报就等于用户看到一份残缺的
    /// 文件夹列表却不知情。
    ///
    /// R11 起 `System Volume Information` 由系统项白名单在读之前就排除,不再走
    /// 这条路径(顺带也就不会因为它的 ACL 而产生一条噪声告警),所以这里改用
    /// 一个真实相机会用的目录名。
    #[cfg(unix)]
    #[test]
    fn unreadable_subdir_is_skipped_and_reported_not_fatal() {
        use std::os::unix::fs::PermissionsExt;
        let tmp = tempdir().unwrap();
        make_card(tmp.path());
        let locked = tmp.path().join("PRIVATE");
        fs::create_dir_all(&locked).unwrap();
        fs::write(locked.join("inside.bin"), b"x").unwrap();
        fs::set_permissions(&locked, fs::Permissions::from_mode(0o000)).unwrap();
        // 白名单里的 Windows 目录:同样读不动,但压根不该被打开,更不该报成告警
        let svi = tmp.path().join("System Volume Information");
        fs::create_dir_all(&svi).unwrap();
        fs::set_permissions(&svi, fs::Permissions::from_mode(0o000)).unwrap();

        let (list, unreadable) = list_source_folders(tmp.path()).unwrap();
        // 复原权限,别把不可删目录留给 TempDir
        fs::set_permissions(&locked, fs::Permissions::from_mode(0o755)).unwrap();
        fs::set_permissions(&svi, fs::Permissions::from_mode(0o755)).unwrap();

        assert!(
            list.iter().any(|f| f.rel_path == "DCIM/100MSDCF"),
            "其余目录必须照常可选"
        );
        assert_eq!(
            unreadable.len(),
            1,
            "读不动的目录必须报出来,且白名单里的系统目录不该混进来: {unreadable:?}"
        );
        assert_eq!(unreadable[0].rel_path, "PRIVATE");
        assert!(!unreadable[0].reason.is_empty());
    }

    /// 选择项非法时,扫描入口自己就要拒(续传时选择来自可被改写的 manifest)。
    #[test]
    fn scan_selection_refuses_escaping_folder() {
        let tmp = tempdir().unwrap();
        make_card(tmp.path());
        let e = scan_selection(tmp.path(), &folders(&["../外面"])).unwrap_err();
        assert!(e.to_string().contains("源文件夹路径非法"), "{e}");
    }

    // ---------------- R3:全局唯一性兜底必须覆盖「没有目录可加」的项 ----------------

    /// R3(必修):卷根下两个折叠后同名的文件(`DSC1.JPG` / `dsc1.jpg`)。
    ///
    /// 它们分在同一组、却一级目录都没有可加(`for depth in 1..=0` 一次都不跑),
    /// 旧实现把「一个字没改」的项直接 `continue`,于是两者都保留原名 → 折叠后同键。
    /// 后果:`plan_source_selection` 给双确认屏返回「0 个改名」,用户批准;
    /// `start_copy_task` 写完 manifest、发完审计、起了 worker,`run_copy` 预检当场
    /// Err,任务直接 failed、一个字节都没拷,报错还是「清单被篡改」——把规划器
    /// 自己的 bug 甩锅给用户,续传只会再失败一次。
    ///
    /// (把兜底改回「原名项 continue」,本测试必红。)
    #[test]
    fn root_level_case_clash_gets_suffix_and_is_reported() {
        let f = |rel: &str| ScannedFile {
            rel: rel.to_string(),
            size: 1,
            mtime_ns: 0,
        };
        let (planned, renamed) = plan_flat_targets(&[f("DSC1.JPG"), f("dsc1.jpg")]);
        let keys: std::collections::HashSet<String> = planned
            .iter()
            .map(|p| target_name_key(&p.target_rel))
            .collect();
        assert_eq!(
            keys.len(),
            planned.len(),
            "折叠后仍同键 = 两个源规划到同一个落点: {:?}",
            planned
                .iter()
                .map(|p| (&p.source_rel, &p.target_rel))
                .collect::<Vec<_>>()
        );
        // 一个留原名,另一个补序号,并且**必须**出现在改名清单里(系统改了名就得明示)
        assert_eq!(renamed.len(), 1, "被改名的必须进清单: {renamed:?}");
        assert!(
            renamed[0].target_rel.contains("_2"),
            "让位的那个应补序号: {renamed:?}"
        );
    }

    /// R3 同型:整批规划出来的落点**任何时候**都必须两两不同(否则引擎预检会
    /// 当场 Err 掉整个任务)。这里一次覆盖三种撞法:根同名、跨组撞、连撞两次。
    #[test]
    fn planned_targets_are_globally_unique_under_the_name_key() {
        let f = |rel: &str| ScannedFile {
            rel: rel.to_string(),
            size: 1,
            mtime_ns: 0,
        };
        let (planned, renamed) = plan_flat_targets(&[
            f("A.JPG"),
            f("a.jpg"),
            f("a.JPG"),
            f("100MSDCF/DSC1.JPG"),
            f("101MSDCF/DSC1.JPG"),
            f("100MSDCF_DSC1.JPG"),
            f("100msdcf_dsc1_2.jpg"),
        ]);
        // R13 E3:唯一性断言**不许拿被测函数自己当预言机**。用 `target_name_key`
        // 算键、再断言键两两不同,等于问「你自己觉得你们不同吗」——实现与目的地
        // 文件系统一起错位(比如 σ/ς 折不平)时它照样绿。这里的输入全是纯 ASCII,
        // 独立预言机就是 ASCII 小写:目的地把 `A.JPG` 与 `a.jpg` 视为同名。
        let oracle: std::collections::HashSet<String> = planned
            .iter()
            .map(|p| p.target_rel.to_ascii_lowercase())
            .collect();
        assert_eq!(
            oracle.len(),
            planned.len(),
            "落点必须两两不同(独立预言机:ASCII 小写): {:?}",
            planned
                .iter()
                .map(|p| p.target_rel.as_str())
                .collect::<Vec<_>>()
        );
        // 改名清单必须与「落盘名 != 原文件名」的集合逐字一致
        let expected: Vec<&str> = planned
            .iter()
            .filter(|p| p.target_rel != base_name(&p.source_rel))
            .map(|p| p.source_rel.as_str())
            .collect();
        let got: Vec<&str> = renamed.iter().map(|r| r.source_rel.as_str()).collect();
        assert_eq!(got, expected, "改名清单不得漏项");
    }

    // ---------------- R13:Unicode 大小写折叠(σ / ς / Σ) ----------------

    /// 希腊小写 sigma 的两种写法与它们共同的大写形。APFS 的大小写不敏感比较按
    /// Unicode 折叠实现,三者是**同一个文件名**。
    const SIGMA_MID: &str = "σ.mov"; // U+03C3 词中 sigma
    const SIGMA_FINAL: &str = "ς.mov"; // U+03C2 词尾 sigma
    const SIGMA_UPPER: &str = "Σ.mov"; // U+03A3 大写 sigma

    /// R13 A3(P0):等价类断言。**不拿被测函数当预言机**——这里直接写出
    /// 「目的地文件系统认为哪些名字是同一个」这个期望,再要求实现符合它。
    ///
    /// `to_lowercase()` 会让这条必红:它把 ς 原样留作 ς(ς 本来就是小写),
    /// 于是 σ.mov 与 ς.mov 折出两个不同的键。
    #[test]
    fn target_name_key_folds_sigma_variants_into_one_class() {
        assert!(
            SIGMA_MID != SIGMA_FINAL && SIGMA_FINAL != SIGMA_UPPER,
            "前置断言:三串字节确实互不相同"
        );
        // 期望的等价类:三者同键
        let k = target_name_key(SIGMA_MID);
        assert_eq!(target_name_key(SIGMA_FINAL), k, "ς 必须与 σ 同键");
        assert_eq!(target_name_key(SIGMA_UPPER), k, "Σ 必须与 σ 同键");

        // Final_Sigma 位置规则的坑:`str::to_lowercase("ΟΔΟΣ")` 末位会变成 ς,
        // 于是同一个词的大小写变体折出不同的键。折叠不受位置影响。
        assert_eq!(
            target_name_key("ΟΔΟΣ.mov"),
            target_name_key("οδοσ.mov"),
            "同一个词的大小写变体必须同键(Final_Sigma 位置规则不得影响折叠)"
        );
        assert_eq!(
            target_name_key("ΟΔΟΣ.mov"),
            target_name_key("οδος.mov"),
            "词尾 sigma 写法同样必须同键"
        );

        // 不同的字必须**不同键**(折叠不许把不该合并的合并掉)
        assert_ne!(
            target_name_key("σ.mov"),
            target_name_key("ο.mov"),
            "不同字母不得折成同键"
        );
    }

    /// R13 A3(P0):端到端——大小写敏感的源卷上同时有 `σ.mov` 与 `ς.mov`,
    /// 目的地是默认的大小写不敏感 APFS。折不平就与刚修的 NFC 那条**完全同形**:
    /// 两遍唯一性与全计划预检都认为它们不同,内容相同时第二项复用第一项的物理
    /// 文件并报 all_verified,两个源最终只落一个目录项。
    ///
    /// 本断言**不碰 `target_name_key`**:只看规划出来的两个落点是不是两串不同的
    /// 字节、让位的那个有没有进改名清单。
    #[test]
    fn sigma_variants_never_land_on_one_target() {
        let f = |rel: &str| ScannedFile {
            rel: rel.to_string(),
            size: 1,
            mtime_ns: 0,
        };
        let (planned, renamed) = plan_flat_targets(&[f(SIGMA_MID), f(SIGMA_FINAL)]);
        assert_eq!(planned.len(), 2);
        assert_ne!(
            planned[0].target_rel,
            planned[1].target_rel,
            "σ 与 ς 在 APFS 上是同一个文件名,落点必须被拉开: {:?}",
            planned
                .iter()
                .map(|p| p.target_rel.as_str())
                .collect::<Vec<_>>()
        );
        assert_eq!(renamed.len(), 1, "让位的那个必须进改名清单: {renamed:?}");
    }

    /// R13 A3:全计划预检也走同一把尺子——清单被改写成 σ/ς 两个「不同」落点时,
    /// 必须在**任何写入之前**拒绝,而不是拷到第二个才静默并成一个。
    #[test]
    fn run_copy_precheck_refuses_sigma_duplicate_targets() {
        let (_t, req, mut m, project) = setup(folders(&[""]));
        let plan = vec![
            PlannedFile {
                source_rel: "ROOT.MP4".into(),
                target_rel: SIGMA_MID.into(),
                size: 4000,
                source_mtime_ns: 0,
            },
            PlannedFile {
                source_rel: "ROOT.MP4".into(),
                target_rel: SIGMA_FINAL.into(),
                size: 4000,
                source_mtime_ns: 0,
            },
        ];
        let e = run_copy(&req, &plan, &mut m, &project, |_| CopyControl::Continue).unwrap_err();
        assert!(e.to_string().contains("同一个落点"), "{e}");
        assert!(!req.destinations[0].exists(), "拒绝要发生在任何写入之前");
    }

    // ---------------- R4:Unicode NFC/NFD 归一 ----------------

    /// `é` 的两种写法:NFC(U+00E9)与 NFD(`e` + U+0301)。
    const E_NFC: &str = "é.mov";
    const E_NFD: &str = "e\u{301}.mov";

    /// R4(必修):同一目录下 NFC/NFD 等价的两个名字,在目的地文件系统上是
    /// **同一个文件名**。不归一就会规划出两个「不冲突」的落点,内容相同时
    /// 第二个直接复用第一个的物理文件并报 all_verified——两个源最终只剩一个
    /// 目录项,用户以为都备份了。这是真丢文件。
    ///
    /// (把 `target_name_key` 里的 `.nfc()` 去掉,本测试必红。)
    #[test]
    fn nfc_and_nfd_equivalent_names_never_land_on_one_target() {
        assert_ne!(E_NFC, E_NFD, "前置断言:两串字节确实不同");
        let f = |rel: &str| ScannedFile {
            rel: rel.to_string(),
            size: 1,
            mtime_ns: 0,
        };
        let (planned, renamed) = plan_flat_targets(&[f(E_NFC), f(E_NFD)]);
        assert_eq!(planned.len(), 2);
        assert_ne!(
            target_name_key(&planned[0].target_rel),
            target_name_key(&planned[1].target_rel),
            "NFC/NFD 等价的两个落点在目的地上是同一个文件: {:?}",
            planned
                .iter()
                .map(|p| p.target_rel.as_str())
                .collect::<Vec<_>>()
        );
        assert_eq!(renamed.len(), 1, "让位的那个必须进改名清单: {renamed:?}");
    }

    /// R4:全计划预检也走同一把尺子——清单被改写成 NFC/NFD 两个「不同」落点时,
    /// 必须在**任何写入之前**拒绝,而不是拷到第二个才静默并成一个。
    #[test]
    fn run_copy_precheck_refuses_nfc_nfd_duplicate_targets() {
        let (_t, req, mut m, project) = setup(folders(&[""]));
        let plan = vec![
            PlannedFile {
                source_rel: "ROOT.MP4".into(),
                target_rel: E_NFC.into(),
                size: 4000,
                source_mtime_ns: 0,
            },
            PlannedFile {
                source_rel: "ROOT.MP4".into(),
                target_rel: E_NFD.into(),
                size: 4000,
                source_mtime_ns: 0,
            },
        ];
        let e = run_copy(&req, &plan, &mut m, &project, |_| CopyControl::Continue).unwrap_err();
        assert!(e.to_string().contains("同一个落点"), "{e}");
        assert!(!req.destinations[0].exists(), "拒绝要发生在任何写入之前");
    }

    /// R4 真实文件系统:卡上放 NFC/NFD 两个名字后完整跑一遍拷贝。
    ///
    /// 源文件系统若把两者视为同一个文件(macOS APFS 的归一不敏感比较),
    /// 卡上本来就只有一个文件——那也没什么可丢的;只要**源上有几个目录项,
    /// 目的地就得有几个**,且内容一一对上。旧实现在源可区分的文件系统上
    /// (Linux ext4)会把两者规划到同一个落点。
    #[test]
    fn nfc_nfd_on_real_fs_lands_one_target_per_source_entry() {
        let tmp = tempdir().unwrap();
        let card = tmp.path().join("card");
        fs::create_dir_all(&card).unwrap();
        fs::write(card.join(E_NFC), vec![1u8; 100]).unwrap();
        fs::write(card.join(E_NFD), vec![2u8; 100]).unwrap();
        let source_entries = fs::read_dir(&card).unwrap().count();

        let project = tmp.path().join("project");
        fs::create_dir_all(&project).unwrap();
        let req = CopyRequest {
            source_root: card,
            destinations: vec![tmp.path().join("nas/target")],
            task_tag: "nfc".into(),
            selection: SourceSelection::Folders(vec![String::new()]),
        };
        let mut m = CopyManifest::new("target", "card", "A7M4_A_ZS", "ZS", "");
        let (plan, _renamed, _) = scan_selection(&req.source_root, &req.selection).unwrap();
        assert_eq!(plan.len(), source_entries, "计划项数必须等于源目录项数");
        let out = run_copy(&req, &plan, &mut m, &project, |_| CopyControl::Continue).unwrap();
        assert!(out.all_verified, "{:?}", out.files);
        assert_eq!(
            fs::read_dir(&req.destinations[0]).unwrap().count(),
            source_entries,
            "源上有几个目录项,目的地就得有几个——少一个就是静默丢文件"
        );
    }

    // ---------------- R5:计划摘要 ----------------

    /// 计划摘要必须对「文件被删/被改大小/换了卡/换了勾选范围」全部敏感,
    /// 对「勾选顺序」不敏感(同一批夹子换个顺序不是「计划变了」)。
    #[test]
    fn plan_digest_is_sensitive_to_every_thing_that_matters() {
        let f = |rel: &str, size: u64| ScannedFile {
            rel: rel.to_string(),
            size,
            mtime_ns: 0,
        };
        let sel = folders(&["A", "B"]);
        let base = plan_flat_targets(&[f("A/x.jpg", 10), f("B/y.jpg", 20)]).0;
        let d = plan_digest(&sel, &base, "vol-1");
        assert_eq!(d, plan_digest(&sel, &base, "vol-1"), "同输入必须同摘要");
        // 勾选顺序无关
        assert_eq!(d, plan_digest(&folders(&["B", "A"]), &base, "vol-1"));
        // 文件被删
        let fewer = plan_flat_targets(&[f("A/x.jpg", 10)]).0;
        assert_ne!(d, plan_digest(&sel, &fewer, "vol-1"), "少一个文件必须变");
        // 大小变了(同名同路径)
        let resized = plan_flat_targets(&[f("A/x.jpg", 11), f("B/y.jpg", 20)]).0;
        assert_ne!(d, plan_digest(&sel, &resized, "vol-1"), "大小变了必须变");
        // 换了卡
        assert_ne!(d, plan_digest(&sel, &base, "vol-2"), "换卡必须变");
        // 勾选范围变了
        assert_ne!(
            d,
            plan_digest(&folders(&["A"]), &base, "vol-1"),
            "范围变了必须变"
        );
    }

    /// R13 C1(P0):**选择独占一段**。卡完全没变、只是提交选择 B 时误带了选择 A
    /// 的令牌——这是纯前端状态错配。共用一段时逐条 diff 会显示「A 被删、B 新增」,
    /// 报文于是断言「卡上的文件变了」,把人推去数卡上的文件、怀疑有人动过卡。
    ///
    /// 判别性:把选择段并回文件集段,`Selection` 那条断言会变成 `FileSet`,必红。
    #[test]
    fn selection_change_is_classified_apart_from_file_set_change() {
        let f = |rel: &str, size: u64| ScannedFile {
            rel: rel.to_string(),
            size,
            mtime_ns: 7,
        };
        // 同一张卡上的两批夹子:各自的文件集也不同(现实里必然如此)
        let plan_a = plan_flat_targets(&[f("A/x.jpg", 10)]).0;
        let plan_b = plan_flat_targets(&[f("B/y.jpg", 20)]).0;
        let da = plan_digest(&folders(&["A"]), &plan_a, "vol-1");
        let db = plan_digest(&folders(&["B"]), &plan_b, "vol-1");
        assert_eq!(
            classify_plan_change(&da, &db),
            PlanChange::Selection,
            "带错令牌 = 勾选范围对不上,绝不能报成「卡上的文件变了」"
        );

        // 选择一样、文件集变了 → 仍旧是 FileSet(选择段不许把它盖掉)
        let more = plan_flat_targets(&[f("A/x.jpg", 10), f("A/z.jpg", 30)]).0;
        assert_eq!(
            classify_plan_change(&da, &plan_digest(&folders(&["A"]), &more, "vol-1")),
            PlanChange::FileSet
        );

        // 勾选顺序 / 重复勾选不算变化(规范化后同键)
        assert_eq!(
            plan_digest(&folders(&["A", "B"]), &plan_a, "vol-1"),
            plan_digest(&folders(&["B", "A", "B"]), &plan_a, "vol-1"),
            "顺序与重复项不该动摘要"
        );
    }

    /// R11:同大小、**修改时间变了**的替换——size-only 摘要漏掉的正是这一类,
    /// 而它在换卡场景里完全可能发生。令牌的全部意义是「你批准的就是将要执行的」。
    ///
    /// R13 E1:名字必须**名副其实**。这个测试构造的是「同大小、mtime 变了」,
    /// 它**证明不了**「内容被替换一定被抓到」——`cp -p` / `touch -r` 保留 mtime 的
    /// 替换,以及「start 比对通过之后、实际复制之前」改源文件,都能绕过令牌。
    /// 那条边界是**声明过的**(令牌是元数据级绑定,不是内容级绑定,见契约文档
    /// 「令牌保护不了什么」一节):内容级绑定要把整张卡多读一遍,代价不可接受。
    ///
    /// 所以这里同时把边界**钉成断言**——真要收紧到内容级,下面第二段必须先变红,
    /// 谁也不能悄悄以为令牌已经管住内容了。
    /// (把 `plan_digest` 里那段 mtime 拿掉,第一段必红。)
    #[test]
    fn plan_digest_catches_retimed_replacement_but_not_timestamp_preserving_ones() {
        let f = |rel: &str, size: u64, ns: u128| ScannedFile {
            rel: rel.to_string(),
            size,
            mtime_ns: ns,
        };
        let sel = folders(&["A"]);
        let base = plan_flat_targets(&[f("A/x.jpg", 10, 1_000)]).0;
        // ① 抓得到:同大小、mtime 变了
        let touched = plan_flat_targets(&[f("A/x.jpg", 10, 2_000)]).0;
        assert_ne!(
            plan_digest(&sel, &base, "vol-1"),
            plan_digest(&sel, &touched, "vol-1"),
            "大小一样、修改时间变了 = 内容可能被换掉,摘要必须变"
        );
        // ② 抓不到(**声明过的边界**):同大小、同 mtime —— `cp -p` / `touch -r`
        //    保留时间戳的替换。摘要只看 (rel, target, size, mtime),看不见内容。
        let preserved = plan_flat_targets(&[f("A/x.jpg", 10, 1_000)]).0;
        assert_eq!(
            plan_digest(&sel, &base, "vol-1"),
            plan_digest(&sel, &preserved, "vol-1"),
            "令牌是元数据级绑定:同大小同 mtime 的替换本就在保护范围之外。\
             若这条变红,说明有人把令牌收紧到了内容级——请同步更新契约文档的边界声明"
        );
    }

    /// R13 E1 配套:真·内容被替换(同大小、同 mtime)确实绕得过令牌,但**绕不过
    /// 引擎的哈希校验**。这条把「令牌管不住的那一半到底谁在管」钉住:落点已被
    /// 占用且内容不同时,引擎必须报冲突,绝不静默覆盖、也绝不静默当成功。
    #[test]
    fn same_size_same_mtime_replacement_is_caught_by_the_engine_not_the_token() {
        let (_t, req, mut m, project) = setup(folders(&["DCIM/100MSDCF"]));
        let src = req.source_root.join("DCIM/100MSDCF/ONLY.JPG");
        let meta = fs::metadata(&src).unwrap();
        let size = meta.len();
        let plan = vec![PlannedFile {
            source_rel: "DCIM/100MSDCF/ONLY.JPG".into(),
            target_rel: "ONLY.JPG".into(),
            size,
            source_mtime_ns: super::super::media::mtime_nanos(&meta),
        }];
        // 目的地先落一份**同名、同大小、同 mtime,但内容不同**的旧版本
        let dest = &req.destinations[0];
        fs::create_dir_all(dest).unwrap();
        let old = dest.join("ONLY.JPG");
        fs::write(&old, vec![0xABu8; size as usize]).unwrap();
        let f = fs::OpenOptions::new().write(true).open(&old).unwrap();
        f.set_times(fs::FileTimes::new().set_modified(meta.modified().unwrap()))
            .unwrap();
        drop(f);

        let out = run_copy(&req, &plan, &mut m, &project, |_| CopyControl::Continue).unwrap();
        assert!(
            matches!(&out.files[0].status, FileStatus::Failed(e) if e.contains("同名")),
            "同名不同内容必须报冲突,不许静默覆盖也不许静默当成功: {:?}",
            out.files[0].status
        );
        assert!(!out.all_verified, "有冲突就不许说全部校验通过");
        assert_eq!(
            fs::read(&old).unwrap(),
            vec![0xABu8; size as usize],
            "目的地已有文件一个字节都不许被动"
        );
    }

    /// 报错必须说对**原因**:说错原因比不说更糟,会把人引向错误的排查方向。
    #[test]
    fn plan_change_is_classified_by_cause() {
        let f = |rel: &str, size: u64, ns: u128| ScannedFile {
            rel: rel.to_string(),
            size,
            mtime_ns: ns,
        };
        let sel = folders(&["A"]);
        let base = plan_flat_targets(&[f("A/x.jpg", 10, 1_000)]).0;
        let d = plan_digest(&sel, &base, "vol-1");

        assert_eq!(classify_plan_change(&d, &d), PlanChange::None);
        // 换卡:优先于其它一切(换卡能解释后面所有差异)
        assert_eq!(
            classify_plan_change(&d, &plan_digest(&sel, &base, "vol-2")),
            PlanChange::Volume
        );
        let more = plan_flat_targets(&[f("A/x.jpg", 10, 1_000), f("A/y.jpg", 20, 1_000)]).0;
        assert_eq!(
            classify_plan_change(&d, &plan_digest(&sel, &more, "vol-1")),
            PlanChange::FileSet
        );
        // 只有 mtime 变:必须报「内容被替换」,不能报成「文件被增删」
        let touched = plan_flat_targets(&[f("A/x.jpg", 10, 2_000)]).0;
        assert_eq!(
            classify_plan_change(&d, &plan_digest(&sel, &touched, "vol-1")),
            PlanChange::ContentReplaced
        );
        // 勾选范围变了单独定性(R13 C1:不许并进 FileSet 说成「卡上的文件变了」)
        assert_eq!(
            classify_plan_change(&d, &plan_digest(&folders(&["A", "B"]), &base, "vol-1")),
            PlanChange::Selection
        );
        // 老版本令牌 / 被改写的令牌:fail-closed,且说得出「认不出这个令牌」
        assert_eq!(
            classify_plan_change("deadbeefdeadbeef", &d),
            PlanChange::Unrecognized
        );
        assert_eq!(
            classify_plan_change("ocard-plan-v1:a:b:c", &d),
            PlanChange::Unrecognized
        );
    }

    /// 逐条差异:每个文件只落进一个桶,报文才说得清「多了几个/少了几个/改了几个」。
    #[test]
    fn diff_plans_buckets_each_file_exactly_once() {
        let p = |src: &str, dst: &str, size: u64, ns: u128| PlannedFile {
            source_rel: src.to_string(),
            target_rel: dst.to_string(),
            size,
            source_mtime_ns: ns,
        };
        let approved = vec![
            p("A/keep.jpg", "keep.jpg", 1, 100),
            p("A/gone.jpg", "gone.jpg", 2, 100),
            p("A/big.jpg", "big.jpg", 3, 100),
            p("A/moved.jpg", "moved.jpg", 4, 100),
            p("A/touched.jpg", "touched.jpg", 5, 100),
            p("A/blind.jpg", "blind.jpg", 6, 0),
        ];
        let fresh = vec![
            p("A/keep.jpg", "keep.jpg", 1, 100),
            p("A/big.jpg", "big.jpg", 30, 100),
            p("A/moved.jpg", "A_moved.jpg", 4, 100),
            p("A/touched.jpg", "touched.jpg", 5, 200),
            p("A/blind.jpg", "blind.jpg", 6, 999),
            p("A/new.jpg", "new.jpg", 7, 100),
        ];
        let d = diff_plans(&approved, &fresh);
        assert_eq!(d.added, vec!["A/new.jpg"]);
        assert_eq!(d.removed, vec!["A/gone.jpg"]);
        assert_eq!(d.resized, vec!["A/big.jpg"]);
        assert_eq!(d.retargeted, vec!["A/moved.jpg"]);
        // blind.jpg 确认时 mtime 读不到(记 0):把「读不到时间」判成「内容被换了」
        // 是纯误报,不能进桶
        assert_eq!(d.retimed, vec!["A/touched.jpg"]);
        assert!(d.file_set_changed());
        assert!(!diff_plans(&approved, &approved).file_set_changed());
        assert!(diff_plans(&approved, &approved).is_empty());
    }

    // ---------------- R11:系统项白名单(取代「点开头一律跳过」) ----------------

    /// 白名单条目必须已经是 `target_name_key` 归一后的形态。
    /// 写了个大写条目却永不命中,是最难发现的一类失效——那条排除会静默失效,
    /// 卡上的 `.Trashes` 会被当素材拷进目标夹。
    #[test]
    fn system_item_names_are_already_normalized() {
        for n in SYSTEM_ITEM_NAMES
            .iter()
            .chain(SYSTEM_ITEM_PREFIXES)
            .chain(SYSTEM_ITEM_SUFFIXES)
            .chain(SYSTEM_ITEM_TAILED.iter().map(|(p, _, _)| p))
        {
            assert_eq!(
                &target_name_key(n),
                n,
                "白名单条目必须写成归一形态(NFC + 大小写折叠): {n}"
            );
        }
    }

    /// 判据是**明确列举**,不是「以点开头」。
    /// (把 `is_system_item` 改回 `name.starts_with('.')`,`.clip.mov` 那几条必红。)
    #[test]
    fn only_enumerated_system_items_are_excluded() {
        // 明确列举的:排除
        for name in [
            ".Trashes",
            ".fseventsd",
            ".Spotlight-V100",
            ".TemporaryItems",
            ".DocumentRevisions-V100",
            ".DS_Store",
            "._DSC0001.JPG",
            "System Volume Information",
            "$RECYCLE.BIN",
            "Thumbs.db",
            "desktop.ini",
            ".ocard",
            ".ocard-volume-id",
            ".Trash-1000",
            // R13 A2:freedesktop 规范给可移动盘定义的**共享**回收站
            // `$topdir/.Trash/$uid`。漏掉它 = 已删除的素材连同 .trashinfo
            // 被当素材备份甚至交付(隐私泄漏 + 容量膨胀)。
            ".Trash",
            ".trash",
            // NAS / 网络共享(打包路径复用同一份名单)
            "@eaDir",
            ".@__thumb",
            ".AppleDouble",
            ".apdisk",
            ".smbdeleteAAA0f4a.4",
            ".nfs0000000000e1a3",
            // R12:本工具自己在 NAS 项目目录里落下的**半截文件**(后缀式)。
            // 它们内容不完整,既不能算进分类计数,更不能被打进交付包。
            "CLIP0001.MP4.t7f3a2.ocardpart",
            ".9f1c0f6e-0000-4000-8000-000000000000.curatepart",
        ] {
            assert!(is_system_item(name), "系统项必须排除: {name}");
        }
        // 大小写不敏感:exFAT/APFS 上 `.ds_store` 与 `.DS_Store` 是同一个文件,
        // 按字节比较会漏掉小写写法
        for name in [
            ".ds_store",
            ".DS_STORE",
            ".trashes",
            "system volume information",
            "$Recycle.Bin",
        ] {
            assert!(is_system_item(name), "白名单比对必须大小写不敏感: {name}");
        }
        // 点开头但**不在**名单上的:一律照拷。漏拷却报成功是这个工具最不能
        // 接受的失败形态,可见告警替代不了拷对
        for name in [
            ".clip.mov",
            ".DS_Store_backup.mov", // 只是前缀像,不是那个文件
            ".hidden_素材",         // 用户自建的隐藏素材夹
            ".Trashesque.mp4",      // 前缀像 .Trashes,但不是它
            ".spotlight-notes.txt", // 前缀像 .Spotlight-V100,但不是它
            "@eaDir_备份.mov",      // 只是以那个名字开头,不是那个目录
            "DSC0001.JPG",
            // 后缀判据只认结尾:名字里出现这几个词但不以它们收尾的,是素材
            "ocardpart.mov",
            "CLIP.ocardpart.MP4",
            "curatepart.jpg",
        ] {
            assert!(!is_system_item(name), "这不是系统项,必须照拷: {name}");
        }
    }

    /// R13 A1(P0):`.ocard` 曾是**前缀**,于是卡上任何以它开头的合法素材整个
    /// 不进计划,告警还断言它「不是素材」,整卷任务照样给「本卡可格式化」——
    /// 「形状判据兜底 → 漏拷却报成功」的原样复发,只是范围小一点。
    ///
    /// 判别性:把 `.ocard` / `.ocard-volume-id` 两条精确名换回一条 `.ocard` 前缀,
    /// 下面这批必红。
    #[test]
    fn ocard_namespace_is_matched_by_exact_name_not_by_prefix() {
        // 本工具真正的落盘:必须排除
        for name in [".ocard", ".OCard", ".ocard-volume-id", ".OCARD-VOLUME-ID"] {
            assert!(is_system_item(name), "本工具自己的落盘必须排除: {name}");
        }
        // 只是以 `.ocard` 开头的**用户素材/文件**:一个都不许被排除
        for name in [
            ".ocardinal.mov",
            ".ocard-notes.txt",
            ".ocard_backup",
            ".ocardio.jpg",
            ".ocard-volume-id.bak", // 像那个指纹文件,但不是它
        ] {
            assert!(
                !is_system_item(name),
                "以 .ocard 开头不等于是系统项,必须照拷: {name}"
            );
        }
    }

    /// R13 A1(P0):带可变尾巴的系统项必须**连尾巴的形状一起校验**。
    /// 只比前缀 = `.ocard` 那条 P0 的同型错误(`.trash-交接单.txt` 会被静默吞掉)。
    ///
    /// 判别性:把 `matches_tailed` 改成只比前缀(去掉形状与最短长度校验),
    /// 下半批必红。
    #[test]
    fn tailed_system_items_validate_the_tail_shape() {
        // 规范形态:排除
        for name in [
            ".Trash-1000",         // freedesktop:$uid 是纯数字
            ".trash-0",            //
            ".smbdeleteAAA0f4a.4", // Samba silly-rename
            ".nfs0000000000e1a3",  // NFS silly-rename(十六进制,≥8 位)
            ".NFS0000000000E1A3",  // 大小写不敏感
        ] {
            assert!(is_system_item(name), "规范形态的系统项必须排除: {name}");
        }
        // 只是**前缀**撞上了命名空间的用户文件:一律照拷
        for name in [
            ".trash-交接单.txt",   // uid 不可能是中文
            ".trash-notes.txt",    // uid 不可能带点和字母
            ".trash-",             // 没有尾巴,不是 `.Trash-$uid`
            ".smbdelete-记录.txt", // Samba 令牌里不会有 `-` 和中文
            ".smbdel.mov",         // 前缀都没撞上
            ".nfs.mov",            // 尾巴不是十六进制
            ".nfs-交接单.txt",     // 同上
            ".nfs01ab",            // 十六进制但太短,不是 silly-rename 的形态
        ] {
            assert!(
                !is_system_item(name),
                "尾巴形状对不上就是用户文件,必须照拷: {name}"
            );
        }
    }

    /// 三处扫描共用同一份口径:选择器里看得见的、列直接子文件列得出的、
    /// 整卷递归扫得到的,必须是同一套判据。分叉 = 「看得见却不拷」或反之。
    #[test]
    fn all_three_scans_share_one_whitelist() {
        let tmp = tempdir().unwrap();
        let root = tmp.path();
        fs::create_dir_all(root.join("D")).unwrap();
        fs::create_dir_all(root.join(".Trashes")).unwrap();
        fs::create_dir_all(root.join(".素材夹")).unwrap();
        fs::write(root.join(".Trashes/junk"), b"x").unwrap();
        fs::write(root.join("D/.clip.mov"), b"legit hidden asset").unwrap();
        fs::write(root.join("D/.DS_Store"), b"junk").unwrap();
        fs::write(root.join(".素材夹/a.mov"), b"asset").unwrap();

        // ① 整卷递归
        let whole: Vec<String> = scan_source(root)
            .unwrap()
            .into_iter()
            .map(|f| f.rel)
            .collect();
        assert_eq!(
            whole,
            vec![".素材夹/a.mov".to_string(), "D/.clip.mov".to_string()],
            "点开头的素材必须进计划,系统项必须不进"
        );

        // ② 列直接子文件
        let direct: Vec<String> = list_direct_files(root, "D")
            .unwrap()
            .into_iter()
            .map(|f| f.rel)
            .collect();
        assert_eq!(direct, vec!["D/.clip.mov".to_string()]);

        // ③ 列可勾选文件夹
        let (folders, _) = list_source_folders(root).unwrap();
        let rels: Vec<&str> = folders.iter().map(|f| f.rel_path.as_str()).collect();
        assert!(
            rels.contains(&".素材夹"),
            "点开头的素材夹必须能勾选: {rels:?}"
        );
        assert!(
            !rels.contains(&".Trashes"),
            "废纸篓不该出现在选择器里: {rels:?}"
        );
    }

    /// 白名单命中的仍然计数并可见上报(零静默:排除了什么必须报到用户面前)。
    #[test]
    fn system_items_are_counted_and_sampled_not_just_silently_dropped() {
        let tmp = tempdir().unwrap();
        make_card(tmp.path());
        fs::create_dir_all(tmp.path().join(".Trashes")).unwrap();
        fs::write(tmp.path().join(".Trashes/junk"), b"x").unwrap();
        fs::create_dir_all(tmp.path().join(".Spotlight-V100")).unwrap();
        fs::write(tmp.path().join(".DS_Store"), b"x").unwrap();
        fs::write(tmp.path().join(".clip.mov"), b"legit hidden asset").unwrap();
        let _ = take_scan_system_skipped(); // 清干净上一轮
        let files = scan_source(tmp.path()).unwrap();
        assert!(
            files.iter().any(|f| f.rel == ".clip.mov"),
            "点开头的合法素材必须进计划: {files:?}"
        );
        let (n, samples) = take_scan_system_skipped();
        // .Trashes(整个目录只算一条,不递归)、.Spotlight-V100、.DS_Store
        assert_eq!(n, 3, "被排除的系统项必须计数: {n} / {samples:?}");
        assert!(
            samples.iter().any(|s| s == ".DS_Store"),
            "样例里要点得出名字: {samples:?}"
        );
        assert!(
            !samples.iter().any(|s| s == ".clip.mov"),
            "没被排除的东西不许出现在排除样例里: {samples:?}"
        );
        assert_eq!(take_scan_system_skipped().0, 0, "取走即清零");
    }

    #[test]
    fn missing_folder_reports_readable_error_not_empty_list() {
        // 零静默:选中的夹子没了要说人话,绝不能返回空清单让用户以为卡是空的
        let tmp = tempdir().unwrap();
        make_card(tmp.path());
        let e = scan_selection(tmp.path(), &folders(&["DCIM/199MSDCF"])).unwrap_err();
        let msg = e.to_string();
        assert!(
            msg.contains("DCIM/199MSDCF") && msg.contains("不存在"),
            "{msg}"
        );
    }
}
