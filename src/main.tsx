import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./styles/tokens.css";
import "./styles/base.css";
import "./styles/shell.css";
import "./styles/components.css";
import "./styles/screens.css";
import "./styles/welcome.css";

/**
 * DEV 专用场景注入（生产构建里 import.meta.env.DEV 为 false，整段被摇树剔除）:
 * 浏览器预览/截图脚本通过 `?dev=<场景>` 把 mock 调到难以自然到达的状态
 * （首跑引导、零登记等）。只改 mock 数据,不改任何运行时行为。
 */
async function applyDevScenario(): Promise<void> {
  if (!import.meta.env.DEV) return;
  const scenario = new URLSearchParams(window.location.search).get("dev");
  if (!scenario) return;
  const mock = await import("./api/mock");
  if (scenario === "onboarding") {
    mock.mockWorkstation.operator = "";
    mock.mockWorkstation.nasRoot = "";
  } else if (scenario === "nocam") {
    mock.mockCameras.length = 0;
    mock.mockStorageCards.length = 0;
  }
}

void applyDevScenario().then(() => {
  ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );
});
