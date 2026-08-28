/** 屏 4：拷卡任务面板（流向 hero + 源卷/文件夹双确认 + 多目的地 + 逐文件哈希状态）。 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as api from "../api";
import type {
  CopyFileItem,
  CopyTaskPreview,
  DestinationKind,
  ProjectSettings,
  SourceFolder,
  SourcePlan,
  StartCopyInput,
  NoticeLevel,
} from "../api/types";
import { SpeedSparkline, useSpeedSamples } from "../components/charts";
import { Checkbox, Select } from "../components/controls";
import { ConfirmDialog, type ConfirmRequest } from "../components/ConfirmDialog";
import { IconChevronRight, IconPlus, IconRetry, IconTrash } from "../components/Icon";
import { PathField } from "../components/PathField";
import { RemoteActivityBanner } from "../components/RemoteActivityBanner";
import { TagChip, TagPicker } from "../components/TagPicker";
import { TopBar } from "../components/TopBar";
import {
  IllCopyEmpty,
  IllCopyFlow,
  IllSdCard,
  IllStorageTarget,
} from "../components/illustrations";
import { Badge, EmptyState, Field, ProgressBar } from "../components/ui";
// 「这次是不是部分拷贝」「范围怎么写」只有一份判据：见 lib/copyScope.ts
import {
  copyScopeFolderCount,
  formatScopeFolders,
  isPartialCopy,
} from "../lib/copyScope";
import {
  formatBytes,
  formatEta,
  formatSpeed,
  formatTimestamp,
  ratio,
} from "../lib/format";
import {
  COPY_FILE_STATUS_LABEL,
  COPY_FILE_STATUS_TONE,
  DESTINATION_KIND_LABEL,
  DESTINATION_STATE_LABEL,
  TASK_STATE_LABEL,
  TASK_STATE_TONE,
} from "../lib/labels";
import { prefersReducedMotion } from "../lib/motion";
import {
  buildCopyPrefix,
  buildCopyTargetPath,
  copyTargetParent,
  currentTimeSlot,
  todayCompactDate,
  TIME_SLOTS,
  type TimeSlot,
} from "../lib/naming";
import { loadPref, savePref } from "../lib/prefs";
import { colorOfTag, joinTagsAsNote, nextTagColor } from "../lib/tags";
import { validateStartCopy } from "../lib/validation";
import {
  remoteActivityForVolume,
  useRemoteActivity,
} from "../hooks/useRemoteActivity";
import { useStore } from "../state/store";
import { useWindowBridge } from "../state/windowBridge";

/** `YYYYMMDD` ↔ date input 的 `YYYY-MM-DD` */
function compactToIso(compact: string): string {
  return `${compact.slice(0, 4)}-${compact.slice(4, 6)}-${compact.slice(6, 8)}`;
}
function isoToCompact(iso: string): string {
  return iso.replace(/-/g, "");
}

interface DestDraft {
  id: string;
  kind: DestinationKind;
  path: string;
}

/**
 * 双确认屏的**不可变**草稿。
 *
 * 这屏此前直接读当前表单渲染、也直接读当前表单提交，于是有一条能毁素材的时序：
 * 确认方案 A → 核算期间点「返回修改」→ 改成方案 B → 再进确认，A 那两个还在飞的
 * `preview`/`plan` 后落地并覆盖 B 的；屏上展示 A 的目标夹、规模与改名清单，
 * 按下「确认开始」提交的却是**当时的表单**，实际跑的是 B。
 *
 * 这直接推翻了本次改动自己的承诺——「加前缀等于系统替用户改了文件名，必须在
 * 双确认屏明示」。展示的清单不是将要执行的清单，明示就是假的。
 *
 * 所以进确认屏的那一刻把表单**冻**成这份草稿：
 *   ① 屏上渲染的每一项都来自草稿，不再读表单；
 *   ② `preview`/`plan` 的响应带 `requestId`，对不上一律丢弃；
 *   ③ 提交只能用草稿，读不到当前表单；
 *   ④ 「返回修改」/切项目/换卷/预填一律作废旧 requestId，旧响应再也落不进来。
 */
interface ConfirmDraft {
  /** 单调递增的请求版本号：草稿、preview、plan、提交四者靠它对齐 */
  requestId: number;
  /**
   * 这一屏确认页的**实例 id**，随草稿生灭（契约 2026-08-28）。
   *
   * 与 `requestId` 是两件事，别合并：
   *   - `requestId` 管**前端**的时序——旧响应对不上就丢弃，每换一次核算就 +1；
   *   - `confirmInstanceId` 管**后端**的计划快照占哪个槽——后端只留最近 16 份
   *     计划，同一个 instance id 的新计划**替换**旧的而不是再占一格。
   *
   * 所以它的生命周期跟着「用户还站不站在这一屏确认页上」走，而不是跟着核算次数走：
   * 屏内重试核算、`PLAN_CHANGED` 后的重新核算都还是同一个确认页，id 保持不变；
   * 只有「返回修改」/切项目/换卷/提交成功把草稿整个作废，下一次才换新 id。
   */
  confirmInstanceId: string;
  projectId: string;
  volumeId: string;
  volumeName: string;
  volumeMountPath: string;
  /** 源卷是不是本机系统盘——确认屏那条红色拦截也必须按草稿说话 */
  volumeIsSystem: boolean;
  cameraId: string;
  cameraCode: string;
  tags: string[];
  targetPrefix: string;
  destinations: Array<{ kind: DestinationKind; path: string }>;
  /** 空数组 = 整卷（与后端契约一致） */
  sourceFolders: string[];
  autoProxy: boolean;
}

/** preview / plan 的响应都要绑在发起它的那份草稿上 */
interface Tagged<T> {
  requestId: number;
  value: T;
}

/**
 * 卡内文件夹清单的扫描结果——**按卷归属**。
 *
 * 此前它是三个裸 state（`folders`/`foldersError`/`foldersLoading`）：扫卡 A 时
 * 切到卡 B，A 的响应照样写进全局，用户在 B 底下看到并勾选的是 A 的目录；
 * 更糟的是重新打开 B 时会因为 `folders !== null` 而**不再扫描**。
 * 带上 `volumeId` 之后，属于别的卷的结果连渲染的机会都没有。
 */
interface FolderScan {
  volumeId: string;
  status: "loading" | "ready" | "error";
  items: SourceFolder[];
  error: string | null;
}

/** 文件明细每页条数 */
const PAGE_SIZE = 200;

/** 改名清单默认露出的条数（数量本身永远可见，折的只是明细） */
const RENAME_PREVIEW = 5;

let destSeq = 0;
function newDest(kind: DestinationKind, path = ""): DestDraft {
  destSeq += 1;
  return { id: `dest-${destSeq}`, kind, path };
}

/** 确认页实例 id 的进程内序号，只用来给兜底分支做防撞的确定性部分 */
let confirmInstanceSeq = 0;

/**
 * 生成一个确认页实例 id。
 *
 * 它对后端只是一把**缓存槽的钥匙**（不参与令牌、不进 manifest、不做鉴权），
 * 唯一的硬要求是**别撞**：撞了就等于两个确认屏共用一个槽，互相把对方批准过的
 * 计划快照挤掉，`PLAN_CHANGED` 的报文随即退化成泛化原因——正是这个参数要防的事。
 *
 * 所以 `crypto.randomUUID` 缺席时（老 WebView / 非安全上下文）不是静默放弃，
 * 而是退到「时间 + 随机 + 进程内自增」：自增段保证同一个窗口内绝不重复，
 * 随机段拉开多窗口之间的距离。这不是需要向用户报警的降级——id 弱一点不改变
 * 任何用户可见的保证，而**不传**才会让后端退化，所以任何情况下都要给出一个。
 */
function newConfirmInstanceId(): string {
  confirmInstanceSeq += 1;
  const uuid = globalThis.crypto?.randomUUID?.();
  if (uuid) return `confirm-${uuid}`;
  const rand = Math.random().toString(36).slice(2, 10);
  return `confirm-${Date.now().toString(36)}-${rand}-${confirmInstanceSeq}`;
}

/** SVG 不会自己打省略号：卡面小字先在 JS 里截断 */
function fitCardLabel(text: string, max = 10): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/**
 * 校验阶段的速度估计(评审 2.2):后端只推 verifiedBytes,不推校验速度。
 * 客户端按增量采样出字节/秒(EMA 平滑),供「校验中」的 ETA 使用。
 * 渲染期突变 ref 是幂等的:verified 不增长就不更新,StrictMode 双渲染安全。
 */
function useVerifySpeed(taskId: string | null, verified: number, active: boolean): number {
  const ref = useRef({ taskId: null as string | null, at: 0, verified: 0, speed: 0 });
  if (ref.current.taskId !== taskId) {
    ref.current = { taskId, at: Date.now(), verified, speed: 0 };
  } else if (active && verified > ref.current.verified) {
    const now = Date.now();
    const dt = (now - ref.current.at) / 1000;
    if (dt >= 0.5) {
      const inst = (verified - ref.current.verified) / dt;
      ref.current = {
        taskId,
        at: now,
        verified,
        speed: ref.current.speed > 0 ? ref.current.speed * 0.6 + inst * 0.4 : inst,
      };
    }
  }
  return active ? ref.current.speed : 0;
}

type FlowState = "idle" | "running" | "paused" | "done" | "failed";

/**
 * hero 中央那条「管道」。
 *
 * 这是本版设计的核心：**同一个元素**，静止时是一条示意性的流动光效
 * （告诉你数据将从左流向右），任务一开跑就直接承载真实进度——不是两块
 * 不同的 UI 在切换，位置、形状、粗细全不变，只是光效之下多了实心进度。
 * 静态表达（虚线管道 + 下方文字状态）不依赖动画：`prefers-reduced-motion`
 * 关掉流动之后，状态照样读得出来。
 */
function CopyFlowBar({
  state,
  value,
  total,
  label,
  valueText,
}: {
  state: FlowState;
  value: number;
  total: number;
  label: string;
  valueText: string;
}) {
  const r = ratio(value, total);
  const idle = state === "idle";
  return (
    <div
      className="copy-flowbar"
      data-state={state}
      data-testid="copy-flowbar"
      /* 静止态没有进度可言,报成 progressbar 只会让读屏器念一个假的 0%;
         此时含义由下方的文字状态承担 */
      role={idle ? undefined : "progressbar"}
      aria-hidden={idle ? true : undefined}
      aria-valuemin={idle ? undefined : 0}
      aria-valuemax={idle ? undefined : 100}
      aria-valuenow={idle ? undefined : Math.round(r * 100)}
      aria-valuetext={idle ? undefined : valueText}
      aria-label={idle ? undefined : label}
    >
      <div className="copy-flowbar__fill" style={{ transform: `scaleX(${r})` }} />
      {/* 流动光效：只动 transform/opacity，不引发重排 */}
      <div className="copy-flowbar__sheen" />
    </div>
  );
}

