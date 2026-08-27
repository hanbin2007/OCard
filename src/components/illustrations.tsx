/**
 * 拟物插画素材（空态 + 拷贝流向辅助图）。
 *
 * 三条约束（与 tokens.css 的插画令牌注释对齐）：
 * ① 全部内联 SVG，不引图片资源；颜色一律走 --ill-* 令牌，深浅主题自动换色。
 * ② 空态素材整体单色（灰阶塑形）；gold/glass 材质色与强调色/状态色
 *    只允许出现在「拷贝流向图」——那张图的职责是讲清流程，需要色彩分层。
 * ③ 插画是装饰不是信息：一律 aria-hidden，含义由空态文字承担。
 *    循环动画只在个别素材上做「还原真实动作」的一小步（插卡往复、LED 呼吸），
 *    reduced-motion 时由 base.css 的全局闸门一并按停。
 */

import { useId } from "react";

/** 渐变 id 必须全页唯一；useId 的冒号在 url(#…) 引用里不可靠，剥掉 */
function useIllId(): (name: string) => string {
  const raw = useId().replace(/:/g, "");
  return (name: string) => `ill-${raw}-${name}`;
}

interface GradientDefsProps {
  id: (name: string) => string;
  /** 需要哪几组材质渐变，用到什么声明什么，避免每张图都拖全量 defs */
  use: Array<"metal" | "plastic" | "chrome" | "dark" | "glass" | "paper" | "photo" | "sheen" | "gold">;
}

function GradientDefs({ id, use }: GradientDefsProps) {
  const has = (name: GradientDefsProps["use"][number]) => use.includes(name);
  return (
    <defs>
      {has("metal") ? (
        <linearGradient id={id("metal")} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="var(--ill-metal-hi)" />
          <stop offset="1" stopColor="var(--ill-metal-lo)" />
        </linearGradient>
      ) : null}
      {has("plastic") ? (
        <linearGradient id={id("plastic")} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="var(--ill-plastic-hi)" />
          <stop offset="1" stopColor="var(--ill-plastic-lo)" />
        </linearGradient>
      ) : null}
      {has("chrome") ? (
        <linearGradient id={id("chrome")} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="var(--ill-chrome-hi)" />
          <stop offset="1" stopColor="var(--ill-chrome-lo)" />
        </linearGradient>
      ) : null}
      {has("dark") ? (
        <linearGradient id={id("dark")} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="var(--ill-dark-hi)" />
          <stop offset="1" stopColor="var(--ill-dark-lo)" />
        </linearGradient>
      ) : null}
      {has("glass") ? (
        <radialGradient id={id("glass")} cx="0.35" cy="0.3" r="0.9">
          <stop offset="0" stopColor="var(--ill-glass-hi)" />
          <stop offset="0.55" stopColor="var(--ill-glass-lo)" />
          <stop offset="1" stopColor="var(--ill-glass-edge)" />
        </radialGradient>
      ) : null}
      {has("paper") ? (
        <linearGradient id={id("paper")} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="var(--ill-paper)" />
          <stop offset="1" stopColor="var(--ill-paper-lo)" />
        </linearGradient>
      ) : null}
      {has("photo") ? (
        <linearGradient id={id("photo")} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="var(--ill-photo-a)" />
          <stop offset="1" stopColor="var(--ill-photo-b)" />
        </linearGradient>
      ) : null}
      {has("sheen") ? (
        <linearGradient id={id("sheen")} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="var(--ill-sheen)" />
          <stop offset="1" stopColor="var(--ill-sheen)" stopOpacity="0" />
        </linearGradient>
      ) : null}
      {has("gold") ? (
        <linearGradient id={id("gold")} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="var(--ill-gold-hi)" />
          <stop offset="1" stopColor="var(--ill-gold-lo)" />
        </linearGradient>
      ) : null}
      <filter id={id("blur")}>
        <feGaussianBlur stdDeviation="2" />
      </filter>
    </defs>
  );
}

/** 物体落影：写实感的地基，一律放在物体正下方 */
function DropShadow({
  id,
  cx,
  cy,
  rx,
}: {
  id: (name: string) => string;
  cx: number;
  cy: number;
  rx: number;
}) {
  return (
    <ellipse
      cx={cx}
      cy={cy}
      rx={rx}
      ry={rx * 0.16}
      fill="var(--ill-shadow)"
      filter={`url(#${id("blur")})`}
    />
  );
}

