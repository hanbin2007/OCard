/** 屏 4：拷卡任务面板（源卷双确认 + 多目的地 + 逐文件哈希状态）。 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as api from "../api";
import type {
  CopyFileItem,
  CopyTaskPreview,
  DestinationKind,
  StartCopyInput,
  NoticeLevel,
} from "../api/types";
import { SpeedSparkline, useSpeedSamples } from "../components/charts";
import { Checkbox, Select } from "../components/controls";
import { ConfirmDialog, type ConfirmRequest } from "../components/ConfirmDialog";
import { IconPlus, IconRetry, IconTrash } from "../components/Icon";
import { PathField } from "../components/PathField";
import { RemoteActivityBanner } from "../components/RemoteActivityBanner";
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
import { buildCopyTargetPath, copyTargetParent } from "../lib/naming";
import { validateStartCopy } from "../lib/validation";
import {
  remoteActivityForVolume,
  useRemoteActivity,
} from "../hooks/useRemoteActivity";
import { useStore } from "../state/store";

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

export function CopyTaskScreen() {
  const { state, dispatch, refreshTask } = useStore();
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
    setTargetPrefix("");
    setPrefixInferred(false);
    prefixEditedRef.current = false;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.copyDraft]);
  const [volumesRefreshing, setVolumesRefreshing] = useState(false);
  const [cameraId, setCameraId] = useState("");
  const [note, setNote] = useState("");
  const [targetPrefix, setTargetPrefix] = useState("");
  const [prefixInferred, setPrefixInferred] = useState(false);
  // 人工改过前缀后就不再被探查结果覆盖
  const prefixEditedRef = useRef(false);
  // 不预填任何平台特有路径：/Volumes/… 在 Windows/Linux 上首屏即是错的
  const [dests, setDests] = useState<DestDraft[]>(() => [
    newDest("nas"),
    newDest("external"),
  ]);
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
        `刷新卷列表失败：${err instanceof Error ? err.message : String(err)}`,
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
  const validation = useMemo(
    () =>
      validateStartCopy({
        volumeId,
        cameraId,
        note,
        targetPrefix,
        destinations: dests.map(({ kind, path }) => ({ kind, path })),
      }),
    [volumeId, cameraId, note, targetPrefix, dests],
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
    setTargetPrefix("");
    setPrefixInferred(false);
    prefixEditedRef.current = false;
  }, [projectKey]);

  // 选中源卷后探查素材时间戳，据此推断时段前缀（PRD §5.3：从素材时间戳推断，可改）
  useEffect(() => {
    if (!volumeId || !project || prefixEditedRef.current) return;
    let cancelled = false;
    // 换卡先清上一张卡的推断结果:上一张成功、这一张失败时,
    // 旧时段前缀留着会把新卡拷进旧时段目录(codex 评审 P1)
    setTargetPrefix("");
    setPrefixInferred(false);
    void (async () => {
      try {
        const inspection = await api.inspectVolume(volumeId);
        if (cancelled || prefixEditedRef.current) return;
        // 工况 A 用项目拍摄日期，工况 B 用卡内素材推断出的时段
        setTargetPrefix(
          project.scenario === "A" ? project.date : inspection.suggestedPrefix,
        );
        setPrefixInferred(true);
      } catch (err) {
        if (cancelled) return;
        // 探查失败以前是静默的：前缀悄悄没推出来,用户不知道为什么是空的
        pushNotice(
          "warning",
          "volume-inspect-failed",
          `读取卡内素材时间失败，时段前缀请手动填写：${err instanceof Error ? err.message : String(err)}`,
        );
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [volumeId, project, pushNotice]);


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
        note,
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
      setNote("");
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

  /** 进入第二步前，先问后端「实际会写到哪」，确认屏只展示真值 */
  async function requestConfirm() {
    setSubmitted(true);
    if (!validation.valid || !project) return;
    setConfirming(true);
    setPreview(null);
    setPreviewFailed(false);
    try {
      const result = await api.previewCopyTask({
        projectId: project.id,
        volumeId,
        cameraId,
        note,
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

  const fileSummary = useMemo(() => {
    const counts = { pending: 0, copied: 0, verified: 0, failed: 0 };
    for (const f of files) counts[f.status] += 1;
    return counts;
  }, [files]);

  // 总数以后端为准（task.fileCount），列表接口的 total 兜底
  const totalFiles = task?.fileCount ?? fileTotal;
  /** 明细是否已全部加载——没全载就不能给出全量「已校验」断言 */
  const fullyLoaded = totalFiles > 0 && files.length >= totalFiles;

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
                          onClick={() => dispatch({ type: "navigate", route: "projects" })}
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
                          <span className="dl__key">备注</span>
                          <span className="dl__val">{note}</span>
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
                                落盘路径解析失败(详见右下角提示),请返回修改后重试
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
                        hint={
                          prefixInferred
                            ? "由卡内素材时间戳推断得出，可改"
                            : `落在「${copyTargetParent(project.scenario)}」下`
                        }
                        error={submitted ? validation.errors.targetPrefix : undefined}
                      >
                        <input
                          id="copy-prefix"
                          className="input input--mono"
                          type="text"
                          value={targetPrefix}
                          placeholder={
                            project.scenario === "A" ? "20260824" : "0824上午"
                          }
                          onChange={(e) => {
                            prefixEditedRef.current = true;
                            setPrefixInferred(false);
                            setTargetPrefix(e.currentTarget.value);
                          }}
                        />
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
                        label="内容备注"
                        htmlFor="copy-note"
                        hint="规范要求「适当记录」，将写入 manifest 与审计日志"
                        error={submitted ? validation.errors.note : undefined}
                      >
                        <textarea
                          id="copy-note"
                          data-testid="copy-note"
                          className="textarea"
                          value={note}
                          placeholder="如：上午田赛，含 4×100 决赛全程"
                          onChange={(e) => setNote(e.currentTarget.value)}
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
                                  setDests((prev) =>
                                    prev.map((d) =>
                                      d.id === dest.id ? { ...d, path } : d,
                                    ),
                                  );
                                }}
                              />
                              <button
                                type="button"
                                className="btn btn--ghost btn--icon"
                                aria-label={`删除第 ${index + 1} 个目的地`}
                                onClick={() =>
                                  setDests((prev) => prev.filter((d) => d.id !== dest.id))
                                }
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
                          <button
                            type="button"
                            className="btn btn--sm"
                            onClick={() => setDests((prev) => [...prev, newDest("local")])}
                          >
                            <IconPlus />
                            添加目的地
                          </button>
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
                    onClick={() => dispatch({ type: "selectTask", taskId: t.id })}
                  >
                    <span className="mono">{t.volumeName}</span>
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
                            挂起
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
                              {Math.round(ratio(task.copiedBytes, task.totalBytes) * 100)}
                              <span className="copy-hero__unit">%</span>
                            </div>
                            <div className="copy-hero__vitals">
                              <div className="copy-hero__vital">
                                <span className="stat__label">速度</span>
                                <span className="copy-hero__vital-value copy-hero__vital-value--spark">
                                  {/* 迷你曲线嵌在速度数字左侧：读法就是「这个数的历史」，
                                      与下方总进度条隔着整块仪表区，不会混成一回事 */}
                                  <SpeedSparkline
                                    samples={speedSamples}
                                    label="拷贝速度曲线"
                                    className="copy-hero__spark"
                                  />
                                  {formatSpeed(task.speedBytesPerSec)}
                                </span>
                              </div>
                              <div className="copy-hero__vital">
                                <span className="stat__label">预计剩余</span>
                                <span className="copy-hero__vital-value">
                                  {formatEta(
                                    task.totalBytes - task.copiedBytes,
                                    task.speedBytesPerSec,
                                  )}
                                </span>
                              </div>
                            </div>
                          </div>
                          <div className="copy-hero__bar">
                            <ProgressBar
                              value={task.copiedBytes}
                              total={task.totalBytes}
                              tone={task.state === "done" ? "ok" : "accent"}
                              label="总进度"
                              valueText={`${formatBytes(task.copiedBytes)} / ${formatBytes(task.totalBytes)}`}
                            />
                          </div>
                          <div className="row-inline text-xs dim">
                            <span className="mono">
                              {formatBytes(task.copiedBytes)} /{" "}
                              {formatBytes(task.totalBytes)}
                            </span>
                          </div>
                        </div>

                        <div className="task-stats">
                          <div>
                            <div className="stat__label">
                              {fullyLoaded ? "已校验" : "文件明细"}
                            </div>
                            <div className="stat__value" data-testid="copy-verified-stat">
                              {fullyLoaded
                                ? `${fileSummary.verified}/${totalFiles}`
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
                            <span className="dl__key">内容备注</span>
                            <span className="dl__val">{task.note}</span>
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
                                  {formatBytes(dest.writtenBytes, 0)}
                                </span>
                              </div>
                              <ProgressBar
                                value={dest.writtenBytes}
                                total={task.totalBytes}
                                tone={dest.state === "done" ? "ok" : "accent"}
                                thin
                                decorative
                              />
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
                        共 {totalFiles} 个（已加载 {files.length}）· 以下为已加载部分：待拷{" "}
                        {fileSummary.pending} · 已拷 {fileSummary.copied} · 已校验{" "}
                        {fileSummary.verified} · 失败 {fileSummary.failed}
                      </span>
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
                        {files.map((f) => (
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
                        {files.length === 0 && !filesLoading ? (
                          <EmptyState>暂无文件明细。</EmptyState>
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
