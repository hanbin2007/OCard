import { describe, expect, it } from "vitest";
import type {
  CameraReg,
  CopyProgressEvent,
  Project,
  StorageCard,
} from "../api/types";
import {
  initialState,
  reducer,
  repeatDelta,
  selectDeliveryWorking,
} from "./store";

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
  copyIncomplete: false,
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
  tags: [],
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
      { ...initialState, route: "copy", loading: false },
      { type: "projectCreated", project },
    );
    expect(next.projects[0].id).toBe("p-new");
    expect(next.selectedProjectId).toBe("p-new");
    // 路由不再跳转:创建发生在欢迎窗口,主窗口经「打开项目」进入
    expect(next.route).toBe("copy");
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
          tags: [],
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

  it("终态跨越出声(评审 2.1):done 出 info、failed 出 error,且带任务引用", () => {
    const seeded = { ...initialState, tasks: [runningTask] };

    const done = reducer(seeded, {
      type: "taskProgress",
      event: progressEvent({ revision: 2, state: "done" }),
    });
    const doneNotice = done.notices.find((n) => n.code === "copy-task-done");
    expect(doneNotice).toBeDefined();
    expect(doneNotice?.level).toBe("info");
    expect(doneNotice?.taskId).toBe(runningTask.id);
    expect(doneNotice?.live).toBe(true);

    const failed = reducer(seeded, {
      type: "taskProgress",
      event: progressEvent({ revision: 2, state: "failed" }),
    });
    const failNotice = failed.notices.find((n) => n.code === "copy-task-failed");
    expect(failNotice?.level).toBe("error");
    expect(failNotice?.projectId).toBe(runningTask.projectId);

    // 终态之后的重复事件不再重复出声
    const again = reducer(failed, {
      type: "taskProgress",
      event: progressEvent({ revision: 3, state: "failed" }),
    });
    expect(again.notices.filter((n) => n.code === "copy-task-failed").length).toBe(1);
  });

  /**
   * ★ 全局通知同样不许在部分拷贝后说「可格式化」。
   *
   * 拷卡终态大概率不在拷卡屏被看到——用户看到的就是这条 toast/铃铛。
   * 屏内提示改对了而这里没改,等于漏了最可能被读到的那一处。
   */
  it("★ 部分拷贝的完成通知说「请勿格式化」,整卷才说「可格式化」", () => {
    const partial = {
      ...runningTask,
      sourceFolders: ["DCIM/100MSDCF"],
    };
    const done = reducer(
      { ...initialState, tasks: [partial] },
      { type: "taskProgress", event: progressEvent({ revision: 2, state: "done" }) },
    );
    const notice = done.notices.find((n) => n.code === "copy-task-done");
    expect(notice?.message).toMatch(/请勿格式化/);
    expect(notice?.message).not.toMatch(/本卡可格式化/);

    // 整卷(sourceFolders 缺省)维持原文案
    const whole = reducer(
      { ...initialState, tasks: [runningTask] },
      { type: "taskProgress", event: progressEvent({ revision: 2, state: "done" }) },
    );
    expect(
      whole.notices.find((n) => n.code === "copy-task-done")?.message,
    ).toMatch(/本卡可格式化/);
  });

  /**
   * ★ 判据统一（E7）：`[""]` 是「只勾了卷根」——**部分拷贝**。
   *
   * 它长得像空、像「什么都没选」，但语义是「只拷卷根的直接子文件」，
   * `DCIM/` 底下的素材一个都不会被拷走。这条判据此前在 store / audit /
   * 拷卡屏各写一遍，任何一处把它读成整卷，那张卡就会被告知「可格式化」。
   */
  it("★ 只勾了卷根（sourceFolders 为 [\"\"]）也是部分拷贝，不许说可格式化", () => {
    const rootOnly = { ...runningTask, sourceFolders: [""] };
    const done = reducer(
      { ...initialState, tasks: [rootOnly] },
      { type: "taskProgress", event: progressEvent({ revision: 2, state: "done" }) },
    );
    const notice = done.notices.find((n) => n.code === "copy-task-done");
    expect(notice?.message).toMatch(/请勿格式化/);
    expect(notice?.message).not.toMatch(/本卡可格式化/);
    // 范围要说得出口:直接 join 会写成一段空白,用户第二天对账时无从判断
    expect(notice?.message).toContain("（卷根）");
  });

  it("★ 范围读不出（不是数组）时按最保守处理，绝不放绿灯", () => {
    // 类型上不该发生,但 DTO 来自另一进程:读不懂时替它担保「整卷」正是要防的事
    const broken = {
      ...runningTask,
      sourceFolders: "DCIM" as unknown as string[],
    };
    const done = reducer(
      { ...initialState, tasks: [broken] },
      { type: "taskProgress", event: progressEvent({ revision: 2, state: "done" }) },
    );
    const notice = done.notices.find((n) => n.code === "copy-task-done");
    expect(notice?.message).toMatch(/请勿格式化/);
    expect(notice?.message).not.toMatch(/本卡可格式化/);
    // 也不能编一句「所选 0 个文件夹」
    expect(notice?.message).not.toContain("0 个文件夹");
  });

  /**
   * ★ 完成通知不许跨卡折叠。
   *
   * 折叠原本只比 `code + level`:任务 A、B 先后完成时,B 的正文覆盖了 A 的条目,
   * 却保留着 A 的 taskId——用户看到 B 的「请勿格式化」,点「查看任务」进的是 A,
   * 据此格式化的是另一张卡。不可逆。
   */
  it("★ 完成通知不跨卡折叠:正文与「查看任务」必须指向同一张卡", () => {
    const wholeCard = { ...runningTask, id: "t-a", volumeName: "CFE-01" };
    const partialCard = {
      ...runningTask,
      id: "t-b",
      volumeName: "SD-06",
      sourceFolders: ["DCIM/100MSDCF"],
    };
    const seeded = { ...initialState, tasks: [wholeCard, partialCard] };

    const afterA = reducer(seeded, {
      type: "taskProgress",
      event: progressEvent({ taskId: "t-a", revision: 2, state: "done" }),
    });
    const afterB = reducer(afterA, {
      type: "taskProgress",
      event: progressEvent({ taskId: "t-b", revision: 2, state: "done" }),
    });

    const dones = afterB.notices.filter((n) => n.code === "copy-task-done");
    expect(dones).toHaveLength(2);
    // 每条通知的正文都必须说的是它自己指向的那张卡
    for (const entry of dones) {
      const task = afterB.tasks.find((t) => t.id === entry.taskId);
      expect(task, `通知的 taskId=${entry.taskId} 找不到任务`).toBeDefined();
      expect(entry.message).toContain(task!.volumeName);
      const partial = (task!.sourceFolders?.length ?? 0) > 0;
      expect(/请勿格式化/.test(entry.message)).toBe(partial);
      // 各自成条,没有被折叠成 ×2
      expect(entry.count).toBe(1);
    }
  });

  /**
   * 同一条的双投递靠 `code@occurredAt` 认；两张卡在同一秒拷完(并行拷卡是常态)
   * 时这个键会撞车,第二张卡的完成通知会被整条当成重复丢掉。
   */
  it("★ 两张卡同一时刻拷完:两条通知都要在,不许被去重吞掉一条", () => {
    const seeded = {
      ...initialState,
      tasks: [
        { ...runningTask, id: "t-a", volumeName: "CFE-01" },
        { ...runningTask, id: "t-b", volumeName: "SD-06" },
      ],
    };
    const sameMoment = "2026-08-24T10:00:01+08:00";
    const afterA = reducer(seeded, {
      type: "taskProgress",
      event: progressEvent({
        taskId: "t-a",
        revision: 2,
        state: "done",
        occurredAt: sameMoment,
      }),
    });
    const afterB = reducer(afterA, {
      type: "taskProgress",
      event: progressEvent({
        taskId: "t-b",
        revision: 2,
        state: "done",
        occurredAt: sameMoment,
      }),
    });
    const dones = afterB.notices.filter((n) => n.code === "copy-task-done");
    expect(dones.map((n) => n.taskId).sort()).toEqual(["t-a", "t-b"]);
  });

  it("同一条通知的双投递仍然只算一条（去重没被上一条改坏）", () => {
    const dto = {
      level: "warning" as const,
      code: "audit-outbox",
      message: "审计日志暂存本机。",
      occurredAt: "2026-08-24T10:00:00+08:00",
    };
    const once = reducer(initialState, { type: "noticeReceived", notice: dto });
    const twice = reducer(once, { type: "noticeReceived", notice: dto });
    expect(twice.notices).toHaveLength(1);
    expect(twice.notices[0].count).toBe(1);
  });

  it("不带任务的同 code 告警照旧折叠计数，没被上一条改坏", () => {
    const once = reducer(initialState, {
      type: "noticeReceived",
      notice: {
        level: "warning",
        code: "audit-outbox",
        message: "审计日志暂存本机。",
        occurredAt: "2026-08-24T10:00:00+08:00",
      },
    });
    const twice = reducer(once, {
      type: "noticeReceived",
      notice: {
        level: "warning",
        code: "audit-outbox",
        message: "审计日志暂存本机。",
        occurredAt: "2026-08-24T10:00:30+08:00",
      },
    });
    expect(twice.notices).toHaveLength(1);
    expect(twice.notices[0].count).toBe(2);
  });

  it("快照对账补出的终态同样出声,但新任务快照不算", () => {
    const seeded = { ...initialState, tasks: [runningTask] };
    const viaSnapshot = reducer(seeded, {
      type: "taskSnapshot",
      task: { ...runningTask, state: "done" as const, progressRevision: 9 },
    });
    expect(viaSnapshot.notices.some((n) => n.code === "copy-task-done")).toBe(true);

    // 本地原本没有的任务(重启恢复/他机)带着终态进来:不是「刚刚结束」,不打扰
    const fresh = reducer(initialState, {
      type: "taskSnapshot",
      task: { ...runningTask, id: "t-other", state: "done" as const },
    });
    expect(fresh.notices.length).toBe(0);
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
    // 缓存里是 running,没跨越终态:不该无中生有地出声
    expect(started.notices).toHaveLength(0);
  });

  /**
   * ★ 拷得很快的卡:终态事件在 startCopy 返回前就到了,被存进 orphanProgress,
   * 再在 taskStarted 里被安静消费掉——taskProgress 那条出声的路径整个被绕过,
   * 全应用对「这张卡能不能格式化」一声不吭。
   */
  it("★ 终态事件早于 taskStarted 返回时,消费缓存也要出声", () => {
    const buffered = reducer(initialState, {
      type: "taskProgress",
      event: progressEvent({ taskId: "t-1", revision: 6, state: "done", copiedBytes: 100 }),
    });
    // 这一刻还不认识这个任务,只能先缓存,没法出声
    expect(buffered.notices).toHaveLength(0);

    const started = reducer(buffered, { type: "taskStarted", task: runningTask });
    expect(started.tasks[0].state).toBe("done");
    const notice = started.notices.find((n) => n.code === "copy-task-done");
    expect(notice).toBeDefined();
    expect(notice?.taskId).toBe("t-1");
    expect(notice?.projectId).toBe(runningTask.projectId);
    expect(notice?.live).toBe(true);
    expect(notice?.message).toMatch(/本卡可格式化/);
  });

  it("★ 同上,失败也要出声(error 级,须确认)", () => {
    const buffered = reducer(initialState, {
      type: "taskProgress",
      event: progressEvent({ taskId: "t-1", revision: 6, state: "failed" }),
    });
    const started = reducer(buffered, { type: "taskStarted", task: runningTask });
    const notice = started.notices.find((n) => n.code === "copy-task-failed");
    expect(notice?.level).toBe("error");
    expect(notice?.taskId).toBe("t-1");
  });

  it("★ 部分拷贝在这条路径上同样说「请勿格式化」", () => {
    const buffered = reducer(initialState, {
      type: "taskProgress",
      event: progressEvent({ taskId: "t-1", revision: 6, state: "done" }),
    });
    const started = reducer(buffered, {
      type: "taskStarted",
      task: { ...runningTask, sourceFolders: ["DCIM/100MSDCF"] },
    });
    expect(
      started.notices.find((n) => n.code === "copy-task-done")?.message,
    ).toMatch(/请勿格式化/);
  });

  it("startCopy 返回时就已是终态(拷完才返回)同样出声", () => {
    const started = reducer(initialState, {
      type: "taskStarted",
      task: { ...runningTask, state: "done" as const },
    });
    expect(started.notices.some((n) => n.code === "copy-task-done")).toBe(true);
  });

  it("正常发起的任务不会平白多出一条完成通知", () => {
    const started = reducer(initialState, { type: "taskStarted", task: runningTask });
    expect(started.notices).toHaveLength(0);
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
        recentProjects: [],
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

describe("作业快照归约", () => {
  const job = {
    id: "job-1",
    kind: "delivery" as const,
    projectId: "p-new",
    state: "running" as const,
    done: 10,
    total: 100,
    bytesDone: 1024,
    revision: 3,
    startedAt: "2026-08-24T10:00:00+08:00",
  };

  it("首次见到的作业直接入列", () => {
    const next = reducer(initialState, { type: "jobProgress", job });
    expect(next.jobs).toHaveLength(1);
    expect(next.jobs[0].done).toBe(10);
  });

  it("revision 前进才更新", () => {
    const seeded = { ...initialState, jobs: [job] };
    const next = reducer(seeded, {
      type: "jobProgress",
      job: { ...job, revision: 4, done: 40 },
    });
    expect(next.jobs[0].done).toBe(40);
  });

  it("乱序/过期事件被丢弃，进度不回退", () => {
    const seeded = { ...initialState, jobs: [{ ...job, revision: 9, done: 90 }] };
    const stale = reducer(seeded, {
      type: "jobProgress",
      job: { ...job, revision: 4, done: 40 },
    });
    expect(stale.jobs[0].done).toBe(90);
    // 同 revision 也不接受（幂等重发不该改状态）
    const same = reducer(seeded, {
      type: "jobProgress",
      job: { ...job, revision: 9, done: 5 },
    });
    expect(same.jobs[0].done).toBe(90);
  });

  it("jobsLoaded 对账同样保单调", () => {
    const seeded = { ...initialState, jobs: [{ ...job, revision: 9, done: 90 }] };
    const next = reducer(seeded, {
      type: "jobsLoaded",
      jobs: [{ ...job, revision: 2, done: 20 }],
    });
    expect(next.jobs[0].done).toBe(90);
  });

  it("jobsLoaded 会补进订阅期间错过的新作业", () => {
    const next = reducer(initialState, { type: "jobsLoaded", jobs: [job] });
    expect(next.jobs).toHaveLength(1);
  });
});

describe("selectDeliveryWorking", () => {
  const base = {
    id: "job-1",
    kind: "delivery" as const,
    projectId: "p-new",
    done: 0,
    total: 10,
    bytesDone: 0,
    revision: 1,
    startedAt: "2026-08-24T10:00:00+08:00",
  };

  it("queued / running 视为进行中", () => {
    for (const state of ["queued", "running"] as const) {
      expect(
        selectDeliveryWorking({
          ...initialState,
          selectedProjectId: "p-new",
          jobs: [{ ...base, state }],
        }),
      ).toBe(true);
    }
  });

  it("终态一律不算进行中", () => {
    for (const state of ["done", "failed", "cancelled"] as const) {
      expect(
        selectDeliveryWorking({
          ...initialState,
          selectedProjectId: "p-new",
          jobs: [{ ...base, state }],
        }),
      ).toBe(false);
    }
  });

  it("别的项目的作业不锁本项目", () => {
    expect(
      selectDeliveryWorking({
        ...initialState,
        selectedProjectId: "p-other",
        jobs: [{ ...base, state: "running" as const }],
      }),
    ).toBe(false);
  });

  it("没有作业（例如应用重启后）= 不锁", () => {
    expect(
      selectDeliveryWorking({ ...initialState, selectedProjectId: "p-new" }),
    ).toBe(false);
  });
});
