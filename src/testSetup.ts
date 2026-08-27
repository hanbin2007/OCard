/** vitest 全局钩子:本地偏好按用例隔离(lib/prefs 写 localStorage) */
import { beforeEach } from "vitest";

beforeEach(() => {
  window.localStorage.clear();
});
