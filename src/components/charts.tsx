/**
 * 渐变图表：速度曲线（面积图）与进度环。
 *
 * 视觉基线仍是 PRD §5.9 的克制路线：单一强调色、无装饰阴影、留白优先。
 * 渐变不引入新颜色——一律是强调色自身的透明度渐变（SVG stop 走
 * `stop-color: var(--accent)` + 不同 stop-opacity），因此天然随主题切换，
 * 也不违反「组件样式中不得出现字面色值」的令牌纪律。
 */

import { useEffect, useId, useRef, useState } from "react";
import { formatSpeed, ratio } from "../lib/format";

/** 采样条数上限：配合下面的抽稀间隔，一屏曲线约覆盖最近一分钟 */
export const SPEED_SAMPLE_LIMIT = 120;
/** 抽稀间隔：进度事件 ~200ms 一条，不抽稀的话窗口只剩二十几秒 */
export const SPEED_SAMPLE_MIN_MS = 500;

/**
 * 把任务的实时速度积累成采样序列。
 *
 * - 换任务立刻清空（渲染期比对，不给旧任务曲线闪一帧的机会）；
 * - 只在拷贝真正推进时采样（revision 变化），挂起/结束后曲线冻结在原地，
 *   而不是被一串 0 拖没——冻结的曲线还能用来回看这张卡的写入节奏。
 */
export function useSpeedSamples(
  taskId: string | null,
  revision: number,
  speedBytesPerSec: number,
  active: boolean,
): number[] {
  const [state, setState] = useState<{ key: string | null; samples: number[] }>({
    key: taskId,
    samples: [],
  });
  const lastRevRef = useRef(-1);
  const lastAtRef = useRef(0);

  if (state.key !== taskId) {
    lastRevRef.current = -1;
    lastAtRef.current = 0;
    setState({ key: taskId, samples: [] });
  }

  useEffect(() => {
    if (!taskId || !active) return;
    if (revision === lastRevRef.current) return;
    lastRevRef.current = revision;
    const now = Date.now();
    if (now - lastAtRef.current < SPEED_SAMPLE_MIN_MS) return;
    lastAtRef.current = now;
    setState((prev) =>
      prev.key !== taskId
        ? prev
        : {
            key: taskId,
            samples: [...prev.samples.slice(-(SPEED_SAMPLE_LIMIT - 1)), speedBytesPerSec],
          },
    );
  }, [taskId, revision, speedBytesPerSec, active]);

  return state.key === taskId ? state.samples : [];
}

/** useId 会带冒号，塞进 url(#…) 前先洗成合法的 SVG id */
function useSvgId(): string {
  return useId().replace(/[^a-zA-Z0-9_-]/g, "");
}

/**
 * 拷贝速度曲线：单序列面积图，强调色描线 + 向下淡出的渐变填充。
 *
 * 刻度轴刻意不画——它是仪表不是报表，绝对值由旁边的「速度」大数与
 * 悬停提示承担，曲线只回答「稳不稳、掉没掉」。
 */
