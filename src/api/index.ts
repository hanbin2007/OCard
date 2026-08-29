/**
 * 类型化接口层：UI 只经由本文件与后端交流。
 *
 * 当前全部返回 mock 数据；Rust 侧实现同名 tauri command 后，把每个函数体
 * 换成注释里标注的 `invoke(...)` 即可，函数签名与类型保持不变。
 * 命名约定：tauri command 名 = 本文件函数名的 snake_case 形式。
 */

import {
  mockCancelJob,
  mockStartAnalysis,
  mockStartArchive,
  mockStartProxyTranscode,
  mockGetJob,
  mockListJobs,
  mockStartDelivery,
  mockSubscribeJobs,
} from "./mockJobs";
import {
  mockAuditLog,
  mockCameras,
  mockCopyTasks,
  mockCapabilities,
  mockCategories,
  mockDeliveryStatus,
  mockFinalCuts,
  mockFlowHints,
  mockDiagnostics,
  mockFfmpegStatus,
  mockFullPreview,
  mockIndexing,
  mockInspection,
  mockPendingAssets,
  mockTrash,
  mockProjects,
  mockProjectCards,
  mockProjectSettings,
  mockSourceFolders,
  mockSourcePlan,
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
  AuditEventDto,
  CameraReg,
  CopyFileItem,
  CopyProgressEvent,
  CopyTask,
  AssetPage,
  BulkResult,
  FullPreview,
  CopyTaskPreview,
  AnalyzeJob,
  CuratedFlowHint,
  DeliveryStatus,
  FfmpegStatus,
  FinalCutReport,
  JobSnapshot,
  RemoteActivity,
  StartArchiveInput,
  StartProxyInput,
  TranscodeCapabilities,
  TranscodeJob,
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
  ProjectCards,
  ProjectSettings,
  Scenario,
  SourceFolder,
  SourcePlan,
  StartCopyInput,
  StorageCard,
  Volume,
  VolumeInspection,
  WorkstationInfo,
  VolumesChangedEvent,
} from "./types";

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { getVersion } from "@tauri-apps/api/app";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { open as openDialog } from "@tauri-apps/plugin-dialog";

/** 运行在 Tauri 里时走真实 IPC;浏览器/vitest 环境回退 mock */
const IS_TAURI =
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

/** 原生文件夹选择器是否可用（浏览器预览/vitest 里没有）。函数形式便于测试替换。 */
export function canPickFolder(): boolean {
  return IS_TAURI;
}

/**
 * 弹原生「选择文件夹」对话框。用户取消返回 null。
 * 所有要填路径的地方都应该挂上它——手打绝对路径只作为兜底（UX 波）。
 */
export async function pickFolder(options?: {
  title?: string;
  defaultPath?: string;
}): Promise<string | null> {
  if (!IS_TAURI) return reply(null);
  const picked = await openDialog({
    directory: true,
    multiple: false,
    title: options?.title,
    ...(options?.defaultPath ? { defaultPath: options.defaultPath } : {}),
  });
  return typeof picked === "string" ? picked : null;
}

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
 * 窗口编排（欢迎/项目管理窗口 ↔ 主窗口）
 *
 * Tauri 下是真正的多窗口：启动先见 `welcome` 窗口，主窗口隐藏待命；
 * 打开项目由 Rust 负责「显示主窗口 + 投递项目 + 销毁欢迎窗」。
 * 浏览器/测试环境只有一个窗口，这些函数退化为 no-op，由
 * `state/windowBridge` 在同一窗口内切视图。
 * ------------------------------------------------------------------ */

/** 是否运行在 Tauri 里（窗口桥接层据此选择真多窗口或单窗口内切视图） */
export function isTauri(): boolean {
  return IS_TAURI;
}

/** 当前运行在哪个窗口。浏览器环境恒为 "main"（单窗口内切视图）。 */
export function windowRole(): "main" | "welcome" {
  if (!IS_TAURI) return "main";
  return getCurrentWebviewWindow().label === "welcome" ? "welcome" : "main";
}

/**
 * 在主窗口中打开项目（欢迎窗口调用）：
 * Rust 记录本机最近打开、显示并聚焦主窗口、把 projectId 投递过去，
 * 最后销毁欢迎窗口。
 */
export function openProjectInMain(projectId: string): Promise<void> {
  if (IS_TAURI) return ipc("open_project_window", { projectId });
  // 浏览器退化路径由 windowBridge 承接；这里只记最近打开
  return recordRecentProjectMock(projectId);
}