interface SdCardProps {
  id: (name: string) => string;
  label: string;
  sub?: string;
  /** 空态是单色（chrome 灰触点）；只有流向图允许金色触点 */
  contacts: "chrome" | "gold";
}

/** SD 卡正面：切角、触点、锁扣、标签。真实比例约 24:32。 */
function SdCard({ id, label, sub, contacts }: SdCardProps) {
  return (
    <g>
      <path
        className="illu-ln"
        d="M2 4 q0 -3 3 -3 h26 l8 8 v26 q0 3 -3 3 h-31 q-3 0 -3 -3 z"
        fill={`url(#${id("plastic")})`}
      />
      <path
        d="M2 4 q0 -3 3 -3 h26 l8 8 v4 h-37 z"
        fill={`url(#${id("sheen")})`}
        stroke="none"
        opacity="0.7"
      />
      {[7, 12.5, 18, 23.5].map((x) => (
        <rect
          key={x}
          className="illu-ln-soft"
          x={x}
          y="3.5"
          width="3.4"
          height="7"
          rx="1"
          fill={`url(#${id(contacts)})`}
        />
      ))}
      <rect
        className="illu-ln-soft"
        x="-1.5"
        y="16"
        width="3.5"
        height="8"
        rx="1.6"
        fill={`url(#${id("metal")})`}
      />
      <rect
        className="illu-ln-soft"
        x="6"
        y="15"
        width="27"
        height="16"
        rx="2"
        fill="var(--ill-paper)"
      />
      <text className="illu-t" x="9" y="22">
        {label}
      </text>
      {sub ? (
        <text className="illu-t" x="9" y="28.5" style={{ fontSize: "5px" }}>
          {sub}
        </text>
      ) : null}
    </g>
  );
}

/** 拷卡任务空态：SD 卡插入读卡器（卡缓慢往复趋近插槽，LED 呼吸） */
export function IllCopyEmpty() {
  const id = useIllId();
  return (
    <svg width="170" height="112" viewBox="0 0 170 112" aria-hidden="true">
      <GradientDefs id={id} use={["metal", "plastic", "chrome", "sheen"]} />
      <DropShadow id={id} cx={38} cy={84} rx={26} />
      <DropShadow id={id} cx={120} cy={86} rx={34} />
      {/* 读卡器：铝壳、插槽、LED、USB-C 线 */}
      <g>
        <rect className="illu-ln" x="88" y="38" width="64" height="46" rx="7" fill={`url(#${id("metal")})`} />
        <rect x="88" y="38" width="64" height="10" rx="7" fill={`url(#${id("sheen")})`} stroke="none" />
        <rect x="88" y="52" width="7" height="20" rx="2.5" fill="var(--ill-slot)" stroke="none" />
        <rect x="95" y="54" width="1.2" height="16" fill="var(--ill-chrome-lo)" stroke="none" opacity="0.8" />
        <circle className="illu-breathe" cx="142" cy="46" r="2.6" fill="var(--ill-mono)" stroke="none" />
        <circle className="illu-breathe" cx="142" cy="46" r="4.6" fill="var(--ill-mono)" stroke="none" opacity="0.22" />
        <path
          className="illu-ln"
          fill="none"
          d="M152 62 h5 q7 0 7 7 v11"
          strokeWidth="2.4"
          stroke="var(--ill-metal-side)"
        />
        <text className="illu-t" x="104" y="79">
          USB 10Gbps
        </text>
      </g>
      {/* SD 卡：向插槽方向缓慢往复，还原「插卡等待检测」 */}
      <g className="illu-nudge">
        <g transform="translate(14,42)">
          <SdCard id={id} label="SD" sub="128G V90" contacts="chrome" />
        </g>
      </g>
      <g stroke="var(--ill-mono)" fill="none" strokeWidth="1.5" strokeLinecap="round">
        <line x1="62" y1="62" x2="80" y2="62" strokeDasharray="3 3" />
        <path d="M76 57 l6 5 -6 5" />
      </g>
    </svg>
  );
}

