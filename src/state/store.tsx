/**
 * 轻量全局状态：Context + useReducer，不引状态库。
 * 数据一律经 `src/api` 拉取，reducer 只负责本地合并与路由。
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useState,
  type Dispatch,
  type ReactNode,
} from "react";
import * as api from "../api";
import type {
  CameraReg,
  CopyDestination,
  CopyFileItem,
  CopyProgressEvent,
  CopyTask,
  Project,
  StorageCard,
  Volume,
  WorkstationInfo,
} from "../api/types";

export type RouteName = "projects" | "new-project" | "devices" | "copy";

export interface AppState {
  route: RouteName;
  loading: boolean;
  /** bootstrap 失败原因（NAS 断连等），非空时展示重试入口 */
  error: string | null;
  workstation: WorkstationInfo | null;
  projects: Project[];
  cameras: CameraReg[];
  cards: StorageCard[];
  volumes: Volume[];
  tasks: CopyTask[];
  selectedProjectId: string | null;
  selectedTaskId: string | null;
  /** 工作站设置对话框是否打开 */
  settingsOpen: boolean;
  /**
   * 收到了事件、但本地还没有这个任务（别的窗口/重启后重建的任务，
   * 或快照还没拉回来）。先按 taskId 缓存最新一条，拉到快照后补上。
   */
  orphanProgress: Record<string, CopyProgressEvent>;
  /** 进度监听建立失败：界面要说出来，不能假装一切正常 */
  progressError: string | null;
}

type BootstrapPayload = Pick<
  AppState,
  "workstation" | "projects" | "cameras" | "cards" | "volumes" | "tasks"
>;

export type AppAction =
  | { type: "navigate"; route: RouteName }
  | { type: "loadStarted" }
  | { type: "bootstrapped"; payload: BootstrapPayload }
  | { type: "loadFailed"; error: string }
  | { type: "selectProject"; projectId: string | null }
  | { type: "selectTask"; taskId: string | null }
  | { type: "projectCreated"; project: Project }
  | { type: "cameraCreated"; camera: CameraReg }
  | { type: "cameraRemoved"; cameraId: string }
  | { type: "cardCreated"; card: StorageCard }
  | { type: "cardRemoved"; cardId: string }
  | { type: "taskStarted"; task: CopyTask }
  | { type: "taskProgress"; event: CopyProgressEvent }
  | { type: "settingsOpened" }
  | { type: "settingsClosed" }
  | { type: "workstationUpdated"; workstation: WorkstationInfo }
  | { type: "taskSnapshot"; task: CopyTask }
  | { type: "progressListenFailed"; error: string };

export const initialState: AppState = {
  route: "projects",
  loading: true,
  error: null,
  workstation: null,
  projects: [],
  cameras: [],
  cards: [],
  volumes: [],
  tasks: [],
  selectedProjectId: null,
  selectedTaskId: null,
  settingsOpen: false,
  orphanProgress: {},
  progressError: null,
};

/** 把增量事件合并进文件列表；未在事件里出现的文件保持原样 */
function mergeFiles(
  files: CopyFileItem[],
  changed: CopyProgressEvent["changedFiles"],
): CopyFileItem[] {
  if (changed.length === 0) return files;
  const patch = new Map(changed.map((c) => [c.id, c]));
  return files.map((file) => {
    const next = patch.get(file.id);
    return next ? { ...file, ...next } : file;
  });
}

function mergeDestinations(
  destinations: CopyDestination[],
  changed: CopyProgressEvent["changedDestinations"],
): CopyDestination[] {
  if (changed.length === 0) return destinations;
  const patch = new Map(changed.map((c) => [c.id, c]));
  return destinations.map((dest) => {
    const next = patch.get(dest.id);
    return next ? { ...dest, ...next } : dest;
  });
}

