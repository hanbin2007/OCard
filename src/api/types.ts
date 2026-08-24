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

export interface CopyFileItem {
  id: string;
  /** 源卡内相对路径 */
  path: string;
  name: string;
  sizeBytes: number;
  status: CopyFileStatus;
  /** xxHash3-64，16 位十六进制；未算出时为空 */
  hash?: string;
  /** status === 'failed' 时的原因 */
  error?: string;
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
  files: CopyFileItem[];
  totalBytes: number;
  copiedBytes: number;
  /** 实时速度，字节/秒 */
  speedBytesPerSec: number;
  state: CopyTaskState;
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
  /** 目的地路径列表，至少一个 */
  destinations: Array<{ kind: DestinationKind; path: string }>;
  /** 拷完自动转代理（工况 A，PRD §5.6） */
  autoProxy?: boolean;
}

/** 拷卡进度事件；Rust 侧经 tauri event 推送 */
export interface CopyProgressEvent {
  taskId: string;
  copiedBytes: number;
  speedBytesPerSec: number;
  state: CopyTaskState;
  /** 本次增量变化的文件 */
  changedFiles: Array<Pick<CopyFileItem, "id" | "status" | "hash" | "error">>;
}

/** 当前工作站身份（PRD §6.3） */
export interface WorkstationInfo {
  machineId: string;
  /** 当前登记的 DIT 名 */
  operator: string;
  /** 本机配置的 NAS 根路径 */
  nasRoot: string;
}