/** 打开欢迎/项目管理窗口（主窗口侧栏调用；不存在则重建） */
export function openManagerWindow(): Promise<void> {
  if (IS_TAURI) return ipc("open_manager_window");
  return Promise.resolve();
}

/**
 * 主窗口启动时取一次「待打开项目」：主窗口可能是被 open_project_window
 * 现场重建的，事件早于监听注册就会丢——pending 由 Rust 暂存、这里消费。
 */
export function takePendingOpenProject(): Promise<string | null> {
  if (IS_TAURI) return ipc("take_pending_open_project");
  return Promise.resolve(null);
}

/** 订阅「打开项目」投递（app://open-project，欢迎窗口 → 主窗口） */
export function subscribeOpenProject(
  onOpen: (projectId: string) => void,
  onError?: (error: unknown) => void,
): () => void {
  if (!IS_TAURI) return () => {};
  let disposed = false;
  let unlisten: (() => void) | null = null;
  listen<{ projectId: string }>("app://open-project", (e) => {
    if (!disposed) onOpen(e.payload.projectId);
  })
    .then((fn) => {
      if (disposed) fn();
      else unlisten = fn;
    })
    .catch((err) => {
      if (!disposed) onError?.(err);
    });
  return () => {
    disposed = true;
    unlisten?.();
  };
}

