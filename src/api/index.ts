/**
 * 类型化接口层：UI 只经由本文件与后端交流。
 *
 * 当前全部返回 mock 数据；Rust 侧实现同名 tauri command 后，把每个函数体
 * 换成注释里标注的 `invoke(...)` 即可，函数签名与类型保持不变。
 * 命名约定：tauri command 名 = 本文件函数名的 snake_case 形式。
 */

import {
  mockCameras,
  mockCopyTasks,
  mockCategories,
  mockIndexing,
  mockInspection,
  mockPendingAssets,
  mockTrash,
  mockProjects,
  mockStorageCards,
  mockVolumes,
  mockWorkstation,
} from "./mock";
import { buildFolderTree } from "../lib/folderTree";
import {
  buildCameraCode,
  buildCopyTargetFolder,
  buildProjectFolderName,
  copyTargetParent,
  inferTimeSlot,
} from "../lib/naming";
import type {
  CameraReg,
  CopyFileItem,
  CopyProgressEvent,
  CopyTask,
  AssetPage,
  BulkResult,
  CopyTaskPreview,
  FolderNode,
  IndexingStatus,
  IndexProgressEvent,
  SortingCategory,
  TrashEntry,
  NoticeDto,
  UpdateCheckResult,
  NewCameraInput,
  NewProjectInput,
  NewStorageCardInput,
  Project,
  Scenario,
  StartCopyInput,
  StorageCard,
  Volume,
  VolumeInspection,
  WorkstationInfo,
} from "./types";

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getVersion } from "@tauri-apps/api/app";

/** 运行在 Tauri 里时走真实 IPC;浏览器/vitest 环境回退 mock */
const IS_TAURI =
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

function ipc<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  return invoke<T>(cmd, args);
}

/** 模拟一次 IPC 往返的延迟，让加载态在开发期真实可见 */
const IPC_DELAY_MS = 120;

function reply<T>(value: T): Promise<T> {
  return new Promise((resolve) => setTimeout(() => resolve(value), IPC_DELAY_MS));
}

function nextId(prefix: string): string {
  return `${prefix}-${Math.random().toString(36).slice(2, 9)}`;
}

/* ------------------------------------------------------------------ *
 * 工作站
 * ------------------------------------------------------------------ */

/** 当前工作站身份与 NAS 根路径（PRD §6.3） */
export function getWorkstationInfo(): Promise<WorkstationInfo> {
  if (IS_TAURI) return ipc("get_workstation_info");
  return reply(mockWorkstation);
}

/**
 * 保存本机的操作人与 NAS 根路径。
 * 操作人会随每条审计事件落盘（PRD §5.10），NAS 根路径是本机私有配置
 * （项目状态内只存相对路径，各机路径形式不同不影响互通，PRD §6.3）。
 */
export function setWorkstationInfo(
  operator: string,
  nasRoot: string,
): Promise<WorkstationInfo> {
  if (IS_TAURI) return ipc("set_workstation_info", { operator, nasRoot });
  // mock 回退：就地更新，后续 getWorkstationInfo 能读到同一份
  Object.assign(mockWorkstation, {
    operator: operator.trim(),
    nasRoot: nasRoot.trim(),
  });
  return reply({ ...mockWorkstation });
}

/* ------------------------------------------------------------------ *
 * 项目
 * ------------------------------------------------------------------ */

/** 列出 NAS 根下的全部项目（合并各机 journal 后的重放结果） */
export function listProjects(): Promise<Project[]> {
  if (IS_TAURI) return ipc("list_projects");
  return reply(mockProjects);
}

/** 取单个项目详情 */
export function getProject(projectId: string): Promise<Project | null> {
  if (IS_TAURI) return ipc("get_project", { projectId });
  return reply(mockProjects.find((p) => p.id === projectId) ?? null);
}

/**
 * 新建项目：按工况建夹并写入首条 journal 事件。
 * Rust 侧须复用与 `buildFolderTree` 等价的模板规则。
 */
export function createProject(input: NewProjectInput): Promise<Project> {
  if (IS_TAURI) return ipc("create_project", { input });
  const folderName = buildProjectFolderName(input.date, input.name);
  const project: Project = {
    id: nextId("p"),
    name: input.name.trim(),
    date: input.date,
    folderName,
    scenario: input.scenario,
    categories: input.scenario === "B" ? input.categories : [],
    relativePath: folderName,
    status: "draft",
    cardsCopied: 0,
    cardsTotal: 0,
    bytesCopied: 0,
    assetCount: 0,
    sortedCount: 0,
    destinationCount: 2,
    updatedAt: new Date().toISOString(),
  };
  return reply(project);
}