/** 设备登记（相机）空态：深色机身微单 + 打开的卡舱与 CFexpress */
export function IllCameraEmpty() {
  const id = useIllId();
  return (
    <svg width="170" height="112" viewBox="0 0 170 112" aria-hidden="true">
      <GradientDefs id={id} use={["metal", "plastic", "dark", "glass", "sheen"]} />
      <DropShadow id={id} cx={78} cy={92} rx={44} />
      <g>
        <path
          className="illu-ln"
          d="M60 34 v-6 q0 -3.5 3.5 -3.5 h17 q3.5 0 3.5 3.5 v6"
          fill={`url(#${id("dark")})`}
        />
        <rect className="illu-ln" x="36" y="34" width="72" height="48" rx="6" fill={`url(#${id("dark")})`} />
        <rect x="36" y="34" width="72" height="9" rx="6" fill={`url(#${id("sheen")})`} stroke="none" opacity="0.35" />
        <path className="illu-ln" d="M36 40 q-9 3 -9 20 q0 17 9 20" fill="var(--ill-dark-side)" />
        <g stroke="var(--ill-dark-side)" strokeWidth="1" opacity="0.8">
          <line x1="42" y1="48" x2="42" y2="74" />
          <line x1="46" y1="48" x2="46" y2="74" />
        </g>
        <circle className="illu-ln" cx="74" cy="58" r="18" fill="var(--ill-dark-side)" />
        <circle cx="74" cy="58" r="14.5" fill={`url(#${id("glass")})`} />
        <circle cx="74" cy="58" r="9" fill="none" stroke="var(--ill-glass-ring)" strokeWidth="1" />
        <ellipse cx="69" cy="52" rx="4.5" ry="3" fill="var(--ill-glint)" transform="rotate(-30 69 52)" />
        <rect className="illu-ln-soft" x="40" y="27.5" width="11" height="4.5" rx="2.2" fill={`url(#${id("metal")})`} />
        <circle className="illu-ln-soft" cx="98" cy="30" r="4" fill={`url(#${id("metal")})`} />
        <path className="illu-ln" fill="none" d="M108 50 l12 -7" strokeWidth="1.4" />
        <rect className="illu-ln-soft" x="103" y="52" width="5" height="18" rx="1.5" fill="var(--ill-dark-side)" />
      </g>
      <g transform="translate(120,52)">
        <rect className="illu-ln" x="0" y="0" width="26" height="22" rx="2.5" fill={`url(#${id("plastic")})`} />
        <rect x="0" y="0" width="26" height="6" rx="2.5" fill={`url(#${id("sheen")})`} stroke="none" opacity="0.7" />
        <rect className="illu-ln-soft" x="2.5" y="8" width="21" height="11" rx="1.5" fill="var(--ill-paper)" />
        <text className="illu-t" x="4.5" y="15.5" style={{ fontSize: "5.5px" }}>
          CFe·B
        </text>
      </g>
    </svg>
  );
}

/** 设备登记（存储卡）空态：SD 与 CFexpress 并排 */
export function IllCardsEmpty() {
  const id = useIllId();
  return (
    <svg width="170" height="112" viewBox="0 0 170 112" aria-hidden="true">
      <GradientDefs id={id} use={["metal", "plastic", "chrome", "sheen"]} />
      <DropShadow id={id} cx={62} cy={86} rx={26} />
      <DropShadow id={id} cx={116} cy={86} rx={26} />
      <g transform="translate(44,42)">
        <SdCard id={id} label="SD" sub="128G V90" contacts="chrome" />
      </g>
      <g transform="translate(96,46) rotate(3 20 15)">
        <rect className="illu-ln" x="0" y="0" width="40" height="32" rx="3" fill={`url(#${id("plastic")})`} />
        <rect x="0" y="0" width="40" height="8" rx="3" fill={`url(#${id("sheen")})`} stroke="none" opacity="0.7" />
        <rect className="illu-ln-soft" x="4" y="11" width="32" height="16" rx="2" fill="var(--ill-paper)" />
        <text className="illu-t" x="7" y="18.5" style={{ fontSize: "5.5px" }}>
          CFe-B
        </text>
        <text className="illu-t" x="7" y="24.5" style={{ fontSize: "5px" }}>
          512G
        </text>
        <rect className="illu-ln-soft" x="6" y="-2.5" width="26" height="3.5" rx="1.2" fill={`url(#${id("chrome")})`} />
      </g>
    </svg>
  );
}

