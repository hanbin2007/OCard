/**
 * OCard 前后端契约类型。
 *
 * 这里的每一个类型都对应 Rust 侧 `tauri::command` 的入参/返回值，
 * Rust 端用 serde 以 camelCase 序列化（`#[serde(rename_all = "camelCase")]`）。
 * 字节数一律用 number（JS 安全整数上限 9PB，足够素材场景）。
 * 时间戳一律用 ISO 8601 字符串（如 `2026-08-24T09:12:33+08:00`）。
 * 日期（无时间）一律用 `YYYYMMDD` 紧凑字符串，与规范的文件夹命名一致。
 */

/** 工况：A = 视频剪辑，B = 纯拍照（PRD §5.2） */
export type Scenario = "A" | "B";

/** 项目生命周期状态 */
export type ProjectStatus =
  | "draft" // 已建夹，未拷卡
  | "copying" // 拷卡进行中
  | "sorting" // 拷卡完成，分类中
  | "delivering" // 分类完成，打包/交付中
  | "done"; // 已交付

export interface Project {
  id: string;
  /** 项目名，不含日期前缀，如「校运会」 */
  name: string;
  /** `YYYYMMDD` */
  date: string;
  /** 落盘文件夹名 `YYYYMMDD_项目名` */
  folderName: string;
  scenario: Scenario;
  /** 工况 B 的自定义分类名（不含「待分类 / 精选 / 其他」这三个固定项） */
  categories: string[];
  /** NAS 根下的相对路径 */
  relativePath: string;
  status: ProjectStatus;
  /** 已拷卡张数 */
  cardsCopied: number;
  /** 本项目登记的卡总数 */
  cardsTotal: number;
  /** 已拷入容量 */
  bytesCopied: number;
  /** 素材总数 */
  assetCount: number;
  /** 已分类素材数（工况 A 恒为 0，进度以转码为准） */
  sortedCount: number;
  /** 备份目的地数量（NAS 主 + 备份盘） */
  destinationCount: number;
  /** 最近一次事件时间（ISO 8601） */
  updatedAt: string;
}

/** 新建项目向导的提交体 */
export interface NewProjectInput {
  name: string;
  /** `YYYYMMDD` */
  date: string;
  scenario: Scenario;
  /** 仅工况 B 有效；工况 A 传空数组 */
  categories: string[];
}

/** 建夹模板预览节点 */
export interface FolderNode {
  name: string;
  children?: FolderNode[];
}

/** 相机登记（PRD §5.1） */
export interface CameraReg {
  id: string;
  /** 型号，如 `DJI Ronin 4D` */
  model: string;
  /** 机位 A–Z 单字母 */
  position: string;
  /** 使用者代称，如 `ZS` */
  operatorAlias: string;
  /** 规范编码，如 `DJIRonin4D_B_ZS`；由 model/position/alias 推导 */
  code: string;
  note?: string;
  createdAt: string;
}

export interface NewCameraInput {
  model: string;
  position: string;
  operatorAlias: string;
  note?: string;
}

/** 存储卡登记，一卡一机 */
export interface StorageCard {
  id: string;
  /** 卡面辨识标签，如 `CFE-01` */
  label: string;
  /** 关联相机 id */
  cameraId: string;
  capacityBytes: number;
  /** 卡序列号（可读到时由卷信息带出） */
  serial?: string;
  createdAt: string;
}

export interface NewStorageCardInput {
  label: string;
  cameraId: string;
  capacityBytes: number;
  serial?: string;
}

/** 可移动卷（读卡器插入的卡）（PRD §6.5） */
export interface Volume {
  id: string;
  /** 卷标 */
  name: string;
  /** 挂载路径 / 盘符 */
  mountPath: string;
  capacityBytes: number;
  usedBytes: number;
  removable: boolean;
  /** 系统内置盘（启动盘/系统分区）：拷卡源默认隐藏，可在 UI 开关显示 */
  isSystem: boolean;
  /** 若能与已登记存储卡匹配上，带出卡 id */
  matchedCardId?: string;
}