/** 建夹模板预览（前端本地即可算出，保留接口以便后端校验一致性） */
export function previewFolderTree(
  scenario: Scenario,
  categories: string[],
): Promise<FolderNode[]> {
  if (IS_TAURI) return ipc("preview_folder_tree", { scenario, categories });
  return reply(buildFolderTree(scenario, categories));
}

/* ------------------------------------------------------------------ *
 * 设备与存储卡登记（全项目共享，存 NAS）
 * ------------------------------------------------------------------ */

export function listCameras(): Promise<CameraReg[]> {
  if (IS_TAURI) return ipc("list_cameras");
  return reply(mockCameras);
}

export function createCamera(input: NewCameraInput): Promise<CameraReg> {
  if (IS_TAURI) return ipc("create_camera", { input });
  const camera: CameraReg = {
    id: nextId("cam"),
    model: input.model.trim(),
    position: input.position.trim().toUpperCase(),
    operatorAlias: input.operatorAlias.trim().toUpperCase(),
    code: buildCameraCode(input.model, input.position, input.operatorAlias),
    note: input.note?.trim() || undefined,
    createdAt: new Date().toISOString(),
  };
  return reply(camera);
}

export function deleteCamera(cameraId: string): Promise<void> {
  if (IS_TAURI) return ipc("delete_camera", { cameraId });
  void cameraId;
  return reply(undefined);
}

export function listStorageCards(): Promise<StorageCard[]> {
  if (IS_TAURI) return ipc("list_storage_cards");
  return reply(mockStorageCards);
}

export function createStorageCard(
  input: NewStorageCardInput,
): Promise<StorageCard> {
  if (IS_TAURI) return ipc("create_storage_card", { input });
  const card: StorageCard = {
    id: nextId("card"),
    label: input.label.trim(),
    cameraId: input.cameraId,
    capacityBytes: input.capacityBytes,
    serial: input.serial?.trim() || undefined,
    createdAt: new Date().toISOString(),
  };
  return reply(card);
}

export function deleteStorageCard(cardId: string): Promise<void> {
  if (IS_TAURI) return ipc("delete_storage_card", { cardId });
  void cardId;
  return reply(undefined);
}

/* ------------------------------------------------------------------ *
 * 卷与拷卡
 * ------------------------------------------------------------------ */

/** 当前插入的可移动卷（PRD §6.5，Rust 侧同时以事件推送插拔） */
export function listVolumes(): Promise<Volume[]> {
  if (IS_TAURI) return ipc("list_volumes");
  return reply(mockVolumes);
}

export function listCopyTasks(projectId?: string): Promise<CopyTask[]> {
  if (IS_TAURI) return ipc("list_copy_tasks", { projectId });
  const tasks = projectId
    ? mockCopyTasks.filter((t) => t.projectId === projectId)
    : mockCopyTasks;
  return reply(tasks);
}

export function getCopyTask(taskId: string): Promise<CopyTask | null> {
  if (IS_TAURI) return ipc("get_copy_task", { taskId });
  return reply(mockCopyTasks.find((t) => t.id === taskId) ?? null);
}

/** 双确认通过后发起拷卡；返回创建出的任务 */
export function startCopyTask(input: StartCopyInput): Promise<CopyTask> {
  if (IS_TAURI) return ipc("start_copy_task", { input });
  const template = mockCopyTasks[0];
  const volume = mockVolumes.find((v) => v.id === input.volumeId);
  const camera = mockCameras.find((c) => c.id === input.cameraId);
  // 前缀由人工确认后传入，不在这里按当前时钟臆测
  const prefix = input.targetPrefix;

  const task: CopyTask = {
    ...template,
    id: nextId("task"),
    projectId: input.projectId,
    volumeId: input.volumeId,
    volumeName: volume?.name ?? "未知卷",
    cameraId: input.cameraId,
    cameraCode: camera?.code ?? "",
    targetFolder: buildCopyTargetFolder(prefix, camera?.code ?? ""),
    note: input.note,
    destinations: input.destinations.map((d, i) => ({
      id: nextId(`d${i}`),
      kind: d.kind,
      path: d.path,
      state: "idle",
      writtenBytes: 0,
    })),
    copiedBytes: 0,
    speedBytesPerSec: 0,
    state: "running",
    startedAt: new Date().toISOString(),
    finishedAt: undefined,
  };
  return reply(task);
}