/** 分类工作台空态：白边相纸摞 + 数字键帽 */
export function IllSortingEmpty() {
  const id = useIllId();
  return (
    <svg width="170" height="112" viewBox="0 0 170 112" aria-hidden="true">
      <GradientDefs id={id} use={["metal", "paper", "photo", "sheen"]} />
      <DropShadow id={id} cx={80} cy={90} rx={42} />
      <g transform="rotate(-7 62 62)">
        <rect className="illu-ln-soft" x="34" y="34" width="58" height="46" rx="2.5" fill={`url(#${id("paper")})`} />
      </g>
      <g transform="rotate(5 92 60)">
        <rect className="illu-ln-soft" x="52" y="31" width="58" height="46" rx="2.5" fill={`url(#${id("paper")})`} />
      </g>
      <g transform="rotate(-1.5 78 58)">
        <rect className="illu-ln" x="44" y="33" width="62" height="50" rx="2.5" fill={`url(#${id("paper")})`} />
        <rect className="illu-ln-soft" x="49" y="38" width="52" height="34" fill={`url(#${id("photo")})`} />
        <path
          d="M51 70 l14 -16 9 10 7 -8 13 14"
          fill="none"
          stroke="var(--ill-sheen)"
          strokeWidth="1.4"
          strokeLinejoin="round"
        />
        <circle cx="92" cy="45" r="4" fill="var(--ill-sheen)" />
        <text className="illu-t" x="50" y="80" style={{ fontSize: "5.5px" }}>
          DSC_0001
        </text>
      </g>
      {[
        { y: 38, label: "1" },
        { y: 62, label: "2" },
      ].map((key) => (
        <g key={key.label} transform={`translate(120,${key.y})`}>
          <rect x="0" y="2" width="17" height="16" rx="3.5" fill="var(--ill-metal-side)" stroke="none" />
          <rect className="illu-ln-soft" x="0" y="0" width="17" height="15.5" rx="3.5" fill={`url(#${id("metal")})`} />
          <text className="illu-t" x="6" y="10.5">
            {key.label}
          </text>
        </g>
      ))}
      <path
        d="M112 60 q4 -8 4 -14"
        stroke="var(--ill-mono)"
        strokeWidth="1.2"
        fill="none"
        strokeDasharray="2.5 2.5"
      />
    </svg>
  );
}

/** 项目空态：档案夹里探出一张写着项目名的纸，前板刻着规范目录 */
export function IllProjectsEmpty() {
  const id = useIllId();
  return (
    <svg width="170" height="112" viewBox="0 0 170 112" aria-hidden="true">
      <GradientDefs id={id} use={["metal", "plastic", "paper", "sheen"]} />
      <DropShadow id={id} cx={85} cy={88} rx={46} />
      <path
        className="illu-ln"
        d="M40 38 q0 -3 3 -3 h24 l7 8 h50 q3 0 3 3 v6 h-87 z"
        fill={`url(#${id("plastic")})`}
      />
      <g transform="rotate(-2 84 50)">
        <rect className="illu-ln-soft" x="50" y="40" width="66" height="14" rx="1.5" fill={`url(#${id("paper")})`} />
        <text className="illu-t" x="54" y="49" style={{ fontSize: "5.5px" }}>
          20260824_校运会
        </text>
      </g>
      <path
        className="illu-ln"
        d="M36 50 h96 q3 0 3 3 l-5 28 q-.5 3 -3.5 3 h-86 q-3 0 -3.5 -3 l-4 -28 q0 -3 3 -3 z"
        fill={`url(#${id("metal")})`}
      />
      <path
        d="M36 50 h96 q3 0 3 3 l-1 6 h-99 l-1 -6 q0 -3 2 -3 z"
        fill={`url(#${id("sheen")})`}
        stroke="none"
        opacity="0.6"
      />
      <g>
        <text className="illu-t" x="58" y="66" style={{ fontSize: "6px" }}>
          1.待分类  2.已分类
        </text>
        <text className="illu-t" x="58" y="75" style={{ fontSize: "6px" }}>
          3.成品   4.交付
        </text>
      </g>
    </svg>
  );
}

