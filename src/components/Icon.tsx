/**
 * 内联图标：16px 网格、1.5px 描边、currentColor。
 * 全部自绘线条，不引第三方图标库，也不使用任何第三方品牌资产。
 */

import type { SVGProps } from "react";

type IconProps = SVGProps<SVGSVGElement> & { size?: number };

function Svg({ size = 16, children, ...rest }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...rest}
    >
      {children}
    </svg>
  );
}

export function IconProjects(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M2 4.5A1.5 1.5 0 0 1 3.5 3h2.2l1.3 1.6h5.5A1.5 1.5 0 0 1 14 6.1v5.4A1.5 1.5 0 0 1 12.5 13h-9A1.5 1.5 0 0 1 2 11.5z" />
    </Svg>
  );
}

export function IconPlus(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M8 3.5v9M3.5 8h9" />
    </Svg>
  );
}

export function IconCamera(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M2 5.8A1.3 1.3 0 0 1 3.3 4.5h1.6l1-1.5h4.2l1 1.5h1.6A1.3 1.3 0 0 1 14 5.8v5.4a1.3 1.3 0 0 1-1.3 1.3H3.3A1.3 1.3 0 0 1 2 11.2z" />
      <circle cx="8" cy="8.4" r="2.3" />
    </Svg>
  );
}

export function IconCard(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M3.2 2.5h6.3L12.8 5.8v7.7H3.2z" />
      <path d="M5.6 2.5v3.1M7.8 2.5v3.1M10 4.7v.9" />
    </Svg>
  );
}

export function IconCheck(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M3.2 8.4 6.4 11.6l6.4-7.2" />
    </Svg>
  );
}

export function IconChevronRight(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M6 3.5 10.5 8 6 12.5" />
    </Svg>
  );
}

export function IconSun(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx="8" cy="8" r="2.8" />
      <path d="M8 1.6v1.4M8 13v1.4M1.6 8H3M13 8h1.4M3.5 3.5l1 1M11.5 11.5l1 1M12.5 3.5l-1 1M4.5 11.5l-1 1" />
    </Svg>
  );
}

export function IconMoon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M13 9.6A5.4 5.4 0 0 1 6.4 3 5.6 5.6 0 1 0 13 9.6" />
    </Svg>
  );
}

export function IconMonitor(props: IconProps) {
  return (
    <Svg {...props}>
      <rect x="2" y="3" width="12" height="8.2" rx="1.2" />
      <path d="M6 13.6h4" />
    </Svg>
  );
}

export function IconTrash(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M3 4.4h10M6.4 4.4V3h3.2v1.4M4.4 4.4l.6 8.2h6l.6-8.2" />
    </Svg>
  );
}

export function IconRetry(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M13 8a5 5 0 1 1-1.6-3.7" />
      <path d="M13.2 2.6v2.9h-2.9" />
    </Svg>
  );
}

export function IconFilm(props: IconProps) {
  return (
    <Svg {...props}>
      <rect x="2" y="3" width="12" height="10" rx="1.4" />
      <path d="M5.2 3v10M10.8 3v10M2 8h12" />
    </Svg>
  );
}

export function IconGrid(props: IconProps) {
  return (
    <Svg {...props}>
      <rect x="2.2" y="2.2" width="5" height="5" rx="1" />
      <rect x="8.8" y="2.2" width="5" height="5" rx="1" />
      <rect x="2.2" y="8.8" width="5" height="5" rx="1" />
      <rect x="8.8" y="8.8" width="5" height="5" rx="1" />
    </Svg>
  );
}

export function IconBell(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M12.2 11.2V7.2a4.2 4.2 0 1 0-8.4 0v4l-1.1 1.6h10.6z" />
      <path d="M6.6 13.8a1.5 1.5 0 0 0 2.8 0" />
    </Svg>
  );
}

export function IconClose(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M4 4l8 8M12 4l-8 8" />
    </Svg>
  );
}

export function IconTasks(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M2.5 4h11" />
      <path d="M2.5 8h11" />
      <path d="M2.5 12h6" />
      <circle cx="12" cy="12" r="2" />
    </Svg>
  );
}

export function IconSettings(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx="8" cy="8" r="2.2" />
      <path d="M12.9 9.8a1.1 1.1 0 0 0 .22 1.21l.04.04a1.33 1.33 0 1 1-1.88 1.88l-.04-.04a1.1 1.1 0 0 0-1.21-.22 1.1 1.1 0 0 0-.67 1v.11a1.33 1.33 0 0 1-2.66 0v-.06a1.1 1.1 0 0 0-.72-1 1.1 1.1 0 0 0-1.21.22l-.04.04a1.33 1.33 0 1 1-1.88-1.88l.04-.04a1.1 1.1 0 0 0 .22-1.21 1.1 1.1 0 0 0-1-.67h-.11a1.33 1.33 0 0 1 0-2.66h.06a1.1 1.1 0 0 0 1-.72 1.1 1.1 0 0 0-.22-1.21l-.04-.04a1.33 1.33 0 1 1 1.88-1.88l.04.04a1.1 1.1 0 0 0 1.21.22h.05a1.1 1.1 0 0 0 .67-1v-.11a1.33 1.33 0 0 1 2.66 0v.06a1.1 1.1 0 0 0 .67 1 1.1 1.1 0 0 0 1.21-.22l.04-.04a1.33 1.33 0 1 1 1.88 1.88l-.04.04a1.1 1.1 0 0 0-.22 1.21v.05a1.1 1.1 0 0 0 1 .67h.11a1.33 1.33 0 0 1 0 2.66h-.06a1.1 1.1 0 0 0-1 .67" />
    </Svg>
  );
}

/**
 * 侧栏开合(macOS「sidebar.left」同款几何):一个窗框 + 靠左的分栏线。
 * 两态共用同一个字形——开合状态由按钮的 aria-expanded 与文案承担,
 * 图标本身不做左右翻转:翻过来读起来像「右侧栏」,是另一个东西。
 */
export function IconSidebar(props: IconProps) {
  return (
    <Svg {...props}>
      <rect x="2" y="3" width="12" height="10" rx="1.4" />
      <path d="M6.2 3v10" />
    </Svg>
  );
}

export function IconArrowLeft(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M12.5 8h-9M6.8 3.6 3 8l3.8 4.4" />
    </Svg>
  );
}