/**
 * 预览拷卡任务的真实落盘位置（不落任何数据）。
 * 入参与 start_copy_task 完全一致，供双确认屏展示解析后的真值。
 */
export function previewCopyTask(input: StartCopyInput): Promise<CopyTaskPreview> {
  if (IS_TAURI) return ipc("preview_copy_task", { input });

  // mock 回退：按与 Rust 侧一致的规则本地拼一个合理值
  const camera = mockCameras.find((c) => c.id === input.cameraId);
  const project = mockProjects.find((p) => p.id === input.projectId);
  const cameraCode = camera?.code ?? "";
  const targetFolder = buildCopyTargetFolder(input.targetPrefix, cameraCode);
  const parent = copyTargetParent(project?.scenario ?? "B");
  const projectFolder = project?.folderName ?? "";

  return reply({
    targetFolder,
    destinations: input.destinations.map((d, i) => ({
      id: `preview-${i}`,
      kind: d.kind,
      // NAS 目的地由项目结构推导，用户填的路径会被后端忽略
      path:
        d.kind === "nas"
          ? `${mockWorkstation.nasRoot}/${projectFolder}/${parent}/${targetFolder}`
          : `${d.path.replace(/\/+$/, "")}/${projectFolder}/${parent}/${targetFolder}`,
      state: "idle" as const,
      writtenBytes: 0,
    })),
  });
}

/** 挂起任务（NAS 断连或人工暂停），按 manifest 可续传 */
export function pauseCopyTask(taskId: string): Promise<void> {
  if (IS_TAURI) return ipc("pause_copy_task", { taskId });
  void taskId;
  return reply(undefined);
}

export function resumeCopyTask(taskId: string): Promise<void> {
  if (IS_TAURI) return ipc("resume_copy_task", { taskId });
  void taskId;
  return reply(undefined);
}

/** 单文件重试（失败文件不作废整个任务，PRD §6.4） */
export function retryCopyFile(taskId: string, fileId: string): Promise<void> {
  if (IS_TAURI) return ipc("retry_copy_file", { taskId, fileId });
  void taskId;
  void fileId;
  return reply(undefined);
}

/** 分页取任务文件明细（千张素材不可一次全量过 IPC） */
export function listCopyFiles(
  taskId: string,
  offset = 0,
  limit = 200,
): Promise<{ items: CopyFileItem[]; total: number }> {
  if (IS_TAURI) return ipc("list_copy_files", { taskId, offset, limit });
  const files = mockCopyTasks.find((t) => t.id === taskId)?.files ?? [];
  return reply({ items: files.slice(offset, offset + limit), total: files.length });
}

/** 探查源卷：素材时间范围 + 建议时段前缀（PRD §5.3「从素材时间戳自动推断，可改」） */
export function inspectVolume(volumeId: string): Promise<VolumeInspection> {
  if (IS_TAURI) return ipc("inspect_volume", { volumeId });
  const volume = mockVolumes.find((v) => v.id === volumeId);
  return reply({
    volumeId,
    fileCount: mockInspection.fileCount,
    totalBytes: volume?.usedBytes ?? 0,
    earliestShotAt: mockInspection.earliestShotAt,
    latestShotAt: mockInspection.latestShotAt,
    // 时段按最早一张素材的拍摄时间推断，不是按当前时钟
    suggestedPrefix: inferTimeSlot(mockInspection.earliestShotAt),
  });
}

/**
 * 订阅拷卡进度事件。**常驻单一监听**：应用启动即建立，直到卸载。
 *
 * 不按 taskId 过滤——过滤会造成订阅断裂：任务转 paused 后监听被拆除，
 * 点「继续」后端在发事件却没有监听者；小任务也可能在监听建立前就结束、
 * 丢掉终态事件。归约交给 reducer 按 taskId 处理。
 *
 * `listen()` 返回 Promise<UnlistenFn>，这里包成可同步调用的 disposer，
 * 并处理「组件先卸载、unlisten 后返回」以及 listen 本身失败的情况。
 */