/** 代理转码空态：4K 原片胶片 → 小一号代理 */
export function IllTranscodeEmpty() {
  const id = useIllId();
  const holes = [25, 34, 43, 52, 61, 70];
  return (
    <svg width="170" height="112" viewBox="0 0 170 112" aria-hidden="true">
      <GradientDefs id={id} use={["metal", "dark", "photo", "sheen"]} />
      <DropShadow id={id} cx={52} cy={86} rx={34} />
      <DropShadow id={id} cx={136} cy={80} rx={22} />
      <g>
        <rect className="illu-ln" x="20" y="38" width="64" height="42" rx="4" fill={`url(#${id("dark")})`} />
        <g className="illu-ln-soft" fill="var(--bg)">
          {holes.map((x) => (
            <g key={x}>
              <rect x={x} y="42" width="4.5" height="4.5" rx="1" />
              <rect x={x} y="71" width="4.5" height="4.5" rx="1" />
            </g>
          ))}
        </g>
        <rect className="illu-ln-soft" x="26" y="51" width="52" height="16" rx="1.5" fill={`url(#${id("photo")})`} />
        <text className="illu-t-inv" x="38" y="61">
          4K · RAW
        </text>
      </g>
      <g stroke="var(--ill-mono)" fill="none" strokeWidth="1.5" strokeLinecap="round">
        <line x1="92" y1="59" x2="108" y2="59" strokeDasharray="3 3" />
        <path d="M104 54 l6 5 -6 5" />
      </g>
      <g>
        <rect className="illu-ln" x="114" y="48" width="42" height="26" rx="3" fill={`url(#${id("metal")})`} />
        <rect className="illu-ln-soft" x="118" y="53" width="34" height="11" rx="1.5" fill={`url(#${id("photo")})`} opacity="0.75" />
        <text className="illu-t" x="122" y="71" style={{ fontSize: "5.5px" }}>
          Proxy·1080
        </text>
      </g>
    </svg>
  );
}

/** 回收站空态：金属垃圾桶（竖棱 + 带提手的盖） */
export function IllTrashEmpty() {
  const id = useIllId();
  return (
    <svg width="170" height="112" viewBox="0 0 170 112" aria-hidden="true">
      <GradientDefs id={id} use={["metal", "sheen"]} />
      <DropShadow id={id} cx={85} cy={90} rx={30} />
      <path
        className="illu-ln"
        d="M56 44 l4.5 34 q0.4 3 3.5 3 h22 q3 0 3.5 -3 l4.5 -34 z"
        fill={`url(#${id("metal")})`}
      />
      <g stroke="var(--ill-metal-side)" strokeWidth="1.6" opacity="0.9">
        <line x1="66" y1="50" x2="67.5" y2="74" />
        <line x1="75" y1="50" x2="75" y2="74" />
        <line x1="84" y1="50" x2="82.5" y2="74" />
      </g>
      <path d="M56 44 l1 8 h44 l1 -8 z" fill={`url(#${id("sheen")})`} stroke="none" opacity="0.5" />
      <rect className="illu-ln" x="52" y="38" width="46" height="6" rx="3" fill={`url(#${id("metal")})`} />
      <path className="illu-ln" d="M69 38 v-3 q0 -2.5 2.5 -2.5 h7 q2.5 0 2.5 2.5 v3" fill="none" />
    </svg>
  );
}

interface CopyFlowProps {
  /** 目的地名称（取前两个）；不足两个时用通用文案补位 */
  destinations?: string[];
}

/**
 * 拷贝流向辅助图（双确认页专用，静态）。
 * 全套素材里唯一允许上色的一张：强调色画数据流向，状态绿画校验对勾，
 * 金触点保留材质色——它的职责是讲清「源读一次、多目的地、双端校验」。
 */
