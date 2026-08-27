/**
 * 窗口桥接：把「打开项目 / 打开项目管理窗口」抽象成一个 Context。
 *
 * - Tauri：真正的多窗口。欢迎窗口调 `openProject` → Rust 显示主窗口并
 *   投递 projectId、销毁欢迎窗；主窗口调 `openManager` → Rust 重建/聚焦
 *   欢迎窗口。
 * - 浏览器 / 测试：只有一个窗口，由 App 根组件传入回调，在同一窗口内
 *   切换「欢迎视图 ↔ 主界面」。
 *
 * 组件只依赖本 Context，不直接感知运行环境。
 */

import { createContext, useContext, useMemo, type ReactNode } from "react";
import * as api from "../api";

export interface WindowBridgeValue {
  /** 本窗口的角色（浏览器环境跟随当前视图语义，由 App 根决定） */
  role: "main" | "welcome";
  /** 在主窗口中打开项目（欢迎侧调用） */
  openProject: (projectId: string) => Promise<void>;
  /** 打开欢迎/项目管理窗口（主窗口侧栏调用） */
  openManager: () => Promise<void>;
}

const WindowBridgeContext = createContext<WindowBridgeValue | null>(null);

export function WindowBridgeProvider({
  children,
  role,
  onBrowserOpenProject,
  onBrowserOpenManager,
}: {
  children: ReactNode;
  role: "main" | "welcome";
  /** 浏览器单窗口环境：切到主界面并选中该项目 */
  onBrowserOpenProject?: (projectId: string) => void;
  /** 浏览器单窗口环境：切回欢迎/项目管理视图 */
  onBrowserOpenManager?: () => void;
}) {
  const value = useMemo<WindowBridgeValue>(
    () => ({
      role,
      openProject: async (projectId: string) => {
        // Tauri:Rust 记最近打开并切窗口;浏览器:api 只记 mock 最近,视图由回调切
        await api.openProjectInMain(projectId);
        if (!api.isTauri()) onBrowserOpenProject?.(projectId);
      },
      openManager: async () => {
        if (api.isTauri()) {
          await api.openManagerWindow();
          return;
        }
        onBrowserOpenManager?.();
      },
    }),
    [role, onBrowserOpenProject, onBrowserOpenManager],
  );
  return (
    <WindowBridgeContext.Provider value={value}>
      {children}
    </WindowBridgeContext.Provider>
  );
}

export function useWindowBridge(): WindowBridgeValue {
  const ctx = useContext(WindowBridgeContext);
  if (!ctx) throw new Error("useWindowBridge 必须在 WindowBridgeProvider 内使用");
  return ctx;
}