export function subscribeCopyProgress(
  onEvent: (event: CopyProgressEvent) => void,
  onError?: (error: unknown) => void,
): () => void {
  if (IS_TAURI) {
    let disposed = false;
    let unlisten: (() => void) | null = null;
    listen<CopyProgressEvent>("copy://progress", (e) => {
      if (!disposed) onEvent(e.payload);
    })
      .then((fn) => {
        // 可能在 listen 完成前就卸载：此时立刻退订，不留悬空监听
        if (disposed) fn();
        else unlisten = fn;
      })
      .catch((err) => {
        // 监听建立失败必须让上层知道，否则界面会一直「静默不动」
        if (!disposed) onError?.(err);
      });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }
  const tracked = mockCopyTasks.filter((t) => t.state === "running");
  if (tracked.length === 0) return () => {};

  const progress = new Map(tracked.map((t) => [t.id, t.copiedBytes]));
  const revisions = new Map(tracked.map((t) => [t.id, 0]));
  let disposed = false;

  const timer = setInterval(() => {
    if (disposed) return;
    let stillRunning = false;

    for (const task of tracked) {
      const copied = Math.min(
        task.totalBytes,
        (progress.get(task.id) ?? 0) + task.speedBytesPerSec,
      );
      progress.set(task.id, copied);
      const revision = (revisions.get(task.id) ?? 0) + 1;
      revisions.set(task.id, revision);

      const done = copied >= task.totalBytes;
      if (!done) stillRunning = true;

      onEvent({
        taskId: task.id,
        revision,
        occurredAt: new Date().toISOString(),
        copiedBytes: copied,
        speedBytesPerSec: done ? 0 : task.speedBytesPerSec,
        state: done ? "verifying" : "running",
        changedFiles: [],
        changedDestinations: task.destinations.map((d) => ({
          id: d.id,
          state: done ? ("verifying" as const) : d.state,
          writtenBytes: copied,
        })),
      });
    }

    if (!stillRunning) clearInterval(timer);
  }, 1000);

  return () => {
    disposed = true;
    clearInterval(timer);
  };
}

/* ------------------------------------------------------------------ *
 * 通知
 * ------------------------------------------------------------------ */

/**
 * 事件订阅句柄：`ready` 在监听真正注册完成后 settle，供调用方串行化后续动作。
 * 通知通道与索引进度通道共用同一形态。
 */
export interface EventSubscription {
  dispose: () => void;
  /** listen() 注册完成后 resolve；注册失败则 reject */
  ready: Promise<void>;
}

/**
 * 订阅后端通知（降级/失败必须可见，不允许静默 fail-open）。
 *
 * 与进度订阅同构：常驻单一监听，可同步调用的 disposer，处理「卸载早于 listen 返回」。
 * 额外暴露 `ready`——回放必须等监听真正注册完成后再发起，否则「注册完成前、
 * 回放取数之后」这段窗口里产生的通知两头都收不到，照样丢信。
 */
export function subscribeNotices(
  onNotice: (notice: NoticeDto) => void,
  onError?: (error: unknown) => void,
): EventSubscription {
  if (IS_TAURI) {
    let disposed = false;
    let unlisten: (() => void) | null = null;
    const ready = listen<NoticeDto>("app://notice", (e) => {
      if (!disposed) onNotice(e.payload);
    })
      .then((fn) => {
        if (disposed) fn();
        else unlisten = fn;
      })
      .catch((err) => {
        if (!disposed) onError?.(err);
        throw err;
      });
    return {
      dispose: () => {
        disposed = true;
        unlisten?.();
      },
      ready,
    };
  }
  // 浏览器/测试环境没有后端推送；测试通过 spy 注入通知
  return { dispose: () => {}, ready: Promise.resolve() };
}

/**
 * 拉取后端积压的通知（启动早期发出的那些，订阅建立前就已产生）。
 * 不这样回放一次就会丢信——而丢信正是「静默 fail-open」的一种。
 */
export function listNotices(): Promise<NoticeDto[]> {
  if (IS_TAURI) return ipc("list_notices");
  return reply([]);
}

/* ------------------------------------------------------------------ *
 * 关于与更新
 * ------------------------------------------------------------------ */

/** 当前应用版本 */
export function getAppVersion(): Promise<string> {
  if (IS_TAURI) return getVersion();
  return reply("0.1.0");
}

/**
 * 安装已下载好的更新并重启。
 * 有拷卡任务在跑时后端会拒绝，并返回中文原因——直接展示给用户。
 */
export function installUpdate(): Promise<void> {
  if (IS_TAURI) return ipc("install_update");
  return reply(undefined);
}

