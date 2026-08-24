/**
 * 主题：默认跟随系统（prefers-color-scheme），可手动切到浅色/深色。
 * 手动选择写 `html[data-theme]`，由 tokens.css 覆盖系统偏好。
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

export type ThemeMode = "system" | "light" | "dark";

const STORAGE_KEY = "ocard.theme";
const MODES: ThemeMode[] = ["system", "light", "dark"];

export const THEME_LABELS: Record<ThemeMode, string> = {
  system: "跟随系统",
  light: "浅色",
  dark: "深色",
};

interface ThemeContextValue {
  mode: ThemeMode;
  /** 实际生效的外观 */
  resolved: "light" | "dark";
  setMode: (mode: ThemeMode) => void;
  /** 系统 → 浅色 → 深色 循环 */
  cycleMode: () => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

function readStoredMode(): ThemeMode {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored && MODES.includes(stored as ThemeMode)) return stored as ThemeMode;
  } catch {
    // 隐私模式/禁用存储时静默回落
  }
  return "system";
}

function systemPrefersDark(): boolean {
  try {
    return window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false;
  } catch {
    return false;
  }
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [mode, setModeState] = useState<ThemeMode>(readStoredMode);
  const [systemDark, setSystemDark] = useState<boolean>(systemPrefersDark);

  useEffect(() => {
    const mql = window.matchMedia?.("(prefers-color-scheme: dark)");
    if (!mql?.addEventListener) return;
    const onChange = (e: MediaQueryListEvent) => setSystemDark(e.matches);
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, []);

  useEffect(() => {
    const root = document.documentElement;
    if (mode === "system") root.removeAttribute("data-theme");
    else root.setAttribute("data-theme", mode);
    try {
      localStorage.setItem(STORAGE_KEY, mode);
    } catch {
      // 忽略写入失败
    }
  }, [mode]);

  const setMode = useCallback((next: ThemeMode) => setModeState(next), []);
  const cycleMode = useCallback(() => {
    setModeState((current) => MODES[(MODES.indexOf(current) + 1) % MODES.length]);
  }, []);

  const value = useMemo<ThemeContextValue>(
    () => ({
      mode,
      resolved: mode === "system" ? (systemDark ? "dark" : "light") : mode,
      setMode,
      cycleMode,
    }),
    [mode, systemDark, setMode, cycleMode],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error("useTheme 必须在 ThemeProvider 内使用");
  return ctx;
}
