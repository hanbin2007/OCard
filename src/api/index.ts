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
  WorkstationInfo,
} from "./types";

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
  // TODO: tauri invoke("get_workstation_info")
  return reply(mockWorkstation);
}

/* ------------------------------------------------------------------ *
 * 项目
 * ------------------------------------------------------------------ */

/** 列出 NAS 根下的全部项目（合并各机 journal 后的重放结果） */
export function listProjects(): Promise<Project[]> {
  // TODO: tauri invoke("list_projects")
  return reply(mockProjects);
}

/** 取单个项目详情 */
export function getProject(projectId: string): Promise<Project | null> {
  // TODO: tauri invoke("get_project", { projectId })
  return reply(mockProjects.find((p) => p.id === projectId) ?? null);
}

/**
 * 新建项目：按工况建夹并写入首条 journal 事件。
 * Rust 侧须复用与 `buildFolderTree` 等价的模板规则。
 */
export function createProject(input: NewProjectInput): Promise<Project> {
  // TODO: tauri invoke("create_project", { input })
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
  // TODO: tauri invoke("preview_folder_tree", { scenario, categories })
  return reply(buildFolderTree(scenario, categories));
}

/* ------------------------------------------------------------------ *
 * 设备与存储卡登记（全项目共享，存 NAS）
 * ------------------------------------------------------------------ */

export function listCameras(): Promise<CameraReg[]> {
  // TODO: tauri invoke("list_cameras")
  return reply(mockCameras);
}

export function createCamera(input: NewCameraInput): Promise<CameraReg> {
  // TODO: tauri invoke("create_camera", { input })
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
  // TODO: tauri invoke("delete_camera", { cameraId })
  void cameraId;
  return reply(undefined);
}

export function listStorageCards(): Promise<StorageCard[]> {
  // TODO: tauri invoke("list_storage_cards")
  return reply(mockStorageCards);
}

export function createStorageCard(
  input: NewStorageCardInput,
): Promise<StorageCard> {
  // TODO: tauri invoke("create_storage_card", { input })
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
  // TODO: tauri invoke("delete_storage_card", { cardId })
  void cardId;
  return reply(undefined);
}

/* ------------------------------------------------------------------ *
 * 卷与拷卡
 * ------------------------------------------------------------------ */

/** 当前插入的可移动卷（PRD §6.5，Rust 侧同时以事件推送插拔） */
export function listVolumes(): Promise<Volume[]> {
  // TODO: tauri invoke("list_volumes")
  return reply(mockVolumes);
}

export function listCopyTasks(projectId?: string): Promise<CopyTask[]> {
  // TODO: tauri invoke("list_copy_tasks", { projectId })
  const tasks = projectId
    ? mockCopyTasks.filter((t) => t.projectId === projectId)
    : mockCopyTasks;
  return reply(tasks);
}

export function getCopyTask(taskId: string): Promise<CopyTask | null> {
  // TODO: tauri invoke("get_copy_task", { taskId })
  return reply(mockCopyTasks.find((t) => t.id === taskId) ?? null);
}

/** 双确认通过后发起拷卡；返回创建出的任务 */
export function startCopyTask(input: StartCopyInput): Promise<CopyTask> {
  // TODO: tauri invoke("start_copy_task", { input })
  const template = mockCopyTasks[0];
  const volume = mockVolumes.find((v) => v.id === input.volumeId);
  const camera = mockCameras.find((c) => c.id === input.cameraId);
  const project = mockProjects.find((p) => p.id === input.projectId);
  const prefix =
    project?.scenario === "A"
      ? project.date
      : inferTimeSlot(new Date().toISOString());

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
  // TODO: tauri invoke("pause_copy_task", { taskId })
  void taskId;
  return reply(undefined);
}

export function resumeCopyTask(taskId: string): Promise<void> {
  // TODO: tauri invoke("resume_copy_task", { taskId })
  void taskId;
  return reply(undefined);
}

/** 单文件重试（失败文件不作废整个任务，PRD §6.4） */
export function retryCopyFile(taskId: string, fileId: string): Promise<void> {
  // TODO: tauri invoke("retry_copy_file", { taskId, fileId })
  void taskId;
  void fileId;
  return reply(undefined);
}

/**
 * 订阅拷卡进度。
 * 真实实现走 tauri event（`listen("copy://progress")`）；
 * 这里用定时器产出等价形状的事件，便于 UI 壳阶段联调。
 */
export function subscribeCopyProgress(
  taskId: string,
  onEvent: (event: CopyProgressEvent) => void,
): () => void {
  // TODO: tauri invoke -> @tauri-apps/api/event listen("copy://progress")
  const task = mockCopyTasks.find((t) => t.id === taskId);
  if (!task || task.state !== "running") return () => {};

  let copied = task.copiedBytes;
  const timer = setInterval(() => {
    copied = Math.min(task.totalBytes, copied + task.speedBytesPerSec);
    onEvent({
      taskId,
      copiedBytes: copied,
      speedBytesPerSec: task.speedBytesPerSec,
      state: copied >= task.totalBytes ? "verifying" : "running",
      changedFiles: [],
    });
  }, 1000);

  return () => clearInterval(timer);
}
