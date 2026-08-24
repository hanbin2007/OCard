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
  | { type: "taskProgress"; event: CopyProgressEvent };

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
      return {
        ...state,
        tasks: state.tasks.map((task) => {
          if (task.id !== event.taskId) return task;
          // 丢弃乱序/过期事件
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
        }),
      };
    }

    default:
      return state;
  }
}

interface StoreValue {
  state: AppState;
  dispatch: Dispatch<AppAction>;
  /** bootstrap 失败后重试 */
  reload: () => void;
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

  // 进度订阅集中在这里，只按「进行中任务的 id 集合」重建，
  // 不随每次进度事件重订阅（否则永远从头开始，进度卡住）。
  const runningTaskKey = state.tasks
    .filter((t) => t.state === "running" || t.state === "verifying")
    .map((t) => t.id)
    .join(",");

  useEffect(() => {
    if (!runningTaskKey) return;
    return api.subscribeCopyProgress(runningTaskKey.split(","), (event) => {
      dispatch({ type: "taskProgress", event });
    });
  }, [runningTaskKey]);

  const value = useMemo(() => ({ state, dispatch, reload }), [state, reload]);
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
