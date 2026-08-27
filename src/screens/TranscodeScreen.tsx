/** 屏 7：代理转码（工况 A，PRD §5.6）。v1 做整项目转代理 + 强制全转开关。 */

import { useCallback, useEffect, useState } from "react";
import * as api from "../api";
import type {
  ArchiveTier,
  FfmpegStatus,
  NoticeLevel,
  TranscodeJob,
} from "../api/types";
import { isArchiveResult, isJobTerminal } from "../api/types";
import { ConfirmDialog, type ConfirmRequest } from "../components/ConfirmDialog";
import { Checkbox } from "../components/controls";
import { PathField } from "../components/PathField";
import { TopBar } from "../components/TopBar";
import { IllTranscodeEmpty } from "../components/illustrations";
import { Badge, EmptyState, Field, ProgressBar } from "../components/ui";
import { isAbsoluteNasRoot } from "../lib/validation";
import { loadPref, savePref } from "../lib/prefs";
import { formatBytes, formatTimestamp } from "../lib/format";
import { selectLatestTranscodeJob, useStore } from "../state/store";
import { useWindowBridge } from "../state/windowBridge";

const TIER_LABEL: Record<ArchiveTier, string> = {
  quality: "高质量",
  balanced: "平衡",
  compact: "高压缩",
};

const TIER_HINT: Record<ArchiveTier, string> = {
  quality: "画质优先，输出体积可能接近源文件",
  balanced: "画质与体积折中，日常归档推荐",
  compact: "体积优先，画质有可见损失",
};