/** 手动检查更新；失败详情由后端经 app://notice 推送 */
export function checkForUpdate(): Promise<UpdateCheckResult> {
  if (IS_TAURI) return ipc("check_for_update");
  return reply("uptodate");
}

/* ------------------------------------------------------------------ *
 * 分类工作台（PRD §5.4）
 * ------------------------------------------------------------------ */

/** 后端对单页条数的硬上限；超出会被静默截断，所以客户端先夹住 */
export const MAX_ASSET_PAGE_LIMIT = 500;

/**
 * 分页列出待分类素材（千张级，绝不一次全量过 IPC）。
 * limit 超过 500 时后端会截断，这里提前夹住——否则调用方会以为拿到了 600 条，
 * 而按「已加载条数」推进的 offset 就会跳过中间那批。
 */
export function listPendingAssets(
  projectId: string,
  offset = 0,
  limit = 200,
): Promise<AssetPage> {
  const capped = Math.min(Math.max(1, limit), MAX_ASSET_PAGE_LIMIT);
  if (IS_TAURI) return ipc("list_pending_assets", { projectId, offset, limit: capped });
  return reply({
    items: mockPendingAssets.slice(offset, offset + capped),
    total: mockPendingAssets.length,
  });
}

/** 分类夹清单（含固定项），带各自计数 */
export function listCategories(projectId: string): Promise<SortingCategory[]> {
  if (IS_TAURI) return ipc("list_categories", { projectId });
  void projectId;
  return reply(mockCategories);
}

/** 移动到某个分类夹；返回逐条结果，部分失败必须能表达 */
export function moveAssets(
  projectId: string,
  assetIds: string[],
  categoryId: string,
): Promise<BulkResult> {
  if (IS_TAURI) return ipc("move_assets", { projectId, assetIds, categoryId });
  return reply({ succeeded: assetIds, failed: [] });
}

/** 标精选：复制一份进「精选/待修」，原件留在原处（PRD §5.4） */
export function curateAssets(
  projectId: string,
  assetIds: string[],
): Promise<BulkResult> {
  if (IS_TAURI) return ipc("curate_assets", { projectId, assetIds });
  return reply({ succeeded: assetIds, failed: [] });
}

/**
 * 移入项目内回收站。**这是两段式删除的第二段**——
 * 第一段「标记」纯在前端，后端只接受人工确认过的批次，且绝不物理删除。
 */
export function trashAssets(
  projectId: string,
  assetIds: string[],
): Promise<BulkResult> {
  if (IS_TAURI) return ipc("trash_assets", { projectId, assetIds });
  return reply({ succeeded: assetIds, failed: [] });
}

export function listTrash(projectId: string): Promise<TrashEntry[]> {
  if (IS_TAURI) return ipc("list_trash", { projectId });
  void projectId;
  return reply(mockTrash);
}

export function restoreFromTrash(
  projectId: string,
  entryIds: string[],
): Promise<BulkResult> {
  if (IS_TAURI) return ipc("restore_from_trash", { projectId, entryIds });
  return reply({ succeeded: entryIds, failed: [] });
}

/** 清空回收站：**唯一真正物理删除**的入口，调用方必须已做不可逆确认 */
export function emptyTrash(projectId: string): Promise<{ removed: number }> {
  if (IS_TAURI) return ipc("empty_trash", { projectId });
  void projectId;
  return reply({ removed: mockTrash.length });
}

/** 缩略图索引进度快照（事件推送之外的兜底） */
export function indexingStatus(projectId: string): Promise<IndexingStatus> {
  if (IS_TAURI) return ipc("indexing_status", { projectId });
  return reply({ ...mockIndexing, projectId });
}

/** 订阅索引进度事件（`index://progress`），与通知订阅同构 */
export function subscribeIndexProgress(
  onEvent: (event: IndexProgressEvent) => void,
  onError?: (error: unknown) => void,
): EventSubscription {
  if (IS_TAURI) {
    let disposed = false;
    let unlisten: (() => void) | null = null;
    const ready = listen<IndexProgressEvent>("index://progress", (e) => {
      if (!disposed) onEvent(e.payload);
    })
      .then((fn) => {
        if (disposed) fn();
        else unlisten = fn;
      })
      .catch((err) => {
        if (!disposed) onError?.(err);
        throw err;
      });
    return {
      dispose: () => {
        disposed = true;
        unlisten?.();
      },
      ready,
    };
  }
  return { dispose: () => {}, ready: Promise.resolve() };
}