/** 逐文件哈希状态（PRD §5.3） */
export type CopyFileStatus = "pending" | "copied" | "verified" | "failed";

/** 单个文件在单个目的地上的落地结果：NAS 成功而备份盘失败必须能表达出来 */
export interface CopyFileTargetResult {
  destinationId: string;
  status: CopyFileStatus;
  /** 回读目标算出的哈希，与源哈希比对 */
  targetHash?: string;
  error?: string;
}

export interface CopyFileItem {
  id: string;
  /** 源卡内相对路径 */
  path: string;
  name: string;
  sizeBytes: number;
  /** 汇总状态：所有目的地都 verified 才是 verified，任一 failed 即 failed */
  status: CopyFileStatus;
  /** 源侧 xxHash3-64，16 位十六进制；未算出时为空 */
  hash?: string;
  /** status === 'failed' 时的汇总原因 */
  error?: string;
  /** 逐目的地结果；省略表示各目的地与汇总状态一致 */
  targets?: CopyFileTargetResult[];
}

export type DestinationKind = "nas" | "local" | "external";
export type DestinationState = "idle" | "writing" | "verifying" | "done" | "error";

export interface CopyDestination {
  id: string;
  kind: DestinationKind;
  /** 目标绝对路径（各工作站形式不同，仅展示用） */
  path: string;
  state: DestinationState;
  writtenBytes: number;
  /** 已回读校验通过的字节数 */
  verifiedBytes?: number;
  /** state === 'error' 时的原因（如 NAS 断连） */
  error?: string;
}

export type CopyTaskState =
  | "confirming" // 双确认界面，尚未开跑
  | "running"
  | "verifying"
  | "paused" // NAS 断连 / 手动挂起，可续传
  | "done"
  | "failed";

export interface CopyTask {
  id: string;
  projectId: string;
  /** 源卷 id */
  volumeId: string;
  volumeName: string;
  /** 该卡对应相机 */
  cameraId: string;
  /** 冗余带出的相机编码，用于目标命名 */
  cameraCode: string;
  /** 内容备注（规范「适当记录」） */
  note: string;
  /** 目标子文件夹名，如 `20260824_DJIRonin4D_B_ZS` 或 `0824上午_A7M4_A_LM` */
  targetFolder: string;
  destinations: CopyDestination[];
  /**
   * 文件明细。注意：一张卡上千文件，Rust 侧不要在 `list_copy_tasks` 里全量返回，
   * 列表接口只回摘要（files 传空数组），明细走分页的 `list_copy_files`。
   */
  files: CopyFileItem[];
  /** 文件总数（files 被分页截断时仍然准确） */
  fileCount?: number;
  totalBytes: number;
  copiedBytes: number;
  /** 实时速度，字节/秒 */
  speedBytesPerSec: number;
  state: CopyTaskState;
  /** 已合并到的进度事件序号，用于丢弃乱序事件 */
  progressRevision?: number;
  /** 操作人（当前登记的 DIT） */
  operator: string;
  startedAt: string;
  finishedAt?: string;
}

/** 发起拷卡任务的提交体 */
export interface StartCopyInput {
  projectId: string;
  volumeId: string;
  cameraId: string;
  note: string;
  /**
   * 目标夹前缀：工况 A 为 `YYYYMMDD`，工况 B 为时段标签（如 `0824上午`）。
   * 由素材时间戳推断出默认值后交人工确认，故必须由前端显式传入（PRD §5.3）。
   */
  targetPrefix: string;
  /** 目的地路径列表，至少一个 */
  destinations: Array<{ kind: DestinationKind; path: string }>;
  /** 拷完自动转代理（工况 A，PRD §5.6） */
  autoProxy?: boolean;
  /**
   * 目标夹已存在且非空时，后端会以 `TARGET_EXISTS:` 开头的错误拒绝。
   * 用户在确认对话框里明示「继续」后带上此标志重发：
   * 后端只补缺失文件，绝不覆盖已有文件。
   */
  confirmExistingTarget?: boolean;
}