export function SpeedSparkline({
  samples,
  label = "速度曲线",
  className,
}: {
  /** 速度采样（字节/秒），时间从左到右 */
  samples: number[];
  label?: string;
  /** 摆放上下文的尺寸覆盖（如拷卡 hero 的角落紧凑版） */
  className?: string;
}) {
  const gradientId = useSvgId();
  const [hover, setHover] = useState<number | null>(null);

  // 不足两点连不成线；返回 null 而不是空框，避免拷卡刚建立时先闪一个空图
  if (samples.length < 2) return null;

  const peak = Math.max(...samples);
  // 顶部留 25% 余量给峰值标注，速度贴着上沿跑时文字也压不到线
  const yMax = peak > 0 ? peak * 1.25 : 1;
  const points = samples.map((v, i) => [
    (i / (samples.length - 1)) * 100,
    100 - (v / yMax) * 100,
  ]);
  const line = points
    .map(([x, y], i) => `${i === 0 ? "M" : "L"}${x.toFixed(2)} ${y.toFixed(2)}`)
    .join(" ");
  const area = `${line} L100 100 L0 100 Z`;

  const current = samples[samples.length - 1];
  const summary = `${label}：当前 ${formatSpeed(current)}，峰值 ${formatSpeed(peak)}`;

  const hovered = hover !== null ? points[hover] : null;
  // 靠边时提示翻向另一侧；点在上半区就翻到点下方——提示必须留在图内，
  // 矮个的角落版探出去会压住旁边的文字
  const tipTransform = hovered
    ? `translate(${hovered[0] > 82 ? "-100%" : hovered[0] < 18 ? "0" : "-50%"}, ${
        hovered[1] < 50 ? "30%" : "-135%"
      })`
    : undefined;

  return (
    <div
      className={`sparkline${className ? ` ${className}` : ""}`}
      role="img"
      aria-label={summary}
      data-testid="speed-sparkline"
      onPointerMove={(e) => {
        const rect = e.currentTarget.getBoundingClientRect();
        if (rect.width <= 0) return;
        const frac = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
        setHover(Math.round(frac * (samples.length - 1)));
      }}
      onPointerLeave={() => setHover(null)}
    >
      <svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
        <defs>
          <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" className="sparkline__stop-a" />
            <stop offset="100%" className="sparkline__stop-b" />
          </linearGradient>
        </defs>
        <path d={area} fill={`url(#${gradientId})`} stroke="none" />
        {/* 非等比缩放的 viewBox 里必须钉住描边宽度，否则线会被拉成变宽的带子 */}
        <path d={line} className="sparkline__line" vectorEffect="non-scaling-stroke" />
      </svg>

      <span className="sparkline__peak" aria-hidden="true">
        峰值 {formatSpeed(peak)}
      </span>

      {hovered ? (
        <div className="sparkline__hover" aria-hidden="true">
          <div className="sparkline__cursor" style={{ left: `${hovered[0]}%` }} />
          <div
            className="sparkline__dot"
            style={{ left: `${hovered[0]}%`, top: `${hovered[1]}%` }}
          />
          <div
            className="sparkline__tip"
            style={{
              left: `${hovered[0]}%`,
              top: `${hovered[1]}%`,
              transform: tipTransform,
            }}
          >
            {formatSpeed(samples[hover!])}
          </div>
        </div>
      ) : null}
    </div>
  );
}

/**
 * 进度环：强调色沿弧线由浅到实的渐变描边，中心是百分比。
 * 用在「一个比例值当主角」的地方（如项目详情的分类进度）。
 */
export function ProgressRing({
  value,
  total,
  label,
  size = 56,
}: {
  value: number;
  total: number;
  /** 读屏与悬停的语义名，如「分类进度」 */
  label: string;
  size?: number;
}) {
  const gradientId = useSvgId();
  const r = ratio(value, total);
  const strokeWidth = 5;
  const radius = (size - strokeWidth) / 2;
  const circumference = 2 * Math.PI * radius;
  const percent = Math.round(r * 100);

  return (
    <svg
      className="ring"
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      role="img"
      aria-label={`${label}：${percent}%`}
    >
      <defs>
        <linearGradient id={gradientId} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" className="ring__stop-a" />
          <stop offset="100%" className="ring__stop-b" />
        </linearGradient>
      </defs>
      <circle
        className="ring__track"
        cx={size / 2}
        cy={size / 2}
        r={radius}
        strokeWidth={strokeWidth}
      />
      <circle
        className="ring__fill"
        cx={size / 2}
        cy={size / 2}
        r={radius}
        strokeWidth={strokeWidth}
        stroke={`url(#${gradientId})`}
        strokeLinecap="round"
        strokeDasharray={circumference}
        strokeDashoffset={circumference * (1 - r)}
        transform={`rotate(-90 ${size / 2} ${size / 2})`}
      />
      <text
        className="ring__label"
        x="50%"
        y="50%"
        textAnchor="middle"
        dominantBaseline="central"
      >
        {percent}%
      </text>
    </svg>
  );
}