/** mock 环境的最近打开记录（就地更新，欢迎视图立即可见） */
function recordRecentProjectMock(projectId: string): Promise<void> {
  const project = mockProjects.find((p) => p.id === projectId);
  if (project) {
    mockWorkstation.recentProjects = [
      {
        id: project.id,
        name: project.name,
        folderName: project.folderName,
        scenario: project.scenario,
        lastOpenedAt: new Date().toISOString(),
      },
      ...mockWorkstation.recentProjects.filter((r) => r.id !== projectId),
    ].slice(0, 10);
  }
  return reply(undefined);
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
    copyIncomplete: false,
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

/** 项目用卡清单:x/y 的真分母(可编辑、可套用登记表模板;UX 波三) */
export function listProjectCards(projectId: string): Promise<ProjectCards> {
  if (IS_TAURI) return ipc("list_project_cards", { projectId });
  return reply(mockProjectCards[projectId] ?? { cardIds: [], copiedCardIds: [] });
}

/**
 * 原子追加一张卡到项目用卡清单(快捷拷卡)。后端写可交换的增量事件,
 * 两台工作站同时各加一张不会像整表覆盖那样互相丢(评审 P0)。
 */
export function addProjectCard(
  projectId: string,
  cardId: string,
): Promise<ProjectCards> {
  if (IS_TAURI) return ipc("add_project_card", { projectId, cardId });
  const current = mockProjectCards[projectId] ?? { cardIds: [], copiedCardIds: [] };
  const next = {
    cardIds: current.cardIds.includes(cardId)
      ? current.cardIds
      : [...current.cardIds, cardId],
    copiedCardIds: current.copiedCardIds,
  };
  mockProjectCards[projectId] = next;
  return reply(next);
}

export function setProjectCards(
  projectId: string,
  cardIds: string[],
): Promise<ProjectCards> {
  if (IS_TAURI) return ipc("set_project_cards", { projectId, cardIds });
  const next = {
    cardIds: [...new Set(cardIds)],
    copiedCardIds: (mockProjectCards[projectId]?.copiedCardIds ?? []).filter((id) =>
      cardIds.includes(id),
    ),
  };
  mockProjectCards[projectId] = next;
  return reply({ ...next });
}

/**
 * 项目级设置：内容标签库 + 备份目的地预设。
 * 存于 `<项目>/.ocard/settings.json`——数据跟着项目走，
 * 任何工作站打开同一项目看到同一套标签与预设。
 */
export function getProjectSettings(projectId: string): Promise<ProjectSettings> {
  if (IS_TAURI) return ipc("get_project_settings", { projectId });
  return reply(
    structuredClone(
      mockProjectSettings[projectId] ?? { tags: [], backupPaths: [] },
    ),
  );
}

/** 整体保存项目设置（末写胜出；标签库变更频度低，可接受） */
export function saveProjectSettings(
  projectId: string,
  settings: ProjectSettings,
): Promise<ProjectSettings> {
  if (IS_TAURI) return ipc("save_project_settings", { projectId, settings });
  mockProjectSettings[projectId] = structuredClone(settings);
  return reply(structuredClone(settings));
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
    volumeUid: input.bindMountPath ? nextId("uid") : undefined,
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
  // mock 也守同一条契约：按文件夹拷必须带双确认屏的绑定令牌，
  // 缺了就拒——绝不悄悄放行成整卷（后端同此，见 start_copy_task）
  if ((input.sourceFolders?.length ?? 0) > 0 && !input.planDigest) {
    return Promise.reject(
      new Error(
        "按文件夹拷卡必须带上双确认屏返回的 planDigest（缺少它就无法确认你批准的范围与改名清单还成立）",
      ),
    );
  }
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
    tags: [...input.tags],
    // 「拷完能不能说本卡可格式化」的唯一判据，必须跟着任务走
    sourceFolders: [...(input.sourceFolders ?? [])],
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

/**
 * 列出卡内可勾选的文件夹（契约 2026-08-28）。
 *
 * 勾一个文件夹只拷它的**直接子文件**；子目录不递归，子目录自身是列表里
 * 另一条独立条目。只列「含直接子文件」或「含子目录」的，空目录不列。
 */
export function listSourceFolders(volumeId: string): Promise<SourceFolder[]> {
  if (IS_TAURI) return ipc("list_source_folders", { volumeId });
  return reply(mockSourceFolders(volumeId));
}

/**
 * 核算这次源选择的规模与改名清单（契约 2026-08-28）。
 *
 * 进双确认屏时调用。`folders` 为空 = 整卷（整卷保留原层级，不会撞名，
 * `renamedFiles` 恒为空）。它与 `previewCopyTask` 是两件事：那个解析
 * **落盘路径**，这个回答**拷多少、谁被改名**，不许合成一个命令。
 *
 * 返回的 `planDigest` 是这次批准的绑定令牌，发起拷卡时必须原样回传；
 * 后端重扫后比对不上会返回 `PLAN_CHANGED:`（卡上内容在确认之后变了）。
 *
 * `confirmInstanceId` 是**确认页实例**的稳定 id（页面存活期间不变，换一次确认屏
 * 换一个）。后端的计划快照缓存只有 16 个槽，带上它之后**同一个确认页**来回改
 * 勾选、重试核算只占一个槽，不会把别的确认屏正在用的那份挤掉。
 *
 * 不传也能用（退化成「TTL + 按时间淘汰」），但多个确认屏并发时快照可能被挤掉——
 * 而快照正是 `PLAN_CHANGED` 报文说得出「多了哪几个文件」「勾选差在哪」的唯一来源，
 * 丢了就只剩泛化原因。所以有 id 就一定带上；没有时**不发这个键**（而不是发
 * `undefined`），让后端收到干净的 `None`，请求体与老客户端逐字节一致。
 */
export function planSourceSelection(
  volumeId: string,
  folders: string[],
  confirmInstanceId?: string,
): Promise<SourcePlan> {
  if (IS_TAURI) {
    return ipc("plan_source_selection", {
      volumeId,
      folders,
      ...(confirmInstanceId ? { confirmInstanceId } : {}),
    });
  }
  return reply(mockSourcePlan(volumeId, folders, confirmInstanceId));
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
        // 真实读卡速度不是常数：加 ±15% 抖动，速度曲线在浏览器演示里才有形状
        speedBytesPerSec: done
          ? 0
          : Math.round(task.speedBytesPerSec * (0.85 + Math.random() * 0.3)),
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
 * 订阅卷插拔事件(快捷拷卡):后端监视线程 2s 轮询挂载表,有插拔即推。
 * 与其它订阅同构。浏览器/测试环境无后端推送,测试直接驱动 store action。
 */
/** 插卡检测是否可用(真后端才有卷监视线程;mock 环境无「开机前已插卡」概念) */
export function volumesWatchAvailable(): boolean {
  return IS_TAURI;
}

export function subscribeVolumesChanged(
  onEvent: (event: VolumesChangedEvent) => void,
  onError?: (error: unknown) => void,
): () => void {
  if (IS_TAURI) {
    let disposed = false;
    let unlisten: (() => void) | null = null;
    listen<VolumesChangedEvent>("volumes://changed", (e) => {
      if (!disposed) onEvent(e.payload);
    })
      .then((fn) => {
        if (disposed) fn();
        else unlisten = fn;
      })
      .catch((err) => {
        if (!disposed) onError?.(err);
      });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }
  return () => {};
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
export const MAX_ASSET_PAGE_LIMIT = 200;

/**
 * 分页列出待分类素材（千张级，绝不一次全量过 IPC）。
 * limit 超过上限时后端会截断，这里提前夹住——否则调用方会以为拿到了更多，
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

/**
 * 按需取一张素材的**全尺寸**预览（全屏预览专用）。
 *
 * 只在打开全屏时调用：整库全尺寸解码是几十 GB 的事，绝不能进索引阶段。
 * 后端解好落本机有界缓存，返回一个可直接放进 `<img src>` 的 `preview://` URL。
 *
 * **失败一律 reject**，`Error.message` 是一句说清原因的话（RAW 未接 libraw /
 * 视频未接抽帧 / 超出像素上限 / 文件损坏 …）。调用方必须把它显示出来——
 * 静默停在缩略图上，正是这条 bug 本身。
 */
export function loadFullPreview(
  projectId: string,
  assetId: string,
): Promise<FullPreview> {
  if (IS_TAURI) return ipc("load_full_preview", { projectId, assetId });
  return mockFullPreview(assetId);
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
export function emptyTrash(
  projectId: string,
): Promise<{ removed: number; failed: number }> {
  if (IS_TAURI) return ipc("empty_trash", { projectId });
  void projectId;
  return reply({ removed: mockTrash.length, failed: 0 });
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

/* ------------------------------------------------------------------ *
 * 交付打包（PRD §5.7）
 * ------------------------------------------------------------------ */

/** 在 Finder / 资源管理器里定位到该路径 */
export function revealPath(path: string): Promise<void> {
  if (IS_TAURI) return revealItemInDir(path);
  // 浏览器/测试环境没有文件管理器可调
  void path;
  return Promise.resolve();
}

/* ------------------------------------------------------------------ *
 * 跨机协同
 * ------------------------------------------------------------------ */

/**
 * 其他工作站在本项目上进行中的拷卡。
 * 数据来自各机 journal 的合并重放，SMB 上没有可靠变更通知，所以由前端轮询。
 */
export function listRemoteActivity(projectId: string): Promise<RemoteActivity[]> {
  if (IS_TAURI) return ipc("list_remote_activity", { projectId });
  void projectId;
  return reply([]);
}

/* ------------------------------------------------------------------ *
 * 后台作业（M3 W2）
 * ------------------------------------------------------------------ */

/**
 * 发起交付打包作业（立即返回快照，实际工作在后台）。
 * 零覆盖与「取消也按实况写清单」由后端保证，前端只负责如实呈现。
 */
export function startDelivery(projectId: string): Promise<JobSnapshot> {
  if (IS_TAURI) return ipc("start_delivery", { projectId });
  return reply(mockStartDelivery(projectId));
}

export function listJobs(): Promise<JobSnapshot[]> {
  if (IS_TAURI) return ipc("list_jobs");
  return reply(mockListJobs());
}

export function getJob(jobId: string): Promise<JobSnapshot | null> {
  if (IS_TAURI) return ipc("get_job", { jobId });
  return reply(mockGetJob(jobId));
}

export function cancelJob(jobId: string): Promise<JobSnapshot> {
  if (IS_TAURI) return ipc("cancel_job", { jobId });
  return reply(mockCancelJob(jobId));
}

/**
 * 订阅作业进度（`job://progress`，≥500ms 节流 + 终态必发）。
 * 与通知/索引订阅同构：暴露 `ready`，调用方必须在 ready 之后用 listJobs 对账一次，
 * 否则订阅注册前就跑完的作业会丢掉终态（M2 #13 的同型竞态）。
 */
export function subscribeJobProgress(
  onEvent: (job: JobSnapshot) => void,
  onError?: (error: unknown) => void,
): EventSubscription {
  if (IS_TAURI) {
    let disposed = false;
    let unlisten: (() => void) | null = null;
    const ready = listen<JobSnapshot>("job://progress", (e) => {
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
  const dispose = mockSubscribeJobs(onEvent);
  return { dispose, ready: Promise.resolve() };
}

/* ------------------------------------------------------------------ *
 * 转码（M3 W5/W6）
 * ------------------------------------------------------------------ */

/** ffmpeg sidecar 状态；missing 时整个转码入口都要禁用并说明原因 */
export function ffmpegStatus(): Promise<FfmpegStatus> {
  if (IS_TAURI) return ipc("ffmpeg_status");
  return reply(mockFfmpegStatus);
}

/**
 * 硬件编码能力矩阵。
 * status = "probing" 时调用方需轮询，直到 ready / failed 才停——
 * 这两个是仅有的终态，别把 idle 也当成终态。
 */
export function transcodeCapabilities(
  refresh = false,
): Promise<TranscodeCapabilities> {
  if (IS_TAURI) return ipc("transcode_capabilities", { refresh });
  return reply(mockCapabilities(refresh));
}

/** 诊断导出（不含任何素材路径） */
export function transcodeDiagnostics(): Promise<Record<string, unknown>> {
  if (IS_TAURI) return ipc("transcode_diagnostics");
  return reply(mockDiagnostics);
}

/**
 * 发起归档转码作业（kind 仍是 "transcode"，结果是 ArchiveResultDto）。
 * 归档输出到项目之外的目录，是独立副本，不改动原始素材。
 */
export function startArchiveTranscode(
  input: StartArchiveInput,
): Promise<TranscodeJob> {
  if (IS_TAURI) return ipc("start_archive_transcode", { input });
  return reply(mockStartArchive(input.projectId));
}

/** 发起代理转码作业（kind = "transcode"，进度走既有 job://progress） */
export function startProxyTranscode(input: StartProxyInput): Promise<TranscodeJob> {
  if (IS_TAURI) return ipc("start_proxy_transcode", { input });
  return reply(mockStartProxyTranscode(input.projectId));
}

/* ------------------------------------------------------------------ *
 * 本地 AI 分析（M3 W7a）
 * ------------------------------------------------------------------ */

/**
 * 发起本地分析作业（kind = "analyze"）。
 * AI 只产出标注，**绝不移动或删除任何文件**——采纳与否由 DIT 决定（PRD §5.5）。
 */
export function startAnalysis(projectId: string): Promise<AnalyzeJob> {
  if (IS_TAURI) return ipc("start_analysis", { projectId });
  return reply(mockStartAnalysis(projectId));
}

/* ------------------------------------------------------------------ *
 * 成片校验与交付状态（M3 W8）
 * ------------------------------------------------------------------ */

/** 成片命名校验（工况 A，PRD §5.8） */
export function checkFinalCuts(projectId: string): Promise<FinalCutReport> {
  if (IS_TAURI) return ipc("check_final_cuts", { projectId });
  void projectId;
  return reply(mockFinalCuts);
}

/** 「待修 → 已修」流转提示（工况 B，PRD §5.4） */
export function curatedFlowHints(projectId: string): Promise<CuratedFlowHint[]> {
  if (IS_TAURI) return ipc("curated_flow_hints", { projectId });
  void projectId;
  return reply(mockFlowHints);
}

export function getDeliveryStatus(projectId: string): Promise<DeliveryStatus> {
  if (IS_TAURI) return ipc("get_delivery_status", { projectId });
  void projectId;
  // 返回副本：真实 IPC 每次都是新对象，mock 若返回同一引用会让调用方
  // 「不回读也能看到更新」，测试因此丧失分辨力
  return reply({ ...mockDeliveryStatus });
}

/* ------------------------------------------------------------------ *
 * 业务审计日志（PRD §5.10）
 * ------------------------------------------------------------------ */

/**
 * 列出该项目的全量业务审计事件（拷卡/分类/交付/转码），**倒序**（最新在前）。
 *
 * 后端合并各机 journal 后重放，因此列表里会出现别台工作站产生的事件——
 * 这正是它的用处：谁在哪台机上动了什么，事后能对得上。
 * 登记类事件（相机/存储卡）属于全局 registry，不在项目级日志里。
 */
export function listAuditLog(projectId: string): Promise<AuditEventDto[]> {
  if (IS_TAURI) return ipc("list_audit_log", { projectId });
  // mock 回退：与 listTrash 等同构，单一样例时间线，不按项目分叉
  void projectId;
  return reply(mockAuditLog);
}

/** 人工勾选「已上传网盘」——OCard 不代传，只记录状态（PRD §5.7） */
export function setDeliveryStatus(
  projectId: string,
  uploaded: boolean,
): Promise<DeliveryStatus> {
  if (IS_TAURI) return ipc("set_delivery_status", { projectId, uploaded });
  Object.assign(mockDeliveryStatus, {
    uploaded,
    updatedBy: mockWorkstation.operator,
    updatedAt: new Date().toISOString(),
  });
  return reply({ ...mockDeliveryStatus });
}