/**
 * `preview_copy_task` 的返回：后端解析后的**真实**落盘位置。
 *
 * 必须显示这个而不是用户填的路径——kind = "nas" 的目的地后端会忽略用户输入，
 * 固定落到项目素材目录下。确认屏显示假路径等于让人对着错信息做双确认。
 */
export interface CopyTaskPreview {
  targetFolder: string;
  destinations: CopyDestination[];
}

/** 源卷探查结果：用于推断工况 B 的时段并给出素材规模预估 */
export interface VolumeInspection {
  volumeId: string;
  fileCount: number;
  totalBytes: number;
  /** 素材最早/最晚拍摄时间（ISO 8601），空卡时为空 */
  earliestShotAt?: string;
  latestShotAt?: string;
  /** 由 earliestShotAt 推断出的建议时段标签，人工可改 */
  suggestedPrefix: string;
}

/** 拷卡进度事件；Rust 侧经 tauri event 推送 */
export interface CopyProgressEvent {
  taskId: string;
  /** 单调递增序号，用于丢弃乱序/过期事件 */
  revision: number;
  occurredAt: string;
  copiedBytes: number;
  speedBytesPerSec: number;
  state: CopyTaskState;
  /** 本次增量变化的文件 */
  changedFiles: Array<
    Pick<CopyFileItem, "id" | "status" | "hash" | "error" | "targets">
  >;
  /** 本次增量变化的目的地 */
  changedDestinations: Array<
    Pick<CopyDestination, "id" | "state" | "writtenBytes" | "verifiedBytes" | "error">
  >;
}

/** 当前工作站身份（PRD §6.3） */
export interface WorkstationInfo {
  machineId: string;
  /** 当前登记的 DIT 名 */
  operator: string;
  /** 本机配置的 NAS 根路径 */
  nasRoot: string;
}

/* ------------------------------------------------------------------ *
 * 通知（tauri 事件 `app://notice`）
 * ------------------------------------------------------------------ */

export type NoticeLevel = "info" | "warning" | "error";

/**
 * 后端推送的降级/失败通知。
 *
 * 硬性原则：任何 fail-open（降级、跳过、兜底）都必须让用户看见，
 * 不允许静默。`code` 是稳定机器码，用于去重、分组与前端的差异化呈现；
 * 前端对**未知 code 必须能通用呈现**，后端随时会加新的。
 */
export interface NoticeDto {
  level: NoticeLevel;
  code: string;
  message: string;
  occurredAt: string;
  /** 后端在 30s 窗口内合并同 code 的次数；缺省视为 1 */
  repeats?: number;
}

/**
 * `check_for_update` 的结果。
 * - ready：已在后台下载完成，重启生效
 * - uptodate：已是最新
 * - busy：后台已有检查/下载在进行
 * - failed：下载/安装失败（详情走 app://notice）
 * - check-failed：检查本身失败（网络等）
 * - unsupported：当前安装方式不支持自动更新（如包管理器安装）
 */
export type UpdateCheckResult =
  | "ready"
  | "uptodate"
  | "busy"
  | "failed"
  | "check-failed"
  | "unsupported";

/* ------------------------------------------------------------------ *
 * 分类工作台（PRD §5.4，工况 B 主场）
 * ------------------------------------------------------------------ */

/**
 * 素材类型。`other` 是后端明确表达「既不是照片也不是视频」的那一类
 * （如误入的 .txt），不再伪装成 video。
 */
export type SortingAssetKind = "photo" | "video" | "raw" | "other";