export function TranscodeScreen() {
  const { state, dispatch, reconcileJobs } = useStore();
  const bridge = useWindowBridge();
  const project = state.projects.find((p) => p.id === state.selectedProjectId) ?? null;
  const job = project ? selectLatestTranscodeJob(state, project.id) : null;
  const working = job !== null && (job.state === "queued" || job.state === "running");

  const [ffmpeg, setFfmpeg] = useState<FfmpegStatus | null>(null);
  const [forceAll, setForceAll] = useState(false);
  const [starting, setStarting] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [confirm, setConfirm] = useState<ConfirmRequest | null>(null);
  /**
   * 档位与归档目录持久化(评审 6.6):归档盘一用一个项目周期,
   * 每次归档都重新点浏览选一遍目录是纯重复劳动。
   */
  const [tier, setTier] = useState<ArchiveTier>(() =>
    loadPref<ArchiveTier>("transcode:tier", "balanced"),
  );
  const [archiveDir, setArchiveDir] = useState(() =>
    loadPref<string>("transcode:archiveDir", ""),
  );
  const [archiveError, setArchiveError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const status = await api.ffmpegStatus();
        if (!cancelled) setFfmpeg(status);
      } catch (err) {
        if (cancelled) return;
        setFfmpeg({
          status: "missing",
          error: err instanceof Error ? err.message : String(err),
        });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const notify = useCallback(
    (level: NoticeLevel, code: string, message: string) =>
      dispatch({
        type: "noticeReceived",
        notice: { level, code, message, occurredAt: new Date().toISOString() },
      }),
    [dispatch],
  );

  async function startArchive() {
    if (!project || starting) return;
    setStarting(true);
    setArchiveError(null);
    try {
      const snapshot = await api.startArchiveTranscode({
        projectId: project.id,
        tier,
        outputDir: archiveDir.trim(),
      });
      dispatch({ type: "jobProgress", job: snapshot });
      // 发起成功即记忆(评审 6.6):下次进屏自动预填同一块归档盘与档位
      savePref("transcode:tier", tier);
      savePref("transcode:archiveDir", archiveDir.trim());
    } catch (err) {
      // 提交后失败统一走 toast;archiveError 只承载提交前的路径校验
      const message = err instanceof Error ? err.message : String(err);
      notify("error", "archive-start-failed", `归档转码未能启动：${message}`);
    } finally {
      setStarting(false);
    }
  }

  function requestArchive() {
    if (!project) return;
    if (!isAbsoluteNasRoot(archiveDir)) {
      setArchiveError("请填写绝对路径，如 /Volumes/ARCHIVE-2026");
      return;
    }
    // 前端就拦「选进项目目录里」(评审 #6):提示承诺过的约束不该等后端才报
    const nasRoot = state.workstation?.nasRoot?.replace(/\/+$/, "");
    if (nasRoot) {
      const projectDir = `${nasRoot}/${project.folderName}`;
      const normalized = archiveDir.trim().replace(/\/+$/, "");
      if (normalized === projectDir || normalized.startsWith(`${projectDir}/`)) {
        setArchiveError(
          "归档目录不能在项目文件夹内——归档是独立副本，请选项目之外的目录",
        );
        return;
      }
    }
    setConfirm({
      title: `按「${TIER_LABEL[tier]}」归档转码？`,
      message:
        `归档会把原始素材另存一份到 ${archiveDir.trim()}，原始素材不受影响。` +
        "高质量档的输出可能接近源文件体积，请先确认目标磁盘空间充足。" +
        "已归档过的文件会跳过。",
      confirmLabel: "开始归档",
      onConfirm: () => void startArchive(),
    });
  }

  function requestRetranscode() {
    if (!project) return;
    setConfirm({
      title: "删除已有代理并全部重转？",
      message:
        "这会先删除「4. 转码素材」下已有的代理文件，再重新转码——已删除的代理无法恢复。" +
        "原始素材不受影响。只有在代理文件确认有问题时才需要这么做。",
      confirmLabel: "删除并重转",
      onConfirm: () => void start(true),
    });
  }

  async function start(retranscode = false) {
    if (!project || starting) return;
    setStarting(true);
    try {
      const snapshot = await api.startProxyTranscode({
        projectId: project.id,
        forceAll,
        ...(retranscode ? { retranscode: true } : {}),
      });
      dispatch({ type: "jobProgress", job: snapshot });
    } catch (err) {
      // 提交后失败统一走 toast(UX 波三)
      const message = err instanceof Error ? err.message : String(err);
      notify("error", "transcode-start-failed", `转码作业未能启动：${message}`);
    } finally {
      setStarting(false);
    }
  }

  async function cancel() {
    if (!job || cancelling) return;
    // 已经跑完的作业不发取消：后端会回「将在当前文件完成后停止」，那是假话
    if (isJobTerminal(job.state)) {
      dispatch({ type: "jobProgress", job });
      return;
    }
    setCancelling(true);
    try {
      const snapshot = await api.cancelJob(job.id);
      dispatch({ type: "jobProgress", job: snapshot });
      // 取消在路上时作业自己跑完了：如实说没生效
      if (isJobTerminal(snapshot.state) && snapshot.state !== "cancelled") {
        notify(
          "info",
          "job-cancel-too-late",
          "转码作业在取消生效前已经结束，本次取消未生效。",
        );
      }
    } catch (err) {
      notify(
        "warning",
        "job-cancel-failed",
        `取消转码作业失败：${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      setCancelling(false);
    }
  }

  // 入口不再从导航上一禁了之(那是无提示的死门):进得来,这里把原因和去路说清楚
  if (!project) {
    return (
      <>
        <TopBar title="代理转码" />
        <div className="content">
          <div className="content__inner">
            <EmptyState art={<IllTranscodeEmpty />}>
              <div className="stack" data-testid="transcode-no-project">
                <p className="text-sm" role="status">
                  {state.projects.length === 0
                    ? "还没有任何项目。先新建一个工况 A（视频剪辑）项目,拷入素材后再来转代理。"
                    : "还没有选择项目。代理转码作用在「当前项目」上——先去项目列表选中一个工况 A（视频剪辑）项目。"}
                </p>
                <div>
                  <button
                    type="button"
                    className="btn btn--primary"
                    data-testid="transcode-goto-projects"
                    onClick={() => void bridge.openManager()}
                  >
                    {state.projects.length === 0 ? "去新建项目" : "去选择项目"}
                  </button>
                </div>
              </div>
            </EmptyState>
          </div>
        </div>
      </>
    );
  }

  if (project.scenario !== "A") {
    return (
      <>
        <TopBar title="代理转码" subtitle={project.folderName} subtitleMono />
        <div className="content">
          <div className="content__inner">
            <EmptyState art={<IllTranscodeEmpty />}>
              <div className="stack" data-testid="transcode-scenario-b">
                <p className="text-sm" role="status">
                  代理转码只适用于工况 A（视频剪辑）项目。当前项目「{project.name}」是工况
                  B（纯拍照），素材整理走「选片与交付」。
                </p>
                <div>
                  <button
                    type="button"
                    className="btn btn--primary"
                    data-testid="transcode-goto-projects"
                    onClick={() => void bridge.openManager()}
                  >
                    切换到其他项目
                  </button>
                </div>
              </div>
            </EmptyState>
          </div>
        </div>
      </>
    );
  }

  const ffmpegMissing = ffmpeg?.status === "missing";

  return (
    <>
      <TopBar
        title="代理转码"
        subtitle={project.folderName}
        subtitleMono
        actions={
          <button
            type="button"
            className="btn btn--sm"
            data-testid="jobs-refresh"
            onClick={() => void reconcileJobs()}
          >
            刷新作业状态
          </button>
        }
      />

      <div className="content">
        <div className="content__inner">
          <div className="stack stack--lg">
            {/* ffmpeg 缺失 = 整个入口禁用，并说清原因 */}
            {ffmpegMissing ? (
              <div
                className="notice notice--danger"
                role="alert"
                data-testid="transcode-ffmpeg-missing"
              >
                <strong>转码组件不可用，无法开始转码</strong>
                <span>
                  {ffmpeg.error}
                  ——ffmpeg 随应用分发，缺失通常意味着安装包不完整，请重新安装。
                </span>
              </div>
            ) : null}

            <div className="card">
              <div className="card__head">
                <span className="card__title">整项目转代理</span>
                <span className="card__hint">
                  把「2. 原始素材」下的高负载素材批量转到「4. 转码素材」
                </span>
              </div>
              <div className="card__body">
                <div className="stack stack--lg">
                  {/* 「高负载判定」是引擎黑话(评审 6.6/#3):说人话——默认转哪些、
                      勾了会怎样,一句讲清;两个「强制」术语拆开,不再并排打架 */}
                  <Checkbox
                    testId="transcode-force-all"
                    checked={forceAll}
                    disabled={working || ffmpegMissing}
                    onChange={setForceAll}
                  >
                    把所有视频都转代理（默认只转 Log/高码率等剪辑时容易卡顿的素材；
                    <strong>不会</strong>重转已经有代理的）
                  </Checkbox>

                  <div className="row-inline">
                    <button
                      type="button"
                      className="btn btn--primary"
                      data-testid="transcode-start"
                      disabled={working || starting || ffmpegMissing}
                      onClick={() => void start(false)}
                    >
                      {working
                        ? "转码中…"
                        : starting
                          ? "正在启动…"
                          : "开始转代理"}
                    </button>
                    {ffmpeg?.status === "ready" ? (
                      <span className="text-xs dim mono">
                        ffmpeg {ffmpeg.info.version}
                      </span>
                    ) : null}
                    {/* 破坏性低频操作降级为文字链接(评审 6.6/#2):
                        不再与日常主操作同尺寸并排,误触少一个入口 */}
                    <button
                      type="button"
                      className="btn btn--ghost btn--sm push-right"
                      data-testid="transcode-retranscode"
                      disabled={working || starting || ffmpegMissing}
                      title="删除已有代理并全部重转——只在代理文件确认有问题时使用"
                      onClick={requestRetranscode}
                    >
                      删除代理并重转…
                    </button>
                  </div>

                </div>
              </div>
            </div>

            {/* 归档转码：输出到项目之外的独立副本 */}
            <div className="card" data-testid="archive-section">
              <div className="card__head">
                <span className="card__title">归档转码</span>
                <span className="card__hint">HEVC 三档压缩，输出为独立副本</span>
              </div>
              <div className="card__body">
                <div className="stack stack--lg">
                  <div className="field">
                    <span className="field__label">压缩档位</span>
                    <div className="segmented" role="radiogroup" aria-label="压缩档位">
                      {(Object.keys(TIER_LABEL) as ArchiveTier[]).map((value) => (
                        <button
                          key={value}
                          type="button"
                          className="segmented__item"
                          role="radio"
                          aria-checked={tier === value}
                          data-testid={`archive-tier-${value}`}
                          disabled={working || ffmpegMissing}
                          onClick={() => setTier(value)}
                        >
                          {TIER_LABEL[value]}
                        </button>
                      ))}
                    </div>
                    <span className="field__hint">{TIER_HINT[tier]}</span>
                  </div>

                  <Field
                    label="归档输出目录"
                    htmlFor="archive-dir"
                    hint={
                      archiveDir
                        ? "已沿用上次的归档目录，可直接开始或改选"
                        : "选择项目之外的目录——归档是独立副本，不放回项目里"
                    }
                    /* 错误就近显示(评审 #4):不再让人从按钮往下扫红字 */
                    error={archiveError ?? undefined}
                  >
                    <PathField
                      id="archive-dir"
                      testId="archive-dir"
                      value={archiveDir}
                      invalid={Boolean(archiveError)}
                      onChange={(next) => {
                        setArchiveDir(next);
                        setArchiveError(null);
                      }}
                      placeholder="/Volumes/ARCHIVE-2026"
                      pickerTitle="选择归档输出目录"
                      disabled={working || ffmpegMissing}
                    />
                  </Field>

                  <div className="row-inline">
                    <button
                      type="button"
                      className="btn"
                      data-testid="archive-start"
                      disabled={working || starting || ffmpegMissing}
                      onClick={requestArchive}
                    >
                      开始归档
                    </button>
                  </div>
                </div>
              </div>
            </div>

            {/* 进行中：进度 + 当前文件 + 取消 */}
            {working && job ? (
              <div className="card" data-testid="transcode-progress">
                <div className="card__head">
                  <span className="card__title">转码进行中</span>
                  <div className="card__actions">
                    <button
                      type="button"
                      className="btn btn--sm"
                      data-testid="transcode-cancel"
                      disabled={cancelling}
                      onClick={cancel}
                    >
                      {cancelling ? "正在取消…" : "取消转码"}
                    </button>
                  </div>
                </div>
                <div className="card__body">
                  <div className="stack stack--sm">
                    <ProgressBar
                      value={job.done}
                      total={job.total}
                      label="转码进度"
                      valueText={`${job.done}/${job.total}`}
                    />
                    <div className="row-inline text-xs dim">
                      <span className="mono" data-testid="transcode-progress-count">
                        {job.done}/{job.total}
                      </span>
                      {job.message ? (
                        <span className="mono" data-testid="transcode-progress-file">
                          {job.message}
                        </span>
                      ) : null}
                      <span className="mono">{formatBytes(job.bytesDone)}</span>
                    </div>
                  </div>
                </div>
              </div>
            ) : null}

            {job && !working ? <TranscodeResult job={job} /> : null}

            {!job ? (
              <div className="list">
                <EmptyState>本项目还没有转码作业。</EmptyState>
              </div>
            ) : null}
          </div>
        </div>
      </div>

      <ConfirmDialog request={confirm} onCancel={() => setConfirm(null)} />
    </>
  );
}

function TranscodeResult({ job }: { job: TranscodeJob }) {
  if (job.state === "failed") {
    return (
      <div className="notice notice--danger" role="alert" data-testid="transcode-failed">
        <strong>转码作业失败</strong>
        <span>{job.error ?? "未知原因"}</span>
      </div>
    );
  }

  if (job.state === "cancelled") {
    return (
      <div className="notice" role="status" data-testid="transcode-cancelled">
        <strong>
          转码已取消，已完成 {job.done}/{job.total}
        </strong>
        <span>已转好的代理文件保留在「4. 转码素材」，重跑会跳过它们。</span>
      </div>
    );
  }

  const result = job.result;
  if (!result) return null;

  // 归档与代理共用 kind，结果结构不同，分开渲染
  if (isArchiveResult(result)) {
    return (
      <div className="card" data-testid="archive-result">
        <div className="card__head">
          <span className="card__title">归档转码完成</span>
          <span className="card__hint" data-testid="archive-encoder">
            编码器 {result.usedEncoder}
          </span>
        </div>
        <div className="card__body">
          <div className="stack stack--lg">
            <div className="task-stats">
              <div>
                <div className="stat__label">新归档</div>
                <div className="stat__value" data-testid="archive-converted">
                  {result.converted}
                </div>
              </div>
              <div>
                <div className="stat__label">此前已归档</div>
                <div className="stat__value" data-testid="archive-already">
                  {result.alreadyArchived}
                </div>
              </div>
              <div>
                <div className="stat__label">失败</div>
                <div className="stat__value">{result.failures.length}</div>
              </div>
            </div>

            <div className="stack stack--sm">
              <span className="field__label">归档输出目录</span>
              <div className="preview__path" data-testid="archive-output">
                {result.outputDir}
              </div>
            </div>

            {result.failures.length > 0 ? (
              <div
                className="notice notice--danger"
                role="alert"
                data-testid="archive-failures"
              >
                <strong>{result.failures.length} 个文件归档失败</strong>
                <div className="delivery__failures">
                  {result.failures.map((item) => (
                    <div className="delivery__failure" key={item.rel}>
                      <span className="mono text-2xs truncate" title={item.rel}>
                        {item.rel}
                      </span>
                      <span className="text-2xs">{item.message}</span>
                    </div>
                  ))}
                </div>
              </div>
            ) : null}

            <Badge tone="neutral">归档为独立副本，原始素材未改动</Badge>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="card" data-testid="transcode-result">
      <div className="card__head">
        <span className="card__title">转码完成</span>
        <span className="card__hint" data-testid="transcode-encoder">
          编码器 {result.usedEncoder}
        </span>
      </div>
      <div className="card__body">
        <div className="stack stack--lg">
          <div className="task-stats">
            <div>
              <div className="stat__label">新转码</div>
              <div className="stat__value" data-testid="transcode-converted">
                {result.converted}
              </div>
            </div>
            <div>
              <div className="stat__label">此前已转码</div>
              <div className="stat__value" data-testid="transcode-already">
                {result.alreadyTranscoded}
              </div>
            </div>
            <div>
              <div className="stat__label">跳过</div>
              <div className="stat__value">{result.skipped.length}</div>
            </div>
            <div>
              <div className="stat__label">失败</div>
              <div className="stat__value">{result.failures.length}</div>
            </div>
          </div>

          <div className="stack stack--sm">
            <span className="field__label">输出目录</span>
            <div className="preview__path" data-testid="transcode-output">
              {result.outputDir}
            </div>
          </div>

          {result.skipped.length > 0 ? (
            <div className="notice" data-testid="transcode-skipped">
              <strong>{result.skipped.length} 个文件被跳过</strong>
              <div className="delivery__failures">
                {result.skipped.map((item) => (
                  <div className="delivery__failure" key={item.rel}>
                    <span className="mono text-2xs truncate" title={item.rel}>
                      {item.rel}
                    </span>
                    <span className="text-2xs">{item.reason}</span>
                  </div>
                ))}
              </div>
            </div>
          ) : null}

          {result.failures.length > 0 ? (
            <div
              className="notice notice--danger"
              role="alert"
              data-testid="transcode-failures"
            >
              <strong>{result.failures.length} 个文件转码失败</strong>
              <div className="delivery__failures">
                {result.failures.map((item) => (
                  <div className="delivery__failure" key={item.rel}>
                    <span className="mono text-2xs truncate" title={item.rel}>
                      {item.rel}
                    </span>
                    <span className="text-2xs">{item.message}</span>
                  </div>
                ))}
              </div>
            </div>
          ) : null}

          {job.finishedAt ? (
            <span className="text-2xs dim mono">
              完成于 {formatTimestamp(job.finishedAt)}
            </span>
          ) : null}
          <Badge tone="neutral">代理文件供剪辑使用，原始素材未改动</Badge>
        </div>
      </div>
    </div>
  );
}
