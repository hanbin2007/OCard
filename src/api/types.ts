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
   * v1 用 base64 data URL 直接内联。
   * 为空 = 尚未索引到 / 无可用预览，UI 显示占位而不是空白。
   */
  thumbnail?: string;
  kind: SortingAssetKind;
  /** 连拍组 id；同组的会折叠显示（PRD §5.4） */
  groupId?: string;
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
  /** 源卷名 */
  volume: string;
  /** 相机编码 */
  camera: string;
  targetFolder: string;
  startedAt: string;
}