/** 待分类素材。id 用项目内相对路径，天然稳定且与落盘一一对应。 */
export interface SortingAsset {
  /** 项目内相对路径，同时作为稳定 id */
  id: string;
  fileName: string;
  sizeBytes: number;
  /** EXIF DateTimeOriginal；取不到时为空（后端回退 mtime 时置 shotAtFallback） */
  shotAt?: string;
  /** true 表示 shotAt 来自 mtime 而非 EXIF，界面要标注「时间为推断值」 */
  shotAtFallback?: boolean;
  /**
   * 缩略图 URL（`thumb://localhost/<projectId>/<cacheName>`；Windows 上是
   * `http://thumb.localhost/...`，由后端按平台生成）。**仅缓存就绪时才有值。**
   * 404 = 该图暂不可用（未索引 / 缓存被清），前端渲染占位。
   */
  thumbnail?: string;
  /**
   * 缩略图缓存是否就绪。
   *
   * 判断「这张图有没有出来」一律用它，**不要用 `thumbnail` 是否存在**——
   * thumbnail 的语义已从「内联数据」变成「URL」，用存在性做判据会让
   * 索引收尾对账（M2 #13）静默失效。
   */
  thumbReady: boolean;
  kind: SortingAssetKind;
  /** 连拍组 id；同组的会折叠显示（PRD §5.4）。分析跑过后才有真值。 */
  groupId?: string;
  /**
   * 本地 AI 的客观判定（PRD §5.5）。
   * **只做标注**：AI 绝不自动移动或删除任何文件，采纳与否由 DIT 决定。
   */
  judgement?: AssetJudgement;
}

export interface AssetPage {
  items: SortingAsset[];
  total: number;
}

/**
 * 分类夹。固定项与自定义分类统一表达，前端不硬编码顺序。
 * - inbox：`1. 待分类`
 * - custom：建项目时定义的分类，绑定数字键 1–9
 * - curated：`精选`（P 键，复制一份进「待修」）
 * - other：`其他`（O 键）
 */
export type SortingCategoryKind = "inbox" | "custom" | "curated" | "other";

export interface SortingCategory {
  id: string;
  /** 显示名，不含序号 */
  name: string;
  /** 落盘夹名，含序号，如 `2. 领导` */
  folderName: string;
  kind: SortingCategoryKind;
  count: number;
  /** 数字键绑定（1–9），仅 custom 有 */
  hotkey?: number;
}

/**
 * 批量操作结果。**必须能表达部分失败**——
 * 一次移动 200 张时有 3 张失败，界面要精确恢复这 3 张的选中态。
 */
export interface BulkResult {
  succeeded: string[];
  failed: Array<{ assetId: string; message: string }>;
}

/** 回收站条目（`.ocard/trash`，两段式删除的第二段落点） */
export interface TrashEntry {
  id: string;
  fileName: string;
  sizeBytes: number;
  /** 删除前的项目内相对路径，恢复时按此还原 */
  originalPath: string;
  trashedAt: string;
  operator: string;
}

/** 缩略图索引进度（后端事件 `index://progress` 推送） */
export interface IndexingStatus {
  projectId: string;
  indexed: number;
  total: number;
  running: boolean;
  /** 索引失败的文件数：不阻断流程，但必须可见 */
  failed: number;
  /** 索引期间被移走的文件数：信息性，不计入失败 */
  missing: number;
  /**
   * 索引轮次，每次重启索引 +1。
   * 「新一轮」必须靠它判定——靠 indexed 数值猜会在「两轮恰好停在同一数值」时失效，
   * 也无法区分「还没开始」与「刚跑完」。
   */
  round: number;
}

export interface IndexProgressEvent extends IndexingStatus {
  occurredAt: string;
}

/* ------------------------------------------------------------------ *
 * 交付打包（PRD §5.7，工况 B）
 * ------------------------------------------------------------------ */

