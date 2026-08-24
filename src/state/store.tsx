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
  useRef,
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
  JobSnapshot,
  NoticeDto,
  NoticeLevel,
  Project,
  StorageCard,
  Volume,
  WorkstationInfo,
} from "../api/types";

export type RouteName =
  | "projects"
  | "new-project"
  | "devices"
  | "copy"
  | "sorting"
  | "trash";

/**
 * 通知中心条目：同 code 连续重复会折叠成一条并计数，避免刷屏。
 * `live` 表示还在即时呈现区（error 需手动确认，warning 数秒后自动收进铃铛）。
 */
export interface NoticeEntry {
  id: string;
  level: NoticeLevel;
  code: string;
  message: string;
  firstAt: string;
  lastAt: string;
  count: number;
  /** 上一条事件带的 repeats（后端窗口内累计值）；无 repeats 的路径记为 1 */
  lastRepeats: number;
  read: boolean;
  live: boolean;
}

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
  /** 通知中心：一切降级/失败都在这里可见，不允许静默 fail-open */
  notices: NoticeEntry[];
  noticesOpen: boolean;
  /** 生成稳定 id 用，保持 reducer 纯函数 */
  noticeSeq: number;
  /** 后台作业快照（交付/转码/分析）。打包互斥由它派生，不再另存布尔值。 */
  jobs: JobSnapshot[];
  /** 已摄入通知的 `code@occurredAt`，供启动回放去重 */
  noticeKeys: Record<string, true>;
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
  | { type: "noticeReceived"; notice: NoticeDto }
  | { type: "noticesReplayed"; notices: NoticeDto[] }
  | { type: "noticeAcknowledged"; id: string }
  | { type: "noticeToastDismissed"; id: string }
  | { type: "noticeDismissed"; id: string }
  | { type: "noticesCleared" }
  | { type: "noticesPanelToggled" }
  | { type: "noticesPanelClosed" }
  | { type: "jobsLoaded"; jobs: JobSnapshot[] }
  | { type: "jobProgress"; job: JobSnapshot };

/** 孤儿对账的退避档位：失败一次等 2s，再失败 5s，之后稳定在 10s */
const ORPHAN_BACKOFF_MS = [2000, 5000, 10000];

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
  notices: [],
  noticesOpen: false,
  noticeSeq: 0,
  noticeKeys: {},
  jobs: [],
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

/**
 * 快照对账要单调：in-flight 的 getCopyTask 可能比本地已归约到的事件更旧，
 * 直接覆盖会把进度回踩。比 revision，旧快照只补本地没有的字段。
 */
function mergeSnapshot(local: CopyTask | undefined, snapshot: CopyTask): CopyTask {
  if (!local) return snapshot;
  const localRev = local.progressRevision ?? -1;
  const snapRev = snapshot.progressRevision ?? -1;
  if (localRev <= snapRev) return snapshot;
  // 快照较旧：进度类字段保留本地事件推进出来的值，其余以快照为准
  return {
    ...snapshot,
    progressRevision: local.progressRevision,
    copiedBytes: local.copiedBytes,
    speedBytesPerSec: local.speedBytesPerSec,
    state: local.state,
    files: local.files.length > 0 ? local.files : snapshot.files,
    destinations:
      local.destinations.length > 0 ? local.destinations : snapshot.destinations,
  };
}

/**
 * 一条新事件相对上一条应当增加多少计数。
 * - 无 repeats：普通一条，+1
 * - repeats 增长（同一窗口内累计推进）：只补差值
 * - repeats 回落（后端换了新窗口，从 None/2 重新开始）：按新窗口的净增量补
 */
/** 折叠时回看的条数（与后端 backlog 的 rev().take(64) 同思路，取更保守的 20） */
const FOLD_LOOKBACK = 20;

export function repeatDelta(lastRepeats: number, repeats: number | undefined): number {
  if (repeats === undefined) return 1;
  if (repeats > lastRepeats) return repeats - lastRepeats;
  return Math.max(0, repeats - 1);
}

interface NoticeBucket {
  notices: NoticeEntry[];
  noticeSeq: number;
  noticeKeys: Record<string, true>;
}

