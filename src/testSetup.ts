/** vitest 全局钩子:本地偏好按用例隔离(lib/prefs 写 localStorage) */
import { beforeEach } from "vitest";

// 部分环境的 jsdom 不提供 localStorage(受限/被移除):补一个 Map 实现,
// 让 lib/prefs 的记忆行为在所有环境下都可测;有原生实现时不动它。
if (typeof window !== "undefined" && !window.localStorage) {
  const store = new Map<string, string>();
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    value: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, String(v)),
      removeItem: (k: string) => void store.delete(k),
      clear: () => store.clear(),
      key: (i: number) => [...store.keys()][i] ?? null,
      get length() {
        return store.size;
      },
    } satisfies Storage,
  });
}

beforeEach(() => {
  window.localStorage.clear();
});