/** 一个交付包 = 一个半天时段的文件夹（不压缩） */
export interface DeliveryPackage {
  /** 包文件夹名，如 `0824上午` */
  name: string;
  fileCount: number;
  bytes: number;
}

/**
 * 打包失败项。三种语义严重程度差别很大，界面必须分开呈现：
 * - `name-collision`：同名但内容不同 → **未交付**，需人工核对，红色
 * - `manifest-error`：文件已交付成功，只是清单没写上 → 重跑可补齐，黄色
 * - `error`：其他真失败
 *
 * 「此前已交付且 hash 一致」不再是失败项，改由 `DeliverySummary.alreadyDelivered` 计数。
 */
export type DeliveryFailureKind = "name-collision" | "error" | "manifest-error";

export interface DeliveryFailure {
  assetId: string;
  message: string;
  kind?: DeliveryFailureKind;
}

export interface DeliverySummary {
  packages: DeliveryPackage[];
  totalFiles: number;
  totalBytes: number;
  /** 重跑时已在包内且 hash 一致的数量——正常结果，不是失败 */
  alreadyDelivered: number;
  failures: DeliveryFailure[];
  /** 交付根目录（含清单），绝对路径 */
  deliveryPath: string;
}

/* ------------------------------------------------------------------ *
 * 跨机协同（规范 §6.3 / PRD §6.3）
 * ------------------------------------------------------------------ */

/**
 * 其他工作站在本项目上进行中的拷卡（24h 内未完成的）。
 * 用途只有一个：让两名 DIT 看见对方正在拷哪张卡，避免重复拷同一张。
 * 它是**提示**而非锁——不阻断任何操作。
 */
export interface RemoteActivity {
  machine: string;
  operator: string;
  /** 活动类型：拷卡 vs 转码，界面措辞不同 */
  activity: "copy" | "transcode";
  /** 源卷名 */
  volume: string;
  /** 相机编码 */
  camera: string;
  targetFolder: string;
  startedAt: string;
}

/* ------------------------------------------------------------------ *
 * 后台作业（M3 W2：交付由同步命令改为后台作业）
 * ------------------------------------------------------------------ */

export type JobKind = "delivery" | "transcode" | "analyze";

export type JobState = "queued" | "running" | "done" | "failed" | "cancelled";

/**
 * 终态：done / failed / cancelled。
 *
 * 与后端 `JobState::is_terminal` 同义。取消路径必须先问这一句——
 * 对已经结束的作业发取消，后端会回一句「将在当前文件完成后停止」，
 * 而它根本不会再停任何东西，那是假话。
 */
export function isJobTerminal(state: JobState): boolean {
  return state === "done" || state === "failed" || state === "cancelled";
}

/** 作业快照的公共字段 */
interface JobBase {
  id: string;
  projectId: string;
  state: JobState;
  done: number;
  total: number;
  bytesDone: number;
  /** 当前正在处理的文件名等进度描述 */
  message?: string;
  /** 单调递增，用于乱序保护——沿 `copy://progress` 的既有模式 */
  revision: number;
  startedAt: string;
  finishedAt?: string;
  error?: string;
}

/**
 * 后台作业快照，**按 kind 判别的联合类型**。
 *
 * 终态语义：
 * - `done`：`result` 是该 kind 对应的结果类型
 * - `failed`：`error` 为原因
 * - `cancelled`：`result` 为空；已完成量看 `done`/`total`
 */
export interface DeliveryJob extends JobBase {
  kind: "delivery";
  result?: DeliverySummary;
}

export interface TranscodeJob extends JobBase {
  kind: "transcode";
  /**
   * 代理与归档共用 kind = "transcode"，结果因此是两种之一，
   * 由结果自带的 `mode` 判别字段分流（后端 ProxyResultDto / ArchiveResultDto
   * 都显式写死这个值）。不做结构嗅探——字段有无是实现细节，判别字段才是契约。
   */
  result?: ProxyResult | ArchiveResult;
}

