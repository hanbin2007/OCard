/**
 * 轻量全局状态：Context + useReducer，不引状态库。
 * 数据一律经 `src/api` 拉取，reducer 只负责本地合并与路由。
 */

import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  type Dispatch,
  type ReactNode,
} from "react";
import * as api from "../api";
import type {
  CameraReg,
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
  workstation: WorkstationInfo | null;
  projects: Project[];
  cameras: CameraReg[];
  cards: StorageCard[];
  volumes: Volume[];
  tasks: CopyTask[];
  selectedProjectId: string | null;
  selectedTaskId: string | null;
}

export type AppAction =
  | { type: "navigate"; route: RouteName }
  | { type: "bootstrapped"; payload: Omit<AppState, "route" | "loading" | "selectedProjectId" | "selectedTaskId"> }
  | { type: "selectProject"; projectId: string | null }
  | { type: "selectTask"; taskId: string | null }
  | { type: "projectCreated"; project: Project }
  | { type: "cameraCreated"; camera: CameraReg }
  | { type: "cameraRemoved"; cameraId: string }
  | { type: "cardCreated"; card: StorageCard }
  | { type: "cardRemoved"; cardId: string }
  | { type: "taskStarted"; task: CopyTask }
  | { type: "taskProgress"; taskId: string; copiedBytes: number; speedBytesPerSec: number };

export const initialState: AppState = {
  route: "projects",
  loading: true,
  workstation: null,
  projects: [],
  cameras: [],
  cards: [],
  volumes: [],
  tasks: [],
  selectedProjectId: null,
  selectedTaskId: null,
};

export function reducer(state: AppState, action: AppAction): AppState {
  switch (action.type) {
    case "navigate":
      return { ...state, route: action.route };

    case "bootstrapped":
      return {
        ...state,
        ...action.payload,
        loading: false,
        selectedProjectId: state.selectedProjectId ?? action.payload.projects[0]?.id ?? null,
        selectedTaskId: state.selectedTaskId ?? action.payload.tasks[0]?.id ?? null,
      };

    case "selectProject":
      return { ...state, selectedProjectId: action.projectId };

    case "selectTask":
      return { ...state, selectedTaskId: action.taskId };

    case "projectCreated":
      return {
        ...state,
        projects: [action.project, ...state.projects],
        selectedProjectId: action.project.id,
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

    case "taskProgress":
      return {
        ...state,
        tasks: state.tasks.map((task) =>
          task.id === action.taskId
            ? {
                ...task,
                copiedBytes: action.copiedBytes,
                speedBytesPerSec: action.speedBytesPerSec,
              }
            : task,
        ),
      };

    default:
      return state;
  }
}

interface StoreValue {
  state: AppState;
  dispatch: Dispatch<AppAction>;
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

  useEffect(() => {
    if (skipBootstrap) return;
    let cancelled = false;

    void (async () => {
      const [workstation, projects, cameras, cards, volumes, tasks] = await Promise.all([
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
    })();

    return () => {
      cancelled = true;
    };
  }, [skipBootstrap]);

  const value = useMemo(() => ({ state, dispatch }), [state]);
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