export function IllCopyFlow({ destinations }: CopyFlowProps) {
  const id = useIllId();
  const [destA, destB] = [
    destinations?.[0] ?? "目的地 A",
    destinations?.[1] ?? "目的地 B",
  ];
  return (
    <svg
      className="copy-flow__svg"
      viewBox="0 0 348 186"
      role="img"
      aria-label={`拷贝流向：源卡只读挂载，源读一次边拷边校，并行写入 ${destA} 与 ${destB}，每个文件双端校验`}
    >
      <GradientDefs id={id} use={["metal", "plastic", "dark", "gold", "sheen"]} />
      <DropShadow id={id} cx={27} cy={104} rx={22} />
      <DropShadow id={id} cx={126} cy={116} rx={40} />
      <DropShadow id={id} cx={244} cy={64} rx={38} />
      <DropShadow id={id} cx={240} cy={158} rx={30} />
      {/* 源卡 */}
      <g transform="translate(8,60)">
        <SdCard id={id} label="源卡" contacts="gold" />
        <text className="illu-t" x="-2" y="48">
          只读挂载
        </text>
      </g>
      {/* 源读一次 */}
      <g stroke="var(--accent)" fill="none" strokeWidth="1.5" strokeLinecap="round">
        <line x1="50" y1="78" x2="82" y2="78" strokeDasharray="3 3" />
        <path d="M78 73 l6 5 -6 5" />
      </g>
      {/* 工作站 */}
      <g transform="translate(88,52)">
        <rect className="illu-ln" x="0" y="0" width="76" height="46" rx="5" fill={`url(#${id("dark")})`} />
        <rect x="4" y="4" width="68" height="34" rx="2.5" fill="var(--ill-slot)" stroke="none" />
        <text className="illu-t-inv" x="22" y="19" style={{ fontSize: "7px" }}>
          xxHash3
        </text>
        <text className="illu-t-inv" x="10" y="31" style={{ fontSize: "5.5px" }}>
          8f2a1c04b7d9e355
        </text>
        <rect x="4" y="4" width="68" height="10" fill={`url(#${id("sheen")})`} stroke="none" opacity="0.12" />
        <path className="illu-ln" fill="none" d="M34 46 v6 M23 52 h22" strokeWidth="2" stroke="var(--ill-metal-side)" />
        <text className="illu-t" x="2" y="66">
          源读一次 · 边拷边校
        </text>
      </g>
      {/* 分叉到两个目的地 */}
      <g stroke="var(--accent)" fill="none" strokeWidth="1.5" strokeLinecap="round">
        <path d="M170 68 q22 -14 44 -20" strokeDasharray="3 3" />
        <path d="M209 43 l7 3.5 -5.5 5.5" />
        <path d="M170 88 q22 20 44 32" strokeDasharray="3 3" />
        <path d="M208 123 l7.5 0.5 -3.5 -7" />
      </g>
      {/* 目的地 1：NAS（两个盘位 + 状态灯） */}
      <g transform="translate(208,14)">
        <rect className="illu-ln" x="0" y="0" width="72" height="42" rx="4" fill={`url(#${id("metal")})`} />
        <rect x="0" y="0" width="72" height="8" rx="4" fill={`url(#${id("sheen")})`} stroke="none" opacity="0.5" />
        <rect className="illu-ln-soft" x="6" y="7" width="54" height="11" rx="2" fill={`url(#${id("dark")})`} />
        <rect className="illu-ln-soft" x="6" y="24" width="54" height="11" rx="2" fill={`url(#${id("dark")})`} />
        <circle cx="65" cy="12.5" r="1.8" fill="var(--ok)" />
        <circle cx="65" cy="29.5" r="1.8" fill="var(--ok)" />
        <text className="illu-t" x="4" y="52">
          {destA}
        </text>
      </g>
      <g transform="translate(296,26)" stroke="var(--ok)" fill="none" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="10" cy="10" r="9.5" fill="var(--panel)" />
        <path d="M5.5 10 l3.5 3.5 6 -6.5" />
      </g>
      {/* 目的地 2：移动盘 */}
      <g transform="translate(212,128)">
        <rect className="illu-ln" x="0" y="0" width="56" height="27" rx="6" fill={`url(#${id("dark")})`} />
        <rect x="0" y="0" width="56" height="7" rx="6" fill={`url(#${id("sheen")})`} stroke="none" opacity="0.25" />
        <line x1="9" y1="6" x2="9" y2="21" stroke="var(--ill-dark-side)" strokeWidth="1.4" />
        <text className="illu-t-inv" x="15" y="17">
          {destB}
        </text>
      </g>
      <g transform="translate(280,132)" stroke="var(--ok)" fill="none" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="10" cy="10" r="9.5" fill="var(--panel)" />
        <path d="M5.5 10 l3.5 3.5 6 -6.5" />
      </g>
    </svg>
  );
}