export interface AnalyzeJob extends JobBase {
  kind: "analyze";
  result?: AnalysisResult;
}

export type JobSnapshot = DeliveryJob | TranscodeJob | AnalyzeJob;

/** 归档结果与代理结果的判别：认后端显式下发的 `mode`，不认字段结构 */
export function isArchiveResult(
  result: ProxyResult | ArchiveResult | undefined,
): result is ArchiveResult {
  return result?.mode === "archive";
}

/** 判别辅助：拿到具体 kind 才能安全读 result */
export function isDeliveryJob(job: JobSnapshot): job is DeliveryJob {
  return job.kind === "delivery";
}

export function isTranscodeJob(job: JobSnapshot): job is TranscodeJob {
  return job.kind === "transcode";
}

/* ------------------------------------------------------------------ *
 * 转码（M3 W5/W6）
 * ------------------------------------------------------------------ */

export interface FfmpegInfo {
  version: string;
  ffmpegPath: string;
  ffprobePath: string;
}

/** sidecar 探测结果：missing 时整个转码入口都要禁用并说明原因 */
export type FfmpegStatus =
  | { status: "ready"; info: FfmpegInfo }
  | { status: "missing"; error: string };

/** 一次能力探测：[能力, 编码器, 是否可用] */
export type CapabilityProbe = [string, string, boolean];

export interface CapabilityReport {
  ffmpeg: FfmpegInfo;
  /** 每种能力最终选中的编码器 */
  winners: Record<string, string>;
  probes: CapabilityProbe[];
  probedAt: string;
}

/** 能力矩阵。probing 时需要轮询直到 ready / failed */
export interface TranscodeCapabilities {
  status: "idle" | "probing" | "ready" | "failed";
  report?: CapabilityReport;
  error?: string;
}

export interface ProxySkipped {
  rel: string;
  reason: string;
}

export interface ProxyFailure {
  rel: string;
  message: string;
}

/** 代理转码作业的结果（kind = "transcode" 且 done 时） */
export interface ProxyResult {
  /** 判别字段：代理与归档共用 kind，靠它分流 */
  mode: "proxy";
  converted: number;
  alreadyTranscoded: number;
  skipped: ProxySkipped[];
  failures: ProxyFailure[];
  usedEncoder: string;
  outputDir: string;
}

/** 归档转码档位（PRD §5.6 三档压缩） */
export type ArchiveTier = "quality" | "balanced" | "compact";

export interface ArchiveResult {
  /** 判别字段：代理与归档共用 kind，靠它分流 */
  mode: "archive";
  converted: number;
  alreadyArchived: number;
  failures: ProxyFailure[];
  usedEncoder: string;
  outputDir: string;
}

export interface StartArchiveInput {
  projectId: string;
  cameraFolders?: string[];
  tier: ArchiveTier;
  /** 归档输出目录，必须是项目**之外**的绝对路径 */
  outputDir: string;
}

export interface StartProxyInput {
  projectId: string;
  cameraFolders?: string[];
  /** 忽略「高负载」判定，把所有素材都纳入——**不会**重转已有输出 */
  forceAll?: boolean;
  /** 强制重转：先删除已有代理再转。破坏性操作，必须经二次确认 */
  retranscode?: boolean;
}

/* ------------------------------------------------------------------ *
 * 本地 AI 分析（M3 W7a，PRD §5.5）
 * ------------------------------------------------------------------ */

export interface AssetJudgement {
  groupId?: string;
  /**
   * 综合质量分，量纲 **0–100**（后端 `(sharpness - penalty).clamp(0, 100)`）。
   * 界面只用区间表达，不显示数值。
   */
  score: number;
  /**
   * 检出人脸数。
   *
   * `null` / 缺省 = **本次分析时人脸检测不可用**（模型缺失、推理失败），
   * 与「检出 0 张脸」是两回事：前者是不知道，后者是知道没有。
   * 界面不许把 null 呈现成「无人脸」。
   */
  faces?: number | null;
  blurry: boolean;
  overExposed: boolean;
  underExposed: boolean;
  /** 组内建议保留项。**只是建议**，不触发任何文件操作 */
  suggestedKeep: boolean;
}

