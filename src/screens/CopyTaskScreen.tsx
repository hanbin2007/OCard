/** 屏 4：拷卡任务面板（源卷双确认 + 多目的地 + 逐文件哈希状态）。 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as api from "../api";
import type {
  CopyFileItem,
  CopyTaskPreview,
  DestinationKind,
  ProjectSettings,
  StartCopyInput,
  NoticeLevel,
} from "../api/types";
import { SpeedSparkline, useSpeedSamples } from "../components/charts";
import { Checkbox, Select } from "../components/controls";
import { ConfirmDialog, type ConfirmRequest } from "../components/ConfirmDialog";
import { IconPlus, IconRetry, IconTrash } from "../components/Icon";
import { PathField } from "../components/PathField";
import { RemoteActivityBanner } from "../components/RemoteActivityBanner";
import { TagChip, TagPicker } from "../components/TagPicker";
import { TopBar } from "../components/TopBar";
import { IllCopyEmpty, IllCopyFlow } from "../components/illustrations";
import { Badge, EmptyState, Field, ProgressBar } from "../components/ui";
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

/** 文件明细每页条数 */
const PAGE_SIZE = 200;

let destSeq = 0;
function newDest(kind: DestinationKind, path = ""): DestDraft {
  destSeq += 1;
  return { id: `dest-${destSeq}`, kind, path };
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
    setConfirming(false);
    setPreview(null);
    setPreviewFailed(false);
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
  /**
   * 目的地是否仍是「无人动过」的初始态:settings 预设的异步预填只允许
   * 落在 pristine 状态上——用户(或本地记忆)已经写过的目的地,预设晚到
   * 一步就整表覆盖是真数据丢失(合并评审:CI/本地时序不同当场翻车)。
   */
  const destsPristineRef = useRef(true);
  const [submitted, setSubmitted] = useState(false);
  /** 工况 A：拷完自动派发代理转码作业（PRD §5.6） */
  const [autoProxy, setAutoProxy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);

  const [confirm, setConfirm] = useState<ConfirmRequest | null>(null);

  // 后端解析出的真实落盘位置（双确认屏只显示这个，不显示用户填的路径）
  const [preview, setPreview] = useState<CopyTaskPreview | null>(null);
  /** 落盘预览失败:面板给静态提示 + 返回修改;具体原因走 toast */
  const [previewFailed, setPreviewFailed] = useState(false);

  // 文件明细分页拉取：list_copy_tasks 按契约不带 files
  const [files, setFiles] = useState<CopyFileItem[]>([]);
  const [fileTotal, setFileTotal] = useState(0);
  const [filesLoading, setFilesLoading] = useState(false);

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

  const targetPath =
    project && camera
      ? buildCopyTargetPath(project.scenario, targetPrefix, camera.code)
      : "";

  // 切项目把发起表单整体归零(codex 评审 P1):侧栏切项目页面不再卸载,
  // 留着旧项目的确认预览会出现「对着 A 的预览确认,任务落进 B」
  const projectKey = project?.id ?? null;
  useEffect(() => {
    setConfirming(false);
    setPreview(null);
    setPreviewFailed(false);
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
    const hasSavedDests = Boolean(saved.dests && saved.dests.length > 0);
    destsPristineRef.current = !hasSavedDests;
    setDests(
      hasSavedDests
        ? saved.dests!.map((d) => newDest(d.kind, d.path))
        : [newDest("nas")],
    );
    setAutoProxy(saved.autoProxy ?? false);
  }, [projectKey]);

  // 项目设置(标签库 + 备份盘预设)随项目加载;预设盘预填进目的地行
  useEffect(() => {
    if (!projectKey) return;
    let cancelled = false;
    void (async () => {
      try {
        const loaded = await api.getProjectSettings(projectKey);
        if (cancelled) return;
        setSettings(loaded);
        // 只在无人动过时预填:用户/本地记忆已写过的目的地不许被晚到的
        // 预设整表覆盖(数据丢失级竞态)
        if (loaded.backupPaths.length > 0 && destsPristineRef.current) {
          destsPristineRef.current = false;
          setDests([
            newDest("nas"),
            ...loaded.backupPaths.map((p) => newDest("external", p)),
          ]);
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


  /** 进度事件驱动的重拉节流：拷贝中每 ~200ms 一条事件，不能每条都打一次 IPC */
  const REFRESH_MIN_MS = 2000;
  const loadedCountRef = useRef(0);
  const lastRefreshRef = useRef(0);

  /** 追加下一页 */
  const loadMoreFiles = useCallback(
    async (taskId: string, offset: number) => {
      setFilesLoading(true);
      try {
        const page = await api.listCopyFiles(taskId, offset, PAGE_SIZE);
        setFileTotal(page.total);
        setFiles((prev) => [...prev, ...page.items]);
      } catch (err) {
        pushNotice(
          "error",
          "copy-files-load-failed",
          `加载文件明细失败：${err instanceof Error ? err.message : String(err)}`,
        );
      } finally {
        setFilesLoading(false);
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
      const limit = Math.max(loadedCountRef.current, PAGE_SIZE);
      lastRefreshRef.current = Date.now();
      try {
        const page = await api.listCopyFiles(taskId, 0, limit);
        setFiles(page.items);
        setFileTotal(page.total);
      } catch (err) {
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
    if (!taskId) {
      setFiles([]);
      setFileTotal(0);
      loadedCountRef.current = 0;
      return;
    }
    let cancelled = false;
    setFiles([]);
    loadedCountRef.current = 0;
    void (async () => {
      try {
        const page = await api.listCopyFiles(taskId, 0, PAGE_SIZE);
        if (cancelled) return;
        setFiles(page.items);
        setFileTotal(page.total);
        lastRefreshRef.current = Date.now();
      } catch (err) {
        if (cancelled) return;
        pushNotice(
          "error",
          "copy-files-load-failed",
          `加载文件明细失败：${err instanceof Error ? err.message : String(err)}`,
        );
      }
    })();
    return () => {
      cancelled = true;
    };
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

  /** 真正提交；confirmExisting 为 true 时表示用户已在对话框里同意继续 */
  async function submitStart(confirmExisting: boolean) {
    if (!project) return;
    setBusy(true);
    try {
      const input: StartCopyInput = {
        projectId: project.id,
        volumeId,
        cameraId,
        // note 是标签拼串的兼容形态:manifest 与审计日志保持人可读
        note: joinTagsAsNote(tags),
        tags,
        targetPrefix,
        destinations: dests.map(({ kind, path }) => ({ kind, path })),
        // 仅工况 A 有代理转码概念，工况 B 不传这个标志
        ...(project.scenario === "A" ? { autoProxy } : {}),
        ...(confirmExisting ? { confirmExistingTarget: true } : {}),
      };
      const started = await api.startCopyTask(input);
      dispatch({ type: "taskStarted", task: started });
      // 与后端对账一次，别只信 start 的返回值
      void refreshTask(started.id);
      setTags([]);
      // 成功即记忆(评审 1.2/1.6):目的地/转代理预填给下一张卡
      savePref(`copy:${project.id}`, {
        dests: dests.map(({ kind, path }) => ({ kind, path })),
        autoProxy,
      });
      setSubmitted(false);
      setConfirming(false);
      setPreview(null);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.startsWith("TARGET_EXISTS:")) {
        // 目标夹已存在且非空：极可能是同名重复拷卡，必须让人明示
        setConfirm({
          title: "目标夹已存在",
          message:
            "目标夹已存在且非空，可能是同名重复拷卡。确认继续将只补缺失文件、绝不覆盖已有文件。",
          confirmLabel: "继续拷卡",
          onConfirm: () => void submitStart(true),
        });
      } else {
        // 提交后失败统一走 toast(UX 波三)
        pushNotice("error", "copy-start-failed", `发起拷卡失败：${message}`);
      }
    } finally {
      setBusy(false);
    }
  }

  async function confirmAndStart() {
    if (!validation.valid || !project || busy) return;
    await submitStart(false);
  }

  /** 落盘预览拉取:独立出来供确认屏内「重试解析」复用(评审 1.6)——
      NAS 偶发失败时不必退回第一步重走整表 */
  async function fetchPreview() {
    if (!project) return;
    setPreview(null);
    setPreviewFailed(false);
    try {
      const result = await api.previewCopyTask({
        projectId: project.id,
        volumeId,
        cameraId,
        note: joinTagsAsNote(tags),
        tags,
        targetPrefix,
        destinations: dests.map(({ kind, path }) => ({ kind, path })),
      });
      setPreview(result);
    } catch (err) {
      setPreviewFailed(true);
      pushNotice(
        "error",
        "copy-preview-failed",
        `无法解析实际落盘路径：${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /** 进入第二步前，先问后端「实际会写到哪」，确认屏只展示真值 */
  async function requestConfirm() {
    setSubmitted(true);
    if (!validation.valid || !project) return;
    setConfirming(true);
    await fetchPreview();
  }

  /** 拷完一张接着拷下一张(评审 1.6):清源卷,保留相机/标签库/目的地 */
  function startNextCard() {
    setVolumeId("");
    // 前缀回到「本机今天 + 当前时段」(日期/时段选择器已取代手敲前缀)
    setPrefixIso(compactToIso(todayCompactDate()));
    setSlot(currentTimeSlot());
    setConfirming(false);
    setSubmitted(false);
    setPreview(null);
    setPreviewFailed(false);
    void refreshVolumes();
  }

  const loadedSummary = useMemo(() => {
    const counts = { pending: 0, copied: 0, verified: 0, failed: 0 };
    for (const f of files) counts[f.status] += 1;
    return counts;
  }, [files]);

  // 总数以后端为准（task.fileCount），列表接口的 total 兜底
  const totalFiles = task?.fileCount ?? fileTotal;
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

  /** 校验阶段总进度(评审 2.2):所有目的地合计的已回读字节 */
  const verifying = task?.state === "verifying";
  const verifiedSum = task
    ? task.destinations.reduce((sum, d) => sum + (d.verifiedBytes ?? 0), 0)
    : 0;
  const verifyTotal = task ? task.totalBytes * Math.max(1, task.destinations.length) : 0;
  const verifySpeed = useVerifySpeed(task?.id ?? null, verifiedSum, Boolean(verifying));

  const volume = volumes.find((v) => v.id === volumeId) ?? null;
  // 同名卷提示：只警告不阻断——这是协作提示，不是锁
  const remoteSameVolume = remoteActivityForVolume(remoteActivities, volume?.name);

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
            <div className="copy__form">
              <div className="card">
                <div className="card__head">
                  <span className="card__title">
                    {confirming ? "确认拷卡信息" : "发起拷卡"}
                  </span>
                  <span className="card__hint">
                    {confirming ? "摄影师与 DIT 共同核对" : "填写后进入双确认"}
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
                  ) : confirming ? (
                    /* 第二步：汇总复核，对应规范「摄影师和 DIT 两方确认」 */
                    <div className="stack stack--lg">
                      {/* 流程辅助图：把「源读一次、多目的地、双端校验」画成实物流向。
                          目的地取真实落盘清单（几路画几路），所以要等 preview 解析出来 */}
                      {preview ? (
                        <div className="copy-flow">
                          <IllCopyFlow
                            destinations={preview.destinations.map((d) => ({
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
                            {volume?.name}（{volume?.mountPath}）
                          </span>
                        </div>
                        <div className="dl__row">
                          <span className="dl__key">相机</span>
                          <span className="dl__val mono">{camera?.code}</span>
                        </div>
                        <div className="dl__row">
                          <span className="dl__key">目标夹</span>
                          <span className="dl__val mono" data-testid="confirm-target-folder">
                            {preview ? preview.targetFolder : "解析中…"}
                          </span>
                        </div>
                        <div className="dl__row">
                          <span className="dl__key">内容标签</span>
                          <span className="dl__val">
                            <span className="tag-row" data-testid="confirm-tags">
                              {tags.map((name) => (
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
                              {autoProxy ? "是，拷完自动派发转码作业" : "否"}
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
                                  onClick={() => void fetchPreview()}
                                >
                                  重试解析
                                </button>
                              </span>
                            ) : preview ? (
                              preview.destinations.map((d) => (
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

                      <p className="text-xs dim">
                        确认后开始读卡。校验全部通过前请勿拔卡，OCard 不会代为格式化。
                      </p>

                      {volume?.isSystem ? (
                        /* 过滤只是「藏」,这里是「拦」:用户显式打开开关选了
                           系统盘,确认屏必须再敲一次警钟(opus 评审 P2) */
                        <div
                          className="notice notice--danger"
                          role="alert"
                          data-testid="copy-system-volume-warning"
                        >
                          <strong>源卷是系统内置盘</strong>
                          <span>
                            「{volume.name}（{volume.mountPath}）」是本机系统盘,
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
                          onClick={() => setConfirming(false)}
                        >
                          返回修改
                        </button>
                        <button
                          type="button"
                          data-testid="copy-confirm-start"
                          className="btn btn--primary"
                          onClick={confirmAndStart}
                          disabled={busy || !preview}
                        >
                          {busy ? "正在建立任务…" : "确认开始"}
                        </button>
                      </div>
                    </div>
                  ) : (
                    <form
                      className="stack stack--lg"
                      onSubmit={(e) => {
                        e.preventDefault();
                        requestConfirm();
                      }}
                    >
                      <div className="field">
                        <div className="row-inline">
                          <span className="field__label" id="volume-group-label">
                            源卷
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
                      </div>

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
                          <span className="text-xs dim mono" data-testid="copy-prefix-value">
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

                      <div className="field">
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
                                  destsPristineRef.current = false;
                                  setDests((prev) =>
                                    prev.map((d) =>
                                      d.id === dest.id ? { ...d, kind } : d,
                                    ),
                                  );
                                }}
                                options={(
                                  Object.keys(DESTINATION_KIND_LABEL) as DestinationKind[]
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
                                  submitted && validation.errors.destinationAt?.[index],
                                )}
                                placeholder={
                                  dest.kind === "nas"
                                    ? "由项目结构自动推导"
                                    : "选择或粘贴目标文件夹路径"
                                }
                                pickerTitle={`选择第 ${index + 1} 个目的地文件夹`}
                                onChange={(path) => {
                                  destsPristineRef.current = false;
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
                                    destsPristineRef.current = false;
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
                                onClick={() => {
                                  destsPristineRef.current = false;
                                  setDests((prev) => prev.filter((d) => d.id !== dest.id));
                                }}
                              >
                                <IconTrash />
                              </button>
                            </div>
                            {submitted && validation.errors.destinationAt?.[index] ? (
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
                              onClick={() => {
                                destsPristineRef.current = false;
                                setDests((prev) => [...prev, newDest("external")]);
                              }}
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

                      <button
                        type="submit"
                        data-testid="copy-start"
                        className="btn btn--primary"
                      >
                        开始拷卡
                      </button>
                    </form>
                  )}
                </div>
              </div>
            </div>

            <div className="stack stack--lg">
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
                            onClick={() => {
                              void api
                                .pauseCopyTask(task.id)
                                .then(() => refreshTask(task.id));
                            }}
                          >
                            暂停
                          </button>
                        ) : null}
                        {task.state === "paused" ? (
                          <button
                            type="button"
                            className="btn btn--sm"
                            onClick={() => {
                              void api
                                .resumeCopyTask(task.id)
                                .then(() => refreshTask(task.id));
                            }}
                          >
                            继续
                          </button>
                        ) : null}
                      </div>
                    </div>
                    <div className="card__body">
                      <div className="stack stack--lg">
                        {/* 仪表区：拷卡是全应用的高光时刻，百分比与速度是主角 */}
                        <div className="copy-hero">
                          <div className="copy-hero__row">
                            <div className="copy-hero__percent">
                              {/* 校验阶段大百分比切到校验进度(评审 2.2):
                                  「拷贝 100% 但还没完」的十几分钟里,用户必须
                                  看得到在推进什么、还要等多久 */}
                              {verifying
                                ? Math.round(ratio(verifiedSum, verifyTotal) * 100)
                                : Math.round(
                                    ratio(task.copiedBytes, task.totalBytes) * 100,
                                  )}
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
                                  {/* 迷你曲线嵌在速度数字左侧：读法就是「这个数的历史」，
                                      与下方总进度条隔着整块仪表区，不会混成一回事 */}
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
                          <div className="copy-hero__bar">
                            <ProgressBar
                              value={verifying ? verifiedSum : task.copiedBytes}
                              total={verifying ? verifyTotal : task.totalBytes}
                              tone={task.state === "done" ? "ok" : "accent"}
                              label={verifying ? "校验进度" : "总进度"}
                              valueText={
                                verifying
                                  ? `已校验 ${formatBytes(verifiedSum)} / ${formatBytes(verifyTotal)}（全部目的地合计）`
                                  : `${formatBytes(task.copiedBytes)} / ${formatBytes(task.totalBytes)}`
                              }
                            />
                          </div>
                          <div className="row-inline text-xs dim">
                            <span className="mono">
                              {verifying
                                ? `已校验 ${formatBytes(verifiedSum)} / ${formatBytes(verifyTotal)}`
                                : `${formatBytes(task.copiedBytes)} / ${formatBytes(task.totalBytes)}`}
                            </span>
                          </div>
                        </div>

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
                    <div className="list">
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
                                  onClick={() => {
                                    void api
                                      .retryCopyFile(task.id, f.id)
                                      .then(() => refreshTask(task.id))
                                      .then(() => refreshLoadedFiles(task.id));
                                  }}
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
                      <div className="hint-bar">
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
                    {project ? "本项目还没有拷卡任务，从左侧发起一个。" : "先选择项目。"}
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
