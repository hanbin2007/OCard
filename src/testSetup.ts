/** vitest 全局钩子:本地偏好与可变 mock 状态按用例隔离 */
import { beforeEach } from "vitest";
import { mockProjectSettings } from "./api/mock";

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

/* mockProjectSettings 是模块级可变状态(saveProjectSettings 会写它):
   不还原的话,一个用例在标签库未加载完时建标签,会把 backupPaths
   清空写回,污染后续所有依赖备份盘预设的用例 */
const initialProjectSettings = structuredClone(mockProjectSettings);

beforeEach(() => {
  window.localStorage.clear();
  for (const key of Object.keys(mockProjectSettings)) {
    delete mockProjectSettings[key];
  }
  Object.assign(mockProjectSettings, structuredClone(initialProjectSettings));
});