export interface AnalysisFailure {
  rel: string;
  message: string;
}

export interface AnalysisResult {
  analyzed: number;
  cached: number;
  missing: number;
  failed: AnalysisFailure[];
  /** 已抽好首帧图的视频数 */
  videoThumbs: number;
  /** 因转码引擎缺失而没抽成首帧图的视频数；>0 必须让用户看见，不能静默 */
  videoThumbsSkipped: number;
  /** 分析缓存里被跳过的损坏行数（降级但不阻断） */
  cacheSkippedLines: number;
}

/* ------------------------------------------------------------------ *
 * 成片命名校验与交付状态（M3 W8）
 * ------------------------------------------------------------------ */

export interface FinalCutItem {
  fileName: string;
  valid: boolean;
  issues: string[];
  /** 识别出的用途/版本分类，如 "预览版" / "成品" */
  class?: string;
  parsed?: Record<string, string>;
  /**
   * 分辨率与命名声明不符时的**说明原文**（如「名字写 4K，实际 1280x720」）。
   * 缺省 = 相符或未核对。后端下发的是原因字符串，不是布尔——
   * 只当真假用会把唯一能说清「哪儿不符」的信息丢掉。
   */
  resolutionMismatch?: string;
  /** 无法校验（探测失败等），附原因 */
  uncheckable?: string;
}

export interface FinalCutReport {
  items: FinalCutItem[];
  warnings: string[];
}

/** 「待修 → 已修」流转提示：待修里的原稿已经有成品了 */
export interface CuratedFlowHint {
  todoAssetId: string;
  doneFileName: string;
}

export interface DeliveryStatus {
  uploaded: boolean;
  updatedBy?: string;
  updatedAt?: string;
}

/* ------------------------------------------------------------------ *
 * 业务审计日志（PRD §5.10）
 * ------------------------------------------------------------------ */

/**
 * 项目级审计事件的 kind。
 *
 * **这是一份"已知清单"，不是白名单**：后端随时可能加新 kind，
 * 界面必须对未收录的值也给出体面呈现（回落到原始字符串 + 中性语气），
 * 绝不能因为不认识就丢掉一条记录——丢记录就是静默 fail-open。
 * 登记类事件（相机/存储卡）落在全局 registry 日志里，不出现在项目级。
 */
export type KnownAuditKind =
  | "copy_started"
  | "copy_completed"
  | "copy_file_failed"
  | "assets_moved"
  | "assets_curated"
  | "assets_trashed"
  | "assets_restored"
  | "trash_emptied"
  | "delivery_built"
  | "delivery_cancelled"
  | "transcode_started"
  | "transcode_completed"
  | "transcode_cancelled"
  | "transcode_failed";

/**
 * 一条审计事件。
 *
 * `kind` 用 `KnownAuditKind | (string & {})` 而不是纯枚举：既保留已知值的
 * 自动补全，又如实表达"后端可能下发新值"这一事实——把它约束成闭集会诱使
 * 调用方写出无处理分支的穷举，等新 kind 上线时界面就哑了。
 */
export interface AuditEventDto {
  /** RFC3339 时间戳 */
  ts: string;
  /** 产生该事件的工作站标识 */
  machine: string;
  /** 当时登记的操作人（DIT 名） */
  operator: string;
  kind: KnownAuditKind | (string & {});
  /**
   * 事件明细。**结构随 kind 而异且不受前端约束**，因此类型只能是 unknown：
   * 任何取值都必须先做运行时探测（见 `lib/audit.ts`），不许直接断言。
   */
  data: unknown;
}
