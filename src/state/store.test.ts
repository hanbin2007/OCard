import { describe, expect, it } from "vitest";
import type { CameraReg, Project, StorageCard } from "../api/types";
import { initialState, reducer } from "./store";

const project: Project = {
  id: "p-new",
  name: "校运会",
  date: "20260824",
  folderName: "20260824_校运会",
  scenario: "B",
  categories: ["开幕式"],
  relativePath: "20260824_校运会",
  status: "draft",
  cardsCopied: 0,
  cardsTotal: 0,
  bytesCopied: 0,
  assetCount: 0,
  sortedCount: 0,
  destinationCount: 2,
  updatedAt: "2026-08-24T10:00:00+08:00",
};

const camera: CameraReg = {
  id: "cam-1",
  model: "Nikon Z9",
  position: "E",
  operatorAlias: "CQ",
  code: "NikonZ9_E_CQ",
  createdAt: "2026-08-24T10:00:00+08:00",
};

const card: StorageCard = {
  id: "card-1",
  label: "SD-06",
  cameraId: "cam-1",
  capacityBytes: 512 * 1024 ** 3,
  createdAt: "2026-08-24T10:00:00+08:00",
};

describe("reducer", () => {
  it("navigate 切换路由", () => {
    expect(reducer(initialState, { type: "navigate", route: "devices" }).route).toBe(
      "devices",
    );
  });

  it("新建项目后置顶、选中并跳回项目列表", () => {
    const next = reducer(
      { ...initialState, route: "new-project", loading: false },
      { type: "projectCreated", project },
    );
    expect(next.projects[0].id).toBe("p-new");
    expect(next.selectedProjectId).toBe("p-new");
    expect(next.route).toBe("projects");
  });

  it("删除相机时级联清掉它名下的卡", () => {
    const seeded = {
      ...initialState,
      cameras: [camera],
      cards: [card],
    };
    const next = reducer(seeded, { type: "cameraRemoved", cameraId: "cam-1" });
    expect(next.cameras).toHaveLength(0);
    expect(next.cards).toHaveLength(0);
  });

  it("bootstrapped 结束加载态并默认选中首个项目", () => {
    const next = reducer(initialState, {
      type: "bootstrapped",
      payload: {
        workstation: null,
        projects: [project],
        cameras: [],
        cards: [],
        volumes: [],
        tasks: [],
      },
    });
    expect(next.loading).toBe(false);
    expect(next.selectedProjectId).toBe("p-new");
  });

  it("taskProgress 只更新对应任务的进度字段", () => {
    const seeded = {
      ...initialState,
      tasks: [
        {
          id: "t-1",
          projectId: "p-new",
          volumeId: "v",
          volumeName: "V",
          cameraId: "cam-1",
          cameraCode: "NikonZ9_E_CQ",
          note: "n",
          targetFolder: "f",
          destinations: [],
          files: [],
          totalBytes: 100,
          copiedBytes: 10,
          speedBytesPerSec: 1,
          state: "running" as const,
          operator: "张涵斌",
          startedAt: "2026-08-24T10:00:00+08:00",
        },
      ],
    };
    const next = reducer(seeded, {
      type: "taskProgress",
      taskId: "t-1",
      copiedBytes: 50,
      speedBytesPerSec: 8,
    });
    expect(next.tasks[0].copiedBytes).toBe(50);
    expect(next.tasks[0].speedBytesPerSec).toBe(8);
    expect(next.tasks[0].note).toBe("n");
  });

  it("未知项目的进度事件不影响现有任务", () => {
    const next = reducer(initialState, {
      type: "taskProgress",
      taskId: "missing",
      copiedBytes: 1,
      speedBytesPerSec: 1,
    });
    expect(next.tasks).toEqual([]);
  });
});