/** 把一条进度事件合并进任务；乱序/过期事件原样返回 */
function applyProgress(task: CopyTask, event: CopyProgressEvent): CopyTask {
  if (task.progressRevision !== undefined && event.revision <= task.progressRevision) {
    return task;
  }
  return {
    ...task,
    progressRevision: event.revision,
    copiedBytes: event.copiedBytes,
    speedBytesPerSec: event.speedBytesPerSec,
    state: event.state,
    files: mergeFiles(task.files, event.changedFiles),
    destinations: mergeDestinations(task.destinations, event.changedDestinations),
  };
}

export function reducer(state: AppState, action: AppAction): AppState {
  switch (action.type) {
    case "navigate":
      return { ...state, route: action.route };

    case "loadStarted":
      return { ...state, loading: true, error: null };

    case "bootstrapped":
      return {
        ...state,
        ...action.payload,
        loading: false,
        error: null,
        selectedProjectId:
          state.selectedProjectId ?? action.payload.projects[0]?.id ?? null,
        selectedTaskId: state.selectedTaskId ?? action.payload.tasks[0]?.id ?? null,
      };

    case "loadFailed":
      return { ...state, loading: false, error: action.error };

    case "selectProject": {
      // 切项目时任务选中跟着切，避免显示 A 项目标题配 B 项目文件
      const nextTask =
        state.tasks.find((t) => t.projectId === action.projectId)?.id ?? null;
      return { ...state, selectedProjectId: action.projectId, selectedTaskId: nextTask };
    }

    case "selectTask":
      return { ...state, selectedTaskId: action.taskId };

    case "projectCreated":
      return {
        ...state,
        projects: [action.project, ...state.projects],
        selectedProjectId: action.project.id,
        selectedTaskId: null,
        route: "projects",
      };

    case "cameraCreated":
      return { ...state, cameras: [...state.cameras, action.camera] };

    case "cameraRemoved":
      return {
        ...state,
        cameras: state.cameras.filter((c) => c.id !== action.cameraId),
        cards: state.cards.filter((c) => c.cameraId !== action.cameraId),
      };

    case "cardCreated":
      return { ...state, cards: [...state.cards, action.card] };

    case "cardRemoved":
      return { ...state, cards: state.cards.filter((c) => c.id !== action.cardId) };

    case "taskStarted":
      return {
        ...state,
        tasks: [action.task, ...state.tasks],
        selectedTaskId: action.task.id,
      };

    case "taskProgress": {
      const { event } = action;
      const known = state.tasks.some((t) => t.id === event.taskId);
      if (!known) {
        // 不认识的 taskId：缓存最新一条，等快照拉回来再补
        const buffered = state.orphanProgress[event.taskId];
        if (buffered && buffered.revision >= event.revision) return state;
        return {
          ...state,
          orphanProgress: { ...state.orphanProgress, [event.taskId]: event },
        };
      }
      return {
        ...state,
        tasks: state.tasks.map((task) =>
          task.id === event.taskId ? applyProgress(task, event) : task,
        ),
      };
    }

    case "taskSnapshot": {
      // 快照对账：以后端为准，再把期间缓存的事件补上
      const buffered = state.orphanProgress[action.task.id];
      const merged = buffered ? applyProgress(action.task, buffered) : action.task;
      const exists = state.tasks.some((t) => t.id === merged.id);
      const rest = { ...state.orphanProgress };
      delete rest[merged.id];
      return {
        ...state,
        tasks: exists
          ? state.tasks.map((t) => (t.id === merged.id ? merged : t))
          : [merged, ...state.tasks],
        orphanProgress: rest,
      };
    }

    case "progressListenFailed":
      return { ...state, progressError: action.error };

    case "settingsOpened":
      return { ...state, settingsOpen: true };

    case "settingsClosed":
      return { ...state, settingsOpen: false };

    case "workstationUpdated":
      return { ...state, workstation: action.workstation, settingsOpen: false };

    default:
      return state;
  }
}