/**
 * 摄入一条通知。
 *
 * 两层机制要分清：
 * - **同一条通知的双投递**（实时推送 + 启动回放拿到同一条）：靠会话级 seen 集
 *   （`code@occurredAt`）识别，直接跳过。两条路径查的是同一个集合，
 *   所以谁先到都一样，不会因为回放先归约就把后到的实时事件计成 ×2。
 * - **不同时刻的重复告警**（同 code、不同 occurredAt）：折叠成一条并计数 ×N，
 *   避免刷屏。
 */
/** ISO 时间戳比较：优先按时刻，解析不了再退回字符串序 */
function isNewerThan(a: string, b: string): boolean {
  const ta = Date.parse(a);
  const tb = Date.parse(b);
  if (Number.isNaN(ta) || Number.isNaN(tb)) return a > b;
  return ta > tb;
}

function ingestNotice(
  bucket: NoticeBucket,
  notice: NoticeDto,
  options: { live: boolean },
): NoticeBucket {
  const key = `${notice.code}@${notice.occurredAt}`;
  // 同一条通知无论从哪条路径先到，都只摄入一次
  if (bucket.noticeKeys[key]) return bucket;

  const keys: Record<string, true> = { ...bucket.noticeKeys, [key]: true };
  /*
   * repeats 是后端 30s 窗口内的**累计值**，窗口过期后新窗口从头再来
   * （典型序列：无, 2, 3, 无, 2）。所以既不能当增量累加（1,2,3 → ×6），
   * 也不能直接替换（跨窗口会把 ×5 打回 ×2）。
   * 正确做法是按「相对上一条 repeats 的增量」累加。
   */
  const repeats = notice.repeats;
  // 只比对最新一条会在「A,B,A」这种交错序列里把同 code 拆成两条，
  // repeats 也会因此重复计入。改为回看最近 FOLD_LOOKBACK 条。
  const foldIndex = bucket.notices
    .slice(0, FOLD_LOOKBACK)
    .findIndex((n) => n.code === notice.code && n.level === notice.level);
  const head = foldIndex >= 0 ? bucket.notices[foldIndex] : undefined;
  if (head) {
    // 回放拿到的是**更旧**的同 code 告警时，只加计数、把窗口向前延伸，
    // 绝不能把 lastAt/message 回写成旧值（那等于让界面时间倒流）
    const newer = isNewerThan(notice.occurredAt, head.lastAt);
    const merged: NoticeEntry = {
      ...head,
      count: head.count + repeatDelta(head.lastRepeats, repeats),
      lastRepeats: repeats ?? 1,
      firstAt: isNewerThan(head.firstAt, notice.occurredAt)
        ? notice.occurredAt
        : head.firstAt,
      lastAt: newer ? notice.occurredAt : head.lastAt,
      message: newer ? notice.message : head.message,
      read: false,
      live: options.live || head.live,
    };
    // 合并后移到最前：它的 lastAt 已是最新，顺序仍然是时间倒序
    const rest = bucket.notices.filter((_, i) => i !== foldIndex);
    return {
      notices: [merged, ...rest],
      noticeSeq: bucket.noticeSeq,
      noticeKeys: keys,
    };
  }

  const entry: NoticeEntry = {
    id: `notice-${bucket.noticeSeq + 1}`,
    level: notice.level,
    code: notice.code,
    message: notice.message,
    firstAt: notice.occurredAt,
    lastAt: notice.occurredAt,
    count: Math.max(1, repeats ?? 1),
    lastRepeats: repeats ?? 1,
    read: false,
    live: options.live,
  };
  return {
    notices: [entry, ...bucket.notices],
    noticeSeq: bucket.noticeSeq + 1,
    noticeKeys: keys,
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

    case "taskStarted": {
      // 任务可能在 start 返回前就已经发过事件：把缓存消费掉，别留两份状态来源
      const buffered = state.orphanProgress[action.task.id];
      const started = buffered ? applyProgress(action.task, buffered) : action.task;
      const rest = { ...state.orphanProgress };
      delete rest[action.task.id];
      return {
        ...state,
        tasks: [started, ...state.tasks],
        selectedTaskId: started.id,
        orphanProgress: rest,
      };
    }

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
      // 先与本地已归约的进度对齐（保证单调），再把期间缓存的事件补上
      const local = state.tasks.find((t) => t.id === action.task.id);
      const reconciled = mergeSnapshot(local, action.task);
      const buffered = state.orphanProgress[action.task.id];
      const merged = buffered ? applyProgress(reconciled, buffered) : reconciled;
      const exists = local !== undefined;
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

    case "noticeReceived":
      return {
        ...state,
        ...ingestNotice(state, action.notice, { live: true }),
      };

    case "noticesReplayed": {
      // 按时间升序摄入，最后统一按最新时间倒序排列
      const ordered = [...action.notices].sort((a, b) =>
        a.occurredAt.localeCompare(b.occurredAt),
      );
      let bucket: NoticeBucket = state;
      for (const notice of ordered) {
        // 回放不弹 toast，直接进铃铛
        bucket = ingestNotice(bucket, notice, { live: false });
      }
      return {
        ...state,
        ...bucket,
        notices: [...bucket.notices].sort((a, b) => b.lastAt.localeCompare(a.lastAt)),
      };
    }

    case "noticeAcknowledged":
      // 逐条确认：error 只有被确认过才算已读
      return {
        ...state,
        notices: state.notices.map((n) =>
          n.id === action.id ? { ...n, read: true, live: false } : n,
        ),
      };

    case "noticeToastDismissed":
      return {
        ...state,
        notices: state.notices.map((n) =>
          n.id === action.id ? { ...n, live: false } : n,
        ),
      };

    case "noticeDismissed":
      return { ...state, notices: state.notices.filter((n) => n.id !== action.id) };

    case "noticesCleared":
      // 「清除已读」绝不能顺手抹掉尚未确认的 error——那等于绕过确认
      return {
        ...state,
        notices: state.notices.filter((n) => n.level === "error" && !n.read),
      };

    case "noticesPanelToggled": {
      const open = !state.noticesOpen;
      return {
        ...state,
        noticesOpen: open,
        // 打开只把 warning/info 置已读；error 必须逐条确认，否则可能从未被独立看到
        notices: open
          ? state.notices.map((n) =>
              n.level === "error" ? n : { ...n, read: true, live: false },
            )
          : state.notices,
      };
    }

    case "noticesPanelClosed":
      return { ...state, noticesOpen: false };

    case "jobsLoaded": {
      // 对账：以后端为准，但逐条按 revision 保单调，别让慢到的旧快照回踩
      const merged = [...state.jobs];
      for (const job of action.jobs) {
        const index = merged.findIndex((j) => j.id === job.id);
        if (index < 0) merged.push(job);
        else if (job.revision >= merged[index].revision) merged[index] = job;
      }
      return { ...state, jobs: merged };
    }

    case "jobProgress": {
      const { job } = action;
      const index = state.jobs.findIndex((j) => j.id === job.id);
      if (index < 0) return { ...state, jobs: [...state.jobs, job] };
      // 乱序保护：revision 不前进的事件一律丢弃
      if (job.revision <= state.jobs[index].revision) return state;
      const jobs = [...state.jobs];
      jobs[index] = job;
      return { ...state, jobs };
    }

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

  /**
   * 后端通知（降级/失败）常驻订阅 + 启动回放。
   *
   * 时序要点：这块**不等 bootstrap**。订阅越早建立，漏掉的推送越少；
   * 订阅建立后再拉一次 list_notices，把订阅建立之前后端已经发出的通知补回来，
   * 否则启动早期的降级提示会静默丢失。回放的通知直接进铃铛、不再弹 toast，
   * 但 error 仍需逐条确认。
   */
  useEffect(() => {
    let cancelled = false;

    const subscription = api.subscribeNotices(
      (notice) => dispatch({ type: "noticeReceived", notice }),
      (err) =>
        dispatch({
          type: "noticeReceived",
          notice: {
            level: "error",
            code: "notice-listen-failed",
            message:
              err instanceof Error
                ? `通知通道未能建立：${err.message}。后端的降级提示可能无法送达，请重启应用。`
                : "通知通道未能建立，后端的降级提示可能无法送达，请重启应用。",
            occurredAt: new Date().toISOString(),
          },
        }),
    );

    async function replayBacklog() {
      try {
        const backlog = await api.listNotices();
        if (!cancelled && backlog.length > 0) {
          dispatch({ type: "noticesReplayed", notices: backlog });
        }
      } catch (err) {
        if (cancelled) return;
        dispatch({
          type: "noticeReceived",
          notice: {
            level: "error",
            code: "notice-replay-failed",
            message:
              err instanceof Error
                ? `启动通知回放失败：${err.message}。可能漏掉了启动期间的降级提示。`
                : "启动通知回放失败，可能漏掉了启动期间的降级提示。",
            occurredAt: new Date().toISOString(),
          },
        });
      }
    }

    // 严格串行：监听注册完成之后才去取积压。
    // 反过来的话，「取数完成 → 注册完成」之间产生的通知两头都收不到。
    // 注册失败（ready reject）时监听虽然没建起来，积压仍然值得补回来，
    // 失败本身已由上面的 onError 报给用户，所以这里 settle 即继续。
    void subscription.ready
      .catch(() => undefined)
      .then(() => {
        if (!cancelled) return replayBacklog();
      });

    return () => {
      cancelled = true;
      subscription.dispose();
    };
  }, []);

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
          type: "noticeReceived",
          notice: {
            level: "error",
            code: "progress-listen-failed",
            message:
              err instanceof Error
                ? `进度监听未能建立：${err.message}。拷卡进度不会自动刷新，请重启应用；已在进行的拷贝不受影响。`
                : "进度监听未能建立，拷卡进度不会自动刷新，请重启应用；已在进行的拷贝不受影响。",
            occurredAt: new Date().toISOString(),
          },
        }),
    );
  }, []);

  /**
   * 作业进度常驻订阅 + ready 后对账。
   * ready 之前跑完的作业，其终态事件会丢——所以必须 listJobs 补一次，
   * 这就是 M2 #13 的同型竞态，不能再犯。
   */
  useEffect(() => {
    let cancelled = false;

    const sub = api.subscribeJobProgress(
      (job) => dispatch({ type: "jobProgress", job }),
      (err) =>
        dispatch({
          type: "noticeReceived",
          notice: {
            level: "warning",
            code: "job-listen-failed",
            message: `作业进度监听未能建立：${
              err instanceof Error ? err.message : String(err)
            }。后台作业仍在运行，但界面不会自动刷新。`,
            occurredAt: new Date().toISOString(),
          },
        }),
    );

    void sub.ready
      .catch(() => undefined)
      .then(async () => {
        if (cancelled) return;
        try {
          const jobs = await api.listJobs();
          if (!cancelled) dispatch({ type: "jobsLoaded", jobs });
        } catch (err) {
          if (cancelled) return;
          dispatch({
            type: "noticeReceived",
            notice: {
              level: "warning",
              code: "jobs-reconcile-failed",
              message: `读取后台作业列表失败：${
                err instanceof Error ? err.message : String(err)
              }。进行中的作业状态可能不准确。`,
              occurredAt: new Date().toISOString(),
            },
          });
        }
      });

    return () => {
      cancelled = true;
      sub.dispose();
    };
  }, []);

  /** 拉一次任务快照与后端对账（start/resume/retry 之后调用） */
  const refreshTask = useCallback(async (taskId: string) => {
    try {
      const task = await api.getCopyTask(taskId);
      if (task) dispatch({ type: "taskSnapshot", task });
    } catch (err) {
      // 快照拉不回来 = 界面上的任务状态可能已经过期，必须说出来
      dispatch({
        type: "noticeReceived",
        notice: {
          level: "warning",
          code: "task-refresh-failed",
          message: `刷新拷卡任务状态失败：${
            err instanceof Error ? err.message : String(err)
          }。当前显示的进度可能不是最新的。`,
          occurredAt: new Date().toISOString(),
        },
      });
    }
  }, []);

  /**
   * 收到了不认识的 taskId 的事件：把快照拉回来补上。
   *
   * key 带上 revision——只用 id 做依赖的话，一次拉取失败后 key 不再变化，
   * 这个孤儿任务就永远不会被重试了。带上 revision 后，该任务的下一条新事件
   * 会改变 key，自然触发重试。
   */
  const orphanIdsKey = Object.keys(state.orphanProgress).sort().join(",");
  const orphanIdsRef = useRef<string[]>([]);
  useEffect(() => {
    orphanIdsRef.current = orphanIdsKey ? orphanIdsKey.split(",") : [];
  }, [orphanIdsKey]);

  /** 同一孤儿同时最多一个在途请求 */
  const inFlightRef = useRef(new Set<string>());
  /** 逐孤儿的失败次数，决定退避档位 */
  const attemptRef = useRef(new Map<string, number>());
  /** 逐孤儿已排期的下一次重试 */
  const timersRef = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const unmountedRef = useRef(false);

  useEffect(() => {
    unmountedRef.current = false;
    const timers = timersRef.current;
    return () => {
      // 只有卸载才停：重试排期绝不打断在途请求
      unmountedRef.current = true;
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
    };
  }, []);

  /**
   * 把孤儿任务的快照拉回来。
   *
   * 调度是**链式**的：一次尝试 settle 之后才排下一次，而不是固定节拍的计时器。
   * 固定节拍会在响应慢于退避窗口时把在途请求当作过期丢掉——连成功的响应都被
   * 自己的重试机制扔掉，还不断叠加重叠请求。这里的不变量是：
   *   ① 慢而成功的响应一定被消费（只有组件卸载才忽略结果）；
   *   ② 同一孤儿任意时刻最多一个在途请求。
   */
  async function reconcileOrphan(id: string): Promise<void> {
    if (unmountedRef.current) return;
    if (inFlightRef.current.has(id)) return; // 已有在途，不叠加
    if (timersRef.current.has(id)) return; // 已排期，等它触发
    if (!orphanIdsRef.current.includes(id)) return; // 已经不是孤儿了

    inFlightRef.current.add(id);
    let settled = false;
    try {
      const task = await api.getCopyTask(id);
      if (unmountedRef.current) return;
      if (task) {
        settled = true;
        attemptRef.current.delete(id);
        dispatch({ type: "taskSnapshot", task });
      }
    } catch {
      // 失败：下面排退避重试
    } finally {
      inFlightRef.current.delete(id);
    }

    if (settled || unmountedRef.current) return;
    if (!orphanIdsRef.current.includes(id)) return;

    const attempt = attemptRef.current.get(id) ?? 0;
    attemptRef.current.set(id, attempt + 1);
    const delay =
      ORPHAN_BACKOFF_MS[Math.min(attempt, ORPHAN_BACKOFF_MS.length - 1)];
    const timer = setTimeout(() => {
      timersRef.current.delete(id);
      void reconcileOrphan(id);
    }, delay);
    timersRef.current.set(id, timer);
  }

  /**
   * 收到不认识的 taskId 的事件时把快照拉回来。
   * 依赖只用 id 集合：同一孤儿的新事件不该打断已经在跑的对账链，
   * 而终态孤儿（不会再有下一条事件）由上面的链式退避兜底。
   */
  useEffect(() => {
    if (!orphanIdsKey) return;
    for (const id of orphanIdsKey.split(",")) void reconcileOrphan(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orphanIdsKey]);

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

/**
 * 该项目是否有进行中的交付作业。
 *
 * 这是打包互斥的**唯一真相来源**：侧栏禁用、分类屏禁用、删除链路禁用都读它。
 * 应用重启后作业不再存在 → 不 working，这是声明语义（后端不持久化作业）。
 */
export function selectDeliveryWorking(state: AppState): boolean {
  const projectId = state.selectedProjectId;
  if (!projectId) return false;
  return state.jobs.some(
    (job) =>
      job.kind === "delivery" &&
      job.projectId === projectId &&
      (job.state === "queued" || job.state === "running"),
  );
}

/** 该项目最近一个交付作业（用于结果/进度呈现） */
export function selectLatestDeliveryJob(
  state: AppState,
  projectId: string,
): JobSnapshot | null {
  const candidates = state.jobs.filter(
    (job) => job.kind === "delivery" && job.projectId === projectId,
  );
  if (candidates.length === 0) return null;
  return candidates.reduce((latest, job) =>
    job.startedAt >= latest.startedAt ? job : latest,
  );
}

/** 便捷选择器 */
export function useAppState(): AppState {
  return useStore().state;
}

export function useSelectedProject(): Project | null {
  const { projects, selectedProjectId } = useAppState();
  return projects.find((p) => p.id === selectedProjectId) ?? null;
}
