/** 主题三态：默认跟随系统，手动切换写 html[data-theme] 并持久化。 */

import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ThemeProvider, useTheme } from "./theme";

function Probe() {
  const { mode, resolved, setMode } = useTheme();
  return (
    <div>
      <span data-testid="mode">{mode}</span>
      <span data-testid="resolved">{resolved}</span>
      <button type="button" onClick={() => setMode("dark")}>
        深色
      </button>
      <button type="button" onClick={() => setMode("light")}>
        浅色
      </button>
      <button type="button" onClick={() => setMode("system")}>
        跟随系统
      </button>
    </div>
  );
}

function renderProbe() {
  render(
    <ThemeProvider>
      <Probe />
    </ThemeProvider>,
  );
}

/**
 * 这套 jsdom 里没有 localStorage（provider 因此写了 try/catch 兜底）。
 * 装一个内存版，才能真正验证「持久化 + 重新挂载读回」这条路径。
 */
function installMemoryStorage() {
  const data = new Map<string, string>();
  const storage = {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, String(v)),
    removeItem: (k: string) => void data.delete(k),
    clear: () => data.clear(),
    key: (i: number) => Array.from(data.keys())[i] ?? null,
    get length() {
      return data.size;
    },
  } as Storage;
  Object.defineProperty(window, "localStorage", {
    value: storage,
    configurable: true,
    writable: true,
  });
  Object.defineProperty(globalThis, "localStorage", {
    value: storage,
    configurable: true,
    writable: true,
  });
}

beforeEach(() => {
  installMemoryStorage();
  document.documentElement.removeAttribute("data-theme");
});

afterEach(cleanup);

describe("ThemeProvider", () => {
  it("默认跟随系统，不写 data-theme（由 prefers-color-scheme 决定）", () => {
    renderProbe();
    expect(screen.getByTestId("mode").textContent).toBe("system");
    expect(document.documentElement.hasAttribute("data-theme")).toBe(false);
  });

  it("手动切深色写 data-theme=dark 并持久化", async () => {
    const user = userEvent.setup();
    renderProbe();

    await user.click(screen.getByRole("button", { name: "深色" }));
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
    expect(screen.getByTestId("resolved").textContent).toBe("dark");
    expect(window.localStorage.getItem("ocard.theme")).toBe("dark");
  });

  it("手动切浅色同样显式覆盖（系统是深色时也保持浅色）", async () => {
    const user = userEvent.setup();
    renderProbe();

    await user.click(screen.getByRole("button", { name: "浅色" }));
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
    expect(screen.getByTestId("resolved").textContent).toBe("light");
  });

  it("切回跟随系统会移除 data-theme", async () => {
    const user = userEvent.setup();
    renderProbe();

    await user.click(screen.getByRole("button", { name: "深色" }));
    await user.click(screen.getByRole("button", { name: "跟随系统" }));
    expect(document.documentElement.hasAttribute("data-theme")).toBe(false);
    expect(screen.getByTestId("mode").textContent).toBe("system");
  });

  it("重新挂载时读回上次的选择", async () => {
    const user = userEvent.setup();
    renderProbe();
    await user.click(screen.getByRole("button", { name: "深色" }));
    cleanup();

    renderProbe();
    expect(screen.getByTestId("mode").textContent).toBe("dark");
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
  });
});