interface StoreValue {
  state: AppState;
  dispatch: Dispatch<AppAction>;
  /** bootstrap 失败后重试 */
  reload: () => void;
  /** 与后端对账某个任务的最新快照 */
  refreshTask: (taskId: string) => Promise<void>;
}

const StoreContext = createContext<StoreValue | null>(null);

export function StoreProvider({
  children,
  preloaded,
}: {
  children: ReactNode;
  /** 测试可注入初始状态，跳过异步 bootstrap */
  preloaded?: Partial<AppState>;
}) {
  const [state, dispatch] = useReducer(reducer, {
    ...initialState,
    ...preloaded,
    loading: preloaded ? false : initialState.loading,
  });

  const skipBootstrap = preloaded !== undefined;
  const [reloadToken, setReloadToken] = useState(0);
  const reload = useCallback(() => setReloadToken((n) => n + 1), []);

  useEffect(() => {
    if (skipBootstrap) return;
    let cancelled = false;
    dispatch({ type: "loadStarted" });

    void (async () => {
      try {
        const [workstation, projects, cameras, cards, volumes, tasks] =
          await Promise.all([
            api.getWorkstationInfo(),
            api.listProjects(),
            api.listCameras(),
            api.listStorageCards(),
            api.listVolumes(),
            api.listCopyTasks(),
          ]);
        if (cancelled) return;
        dispatch({
          type: "bootstrapped",
          payload: { workstation, projects, cameras, cards, volumes, tasks },
        });
      } catch (err) {
        if (cancelled) return;
        dispatch({
          type: "loadFailed",
          error: err instanceof Error ? err.message : "读取 NAS 项目状态失败",
        });
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [skipBootstrap, reloadToken]);

  /**
   * 常驻单一监听：应用启动即建立，整个生命周期只此一个，绝不按任务状态拆建。
   * 之前按「进行中任务 id」重建订阅会造成订阅断裂——任务转 paused 后监听被拆掉，
   * 点「继续」后端在发事件却没人听；小任务也可能在监听建立前就跑完丢掉终态。
   */
  useEffect(() => {
    return api.subscribeCopyProgress(
      (event) => dispatch({ type: "taskProgress", event }),
      (err) =>
        dispatch({
          type: "progressListenFailed",
          error:
            err instanceof Error
              ? `进度监听未能建立：${err.message}`
              : "进度监听未能建立，界面可能不会自动刷新",
        }),
    );
  }, []);

  /** 拉一次任务快照与后端对账（start/resume/retry 之后调用） */
  const refreshTask = useCallback(async (taskId: string) => {
    const task = await api.getCopyTask(taskId);
    if (task) dispatch({ type: "taskSnapshot", task });
  }, []);

  // 收到了不认识的 taskId 的事件：把快照拉回来补上
  const orphanIds = Object.keys(state.orphanProgress).join(",");
  useEffect(() => {
    if (!orphanIds) return;
    let cancelled = false;
    void (async () => {
      for (const id of orphanIds.split(",")) {
        try {
          const task = await api.getCopyTask(id);
          if (!cancelled && task) dispatch({ type: "taskSnapshot", task });
        } catch {
          // 拉不到就留在缓存里，下一条事件会再触发一次
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [orphanIds]);

  const value = useMemo(
    () => ({ state, dispatch, reload, refreshTask }),
    [state, reload, refreshTask],
  );
  return <StoreContext.Provider value={value}>{children}</StoreContext.Provider>;
}

export function useStore(): StoreValue {
  const ctx = useContext(StoreContext);
  if (!ctx) throw new Error("useStore 必须在 StoreProvider 内使用");
  return ctx;
}

/** 便捷选择器 */
export function useAppState(): AppState {
  return useStore().state;
}

export function useSelectedProject(): Project | null {
  const { projects, selectedProjectId } = useAppState();
  return projects.find((p) => p.id === selectedProjectId) ?? null;
}