export function CopyTaskScreen() {
  const { state, dispatch, refreshTask } = useStore();
  const bridge = useWindowBridge();
  const { volumes, cameras, tasks, projects, selectedProjectId, selectedTaskId } = state;

  // 不做 `?? projects[0]` 兜底：没选项目就不该猜一个往里拷
  const project = projects.find((p) => p.id === selectedProjectId) ?? null;
  // 任务按项目过滤，避免 A 项目标题配 B 项目文件
  const projectTasks = useMemo(
    () => (project ? tasks.filter((t) => t.projectId === project.id) : []),
    [tasks, project],
  );
  const task =
    projectTasks.find((t) => t.id === selectedTaskId) ?? projectTasks[0] ?? null;

  const [volumeId, setVolumeId] = useState("");
  /** 忽略系统内置盘（默认开）：本机启动盘不是拷卡源,误选后果严重 */
  const [showSystemVolumes, setShowSystemVolumes] = useState(false);

  /**
   * 源范围：默认整卷；`folders` = 只拷勾中文件夹的直接子文件（落盘扁平化）。
   * 「按文件夹但一个没勾」是**错误**而不是回退成整卷——静默扩大拷贝范围
   * 比报错危险得多。
   */
  const [sourceMode, setSourceMode] = useState<"whole" | "folders">("whole");
  const [selectedFolders, setSelectedFolders] = useState<string[]>([]);
  /** 文件夹清单按卷归属：别的卷的结果不渲染、也不冒充「已扫过」 */
  const [folderScan, setFolderScan] = useState<FolderScan | null>(null);
  const [folderPickerOpen, setFolderPickerOpen] = useState(false);
  /** 双确认屏的规模与改名清单（planSourceSelection 的结果），绑在草稿上 */
  const [plan, setPlan] = useState<Tagged<SourcePlan> | null>(null);
  /** 核算失败的是哪份草稿（失败也会过期：旧草稿的失败不该盖住新草稿的成功） */
  const [planFailedFor, setPlanFailedFor] = useState<number | null>(null);
  /** 后端回了 PLAN_CHANGED：卡上内容在确认之后变了，确认屏要显式说明 */
  const [planChangedFor, setPlanChangedFor] = useState<number | null>(null);
  /** 后端在 `PLAN_CHANGED:` 后给的具体原因,原样展示(见提交失败处的说明) */
  const [planChangedCause, setPlanChangedCause] = useState<string>("");
  const [renamesExpanded, setRenamesExpanded] = useState(false);

  /**
   * 快捷拷卡引导「去拷卡」预填:预选卷,匹配卡带出相机。
   * 预填同时把确认态整体归零——用户可能正停在上一张卡的确认屏,
   * 只换卷不清确认会「对着 A 的预览确认,任务落到 B」(codex 评审 P0,
   * 与切项目归零同一条铁律)。卷已被拔走则丢弃草稿并出声。
   */
  useEffect(() => {
    const draft = state.copyDraft;
    if (!draft) return;
    dispatch({ type: "copyDraftConsumed" });
    const vol = state.volumes.find((v) => v.id === draft.volumeId);
    if (!vol) {
      pushNotice(
        "info",
        "quick-copy-draft-dropped",
        "刚插入的卡已被拔出,拷卡表单未预选源卷,请重新插卡或手动选择。",
      );
      return;
    }
    setVolumeId(vol.id);
    if (draft.cameraId && state.cameras.some((c) => c.id === draft.cameraId)) {
      setCameraId(draft.cameraId);
    }
    // 作废在飞的确认请求:预填换了卷,旧草稿的 preview/plan 一律不许再落地
    nextConfirmId();
    setConfirmDraft(null);
    setPreview(null);
    setPreviewFailedFor(null);
    setPlanChangedFor(null);
    setSubmitted(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.copyDraft]);
  const [volumesRefreshing, setVolumesRefreshing] = useState(false);
  const [cameraId, setCameraId] = useState("");
  /**
   * 内容标签(替代自由文本备注):标签库随项目存 settings.json,
   * 现场新建的标签当场写回库,其他工作站打开同一项目即可复用。
   */
  const [tags, setTags] = useState<string[]>([]);
  const [settings, setSettings] = useState<ProjectSettings | null>(null);
  /**
   * 目标夹前缀不再手敲、也不再探查卡内素材时间:
   * 日期选择器默认本机今天,工况 B 另有上午/下午/晚上时段切换。
   */
  const [prefixIso, setPrefixIso] = useState(() => compactToIso(todayCompactDate()));
  const [slot, setSlot] = useState<TimeSlot>(() => currentTimeSlot());
  // 默认只留 NAS(评审 1.1):此前预置的空「移动盘」行会拦提交,
  // 等于给每一次拷卡强加一步「删行或填路径」。双备份用「添加目的地」引导。
  // 不预填任何平台特有路径：/Volumes/… 在 Windows/Linux 上首屏即是错的
  const [dests, setDests] = useState<DestDraft[]>(() => [newDest("nas")]);
  const [submitted, setSubmitted] = useState(false);
  /** 工况 A：拷完自动派发代理转码作业（PRD §5.6） */
  const [autoProxy, setAutoProxy] = useState(false);
  /**
   * 进入确认屏 = 把表单冻成一份草稿。`null` 就是「不在确认屏」——
   * 不再另有一个 `confirming` 布尔值,省掉「confirming 为真但草稿是空」这种
   * 根本不该存在的中间态。
   */
  const [confirmDraft, setConfirmDraft] = useState<ConfirmDraft | null>(null);
  const confirming = confirmDraft !== null;
  const [busy, setBusy] = useState(false);
  /** 暂停/继续/单文件重试正在飞:按钮置灰,避免连点堆叠 IPC */
  const [controlBusy, setControlBusy] = useState(false);

  const [confirm, setConfirm] = useState<ConfirmRequest | null>(null);

  // 后端解析出的真实落盘位置（双确认屏只显示这个，不显示用户填的路径）
  const [preview, setPreview] = useState<Tagged<CopyTaskPreview> | null>(null);
  /** 落盘预览失败的是哪份草稿:面板给静态提示 + 返回修改;具体原因走 toast */
  const [previewFailedFor, setPreviewFailedFor] = useState<number | null>(null);

  /**
   * 请求版本号的唯一来源。**同步**自增(在事件处理/effect 里,不在 await 之后),
   * 于是「作废旧请求」这件事在 React 的一次提交内就完成了,不会有窗口期。
   */
  const confirmSeqRef = useRef(0);
  /** 作废当前所有在飞的确认请求;返回新的版本号供新草稿使用 */
  const nextConfirmId = useCallback(() => {
    confirmSeqRef.current += 1;
    return confirmSeqRef.current;
  }, []);

  /* 展示层只认「属于当前草稿」的响应:过期的既落不进来(写入前校验),
     万一落进来了(比如先到的是新的、后到的是旧的)也渲染不出去。两道闸。 */
  const draftId = confirmDraft?.requestId ?? -1;
  const activePreview = preview?.requestId === draftId ? preview.value : null;
  const activePlan = plan?.requestId === draftId ? plan.value : null;
  const previewFailed = previewFailedFor === draftId;
  const planFailed = planFailedFor === draftId;
  const planChanged = planChangedFor === draftId;

  // 文件明细分页拉取：list_copy_tasks 按契约不带 files
  const [files, setFiles] = useState<CopyFileItem[]>([]);
  const [fileTotal, setFileTotal] = useState(0);
  const [filesLoading, setFilesLoading] = useState(false);

  /** hero 的「设置」按钮把焦点送到下半区的目的地编辑处 */
  const destsRef = useRef<HTMLDivElement | null>(null);

  const { activities: remoteActivities, unavailable: remoteUnavailable } =
    useRemoteActivity(project?.id ?? null);

  // 速度曲线的采样：只在拷贝真正推进时积累，挂起/完成后冻结供回看
  const speedSamples = useSpeedSamples(
    task?.id ?? null,
    task?.progressRevision ?? 0,
    task?.speedBytesPerSec ?? 0,
    task?.state === "running" || task?.state === "verifying",
  );

  /** 本屏内失败上抛通知中心的统一出口（零静默铁律） */
  const pushNotice = useCallback(
    (level: NoticeLevel, code: string, message: string) =>
      dispatch({
        type: "noticeReceived",
        notice: { level, code, message, occurredAt: new Date().toISOString() },
      }),
    [dispatch],
  );

  /**
   * 卷列表以前只在启动时拉一次：开机后才插卡永远看不见,也没有任何提示。
   * 进屏自动刷一次 + 手动刷新按钮兜底（原生挂载事件通知是后续增强,PRD §6.5）。
   */
  const refreshVolumes = useCallback(async () => {
    setVolumesRefreshing(true);
    try {
      const next = await api.listVolumes();
      dispatch({ type: "volumesUpdated", volumes: next });
    } catch (err) {
      pushNotice(
        "error",
        "volumes-refresh-failed",
        `刷新卡列表失败：${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      setVolumesRefreshing(false);
    }
  }, [dispatch, pushNotice]);

  useEffect(() => {
    void refreshVolumes();
  }, [refreshVolumes]);

  /** 默认隐藏系统内置盘；已选中的卷永远不隐藏（开关不该把当前选择变没） */
  const visibleVolumes = useMemo(
    () =>
      volumes.filter((v) => showSystemVolumes || !v.isSystem || v.id === volumeId),
    [volumes, showSystemVolumes, volumeId],
  );
  const hiddenSystemCount = volumes.length - visibleVolumes.length;

  /**
   * 换卡必须把文件夹选择整体归零:相对路径是**属于那张卡**的,
   * 留着上一张卡的 `DCIM/100MSDCF` 会拷出完全不同的一批文件。
   * 归零本身也要出声——用户勾过的东西被系统清掉,不许静悄悄发生。
   */
  const prevVolumeRef = useRef(volumeId);
  useEffect(() => {
    if (prevVolumeRef.current === volumeId) return;
    const hadSelection = sourceMode === "folders" && selectedFolders.length > 0;
    prevVolumeRef.current = volumeId;
    setSourceMode("whole");
    setSelectedFolders([]);
    setFolderScan(null);
    setFolderPickerOpen(false);
    /* 换卷也必须作废在飞的确认请求。确认屏虽然锁着源卷选择,但「快捷拷卡预填」
       和程序化的清空(拷下一张卡)都会走到这里,旧草稿的响应不许再落地。 */
    nextConfirmId();
    if (hadSelection) {
      pushNotice(
        "info",
        "source-folders-reset",
        "源卷已更换，文件夹选择重置为「整卷」——文件夹路径是属于上一张卡的，请重新勾选。",
      );
    }
  }, [volumeId, sourceMode, selectedFolders, pushNotice, nextConfirmId]);

  /* 扫描结果的展示口径:只有属于当前卷的才算数。
     属于别的卷的结果既不渲染,也不冒充「已经扫过了」——后者会让重新打开
     选择器时直接跳过扫描,把上一张卡的目录当成这张卡的。 */
  const scan = folderScan?.volumeId === volumeId ? folderScan : null;
  const folders = scan?.status === "ready" ? scan.items : null;
  const foldersLoading = scan?.status === "loading";
  const foldersError = scan?.status === "error" ? scan.error : null;

  const camera = cameras.find((c) => c.id === cameraId) ?? null;
  const targetPrefix = project
    ? buildCopyPrefix(project.scenario, isoToCompact(prefixIso), slot)
    : "";
  const validation = useMemo(
    () =>
      validateStartCopy({
        volumeId,
        cameraId,
        tags,
        targetPrefix,
        destinations: dests.map(({ kind, path }) => ({ kind, path })),
      }),
    [volumeId, cameraId, tags, targetPrefix, dests],
  );

  /** 传给后端的源选择：整卷 = 空数组（契约里的向后兼容口径） */
  const effectiveFolders = sourceMode === "folders" ? selectedFolders : [];
  /**
   * validateStartCopy 是多屏共用的纯函数，不塞本屏私有规则；
   * 「切了按文件夹却一个没勾」就地校验，且**只报错、绝不回退整卷**。
   */
  const folderError =
    sourceMode === "folders" && selectedFolders.length === 0
      ? "已切到「按文件夹选择」但一个都没勾。请至少勾一个文件夹，或切回「整卷」。"
      : undefined;
  const canSubmit = validation.valid && !folderError;

  const targetPath =
    project && camera
      ? buildCopyTargetPath(project.scenario, targetPrefix, camera.code)
      : "";

  // 切项目把发起表单整体归零(codex 评审 P1):侧栏切项目页面不再卸载,
  // 留着旧项目的确认预览会出现「对着 A 的预览确认,任务落进 B」
  const projectKey = project?.id ?? null;
  useEffect(() => {
    // 先作废在飞的请求,再清状态：顺序反了会留出一个「已清空但旧响应还能落地」的窗口
    nextConfirmId();
    setConfirmDraft(null);
    setPreview(null);
    setPreviewFailedFor(null);
    setPlan(null);
    setPlanFailedFor(null);
    setPlanChangedFor(null);
    setSubmitted(false);
    setTags([]);
    setSettings(null);
    // 前缀回到「本机今天 + 当前时段」——按本机日期自动填,不探查卡内素材
    setPrefixIso(compactToIso(todayCompactDate()));
    setSlot(currentTimeSlot());
    /*
     * 目的地/自动转代理按项目记忆(评审 1.2/1.6):备份盘一整个项目周期
     * 不变,预填上次的值,连拷第二张起只需要选卷。(备注已被标签系统取代,
     * 标签库本身随项目 settings 共享,无需另记)
     */
    const saved = projectKey
      ? loadPref<{
          dests?: Array<{ kind: DestinationKind; path: string }>;
          autoProxy?: boolean;
        }>(`copy:${projectKey}`, {})
      : {};
    setDests(
      saved.dests && saved.dests.length > 0
        ? saved.dests.map((d) => newDest(d.kind, d.path))
        : [newDest("nas")],
    );
    setAutoProxy(saved.autoProxy ?? false);
  }, [projectKey, nextConfirmId]);

  // 项目设置(标签库 + 备份盘预设)随项目加载;预设盘预填进目的地行
  useEffect(() => {
    if (!projectKey) return;
    let cancelled = false;
    void (async () => {
      try {
        const loaded = await api.getProjectSettings(projectKey);
        if (cancelled) return;
        setSettings(loaded);
        if (loaded.backupPaths.length > 0) {
          // 预设只填「还没动过」的表单:settings 是异步落地的,
          // 用户已经添加/填写的目的地行(或按项目记忆恢复的行)不许被冲掉
          setDests((prev) =>
            prev.length === 1 && prev[0].kind === "nas" && prev[0].path === ""
              ? [prev[0], ...loaded.backupPaths.map((p) => newDest("external", p))]
              : prev,
          );

        }
      } catch (err) {
        if (cancelled) return;
        // 标签库读不到必须出声:否则用户只看到一个永远为空的标签选择器
        setSettings({ tags: [], backupPaths: [] });
        pushNotice(
          "warning",
          "project-settings-load-failed",
          `读取项目标签库失败：${err instanceof Error ? err.message : String(err)}。仍可现场新建标签。`,
        );
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [projectKey, pushNotice]);

  /**
   * 现场新建标签:先进库(本地即时可用),再写回项目 settings(零静默)。
   * 回写必须以**后端最新** settings 为基底合并——settings 还没载入时
   * 直接拿空壳保存,会把共享的备份盘预设整表清空(数据丢失级竞态,
   * 合并评审实证:一个用例建了标签,后续用例的预设全没了)。
   */
  const createTag = useCallback(
    (name: string) => {
      const local = settings ?? { tags: [], backupPaths: [] };
      setSettings({
        ...local,
        tags: [...local.tags, { name, color: nextTagColor(local.tags) }],
      });
      if (!projectKey) return;
      void (async () => {
        try {
          const base = settings ?? (await api.getProjectSettings(projectKey));
          const next: ProjectSettings = base.tags.some((t) => t.name === name)
            ? base
            : {
                ...base,
                tags: [...base.tags, { name, color: nextTagColor(base.tags) }],
              };
          await api.saveProjectSettings(projectKey, next);
          setSettings(next);
        } catch (err) {
          pushNotice(
            "warning",
            "project-settings-save-failed",
            `标签「${name}」写入项目失败(本次拷卡仍会带上它)：${err instanceof Error ? err.message : String(err)}`,
          );
        }
      })();
    },
    [settings, projectKey, pushNotice],
  );

  /* ---------------- 源「按文件夹多选」 ---------------- */

  /**
   * 拉卡内文件夹清单。失败给就地报错 + 重试，具体原因另走 toast（零静默）。
   *
   * 结果**按卷归属**：扫 A 的过程中切到 B，A 的响应(成功或失败)一律不许写进
   * 状态——用户在 B 底下看到并勾选 A 的目录，会拷出完全不同的一批文件。
   * 丢弃也不许静悄悄：用户当时正等着这个清单，得告诉他为什么它没出现。
   */
  const loadFolders = useCallback(async () => {
    const forVolume = volumeId;
    if (!forVolume) return;
    const forName = volumes.find((v) => v.id === forVolume)?.name ?? forVolume;
    setFolderScan({
      volumeId: forVolume,
      status: "loading",
      items: [],
      error: null,
    });
    /** 落地前的归属校验：只有「当前正显示的还是这张卡」才准写 */
    const stillCurrent = () => prevVolumeRef.current === forVolume;
    try {
      const list = await api.listSourceFolders(forVolume);
      if (!stillCurrent()) {
        pushNotice(
          "info",
          "source-folders-stale",
          `「${forName}」的文件夹清单读回来时你已经切到别的卡了，这份结果已丢弃（它只对那张卡有效）。请对当前这张卡重新点「选择文件夹」。`,
        );
        return;
      }
      setFolderScan({
        volumeId: forVolume,
        status: "ready",
        items: list,
        error: null,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (!stillCurrent()) {
        // 旧卷的失败不该冒充当前卡的失败,但也不能一声不吭
        pushNotice(
          "warning",
          "source-folders-stale",
          `「${forName}」的文件夹清单读取失败（${message}）。你已经切到别的卡，这条错误与当前卡无关，当前卡尚未扫描。`,
        );
        return;
      }
      setFolderScan({
        volumeId: forVolume,
        status: "error",
        items: [],
        error: message,
      });
      pushNotice("error", "source-folders-failed", `读取卡内文件夹失败：${message}`);
    }
  }, [volumeId, volumes, pushNotice]);

  function toggleFolderPicker() {
    const next = !folderPickerOpen;
    setFolderPickerOpen(next);
    // 目录扫描有代价,选卷时不预拉,等用户真的要看再拉
    if (next && !folders && !foldersLoading) void loadFolders();
  }

  function toggleFolder(relPath: string, checked: boolean) {
    // 勾任意一行即意味着「按文件夹」，不必先去点分段开关
    setSourceMode("folders");
    setSelectedFolders((prev) =>
      checked ? [...prev, relPath] : prev.filter((p) => p !== relPath),
    );
  }

  /** hero 里点「设置」把用户带到下半区的目的地编辑区 */
  function focusDestinations() {
    const el = destsRef.current;
    if (!el) return;
    try {
      // jsdom / 老内核没有 scrollIntoView；动效偏好由 base.css 的全局闸门兜底
      el.scrollIntoView?.({
        block: "center",
        behavior: prefersReducedMotion() ? "auto" : "smooth",
      });
    } catch {
      // 滚动不是关键路径，失败也要把焦点送到位
    }
    el.querySelector<HTMLElement>("input:not([disabled]), button:not([disabled])")?.focus();
  }

  /** 进度事件驱动的重拉节流：拷贝中每 ~200ms 一条事件，不能每条都打一次 IPC */
  const REFRESH_MIN_MS = 2000;
  const loadedCountRef = useRef(0);
  const lastRefreshRef = useRef(0);

  /** 文件明细触底哨兵:进入视口即自动续拉下一页 */
  const filesEndRef = useRef<HTMLDivElement | null>(null);

  /**
   * 文件明细的请求版本号（epoch）。
   *
   * 明细列表是**当前这个任务**的账:文件名、大小、xxHash3、逐条状态。切任务时
   * 上一个任务的分页/节流刷新还在飞,落地后会把另一张卡的文件与哈希填进这张卡
   * 的表里——一张看起来正常、实则张冠李戴的对账表,比空表危险得多。
   * 切任务即自增,过期响应一律丢弃。
   */
  const filesEpochRef = useRef(0);

  /** 追加下一页 */
  const loadMoreFiles = useCallback(
    async (taskId: string, offset: number) => {
      const epoch = filesEpochRef.current;
      setFilesLoading(true);
      try {
        const page = await api.listCopyFiles(taskId, offset, PAGE_SIZE);
        // 过期响应直接丢:此刻的 files 已经是另一个任务的,append 上去就是混表
        if (epoch !== filesEpochRef.current) return;
        setFileTotal(page.total);
        setFiles((prev) => [...prev, ...page.items]);
      } catch (err) {
        if (epoch !== filesEpochRef.current) return;
        pushNotice(
          "error",
          "copy-files-load-failed",
          `加载文件明细失败：${err instanceof Error ? err.message : String(err)}`,
        );
      } finally {
        if (epoch === filesEpochRef.current) setFilesLoading(false);
      }
    },
    [pushNotice],
  );

  /**
   * 重拉「已经加载出来的那些」——从 0 拉到已加载条数，而不是固定回到第一页。
   * 否则用户点了几次「加载更多」，一条进度事件就把它们全丢了。
   */
  const refreshLoadedFiles = useCallback(
    async (taskId: string) => {
      const epoch = filesEpochRef.current;
      const limit = Math.max(loadedCountRef.current, PAGE_SIZE);
      lastRefreshRef.current = Date.now();
      try {
        const page = await api.listCopyFiles(taskId, 0, limit);
        if (epoch !== filesEpochRef.current) return;
        setFiles(page.items);
        setFileTotal(page.total);
      } catch (err) {
        /* 过期的失败也不报:那句「列表可能滞后」说的是**当前**这张表,而当前
           这张表正由新任务自己的加载负责。为一个用户已经离开的任务弹一条
           针对当前任务的警告,才是真的误导。 */
        if (epoch !== filesEpochRef.current) return;
        // 节流刷新失败：状态列可能滞后,必须让用户知道显示的不是最新
        pushNotice(
          "warning",
          "copy-files-refresh-failed",
          `文件状态刷新失败，列表可能滞后：${err instanceof Error ? err.message : String(err)}`,
        );
      }
    },
    [pushNotice],
  );

  // 切换任务：重置并拉第一页（只认 taskId，不受进度事件影响）
  const taskId = task?.id ?? null;
  useEffect(() => {
    // 上一个任务的所有在飞请求就此作废（含节流刷新与「加载更多」）
    filesEpochRef.current += 1;
    const epoch = filesEpochRef.current;
    if (!taskId) {
      setFiles([]);
      setFileTotal(0);
      loadedCountRef.current = 0;
      return;
    }
    setFiles([]);
    loadedCountRef.current = 0;
    void (async () => {
      try {
        const page = await api.listCopyFiles(taskId, 0, PAGE_SIZE);
        if (epoch !== filesEpochRef.current) return;
        setFiles(page.items);
        setFileTotal(page.total);
        lastRefreshRef.current = Date.now();
      } catch (err) {
        if (epoch !== filesEpochRef.current) return;
        pushNotice(
          "error",
          "copy-files-load-failed",
          `加载文件明细失败：${err instanceof Error ? err.message : String(err)}`,
        );
      }
    })();
  }, [taskId, pushNotice]);

  // 进度推进时刷新状态列，但按 REFRESH_MIN_MS 节流并保住已加载的页数
  const taskRevision = task?.progressRevision ?? 0;
  useEffect(() => {
    if (!taskId || taskRevision === 0) return;
    const elapsed = Date.now() - lastRefreshRef.current;
    // 事件密集时定时器被不断重建，但 delay 随 elapsed 单调递减，不会饿死
    const timer = setTimeout(
      () => void refreshLoadedFiles(taskId),
      Math.max(0, REFRESH_MIN_MS - elapsed),
    );
    return () => clearTimeout(timer);
  }, [taskId, taskRevision, refreshLoadedFiles]);

  // 让节流回调读得到最新的已加载条数
  useEffect(() => {
    loadedCountRef.current = files.length;
  }, [files.length]);

  /**
   * 真正提交；confirmExisting 为 true 时表示用户已在对话框里同意继续。
   *
   * **只读草稿,不读表单**。这是 E1 的要害:屏上展示的是草稿,提交的也必须是
   * 同一份草稿,否则「双确认」确认的东西和执行的东西就不是一回事。
   */
  async function submitStart(draft: ConfirmDraft, confirmExisting: boolean) {
    // 用户批准的那份计划的令牌:plan 只有在属于这份草稿时才作数
    const approvedPlan = plan?.requestId === draft.requestId ? plan.value : null;
    setBusy(true);
    try {
      const input: StartCopyInput = {
        projectId: draft.projectId,
        volumeId: draft.volumeId,
        cameraId: draft.cameraId,
        // note 是标签拼串的兼容形态:manifest 与审计日志保持人可读
        note: joinTagsAsNote(draft.tags),
        tags: draft.tags,
        targetPrefix: draft.targetPrefix,
        destinations: draft.destinations.map(({ kind, path }) => ({ kind, path })),
        // 整卷时干脆不带这个字段：与老客户端的请求体逐字节一致
        ...(draft.sourceFolders.length > 0
          ? { sourceFolders: draft.sourceFolders }
          : {}),
        // 用户在确认屏批准的是**这一份**计划。令牌原样回传，后端重扫后对不上
        // 就返回 PLAN_CHANGED，而不是照着一份已经不成立的批准开跑
        ...(approvedPlan?.planDigest ? { planDigest: approvedPlan.planDigest } : {}),
        // 仅工况 A 有代理转码概念，工况 B 不传这个标志
        ...(project?.scenario === "A" ? { autoProxy: draft.autoProxy } : {}),
        ...(confirmExisting ? { confirmExistingTarget: true } : {}),
      };
      const started = await api.startCopyTask(input);
      dispatch({ type: "taskStarted", task: started });
      // 与后端对账一次，别只信 start 的返回值
      void refreshTask(started.id);
      setTags([]);
      // 成功即记忆(评审 1.2/1.6):目的地/转代理预填给下一张卡
      savePref(`copy:${draft.projectId}`, {
        dests: draft.destinations.map(({ kind, path }) => ({ kind, path })),
        autoProxy: draft.autoProxy,
      });
      setSubmitted(false);
      // 这份草稿到此作废,连同它可能还在飞的 preview/plan
      nextConfirmId();
      setConfirmDraft(null);
      setPreview(null);
      setPlan(null);
      setPlanChangedFor(null);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.startsWith("PLAN_CHANGED:")) {
        /*
         * 卡上的内容在双确认之后变了（换卡、别的进程写入、文件被删）。
         * 用户批准的那份清单已经不成立：**绝不自动重试**——重试等于替他
         * 批准了一份他没看过的清单。
         *
         * 这里换一份**新的 requestId**（表单内容原样照搬，变的是卡上的内容）：
         * 旧 requestId 下所有在飞的响应就此作废，新的规模/改名清单与新的
         * planDigest 必然出自同一次核算，用户重新过目、重新按「确认开始」，
         * 提交的才是他刚看过的那一份。这是知情同意，不是重试。
         *
         * 但 `confirmInstanceId` **原样保留**（靠展开继承，别在这里换新的）：
         * 用户根本没离开这一屏确认页，换的只是他要核对的那份清单。保留同一个
         * id，后端才会拿新计划去**替换**这一屏的旧快照——那份旧快照刚被判定
         * 不成立，已经是死的。换新 id 等于把这具尸体留在 16 格缓存里等 TTL，
         * 还可能顺手挤掉别的确认屏正在用的活快照，让**那一屏**将来的
         * PLAN_CHANGED 只说得出泛化原因。这正是这个参数存在的理由。
         */
        const renewed: ConfirmDraft = { ...draft, requestId: nextConfirmId() };
        setConfirmDraft(renewed);
        setPreview(null);
        setPreviewFailedFor(null);
        setPlan(null);
        setPlanFailedFor(null);
        setPlanChangedFor(renewed.requestId);
        void fetchPreview(renewed);
        void fetchPlan(renewed);
        /*
         * 后端在冒号后面给的是**定性到具体原因**的那句话：换卡了 / 多了文件 /
         * 少了文件 / 大小变了 / 只有 mtime 变了 / 令牌认不出,各有各的措辞,
         * 有的还点名到文件。原样透传,不许自己套一句笼统的「计划变了」——
         * 那等于把后端这一轮的全部价值抹掉,还会把人引向错误的排查方向
         * (例如实际是「文件被改过」,却让人去翻读卡器)。
         */
        const cause = message.slice("PLAN_CHANGED:".length).trim();
        setPlanChangedCause(cause);
        pushNotice(
          "error",
          "copy-plan-changed",
          cause
            ? `${cause}本次没有开跑。已重新核算，请重新核对范围与改名清单后再确认。`
            : "卡上的内容在你确认之后变了，本次没有开跑。已重新核算，请重新核对范围与改名清单后再确认。",
        );
      } else if (message.startsWith("TARGET_EXISTS:")) {
        // 目标夹已存在且非空：极可能是同名重复拷卡，必须让人明示。
        // 重发时仍然带**同一份**草稿：用户在对话框里同意的是他看过的那一份
        setConfirm({
          title: "目标夹已存在",
          message:
            "目标夹已存在且非空，可能是同名重复拷卡。确认继续将只补缺失文件、绝不覆盖已有文件。",
          confirmLabel: "继续拷卡",
          onConfirm: () => void submitStart(draft, true),
        });
      } else {
        // 提交后失败统一走 toast(UX 波三)
        pushNotice("error", "copy-start-failed", `发起拷卡失败：${message}`);
      }
    } finally {
      setBusy(false);
    }
  }

  function confirmAndStart() {
    // 只认草稿:没有草稿就没有「已确认的内容」,不许提交
    if (!confirmDraft || busy) return;
    void submitStart(confirmDraft, false);
  }

  /**
   * 落盘预览拉取:独立出来供确认屏内「重试解析」复用(评审 1.6)——
   * NAS 偶发失败时不必退回第一步重走整表。
   * 入参是草稿:请求内容与落地校验都按草稿走,不读当前表单。
   */
  async function fetchPreview(draft: ConfirmDraft) {
    setPreview(null);
    setPreviewFailedFor(null);
    try {
      const result = await api.previewCopyTask({
        projectId: draft.projectId,
        volumeId: draft.volumeId,
        cameraId: draft.cameraId,
        note: joinTagsAsNote(draft.tags),
        tags: draft.tags,
        targetPrefix: draft.targetPrefix,
        destinations: draft.destinations.map(({ kind, path }) => ({ kind, path })),
      });
      // 过期响应一律丢弃：它属于一份已经被作废的草稿
      if (confirmSeqRef.current !== draft.requestId) return;
      setPreview({ requestId: draft.requestId, value: result });
    } catch (err) {
      if (confirmSeqRef.current !== draft.requestId) return;
      setPreviewFailedFor(draft.requestId);
      pushNotice(
        "error",
        "copy-preview-failed",
        `无法解析实际落盘路径：${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * 核算本次要拷多少、有谁被系统改名。
   *
   * 整卷也照样问一次（`folders` 空 = 整卷），双确认屏因此永远有「N 个文件 ·
   * X GB」这条真值。失败时**只报错不放行**：拿不到改名清单就开跑，等于系统
   * 替用户改了文件名而用户不知情——这正是本项目最不许发生的事。
   */
  async function fetchPlan(draft: ConfirmDraft) {
    setPlan(null);
    setPlanFailedFor(null);
    setRenamesExpanded(false);
    try {
      const result = await api.planSourceSelection(
        draft.volumeId,
        draft.sourceFolders,
        // 同一屏确认页的每一次核算都报同一个 instance id:后端据此**替换**
        // 而不是新占一格快照槽,别的确认屏正在用的那份就不会被挤掉
        draft.confirmInstanceId,
      );
      // 过期响应一律丢弃:方案 A 的规模与改名清单绝不许出现在方案 B 的确认屏上
      if (confirmSeqRef.current !== draft.requestId) return;
      setPlan({ requestId: draft.requestId, value: result });
    } catch (err) {
      if (confirmSeqRef.current !== draft.requestId) return;
      setPlanFailedFor(draft.requestId);
      pushNotice(
        "error",
        "copy-plan-failed",
        `无法核算本次拷贝范围：${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /** 进入第二步前，先问后端「实际会写到哪、到底拷多少」，确认屏只展示真值 */
  async function requestConfirm() {
    setSubmitted(true);
    if (!canSubmit || !project || !volume) return;
    // 把表单**冻**成一份不可变草稿:从这一刻起,屏上展示的、提交出去的,
    // 都只来自它。中途改表单也只影响下一份草稿。
    const draft: ConfirmDraft = {
      requestId: nextConfirmId(),
      // 只有这里会**新开**一屏确认页,所以 instance id 也只在这里出生
      confirmInstanceId: newConfirmInstanceId(),
      projectId: project.id,
      volumeId,
      volumeName: volume.name,
      volumeMountPath: volume.mountPath,
      volumeIsSystem: volume.isSystem,
      cameraId,
      cameraCode: camera?.code ?? "",
      tags: [...tags],
      targetPrefix,
      destinations: dests.map(({ kind, path }) => ({ kind, path })),
      sourceFolders: [...effectiveFolders],
      autoProxy,
    };
    setConfirmDraft(draft);
    setPreview(null);
    setPreviewFailedFor(null);
    setPlan(null);
    setPlanFailedFor(null);
    setPlanChangedFor(null);
    await Promise.all([fetchPreview(draft), fetchPlan(draft)]);
  }

  /** 「返回修改」：作废这份草稿与它所有在飞的请求 */
  function leaveConfirm() {
    nextConfirmId();
    setConfirmDraft(null);
    setPreview(null);
    setPreviewFailedFor(null);
    setPlan(null);
    setPlanFailedFor(null);
    setPlanChangedFor(null);
  }

  /** 拷完一张接着拷下一张(评审 1.6):清源卷,保留相机/标签库/目的地 */
  function startNextCard() {
    setVolumeId("");
    // 前缀回到「本机今天 + 当前时段」(日期/时段选择器已取代手敲前缀)
    setPrefixIso(compactToIso(todayCompactDate()));
    setSlot(currentTimeSlot());
    setSubmitted(false);
    leaveConfirm();
    void refreshVolumes();
  }

  const loadedSummary = useMemo(() => {
    const counts = { pending: 0, copied: 0, verified: 0, failed: 0 };
    for (const f of files) counts[f.status] += 1;
    return counts;
  }, [files]);

  // 总数以后端为准（task.fileCount），列表接口的 total 兜底
  const totalFiles = task?.fileCount ?? fileTotal;

  /**
   * 触底自动续拉:哨兵进入视口就取下一页。滚动源是外层 .content(本屏
   * 唯一的滚动容器),IntersectionObserver 默认以视口为 root,正好对上。
   * 老内核没有 IO 时静默跳过——按钮仍在,不影响功能。
   */
  useEffect(() => {
    const el = filesEndRef.current;
    if (!el || typeof IntersectionObserver === "undefined") return;
    if (filesLoading || files.length >= totalFiles) return;
    const taskId = task?.id;
    if (!taskId) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          void loadMoreFiles(taskId, files.length);
        }
      },
      { rootMargin: "200px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [files.length, totalFiles, filesLoading, task?.id, loadMoreFiles]);
  /** 明细是否已全部加载 */
  const fullyLoaded = totalFiles > 0 && files.length >= totalFiles;
  /**
   * 全量状态计数(评审 2.5):任务快照/进度事件自带的聚合真值,
   * 不受明细分页挟持——几千个文件不必点十几次「加载更多」才见总账。
   * 旧后端没这个字段时,退回「已全部加载才敢断言」的旧口径。
   */
  const counts = task?.statusCounts ?? (fullyLoaded ? loadedSummary : null);
  /** 「只看失败」过滤(评审 2.6):失败文件不该逐页翻着找 */
  const [failedOnly, setFailedOnly] = useState(false);
  const visibleFiles = failedOnly ? files.filter((f) => f.status === "failed") : files;
  const failedTotal = counts?.failed ?? loadedSummary.failed;
  /** 重试全部失败 = 续跑任务:引擎按 manifest 只补未校验文件 */
  const [retryingAll, setRetryingAll] = useState(false);
  const retryAllFailed = useCallback(async () => {
    if (!task || retryingAll) return;
    setRetryingAll(true);
    try {
      await api.resumeCopyTask(task.id);
      await refreshTask(task.id);
      await refreshLoadedFiles(task.id);
    } catch (err) {
      pushNotice(
        "error",
        "copy-retry-failed",
        `重试失败文件未能发起：${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      setRetryingAll(false);
    }
  }, [task, retryingAll, refreshTask, refreshLoadedFiles, pushNotice]);

  /**
   * 暂停 / 继续。
   *
   * 此前是裸的 `void api.pauseCopyTask(...).then(...)`：IPC 被拒时没有 catch，
   * 于是「按了没反应」——按钮弹回原样、任务照跑，用户只会再按几下。
   * 与任务中心的 `pauseOrResume` 同一套口径：busy 期间置灰，失败发通知。
   */
  const pauseOrResume = useCallback(
    async (id: string, action: "pause" | "resume") => {
      if (controlBusy) return;
      setControlBusy(true);
      try {
        if (action === "resume") await api.resumeCopyTask(id);
        else await api.pauseCopyTask(id);
        await refreshTask(id);
      } catch (err) {
        pushNotice(
          "warning",
          "copy-pause-failed",
          `${action === "resume" ? "继续" : "暂停"}拷卡失败：${
            err instanceof Error ? err.message : String(err)
          }。任务仍保持原状态。`,
        );
      } finally {
        setControlBusy(false);
      }
    },
    [controlBusy, refreshTask, pushNotice],
  );

  /** 单文件重试：同上，被拒时必须出声，否则那一行会永远停在「失败」而没人知道为什么 */
  const retryOneFile = useCallback(
    async (id: string, file: CopyFileItem) => {
      if (controlBusy) return;
      setControlBusy(true);
      try {
        await api.retryCopyFile(id, file.id);
        await refreshTask(id);
        await refreshLoadedFiles(id);
      } catch (err) {
        pushNotice(
          "error",
          "copy-file-retry-failed",
          `重试「${file.name}」未能发起：${
            err instanceof Error ? err.message : String(err)
          }。该文件仍是失败状态。`,
        );
      } finally {
        setControlBusy(false);
      }
    },
    [controlBusy, refreshTask, refreshLoadedFiles, pushNotice],
  );

  /** 校验阶段总进度(评审 2.2):所有目的地合计的已回读字节 */
  const verifying = task?.state === "verifying";
  const verifiedSum = task
    ? task.destinations.reduce((sum, d) => sum + (d.verifiedBytes ?? 0), 0)
    : 0;
  const verifyTotal = task ? task.totalBytes * Math.max(1, task.destinations.length) : 0;
  const verifySpeed = useVerifySpeed(task?.id ?? null, verifiedSum, Boolean(verifying));

  const volume = volumes.find((v) => v.id === volumeId) ?? null;
  /* 确认屏里一切与源卷有关的展示都走草稿:表单虽然在确认期间锁着源卷选择,
     但「同名卷他机在拷」这类提示如果还读当前表单,就又打开了一条
     「展示的不是将要执行的」的口子。 */
  const confirmVolumeName = confirmDraft?.volumeName ?? volume?.name;
  // 同名卷提示：只警告不阻断——这是协作提示，不是锁
  const remoteSameVolume = remoteActivityForVolume(
    remoteActivities,
    confirmVolumeName,
  );

  /* ---------------- 完成后的范围口径（判据只有 copyScope 一份） ---------------- */

  /**
   * 「这次是不是部分拷贝」。口径只认后端回填的 `task.sourceFolders`,
   * 不看屏内表单状态——拷贝期间表单可能已经被改成别的方案了。
   */
  const taskPartial = task ? isPartialCopy(task.sourceFolders) : false;
  const taskFolderCount = task ? copyScopeFolderCount(task.sourceFolders) : 0;
  /** 完成屏/hero 共用的范围文案：`[""]`（卷根）会写成「（卷根）」而不是空白 */
  const taskScopeText = task
    ? formatScopeFolders(task.sourceFolders).text
    : "";

  /* ---------------- hero 管道的状态与数值 ---------------- */

  const flowState: FlowState = !task
    ? "idle"
    : task.state === "running" || task.state === "verifying"
      ? "running"
      : task.state === "paused"
        ? "paused"
        : task.state === "done"
          ? "done"
          : task.state === "failed"
            ? "failed"
            : "idle";
  const flowValue = task ? (verifying ? verifiedSum : task.copiedBytes) : 0;
  const flowTotal = task ? (verifying ? verifyTotal : task.totalBytes) : 0;
  const flowPercent = Math.round(ratio(flowValue, flowTotal) * 100);
  /**
   * 管道下方那行字：动画被关掉时，状态全靠它说清楚。
   *
   * 完成态必须与完成提示、终态通知、审计日志同一口径分叉。这行字在屏幕最上方、
   * 管道正下方，主语是**整张卡**：部分拷贝时写「{卷名} 校验 100% 通过」，
   * 等于在最显眼的位置替一张还留着未备份素材的卡背书——而 `prefers-reduced-motion`
   * 下它是唯一的状态来源，下面那条 warning 用户可能根本不会往下滚。
   */
  const flowCaption = !task
    ? `源读一次，并行写 ${dests.length} 个目的地。选好卡与目的地后按「开始拷卡」。`
    : flowState === "running"
      ? `${task.volumeName} → ${task.destinations.length} 个目的地 · ${verifying ? "逐文件回读校验中" : "边拷边算 xxHash3"}`
      : flowState === "paused"
        ? `${task.volumeName} 已挂起，按 manifest 可续传。`
        : flowState === "done"
          ? taskPartial
            ? taskFolderCount > 0
              ? `${task.volumeName} 所选 ${taskFolderCount} 个文件夹（${taskScopeText}）校验 100% 通过——部分拷贝，卡上其余内容尚未备份，请勿格式化。`
              : /* 范围读不出:不许说「整卷通过」,也不能编一个条数 */
                `${task.volumeName} 校验 100% 通过，但本次的拷贝范围读不出来——请勿格式化，详见下方说明。`
            : `${task.volumeName} 校验 100% 通过。`
          : flowState === "failed"
            ? `${task.volumeName} 拷卡失败，详见下方文件明细。`
            : `${task.volumeName} 等待开始。`;

  /** 目的地图形取第一路的类型：hero 画的是真实配置，不是通用示意 */
  const heroDestKind = dests[0]?.kind === "nas" ? "nas" : "external";

  return (
    <>
      <TopBar
        title="拷卡任务"
        subtitle={project ? project.folderName : "未选择项目"}
        subtitleMono={project !== null}
        actions={
          <span className="text-xs dim">源读一次，并行写 {dests.length} 个目的地</span>
        }
      />

      <div className="content">
        <div className="content__inner">
          <RemoteActivityBanner
            activities={remoteActivities}
            unavailable={remoteUnavailable}
          />

          <div className="copy">
            {project ? (
              /* ---------- hero：源 →（管道）→ 目的地 ---------- */
              <section className="copy-stage" aria-label="拷卡流向">
                <div className="copy-stage__node">
                  <div className="copy-stage__art">
                    <IllSdCard
                      label="源卡"
                      sub={volume ? fitCardLabel(volume.name) : "未选择"}
                    />
                  </div>
                  <div className="copy-stage__box">
                    <div className="copy-stage__box-head">
                      <span className="copy-stage__box-title" id="volume-group-label">
                        源：存储卡
                      </span>
                      <button
                        type="button"
                        className="btn btn--sm push-right"
                        data-testid="volumes-refresh"
                        disabled={volumesRefreshing}
                        onClick={() => void refreshVolumes()}
                      >
                        {volumesRefreshing ? "刷新中…" : "刷新"}
                      </button>
                    </div>
                    <div
                      role="radiogroup"
                      data-testid="copy-volume-select"
                      aria-labelledby="volume-group-label"
                    >
                      {visibleVolumes.map((v) => {
                        const matched = state.cards.find(
                          (c) => c.id === v.matchedCardId,
                        );
                        return (
                          <button
                            key={v.id}
                            type="button"
                            data-testid="copy-volume-option"
                            className="volume-row"
                            role="radio"
                            aria-label={`选择源卷 ${v.name}`}
                            aria-checked={volumeId === v.id}
                            /* 确认屏开着时锁住源:改了卷而预览还是旧的,
                               等于「对着 A 的预览把任务落进 B」 */
                            disabled={confirming}
                            onClick={() => {
                              setVolumeId(v.id);
                              if (matched) setCameraId(matched.cameraId);
                            }}
                          >
                            <span className="truncate">
                              <span className="volume-row__name">{v.name}</span>
                              <span className="volume-row__meta" title={v.mountPath}>
                                {v.mountPath} · 已用 {formatBytes(v.usedBytes, 0)} /{" "}
                                {formatBytes(v.capacityBytes, 0)}
                              </span>
                            </span>
                            {/* 他机同卷冲突前置到选择时刻(评审 F2):
                                不该填完整张表进确认屏才被告知 */}
                            {remoteActivityForVolume(remoteActivities, v.name) ? (
                              <Badge tone="warn">他机在拷</Badge>
                            ) : null}
                            {v.isSystem ? (
                              <Badge tone="warn">系统盘</Badge>
                            ) : matched ? (
                              <Badge mono>{matched.label}</Badge>
                            ) : (
                              <Badge tone="warn">未登记</Badge>
                            )}
                          </button>
                        );
                      })}
                      {visibleVolumes.length === 0 ? (
                        <p className="text-sm dim" data-testid="volumes-empty">
                          {hiddenSystemCount > 0
                            ? `未检测到存储卡（已隐藏 ${hiddenSystemCount} 个系统内置盘）。插入卡后点「刷新」。`
                            : "未检测到卷。插入卡后点「刷新」。"}
                        </p>
                      ) : null}
                    </div>
                    <Checkbox
                      className="text-xs dim"
                      testId="volumes-hide-system"
                      checked={!showSystemVolumes}
                      onChange={(next) => setShowSystemVolumes(!next)}
                    >
                      忽略系统内置盘
                      {!showSystemVolumes && hiddenSystemCount > 0
                        ? `（已隐藏 ${hiddenSystemCount} 个）`
                        : ""}
                    </Checkbox>
                    {submitted && validation.errors.volumeId ? (
                      <span className="field__error" role="alert">
                        {validation.errors.volumeId}
                      </span>
                    ) : null}

                    {/* ---- 拷贝范围：整卷 / 按文件夹多选 ---- */}
                    <div className="folder-scope">
                      <div className="folder-scope__row">
                        <span className="folder-scope__label">拷贝范围</span>
                        <span
                          className="folder-scope__value"
                          data-testid="copy-source-scope"
                        >
                          {sourceMode === "whole"
                            ? "整卷（卡内全部）"
                            : `已选 ${selectedFolders.length} 个文件夹`}
                        </span>
                        <button
                          type="button"
                          className="btn btn--sm push-right"
                          data-testid="copy-folder-toggle"
                          disabled={!volumeId || confirming}
                          aria-expanded={folderPickerOpen}
                          onClick={toggleFolderPicker}
                        >
                          {folderPickerOpen ? "收起" : "选择文件夹"}
                        </button>
                      </div>

                      {folderPickerOpen ? (
                        <div className="folder-picker" data-testid="copy-folder-picker">
                          <div className="folder-picker__head">
                            <div className="seg" role="group" aria-label="拷贝范围">
                              <button
                                type="button"
                                className="seg__btn"
                                data-testid="copy-scope-whole"
                                aria-pressed={sourceMode === "whole"}
                                /* 确认屏开着时范围也锁死:plan 是按当时的选择算的,
                                   偷偷改回整卷等于拿着「2 个文件夹」的改名清单
                                   去拷整张卡 */
                                disabled={confirming}
                                onClick={() => {
                                  setSourceMode("whole");
                                  setSelectedFolders([]);
                                }}
                              >
                                整卷
                              </button>
                              <button
                                type="button"
                                className="seg__btn"
                                data-testid="copy-scope-folders"
                                aria-pressed={sourceMode === "folders"}
                                disabled={confirming}
                                onClick={() => setSourceMode("folders")}
                              >
                                按文件夹
                              </button>
                            </div>
                            {/* JSX 里换行会渲染成一个空格,中文断句处才可断行 */}
                            <span className="text-2xs dim">
                              勾中的只拷「直接子文件」；
                              子目录不递归，它自己是下面另一条独立条目
                            </span>
                          </div>

                          {foldersLoading ? (
                            <p className="text-xs dim">正在读取卡内文件夹…</p>
                          ) : null}

                          {foldersError ? (
                            <div
                              className="notice notice--danger"
                              role="alert"
                              data-testid="copy-folder-error"
                            >
                              <strong>读取卡内文件夹失败</strong>
                              <span>
                                {foldersError}。
                                没拿到清单就按整卷继续等于悄悄扩大范围，
                                所以这里不会自动回退——请重试，或保持「整卷」并明示。
                              </span>
                              <div>
                                <button
                                  type="button"
                                  className="btn btn--sm"
                                  data-testid="copy-folder-retry"
                                  onClick={() => void loadFolders()}
                                >
                                  重试
                                </button>
                              </div>
                            </div>
                          ) : null}

                          {folders && folders.length > 0 ? (
                            <div className="folder-list" data-testid="copy-folder-list">
                              {folders.map((f) => {
                                /* 可见 meta 必须一并进读屏名。
                                   `aria-label` 会**覆盖**可见文字,此前这一行
                                   读出来只有「选择文件夹 DCIM」——被吃掉的恰恰是
                                   「含子目录（另有条目）」这句:本功能最容易误解的
                                   规则(子目录不递归)就藏在这里,读屏用户完全听不到。 */
                                const meta = `${f.fileCount} 个文件，${formatBytes(
                                  f.totalBytes,
                                  0,
                                )}${f.hasSubfolders ? "，含子目录（子目录不在本条内，是列表里另一条独立条目）" : ""}`;
                                return (
                                  <Checkbox
                                    key={f.relPath}
                                    className="folder-row"
                                    checked={selectedFolders.includes(f.relPath)}
                                    disabled={confirming}
                                    ariaLabel={`选择文件夹 ${f.relPath || "卷根"}，${meta}`}
                                    onChange={(next) => toggleFolder(f.relPath, next)}
                                  >
                                    <span className="folder-row__path">
                                      {f.relPath || "（卷根）"}
                                    </span>
                                    <span className="folder-row__meta">
                                      {f.fileCount} 个文件 ·{" "}
                                      {formatBytes(f.totalBytes, 0)}
                                      {f.hasSubfolders ? " · 含子目录（另有条目）" : ""}
                                    </span>
                                  </Checkbox>
                                );
                              })}
                            </div>
                          ) : null}

                          {folders && folders.length === 0 ? (
                            <p className="text-xs dim">这张卡里没有可选的文件夹。</p>
                          ) : null}

                          {sourceMode === "folders" && selectedFolders.length > 0 ? (
                            <p className="folder-picker__note">
                              落盘会「扁平化」：不保留文件夹名与层级，全部平铺进目标夹。
                              重名的会被系统自动加前缀，确认屏会逐条列给你看。
                            </p>
                          ) : null}
                        </div>
                      ) : null}

                      {submitted && folderError ? (
                        <span
                          className="field__error"
                          role="alert"
                          data-testid="copy-folder-error-empty"
                        >
                          {folderError}
                        </span>
                      ) : null}
                    </div>
                  </div>
                </div>

                {/* ---- 中央管道：静止示意 ⇄ 运行真值，同一个元素 ---- */}
                <div className="copy-stage__flow">
                  {task ? (
                    <div className="copy-hero__row">
                      <div className="copy-hero__percent" data-testid="copy-flow-percent">
                        {flowPercent}
                        <span className="copy-hero__unit">%</span>
                        {verifying ? (
                          <span
                            className="copy-hero__phase"
                            data-testid="copy-hero-phase"
                          >
                            校验中
                          </span>
                        ) : null}
                      </div>
                      <div className="copy-hero__vitals">
                        <div className="copy-hero__vital">
                          <span className="stat__label">
                            {verifying ? "校验速度" : "速度"}
                          </span>
                          <span className="copy-hero__vital-value copy-hero__vital-value--spark">
                            {/* 迷你曲线嵌在速度数字左侧：读法就是「这个数的历史」 */}
                            <SpeedSparkline
                              samples={speedSamples}
                              label="拷贝速度曲线"
                              className="copy-hero__spark"
                            />
                            {formatSpeed(
                              verifying ? verifySpeed : task.speedBytesPerSec,
                            )}
                          </span>
                        </div>
                        <div className="copy-hero__vital">
                          <span className="stat__label">预计剩余</span>
                          <span className="copy-hero__vital-value">
                            {verifying
                              ? formatEta(verifyTotal - verifiedSum, verifySpeed)
                              : formatEta(
                                  task.totalBytes - task.copiedBytes,
                                  task.speedBytesPerSec,
                                )}
                          </span>
                        </div>
                      </div>
                    </div>
                  ) : (
                    <div className="copy-stage__idle">
                      <span className="copy-stage__idle-title">等待开始</span>
                    </div>
                  )}

                  <div className="copy-stage__pipe">
                    <CopyFlowBar
                      state={flowState}
                      value={flowValue}
                      total={flowTotal}
                      label={verifying ? "校验进度" : "总进度"}
                      valueText={
                        verifying
                          ? `已校验 ${formatBytes(verifiedSum)} / ${formatBytes(verifyTotal)}（全部目的地合计）`
                          : `${formatBytes(flowValue)} / ${formatBytes(flowTotal)}`
                      }
                    />
                    <IconChevronRight
                      className="copy-stage__arrow"
                      aria-hidden="true"
                    />
                  </div>

                  <p className="copy-stage__caption" data-testid="copy-flow-caption">
                    {flowCaption}
                  </p>
                  {task ? (
                    <p className="copy-stage__readout mono">
                      {verifying
                        ? `已校验 ${formatBytes(verifiedSum)} / ${formatBytes(verifyTotal)}`
                        : `${formatBytes(task.copiedBytes)} / ${formatBytes(task.totalBytes)}`}
                    </p>
                  ) : null}
                </div>

                {/* ---- 目的端 ---- */}
                <div className="copy-stage__node copy-stage__node--dest">
                  <div className="copy-stage__art">
                    <IllStorageTarget kind={heroDestKind} />
                  </div>
                  <div className="copy-stage__box">
                    <div className="copy-stage__box-head">
                      <span className="copy-stage__box-title">目的地</span>
                      <button
                        type="button"
                        className="btn btn--sm push-right"
                        data-testid="copy-dests-jump"
                        disabled={confirming}
                        onClick={focusDestinations}
                      >
                        设置
                      </button>
                    </div>
                    <ul className="copy-dest-summary" data-testid="copy-dest-summary">
                      {dests.map((d) => (
                        <li key={d.id} className="copy-dest-summary__item">
                          <Badge>{DESTINATION_KIND_LABEL[d.kind]}</Badge>
                          {d.kind === "nas" ? (
                            <span className="copy-dest-summary__path truncate">
                              由项目结构自动推导
                            </span>
                          ) : d.path ? (
                            <span
                              className="copy-dest-summary__path truncate"
                              title={d.path}
                            >
                              {d.path}
                            </span>
                          ) : (
                            <span className="copy-dest-summary__path text-warn">
                              未填写路径
                            </span>
                          )}
                        </li>
                      ))}
                    </ul>
                    {dests.length < 2 ? (
                      /* 与下半区那句引导措辞不同,避免同一句话在一屏里出现两遍 */
                      <p className="copy-stage__note">
                        当前只有 1 份备份，点「设置」可再加一块盘
                      </p>
                    ) : null}
                  </div>
                  <button
                    type="submit"
                    form="copy-form"
                    className="btn copy-stage__start"
                    data-testid="copy-start"
                    disabled={confirming || busy}
                  >
                    开始拷卡
                  </button>
                </div>
              </section>
            ) : null}

            {confirmDraft && project ? (
              /* ---------- 第二步：双确认（通栏，改名清单要地方） ----------
                 这一整块**只读 confirmDraft 与绑定在它上面的 preview/plan**。
                 一旦有一处退回去读当前表单，「展示的清单 = 将要执行的清单」
                 这条承诺就破了，而双确认屏的全部价值就是这条承诺。 */
              <div className="copy-confirm">
                <div className="card">
                  <div className="card__head">
                    <span className="card__title">确认拷卡信息</span>
                    <span className="card__hint">摄影师与 DIT 共同核对</span>
                  </div>
                  <div className="card__body">
                    <div className="copy-confirm__grid">
                      <div className="stack stack--lg">
                        {/* 流程辅助图：把「源读一次、多目的地、双端校验」画成实物流向。
                            目的地取真实落盘清单（几路画几路），等 preview 解析出来 */}
                        {activePreview ? (
                          <div className="copy-flow">
                            <IllCopyFlow
                              destinations={activePreview.destinations.map((d) => ({
                                kind: d.kind,
                                label: DESTINATION_KIND_LABEL[d.kind],
                              }))}
                            />
                          </div>
                        ) : null}
                        <div className="dl">
                          <div className="dl__row">
                            <span className="dl__key">项目</span>
                            <span className="dl__val mono">{project.folderName}</span>
                          </div>
                          <div className="dl__row">
                            <span className="dl__key">源卷</span>
                            <span className="dl__val mono">
                              {confirmDraft.volumeName}（{confirmDraft.volumeMountPath}）
                            </span>
                          </div>
                          <div className="dl__row">
                            <span className="dl__key">拷贝范围</span>
                            <span
                              className="dl__val"
                              data-testid="confirm-source-scope"
                            >
                              {confirmDraft.sourceFolders.length === 0 ? (
                                "整卷（保留卡内原有层级）"
                              ) : (
                                <>
                                  <span>
                                    {confirmDraft.sourceFolders.length}{" "}
                                    个文件夹，扁平化落盘（不保留文件夹名与层级）
                                  </span>
                                  <span className="copy-confirm__folders mono">
                                    {/* 卷根是空串,直接 join 会渲染成一段空白 */}
                                    {formatScopeFolders(confirmDraft.sourceFolders).text}
                                  </span>
                                </>
                              )}
                            </span>
                          </div>
                          <div className="dl__row">
                            <span className="dl__key">相机</span>
                            <span className="dl__val mono">
                              {confirmDraft.cameraCode}
                            </span>
                          </div>
                          <div className="dl__row">
                            <span className="dl__key">目标夹</span>
                            <span
                              className="dl__val mono"
                              data-testid="confirm-target-folder"
                            >
                              {activePreview ? activePreview.targetFolder : "解析中…"}
                            </span>
                          </div>
                          <div className="dl__row">
                            <span className="dl__key">内容标签</span>
                            <span className="dl__val">
                              <span className="tag-row" data-testid="confirm-tags">
                                {confirmDraft.tags.map((name) => (
                                  <TagChip
                                    key={name}
                                    name={name}
                                    color={colorOfTag(settings?.tags ?? [], name)}
                                  />
                                ))}
                              </span>
                            </span>
                          </div>
                          {project.scenario === "A" ? (
                            <div className="dl__row">
                              <span className="dl__key">拷完转代理</span>
                              <span className="dl__val" data-testid="confirm-auto-proxy">
                                {confirmDraft.autoProxy
                                  ? "是，拷完自动派发转码作业"
                                  : "否"}
                              </span>
                            </div>
                          ) : null}
                          <div className="dl__row">
                            <span className="dl__key">实际落盘</span>
                            <span className="dl__val" data-testid="confirm-destinations">
                              {previewFailed ? (
                                <span className="text-warn" role="alert">
                                  落盘路径解析失败(详见右下角提示)。表单没改的话不必退回,{" "}
                                  <button
                                    type="button"
                                    className="btn btn--sm"
                                    data-testid="copy-preview-retry"
                                    onClick={() => void fetchPreview(confirmDraft)}
                                  >
                                    重试解析
                                  </button>
                                </span>
                              ) : activePreview ? (
                                activePreview.destinations.map((d) => (
                                  <span key={d.id} className="dest-line__path">
                                    {DESTINATION_KIND_LABEL[d.kind]} · {d.path}
                                    <br />
                                  </span>
                                ))
                              ) : (
                                <span className="dim">解析中…</span>
                              )}
                            </span>
                          </div>
                        </div>
                      </div>

                      {/* ---- 规模 + 改名清单：零静默的主战场 ---- */}
                      <div className="stack stack--lg">
                        {planChanged ? (
                          /* 后端拒了这次提交：卡上内容在双确认之后变了。
                             绝不自动重试——重试等于替用户批准一份他没看过的
                             清单。这里重新核算，让他重新过一遍。 */
                          <div
                            className="notice notice--danger"
                            role="alert"
                            data-testid="copy-plan-changed"
                          >
                            <strong>
                              {planChangedCause
                                ? "本次提交被拒：批准的那份计划已经不成立"
                                : "卡上的内容在你确认之后变了"}
                            </strong>
                            <span>
                              {/* 后端点名到具体原因(甚至具体文件)的那句话原样展示。
                                  笼统的「内容变了」会把人引向错误的排查方向——
                                  实际是「文件被改过」却让人去翻读卡器。 */}
                              {planChangedCause ||
                                "可能是换了卡、文件被增删，或有别的程序在写这张卡。"}
                              {" "}这次<strong>没有</strong>开跑。
                              下面是重新核算出的范围与改名清单，请重新核对后再确认。
                            </span>
                          </div>
                        ) : null}
                        {planFailed ? (
                          <div
                            className="notice notice--danger"
                            role="alert"
                            data-testid="copy-plan-error"
                          >
                            <strong>无法核算本次拷贝范围</strong>
                            <span>
                              没有文件数与改名清单就开跑，
                              等于让系统替你改文件名而你看不见。
                              这里不会自动退回整卷继续——请重试；仍失败就「返回修改」。
                            </span>
                            <div>
                              <button
                                type="button"
                                className="btn btn--sm"
                                data-testid="copy-plan-retry"
                                onClick={() => void fetchPlan(confirmDraft)}
                              >
                                重试核算
                              </button>
                            </div>
                          </div>
                        ) : activePlan ? (
                          <>
                            <div className="copy-plan">
                              <span className="copy-plan__label">本次将拷</span>
                              <span
                                className="copy-plan__value"
                                data-testid="confirm-plan-scale"
                              >
                                {activePlan.fileCount} 个文件 ·{" "}
                                {formatBytes(activePlan.totalBytes)}
                              </span>
                            </div>

                            {activePlan.fileCount === 0 ? (
                              /* 只勾了「只有子目录、没有直接子文件」的父目录时
                                 会走到这:照跑只会建一个空目标夹,而用户以为
                                 卡已经拷完了。这是最容易踩的规则,必须拦住。 */
                              <div
                                className="notice notice--warn"
                                role="alert"
                                data-testid="confirm-plan-empty"
                              >
                                <strong>这次一个文件都不会拷</strong>
                                <span>
                                  勾中的文件夹没有直接子文件（多半只含子目录）。
                                  子目录不递归，要拷它就得在列表里单独勾上它自己。
                                  请「返回修改」重选。
                                </span>
                              </div>
                            ) : null}

                            {activePlan.hiddenSkipped > 0 ? (
                              /* 被排除的东西不进计划，任务却照样报 100%。配上
                                 「本卡可格式化」那句话就是引导用户格式化掉没备份
                                 的东西——必须在确认前说出来。

                                 口径已变(2026-08-28):曾经是「以点开头一律跳过」,
                                 那会把 `.clip.mov` 这类合法素材静默漏掉;现在只排除
                                 明确列举的系统项。文案跟着改准——说成「点开头的都不拷」
                                 会让人白白去给素材改名。 */
                              <div
                                className="notice notice--warn"
                                role="alert"
                                data-testid="confirm-hidden-skipped"
                              >
                                <strong>
                                  {activePlan.hiddenSkipped} 个系统项不在本次范围内
                                </strong>
                                <span>
                                  指废纸篓、索引数据库、`.DS_Store` 这类由操作系统或
                                  NAS 自己生成的记账文件。它们不会被拷贝，也不计入
                                  「全部校验通过」
                                  {activePlan.hiddenSamples.length > 0
                                    ? `——例如：${activePlan.hiddenSamples.join("、")}。`
                                    : "。"}
                                  你的素材不受影响：以点开头的素材文件（如
                                  `.clip.mov`）现在会照常拷贝，不必改名。
                                </span>
                              </div>
                            ) : null}

                            {activePlan.renamedFiles.length === 0 ? (
                              <p
                                className="text-xs dim"
                                data-testid="confirm-renames-none"
                              >
                                没有重名，所有文件名一个字都不改。
                              </p>
                            ) : (
                              <div
                                className="notice notice--warn"
                                role="alert"
                                data-testid="confirm-renames"
                              >
                                <strong>
                                  {activePlan.renamedFiles.length} 个文件将被系统自动改名
                                </strong>
                                <span>
                                  扁平化后这些文件名会撞车，
                                  系统给它们加了「最短可区分前缀」。
                                  这是系统替你改文件名，务必逐条核对。
                                </span>
                                <ul className="copy-renames">
                                  {(renamesExpanded
                                    ? activePlan.renamedFiles
                                    : activePlan.renamedFiles.slice(0, RENAME_PREVIEW)
                                  ).map((r) => (
                                    <li
                                      key={r.sourceRel}
                                      className="copy-renames__item"
                                      data-testid="confirm-rename-item"
                                    >
                                      <span className="copy-renames__from mono">
                                        {r.sourceRel}
                                      </span>
                                      <span className="copy-renames__arrow">→</span>
                                      <span className="copy-renames__to mono">
                                        {r.targetRel}
                                      </span>
                                    </li>
                                  ))}
                                </ul>
                                {activePlan.renamedFiles.length > RENAME_PREVIEW &&
                                !renamesExpanded ? (
                                  <div>
                                    <button
                                      type="button"
                                      className="btn btn--sm"
                                      data-testid="confirm-renames-expand"
                                      onClick={() => setRenamesExpanded(true)}
                                    >
                                      展开查看全部 {activePlan.renamedFiles.length} 条
                                    </button>
                                  </div>
                                ) : null}
                              </div>
                            )}
                          </>
                        ) : (
                          <p className="text-xs dim" data-testid="confirm-plan-loading">
                            正在核算本次拷贝范围…
                          </p>
                        )}

                        <p className="text-xs dim">
                          确认后开始读卡。校验全部通过前请勿拔卡，OCard 不会代为格式化。
                        </p>

                        {confirmDraft.volumeIsSystem ? (
                          /* 过滤只是「藏」,这里是「拦」:用户显式打开开关选了
                             系统盘,确认屏必须再敲一次警钟(opus 评审 P2)。
                             判据也走草稿:这条警告说的是**将要拷的那个卷** */
                          <div
                            className="notice notice--danger"
                            role="alert"
                            data-testid="copy-system-volume-warning"
                          >
                            <strong>源卷是系统内置盘</strong>
                            <span>
                              「{confirmDraft.volumeName}（{confirmDraft.volumeMountPath}
                              ）」是本机系统盘,
                              不是相机存储卡。把整台电脑的磁盘当卡拷几乎肯定是误选,
                              请返回重选源卷。
                            </span>
                          </div>
                        ) : null}

                        {remoteSameVolume ? (
                          <div
                            className="notice notice--warn"
                            role="alert"
                            data-testid="copy-same-volume-warning"
                          >
                            <strong>该卡可能正被他机拷贝</strong>
                            <span>
                              {remoteSameVolume.machine}（操作人 {remoteSameVolume.operator}）
                              正在拷同名卷「{remoteSameVolume.volume}」。
                              请与对方确认后再继续，避免重复拷同一张卡。
                            </span>
                          </div>
                        ) : null}

                        <div className="row-inline">
                          <button
                            type="button"
                            className="btn"
                            /* 返回即作废这份草稿:它那两个还在飞的请求落地后
                               再也写不进任何状态(E1 的时序就是从这里被打开的) */
                            onClick={leaveConfirm}
                          >
                            返回修改
                          </button>
                          <button
                            type="button"
                            data-testid="copy-confirm-start"
                            className="btn copy-stage__start"
                            onClick={confirmAndStart}
                            /* 没有 plan 就没有改名清单可看——此时开跑就是静默改名;
                               核算出 0 个文件也不放行,那只会建一个空目标夹。
                               这里判的是 activePlan/activePreview:属于**这份草稿**
                               的那两份,别的草稿的结果一律不算数 */
                            disabled={
                              busy ||
                              !activePreview ||
                              !activePlan ||
                              activePlan.fileCount === 0
                            }
                          >
                            {busy ? "正在建立任务…" : "确认开始"}
                          </button>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            ) : (
              <div className="copy__form">
                <div className="card">
                  <div className="card__head">
                    <span className="card__title">
                      {project ? "拷卡设置" : "发起拷卡"}
                    </span>
                    <span className="card__hint">
                      {project ? "目的地与转代理按项目记住" : "先选项目"}
                    </span>
                  </div>
                  <div className="card__body">
                    {!project ? (
                      <div className="stack">
                        <p className="text-sm" role="alert">
                          尚未选择项目，无法发起拷卡。
                        </p>
                        <div>
                          <button
                            type="button"
                            className="btn"
                            onClick={() => void bridge.openManager()}
                          >
                            去选择项目
                          </button>
                        </div>
                      </div>
                    ) : (
                      <form
                        id="copy-form"
                        className="stack stack--lg"
                        onSubmit={(e) => {
                          e.preventDefault();
                          void requestConfirm();
                        }}
                      >
                        <Field
                          label="对应相机"
                          htmlFor="copy-camera"
                          error={submitted ? validation.errors.cameraId : undefined}
                        >
                          <Select
                            id="copy-camera"
                            testId="copy-camera-select"
                            value={cameraId}
                            onChange={setCameraId}
                            options={cameras.map((c) => ({
                              value: c.id,
                              label: `${c.model} · ${c.code}`,
                            }))}
                          />
                        </Field>

                        <Field
                          label={
                            project.scenario === "A" ? "目标夹日期" : "目标夹时段"
                          }
                          htmlFor="copy-prefix"
                          hint={`默认本机今天,落在「${copyTargetParent(project.scenario)}」下`}
                          error={submitted ? validation.errors.targetPrefix : undefined}
                        >
                          <div className="prefix-picker">
                            <input
                              id="copy-prefix"
                              data-testid="copy-prefix-date"
                              className="input input--mono prefix-picker__date"
                              type="date"
                              value={prefixIso}
                              onChange={(e) => setPrefixIso(e.currentTarget.value)}
                            />
                            {project.scenario === "B" ? (
                              <div
                                className="seg"
                                role="group"
                                aria-label="时段"
                                data-testid="copy-prefix-slot"
                              >
                                {TIME_SLOTS.map((value) => (
                                  <button
                                    key={value}
                                    type="button"
                                    className="seg__btn"
                                    aria-pressed={slot === value}
                                    onClick={() => setSlot(value)}
                                  >
                                    {value}
                                  </button>
                                ))}
                              </div>
                            ) : null}
                            <span
                              className="text-xs dim mono"
                              data-testid="copy-prefix-value"
                            >
                              {targetPrefix || "—"}
                            </span>
                          </div>
                        </Field>

                        <div className="code-preview">
                          <span className="code-preview__label">目标路径预览</span>
                          <span
                            className={`code-preview__value${targetPath ? "" : " code-preview__value--empty"}`}
                            data-testid="copy-target-preview"
                          >
                            {targetPath || "选择相机后生成"}
                          </span>
                        </div>

                        <Field
                          label="内容标签"
                          htmlFor="copy-tags"
                          hint="规范要求「适当记录」；标签随项目走，各工作站共用一套"
                          error={submitted ? validation.errors.tags : undefined}
                        >
                          <TagPicker
                            id="copy-tags"
                            testId="copy-tags"
                            value={tags}
                            onChange={setTags}
                            library={settings?.tags ?? []}
                            onCreateTag={createTag}
                            invalid={Boolean(submitted && validation.errors.tags)}
                          />
                        </Field>

                        {project.scenario === "A" ? (
                          <Checkbox
                            testId="copy-auto-proxy"
                            checked={autoProxy}
                            onChange={setAutoProxy}
                          >
                            拷完自动转代理（转入「4. 转码素材」）
                          </Checkbox>
                        ) : null}

                        <div className="field" ref={destsRef}>
                          <span className="field__label">目的地</span>
                          <div className="stack stack--sm">
                            {dests.map((dest, index) => (
                              <div key={dest.id}>
                                <div className="dest-row">
                                  <Select
                                    ariaLabel={`第 ${index + 1} 个目的地类型`}
                                    value={dest.kind}
                                    onChange={(next) => {
                                      const kind = next as DestinationKind;
                                      setDests((prev) =>
                                        prev.map((d) =>
                                          d.id === dest.id ? { ...d, kind } : d,
                                        ),
                                      );
                                    }}
                                    options={(
                                      Object.keys(
                                        DESTINATION_KIND_LABEL,
                                      ) as DestinationKind[]
                                    ).map((kind) => ({
                                      value: kind,
                                      label: DESTINATION_KIND_LABEL[kind],
                                    }))}
                                  />
                                  <PathField
                                    value={dest.kind === "nas" ? "" : dest.path}
                                    ariaLabel={`第 ${index + 1} 个目的地路径`}
                                    /* NAS 目的地由项目结构推导，用户填了也会被后端忽略 */
                                    readOnly={dest.kind === "nas"}
                                    disabled={dest.kind === "nas"}
                                    invalid={Boolean(
                                      submitted &&
                                        validation.errors.destinationAt?.[index],
                                    )}
                                    placeholder={
                                      dest.kind === "nas"
                                        ? "由项目结构自动推导"
                                        : "选择或粘贴目标文件夹路径"
                                    }
                                    pickerTitle={`选择第 ${index + 1} 个目的地文件夹`}
                                    onChange={(path) => {
                                      setDests((prev) =>
                                        prev.map((d) =>
                                          d.id === dest.id ? { ...d, path } : d,
                                        ),
                                      );
                                    }}
                                  />
                                  {dest.kind !== "nas" ? (
                                    /* 备份盘就在已挂载卷里(评审 1.2):选卷即得根路径,
                                       不必进文件系统翻。源卷与系统盘不在候选之列。 */
                                    <Select
                                      ariaLabel={`第 ${index + 1} 个目的地从已挂载卷选择`}
                                      value=""
                                      placeholder="选盘…"
                                      onChange={(mount) => {
                                        if (!mount) return;
                                        setDests((prev) =>
                                          prev.map((d) =>
                                            d.id === dest.id ? { ...d, path: mount } : d,
                                          ),
                                        );
                                      }}
                                      options={volumes
                                        .filter((v) => !v.isSystem && v.id !== volumeId)
                                        .map((v) => ({
                                          value: v.mountPath,
                                          label: `${v.name}（剩 ${formatBytes(
                                            v.capacityBytes - v.usedBytes,
                                            0,
                                          )}）`,
                                        }))}
                                    />
                                  ) : null}
                                  <button
                                    type="button"
                                    className="btn btn--ghost btn--icon"
                                    aria-label={`删除第 ${index + 1} 个目的地`}
                                    onClick={() =>
                                      setDests((prev) =>
                                        prev.filter((d) => d.id !== dest.id),
                                      )
                                    }
                                  >
                                    <IconTrash />
                                  </button>
                                </div>
                                {submitted &&
                                validation.errors.destinationAt?.[index] ? (
                                  <div className="dest-row__error">
                                    <span className="field__error" role="alert">
                                      {validation.errors.destinationAt[index]}
                                    </span>
                                  </div>
                                ) : null}
                              </div>
                            ))}
                            <div className="row-inline">
                              <button
                                type="button"
                                className="btn btn--sm"
                                onClick={() =>
                                  setDests((prev) => [...prev, newDest("external")])
                                }
                              >
                                <IconPlus />
                                添加目的地
                              </button>
                              {dests.length < 2 ? (
                                <span className="text-xs dim">
                                  建议再加一块本地/移动盘做第二份备份
                                </span>
                              ) : null}
                            </div>
                            {submitted && validation.errors.destinations ? (
                              <span className="field__error" role="alert">
                                {validation.errors.destinations}
                              </span>
                            ) : null}
                          </div>
                        </div>
                      </form>
                    )}
                  </div>
                </div>
              </div>
            )}

            <div
              className={`copy__tasks${confirming && project ? " copy__tasks--wide" : ""}`}
            >
              <div className="tasks__tabs" role="group" aria-label="任务切换">
                {projectTasks.map((t) => (
                  <button
                    key={t.id}
                    type="button"
                    className="btn btn--sm"
                    aria-pressed={t.id === task?.id}
                    title={`开始于 ${formatTimestamp(t.startedAt)}`}
                    onClick={() => dispatch({ type: "selectTask", taskId: t.id })}
                  >
                    <span className="mono">{t.volumeName}</span>
                    {/* 同名卷拷两次靠时间区分(评审 B6) */}
                    <span className="text-2xs dim mono">
                      {formatTimestamp(t.startedAt).slice(-5)}
                    </span>
                    <Badge tone={TASK_STATE_TONE[t.state]}>
                      {TASK_STATE_LABEL[t.state]}
                    </Badge>
                  </button>
                ))}
              </div>

              {task ? (
                <>
                  {task.state === "done" ? (
                    /* 「可格式化」只在整卷时成立:按文件夹拷时卡上还有没拷的内容,
                       这句话会直接导致用户格式化掉未备份素材。范围口径以后端
                       回填的 sourceFolders 为准,不用屏内表单状态(可能已被改过);
                       判据本身走 copyScope,与终态通知/审计/hero 大字同一份。 */
                    taskPartial ? (
                    <div className="notice notice--warn" role="status" data-testid="copy-partial-done">
                      <strong>
                        {taskFolderCount > 0
                          ? `所选 ${taskFolderCount} 个文件夹校验 100% 通过——但这是部分拷贝，请勿格式化。`
                          : "校验 100% 通过，但本次的拷贝范围读不出来——请勿格式化。"}
                      </strong>
                      <span>
                        {taskFolderCount > 0
                          ? /* 卷根是空串,直接 join 会写成「本次只拷了：。」——
                               安全结论还在,备份范围却没说清 */
                            `本次只拷了：${taskScopeText}。卡上其余内容尚未备份，格式化会连同它们一起抹掉。`
                          : "后端回填的范围不是一份文件夹清单，无法断定卡上还剩什么没备份。请对照审计日志核实后再决定。"}
                      </span>
                      <div>
                        <button
                          type="button"
                          className="btn btn--sm"
                          data-testid="copy-next-card"
                          onClick={startNextCard}
                        >
                          拷下一张卡
                        </button>
                      </div>
                    </div>
                    ) : (
                    <div className="notice notice--ok" role="status">
                      <strong>校验 100% 通过，本卡可格式化。</strong>
                      <span>
                        请在相机内格式化——OCard 不代为格式化，以防误操作。
                      </span>
                      <div>
                        <button
                          type="button"
                          className="btn btn--sm"
                          data-testid="copy-next-card"
                          onClick={startNextCard}
                        >
                          拷下一张卡
                        </button>
                      </div>
                    </div>
                    )
                  ) : null}

                  {/* 失败必须与完成同等醒目(评审 2.1):写明规模与下一步,不让用户
                      只面对一个红 Badge 猜原因 */}
                  {task.state === "failed" ? (
                    <div
                      className="notice notice--danger"
                      role="alert"
                      data-testid="copy-failed-banner"
                    >
                      <strong>
                        拷卡失败
                        {failedTotal > 0 ? `：${failedTotal} 个文件未通过` : ""}。
                      </strong>
                      <span>
                        {task.destinations.some((d) => d.error)
                          ? "目的地报错（见下方「目的地」的红字原因）。"
                          : "失败原因见下方文件明细的红字说明。"}
                        排除故障后点「重试全部失败文件」，按 manifest 续拷，
                        已校验的文件自动跳过、绝不覆盖。
                      </span>
                      <div>
                        <button
                          type="button"
                          className="btn btn--primary btn--sm"
                          data-testid="copy-retry-all"
                          disabled={retryingAll}
                          onClick={() => void retryAllFailed()}
                        >
                          {retryingAll
                            ? "正在重试…"
                            : `重试全部失败文件${failedTotal > 0 ? `（${failedTotal}）` : ""}`}
                        </button>
                      </div>
                    </div>
                  ) : null}

                  <div className="card">
                    <div className="card__head">
                      <span className="card__title mono truncate" title={task.targetFolder}>
                        {task.targetFolder}
                      </span>
                      <div className="card__actions">
                        <Badge tone={TASK_STATE_TONE[task.state]} dot>
                          {TASK_STATE_LABEL[task.state]}
                        </Badge>
                        {task.state === "running" || task.state === "verifying" ? (
                          <button
                            type="button"
                            className="btn btn--sm"
                            data-testid="copy-pause"
                            disabled={controlBusy}
                            onClick={() => void pauseOrResume(task.id, "pause")}
                          >
                            {controlBusy ? "处理中…" : "暂停"}
                          </button>
                        ) : null}
                        {task.state === "paused" ? (
                          <button
                            type="button"
                            className="btn btn--sm"
                            data-testid="copy-resume"
                            disabled={controlBusy}
                            onClick={() => void pauseOrResume(task.id, "resume")}
                          >
                            {controlBusy ? "处理中…" : "继续"}
                          </button>
                        ) : null}
                      </div>
                    </div>
                    <div className="card__body">
                      <div className="stack stack--lg">
                        {/* 百分比/速度/ETA 已经上移到顶部那条管道:仪表只留一处,
                            这里专注「各目的地分别走到哪」与账目 */}
                        <div className="task-stats">
                          <div>
                            <div className="stat__label">
                              {counts ? "已校验" : "文件明细"}
                            </div>
                            <div className="stat__value" data-testid="copy-verified-stat">
                              {counts
                                ? `${counts.verified}/${totalFiles}`
                                : `已加载 ${files.length}/${totalFiles}`}
                            </div>
                          </div>
                          <div>
                            <div className="stat__label">开始于</div>
                            <div className="stat__value">
                              {formatTimestamp(task.startedAt)}
                            </div>
                          </div>
                        </div>

                        <div className="dl">
                          <div className="dl__row">
                            <span className="dl__key">相机</span>
                            <span className="dl__val mono">{task.cameraCode}</span>
                          </div>
                          <div className="dl__row">
                            <span className="dl__key">内容标签</span>
                            <span className="dl__val">
                              {task.tags.length > 0 ? (
                                <span className="tag-row">
                                  {task.tags.map((name) => (
                                    <TagChip
                                      key={name}
                                      name={name}
                                      color={colorOfTag(settings?.tags ?? [], name)}
                                    />
                                  ))}
                                </span>
                              ) : (
                                /* 旧任务(标签系统之前发起的)只有自由文本备注 */
                                task.note || "—"
                              )}
                            </span>
                          </div>
                          <div className="dl__row">
                            <span className="dl__key">操作人</span>
                            <span className="dl__val">{task.operator}</span>
                          </div>
                        </div>

                        <div>
                          <div className="section__head">
                            <h2 className="section__title">目的地</h2>
                            <span className="card__hint">
                              {task.destinations.length} 个 · 单读多写
                            </span>
                          </div>
                          {/* 每个目的地一条通栏泳道：多写并行时各自的写入节奏一眼可见 */}
                          {task.destinations.map((dest) => (
                            <div className="dest-lane" key={dest.id}>
                              <div className="dest-lane__head">
                                <Badge>{DESTINATION_KIND_LABEL[dest.kind]}</Badge>
                                <span
                                  className="dest-line__path truncate"
                                  title={dest.path}
                                >
                                  {dest.path}
                                </span>
                                <span className="dest-lane__stats">
                                  {DESTINATION_STATE_LABEL[dest.state]} ·{" "}
                                  {dest.state === "verifying"
                                    ? `已校验 ${formatBytes(dest.verifiedBytes ?? 0, 0)}`
                                    : formatBytes(dest.writtenBytes, 0)}
                                </span>
                              </div>
                              <ProgressBar
                                value={
                                  dest.state === "verifying"
                                    ? (dest.verifiedBytes ?? 0)
                                    : dest.writtenBytes
                                }
                                total={task.totalBytes}
                                tone={
                                  dest.state === "done"
                                    ? "ok"
                                    : dest.state === "error"
                                      ? "danger"
                                      : "accent"
                                }
                                thin
                                decorative
                              />
                              {/* 出错原因就地可见(评审 2.3):后端给了 dest.error,
                                  用户不该只看到一个红色「出错」猜是拔线还是坏盘 */}
                              {dest.state === "error" && dest.error ? (
                                <span
                                  className="field__error"
                                  role="alert"
                                  data-testid="copy-dest-error"
                                >
                                  {dest.error}
                                </span>
                              ) : null}
                            </div>
                          ))}
                        </div>
                      </div>
                    </div>
                  </div>

                  <div>
                    <div className="section__head">
                      <h2 className="section__title">文件</h2>
                      <span className="card__hint">
                        {counts
                          ? /* 全量真值(评审 2.5):不再让总账被分页挟持 */
                            `共 ${totalFiles} 个：待拷 ${counts.pending} · 已拷 ${counts.copied} · 已校验 ${counts.verified} · 失败 ${counts.failed}`
                          : `共 ${totalFiles} 个（已加载 ${files.length}）· 以下为已加载部分：待拷 ${loadedSummary.pending} · 已拷 ${loadedSummary.copied} · 已校验 ${loadedSummary.verified} · 失败 ${loadedSummary.failed}`}
                      </span>
                      {failedTotal > 0 ? (
                        <Checkbox
                          className="text-xs"
                          testId="copy-failed-only"
                          checked={failedOnly}
                          onChange={setFailedOnly}
                        >
                          只看失败（{failedTotal}）
                        </Checkbox>
                      ) : null}
                    </div>
                    {/* --files:这层是文件明细的外框,需要 overflow:clip 让
                        里面的 sticky 表头绑到 .content 而不是被这层截胡 */}
                    <div className="list list--files">
                      <div className="files__scroll">
                        <div className="list__head files__head">
                          <span>文件名</span>
                          <span>大小</span>
                          <span>xxHash3-64</span>
                          <span>状态</span>
                          <span />
                        </div>
                        {visibleFiles.map((f) => (
                          <div className="list__row files__row" key={f.id}>
                            <span className="files__name truncate" title={f.path}>
                              {f.name}
                              {f.error ? (
                                <span className="files__error">{f.error}</span>
                              ) : null}
                            </span>
                            <span className="files__cell">{formatBytes(f.sizeBytes)}</span>
                            <span className="files__cell truncate">{f.hash ?? "—"}</span>
                            <span>
                              <Badge tone={COPY_FILE_STATUS_TONE[f.status]}>
                                {COPY_FILE_STATUS_LABEL[f.status]}
                              </Badge>
                            </span>
                            <span>
                              {f.status === "failed" ? (
                                <button
                                  type="button"
                                  className="btn btn--ghost btn--icon btn--sm"
                                  aria-label={`重试 ${f.name}`}
                                  disabled={controlBusy}
                                  onClick={() => void retryOneFile(task.id, f)}
                                >
                                  <IconRetry />
                                </button>
                              ) : null}
                            </span>
                          </div>
                        ))}
                        {visibleFiles.length === 0 && !filesLoading ? (
                          <EmptyState>
                            {failedOnly
                              ? files.length < totalFiles
                                ? "已加载的部分没有失败文件；点下方「加载更多」继续找。"
                                : "没有失败文件。"
                              : "暂无文件明细。"}
                          </EmptyState>
                        ) : null}
                      </div>
                    </div>

                    {files.length < totalFiles ? (
                      /* 列表不再自滚(与外层嵌套)后,「加载更多」会被自己推到
                         几千像素之外:每点一次列表就长一页,下次还得先滚回来找。
                         改成触底自动续拉(与选片屏 onEndReached 同一范式),
                         按钮保留为哨兵没触发时的手动出口。 */
                      <div className="hint-bar" ref={filesEndRef}>
                        <button
                          type="button"
                          className="btn btn--sm"
                          data-testid="copy-load-more-files"
                          disabled={filesLoading}
                          onClick={() => void loadMoreFiles(task.id, files.length)}
                        >
                          {filesLoading
                            ? "加载中…"
                            : `加载更多（还有 ${totalFiles - files.length} 个）`}
                        </button>
                      </div>
                    ) : null}
                  </div>
                </>
              ) : (
                <div className="list">
                  <EmptyState art={project ? <IllCopyEmpty /> : undefined}>
                    {project ? "本项目还没有拷卡任务，从上方发起一个。" : "先选择项目。"}
                  </EmptyState>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>

      <ConfirmDialog request={confirm} onCancel={() => setConfirm(null)} />
    </>
  );
}
