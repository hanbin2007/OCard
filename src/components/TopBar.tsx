/** 主区顶部极简标题栏：标题 + 次要信息 + 居中的当前项目 + 右侧动作 + 设置入口。 */

import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { IconSettings } from "./Icon";
import { NoticeBell } from "./NotificationCenter";
import { TaskCenter } from "./TaskCenter";
import { selectDeliveryWorking, useStore } from "../state/store";
import { useWindowBridge } from "../state/windowBridge";

/**
 * 当前操作项目的常驻指示（UX 波）：拷卡/分类/转码全都作用在「当前项目」上，
 * 这个内部状态过去只藏在项目列表的选中行里,极易在错误的项目上开工。
 * 现在钉在顶栏正中——黄底加粗,超长跑马灯,点击回项目列表。
 */
function CurrentProjectChip() {
  const { state } = useStore();
  const bridge = useWindowBridge();
  const project =
    state.projects.find((p) => p.id === state.selectedProjectId) ?? null;
  // 首跑引导阶段没有「当前项目」概念,不显示(设置没配完,项目都还进不去)
  const configured = Boolean(
    state.workstation?.operator?.trim() && state.workstation?.nasRoot?.trim(),
  );

  const clipRef = useRef<HTMLSpanElement>(null);
  const textRef = useRef<HTMLSpanElement>(null);
  const [shift, setShift] = useState(0);

  // 量出超出宽度：超出才起播跑马灯,不超出的名字一动不动
  useLayoutEffect(() => {
    const clip = clipRef.current;
    const text = textRef.current;
    if (!clip || !text) return;
    const measure = () => {
      setShift(Math.max(0, text.scrollWidth - clip.clientWidth));
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(clip);
    observer.observe(text);
    return () => observer.disconnect();
  }, [project?.name]);

  if (!configured) return null;

  if (!project) {
    return (
      <span className="topbar__project topbar__project--empty" data-testid="current-project-chip">
        未选择项目
      </span>
    );
  }

  // 交付打包期间侧栏锁导航,黄标不能成为绕过锁的旁门(codex P1):
  // 离开会让结果面板(含未交付明细)静默蒸发
  const deliveryWorking = selectDeliveryWorking(state);

  return (
    <button
      type="button"
      className="topbar__project"
      data-testid="current-project-chip"
      disabled={deliveryWorking}
      title={
        deliveryWorking
          ? "交付打包进行中，完成后才能切换页面"
          : `当前操作项目：${project.name}（点击打开项目管理）`
      }
      onClick={() => void bridge.openManager()}
    >
      <span className="topbar__project-label">当前</span>
      <span className="topbar__project-clip" ref={clipRef}>
        <span
          className={`topbar__project-name${shift > 0 ? " topbar__project-name--marquee" : ""}`}
          ref={textRef}
          style={shift > 0 ? ({ "--marquee-shift": `-${shift}px` } as React.CSSProperties) : undefined}
        >
          {project.name}
        </span>
      </span>
    </button>
  );
}

export function TopBar({
  title,
  subtitle,
  subtitleMono = false,
  actions,
}: {
  title: string;
  subtitle?: ReactNode;
  /** 仅路径/编码等技术信息用等宽字体，普通说明文案不要 mono */
  subtitleMono?: boolean;
  actions?: ReactNode;
}) {
  const { dispatch } = useStore();

  return (
    <div className="topbar" data-tauri-drag-region>
      {/* 三列网格:左标题簇 | 中当前项目 | 右动作。三块各占独立轨道,
          结构上杜绝重叠——绝对定位居中在长标题/长路径下必然压到别人 */}
      <div className="topbar__lead">
        <h1 className="topbar__title">{title}</h1>
        {subtitle ? (
          <span className={`topbar__sub${subtitleMono ? " mono" : ""}`}>{subtitle}</span>
        ) : null}
      </div>
      <CurrentProjectChip />
      <div className="topbar__actions">
        {actions}
        {/* 任务中心:跨项目/跨类型后台任务的统一入口(常驻) */}
        <TaskCenter />
        {/* 通知铃铛常驻所有屏幕：降级/失败必须随时看得见 */}
        <NoticeBell />
        {/* 设置入口常驻：首跑没配 NAS 时也要够得着 */}
        <button
          type="button"
          data-testid="settings-open"
          className="btn btn--ghost btn--icon"
          aria-label="工作站设置"
          title="工作站设置"
          onClick={() => dispatch({ type: "settingsOpened" })}
        >
          <IconSettings />
        </button>
      </div>
    </div>
  );
}
