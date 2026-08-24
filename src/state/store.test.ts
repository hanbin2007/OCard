import { describe, expect, it } from "vitest";
import type {
  CameraReg,
  CopyProgressEvent,
  Project,
  StorageCard,
} from "../api/types";
import { initialState, reducer, repeatDelta } from "./store";

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

const runningTask = {
  id: "t-1",
  projectId: "p-new",
  volumeId: "v",
  volumeName: "V",
  cameraId: "cam-1",
  cameraCode: "NikonZ9_E_CQ",
  note: "n",
  targetFolder: "f",
  destinations: [
    { id: "d-1", kind: "nas" as const, path: "/nas", state: "writing" as const, writtenBytes: 0 },
  ],
  files: [
    { id: "f-1", path: "a/DSC_1.NEF", name: "DSC_1.NEF", sizeBytes: 10, status: "pending" as const },
    { id: "f-2", path: "a/DSC_2.NEF", name: "DSC_2.NEF", sizeBytes: 10, status: "pending" as const },
  ],
  totalBytes: 100,
  copiedBytes: 10,
  speedBytesPerSec: 1,
  state: "running" as const,
  operator: "张涵斌",
  startedAt: "2026-08-24T10:00:00+08:00",
};

function progressEvent(overrides: Partial<CopyProgressEvent> = {}): CopyProgressEvent {
  return {
    taskId: "t-1",
    revision: 1,
    occurredAt: "2026-08-24T10:00:01+08:00",
    copiedBytes: 50,
    speedBytesPerSec: 8,
    state: "running",
    changedFiles: [],
    changedDestinations: [],
    ...overrides,
  };
}

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
      event: progressEvent({ copiedBytes: 50, speedBytesPerSec: 8, revision: 1 }),
    });
    expect(next.tasks[0].copiedBytes).toBe(50);
    expect(next.tasks[0].speedBytesPerSec).toBe(8);
    expect(next.tasks[0].note).toBe("n");
  });

  it("未知任务的进度事件不影响现有任务", () => {
    const next = reducer(initialState, {
      type: "taskProgress",
      event: progressEvent({ taskId: "missing" }),
    });
    expect(next.tasks).toEqual([]);
  });

  it("丢弃乱序/过期的进度事件", () => {
    const seeded = { ...initialState, tasks: [runningTask] };
    const advanced = reducer(seeded, {
      type: "taskProgress",
      event: progressEvent({ revision: 5, copiedBytes: 80 }),
    });
    expect(advanced.tasks[0].copiedBytes).toBe(80);

    // 迟到的 revision=3 不能把进度拉回去
    const stale = reducer(advanced, {
      type: "taskProgress",
      event: progressEvent({ revision: 3, copiedBytes: 20 }),
    });
    expect(stale.tasks[0].copiedBytes).toBe(80);
  });

  it("进度事件把逐文件与逐目的地增量合并进任务", () => {
    const seeded = { ...initialState, tasks: [runningTask] };
    const next = reducer(seeded, {
      type: "taskProgress",
      event: progressEvent({
        revision: 2,
        changedFiles: [{ id: "f-1", status: "verified", hash: "abc123" }],
        changedDestinations: [{ id: "d-1", state: "done", writtenBytes: 100 }],
      }),
    });
    expect(next.tasks[0].files[0].status).toBe("verified");
    expect(next.tasks[0].files[0].hash).toBe("abc123");
    // 未出现在事件里的文件保持原样
    expect(next.tasks[0].files[1].status).toBe("pending");
    expect(next.tasks[0].destinations[0].state).toBe("done");
  });

  it("不认识的 taskId：事件先缓存，不丢也不误伤现有任务", () => {
    const seeded = { ...initialState, tasks: [runningTask] };
    const next = reducer(seeded, {
      type: "taskProgress",
      event: progressEvent({ taskId: "t-unknown", revision: 4, copiedBytes: 42 }),
    });
    expect(next.tasks[0].copiedBytes).toBe(runningTask.copiedBytes);
    expect(next.orphanProgress["t-unknown"].copiedBytes).toBe(42);
  });

  it("缓存只保留最新一条，过期事件不覆盖", () => {
    const a = reducer(initialState, {
      type: "taskProgress",
      event: progressEvent({ taskId: "t-x", revision: 5, copiedBytes: 50 }),
    });
    const b = reducer(a, {
      type: "taskProgress",
      event: progressEvent({ taskId: "t-x", revision: 2, copiedBytes: 20 }),
    });
    expect(b.orphanProgress["t-x"].copiedBytes).toBe(50);
  });

  it("快照到达后补上缓存事件并清空缓存", () => {
    const buffered = reducer(initialState, {
      type: "taskProgress",
      event: progressEvent({ taskId: "t-1", revision: 7, copiedBytes: 90, state: "done" }),
    });
    expect(buffered.tasks).toHaveLength(0);

    const snapped = reducer(buffered, { type: "taskSnapshot", task: runningTask });
    expect(snapped.tasks).toHaveLength(1);
    // 快照里是 running/copied=10，缓存事件把它推进到 done/90
    expect(snapped.tasks[0].copiedBytes).toBe(90);
    expect(snapped.tasks[0].state).toBe("done");
    expect(snapped.orphanProgress["t-1"]).toBeUndefined();
  });

  it("快照对已知任务是就地替换，不产生重复行", () => {
    const seeded = { ...initialState, tasks: [runningTask] };
    const next = reducer(seeded, {
      type: "taskSnapshot",
      task: { ...runningTask, state: "paused" as const, copiedBytes: 33 },
    });
    expect(next.tasks).toHaveLength(1);
    expect(next.tasks[0].state).toBe("paused");
    expect(next.tasks[0].copiedBytes).toBe(33);
  });

  it("paused / failed 态任务的事件照常归约（订阅不再按状态过滤）", () => {
    const paused = { ...runningTask, state: "paused" as const };
    const seeded = { ...initialState, tasks: [paused] };
    const next = reducer(seeded, {
      type: "taskProgress",
      event: progressEvent({ revision: 9, copiedBytes: 70, state: "running" }),
    });
    expect(next.tasks[0].state).toBe("running");
    expect(next.tasks[0].copiedBytes).toBe(70);
  });

  it("过期快照不回踩已归约的进度（对账必须单调）", () => {
    // 本地已被 revision=9 的事件推进到 90 字节
    const seeded = { ...initialState, tasks: [runningTask] };
    const advanced = reducer(seeded, {
      type: "taskProgress",
      event: progressEvent({ revision: 9, copiedBytes: 90, state: "verifying" }),
    });
    expect(advanced.tasks[0].copiedBytes).toBe(90);

    // 一个更旧的快照（in-flight 的 getCopyTask）后到
    const stale = reducer(advanced, {
      type: "taskSnapshot",
      task: { ...runningTask, copiedBytes: 10, state: "running", progressRevision: 3 },
    });
    expect(stale.tasks[0].copiedBytes).toBe(90);
    expect(stale.tasks[0].state).toBe("verifying");
    expect(stale.tasks[0].progressRevision).toBe(9);
  });

  it("较新的快照仍然以后端为准", () => {
    const seeded = { ...initialState, tasks: [runningTask] };
    const advanced = reducer(seeded, {
      type: "taskProgress",
      event: progressEvent({ revision: 2, copiedBytes: 20 }),
    });
    const fresh = reducer(advanced, {
      type: "taskSnapshot",
      task: { ...runningTask, copiedBytes: 88, state: "done", progressRevision: 12 },
    });
    expect(fresh.tasks[0].copiedBytes).toBe(88);
    expect(fresh.tasks[0].state).toBe("done");
  });

  it("taskStarted 会消费掉该任务的孤儿缓存，不留两份状态来源", () => {
    // start 返回前就先收到了这个任务的事件
    const buffered = reducer(initialState, {
      type: "taskProgress",
      event: progressEvent({ taskId: "t-1", revision: 6, copiedBytes: 60 }),
    });
    expect(buffered.orphanProgress["t-1"]).toBeDefined();

    const started = reducer(buffered, { type: "taskStarted", task: runningTask });
    expect(started.tasks[0].copiedBytes).toBe(60);
    expect(started.tasks[0].progressRevision).toBe(6);
    expect(started.orphanProgress["t-1"]).toBeUndefined();
  });

  it("监听建立失败经通知中心呈现（不再是一次性横幅）", () => {
    const next = reducer(initialState, {
      type: "noticeReceived",
      notice: {
        level: "error",
        code: "progress-listen-failed",
        message: "进度监听未能建立：boom",
        occurredAt: "2026-08-24T10:00:00+08:00",
      },
    });
    expect(next.notices).toHaveLength(1);
    expect(next.notices[0].level).toBe("error");
    expect(next.notices[0].code).toBe("progress-listen-failed");
    expect(next.notices[0].message).toContain("boom");
    expect(next.notices[0].live).toBe(true);
    expect(next.notices[0].read).toBe(false);
  });

  it("设置对话框开合，保存后写回工作站并自动关闭", () => {
    const opened = reducer(initialState, { type: "settingsOpened" });
    expect(opened.settingsOpen).toBe(true);

    const closed = reducer(opened, { type: "settingsClosed" });
    expect(closed.settingsOpen).toBe(false);

    const saved = reducer(opened, {
      type: "workstationUpdated",
      workstation: {
        machineId: "WS-1",
        operator: "李默",
        nasRoot: "/Volumes/NAS2",
      },
    });
    expect(saved.workstation?.operator).toBe("李默");
    expect(saved.settingsOpen).toBe(false);
  });

  it("bootstrap 失败落到错误态，重新加载时清掉错误", () => {
    const failed = reducer(initialState, { type: "loadFailed", error: "NAS 未挂载" });
    expect(failed.loading).toBe(false);
    expect(failed.error).toBe("NAS 未挂载");

    const retrying = reducer(failed, { type: "loadStarted" });
    expect(retrying.loading).toBe(true);
    expect(retrying.error).toBeNull();
  });

  it("切换项目时任务选中跟着切，不串台", () => {
    const seeded = {
      ...initialState,
      projects: [project],
      tasks: [runningTask, { ...runningTask, id: "t-other", projectId: "p-other" }],
      selectedTaskId: "t-other",
    };
    const next = reducer(seeded, { type: "selectProject", projectId: "p-new" });
    expect(next.selectedTaskId).toBe("t-1");
  });
});

describe("repeatDelta（通知计数增量）", () => {
  it("无 repeats 视为普通一条", () => {
    expect(repeatDelta(1, undefined)).toBe(1);
    expect(repeatDelta(5, undefined)).toBe(1);
  });

  it("同一窗口内累计推进只补差值", () => {
    expect(repeatDelta(1, 2)).toBe(1);
    expect(repeatDelta(2, 3)).toBe(1);
    expect(repeatDelta(1, 5)).toBe(4);
  });

  it("跨窗口回落时按新窗口净增量补，不倒退", () => {
    // 新窗口从 2 开始：这条代表窗口内第 2 次，净增 1
    expect(repeatDelta(3, 2)).toBe(1);
    // 新窗口的第 1 次通常不带 repeats；若带 1 则净增 0（已由无 repeats 那条计过）
    expect(repeatDelta(3, 1)).toBe(0);
  });

  it("真实序列 [无,2,3,无,2] 累计为 5", () => {
    const seq: Array<number | undefined> = [undefined, 2, 3, undefined, 2];
    let count = 0;
    let last = 1;
    for (const r of seq) {
      count += repeatDelta(last, r);
      last = r ?? 1;
    }
    expect(count).toBe(5);
  });
});
