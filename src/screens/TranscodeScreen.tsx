/** 屏 7：代理转码（工况 A，PRD §5.6）。v1 做整项目转代理 + 强制全转开关。 */

import { useCallback, useEffect, useState } from "react";
import * as api from "../api";
import type { FfmpegStatus, TranscodeJob } from "../api/types";
import { TopBar } from "../components/TopBar";
import { Badge, EmptyState, ProgressBar } from "../components/ui";
import { formatBytes, formatTimestamp } from "../lib/format";
import { selectLatestTranscodeJob, useStore } from "../state/store";

export function TranscodeScreen() {
  const { state, dispatch } = useStore();
  const project = state.projects.find((p) => p.id === state.selectedProjectId) ?? null;
  const job = project ? selectLatestTranscodeJob(state, project.id) : null;
  const working = job !== null && (job.state === "queued" || job.state === "running");

  const [ffmpeg, setFfmpeg] = useState<FfmpegStatus | null>(null);
  const [forceAll, setForceAll] = useState(false);
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState(false);

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
    (level: "warning" | "error", code: string, message: string) =>
      dispatch({
        type: "noticeReceived",
        notice: { level, code, message, occurredAt: new Date().toISOString() },
      }),
    [dispatch],
  );

  async function start() {
    if (!project || starting) return;
    setStarting(true);
    setStartError(null);
    try {
      const snapshot = await api.startProxyTranscode({
        projectId: project.id,
        forceAll,
      });
      dispatch({ type: "jobProgress", job: snapshot });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setStartError(message);
      notify("error", "transcode-start-failed", `转码作业未能启动：${message}`);
    } finally {
      setStarting(false);
    }
  }

  async function cancel() {
    if (!job || cancelling) return;
    setCancelling(true);
    try {
      dispatch({ type: "jobProgress", job: await api.cancelJob(job.id) });
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

  if (!project) {
    return (
      <>
        <TopBar title="代理转码" />
        <div className="content">
          <div className="content__inner">
            <p className="text-sm" role="alert">
              尚未选择项目。
            </p>
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
            <p className="text-sm" role="alert" data-testid="transcode-scenario-b">
              代理转码只适用于工况 A（视频剪辑）项目。当前项目是工况 B。
            </p>
          </div>
        </div>
      </>
    );
  }

  const ffmpegMissing = ffmpeg?.status === "missing";

  return (
    <>
      <TopBar title="代理转码" subtitle={project.folderName} subtitleMono />

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
                  <label className="row-inline text-sm">
                    <input
                      type="checkbox"
                      data-testid="transcode-force-all"
                      checked={forceAll}
                      disabled={working || ffmpegMissing}
                      onChange={(e) => setForceAll(e.currentTarget.checked)}
                    />
                    强制全转（忽略「已转码 / 无需转码」判定，重转所有素材）
                  </label>

                  <div className="row-inline">
                    <button
                      type="button"
                      className="btn btn--primary"
                      data-testid="transcode-start"
                      disabled={working || starting || ffmpegMissing}
                      onClick={start}
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
                  </div>

                  {startError ? (
                    <span
                      className="field__error"
                      role="alert"
                      data-testid="transcode-start-error"
                    >
                      {startError}
                    </span>
                  ) : null}
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
