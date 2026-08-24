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
  mockInspection,
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
  inferTimeSlot,
} from "../lib/naming";
import type {
  CameraReg,
  CopyFileItem,
  CopyProgressEvent,
  CopyTask,
  FolderNode,
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
 * 订阅全部进行中任务的进度。
 *
 * 真实实现是 `listen("copy://progress")`（返回 Promise<UnlistenFn>），
 * 这里把它包成可同步调用的 disposer，并处理「组件先卸载、unlisten 后返回」。
 * 终态（done/failed）后自行停止，不留悬空定时器。
 */
export function subscribeCopyProgress(
  taskIds: string[],
  onEvent: (event: CopyProgressEvent) => void,
): () => void {
  if (IS_TAURI) {
    let disposed = false;
    let unlisten: (() => void) | null = null;
    void listen<CopyProgressEvent>("copy://progress", (e) => {
      if (!disposed && taskIds.includes(e.payload.taskId)) onEvent(e.payload);
    }).then((fn) => {
      // 组件可能在 listen 完成前就卸载:此时立刻退订,不留悬空监听
      if (disposed) fn();
      else unlisten = fn;
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }
  const tracked = mockCopyTasks.filter(
    (t) => taskIds.includes(t.id) && t.state === "running",
  );
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
