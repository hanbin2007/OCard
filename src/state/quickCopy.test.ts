/** 快捷拷卡队列的 reducer 纯测试:入队过滤、去重、拔卡出队、整表替换不变量。 */

import { describe, expect, it } from "vitest";
import { mockVolumes, mockWorkstation } from "../api/mock";
import type { Volume } from "../api/types";
import { initialState, reducer, type AppState } from "./store";

function withVolumes(volumes: Volume[], extra?: Partial<AppState>): AppState {
  return { ...initialState, workstation: mockWorkstation, volumes, ...extra };
}

const removableCard: Volume = {
  id: "/Volumes/CARD-X",
  name: "CARD-X",
  mountPath: "/Volumes/CARD-X",
  capacityBytes: 1,
  usedBytes: 0,
  removable: true,
  isSystem: false,
  matchStatus: "unregistered",
};

describe("volumesInserted 过滤", () => {
  it("非系统卷入队;removable=false 不再是硬过滤(读卡器常被 sysinfo 判错)", () => {
    const fixedReader: Volume = {
      ...removableCard,
      id: "/Volumes/READER",
      mountPath: "/Volumes/READER",
      removable: false,
    };
    const s = withVolumes([removableCard, fixedReader]);
    const next = reducer(s, {
      type: "volumesInserted",
      volumeIds: [removableCard.id, fixedReader.id],
    });
    expect(next.quickCopyQueue).toEqual([removableCard.id, fixedReader.id]);
  });

  it("系统盘、未知 id、NAS 挂载卷都不入队", () => {
    const system: Volume = {
      ...removableCard,
      id: "/",
      mountPath: "/",
      isSystem: true,
    };
    const nasVol: Volume = {
      ...removableCard,
      id: "/Volumes/DIT-NAS",
      mountPath: "/Volumes/DIT-NAS",
    };
    // mockWorkstation.nasRoot 位于 /Volumes/DIT-NAS 之下
    const s = withVolumes([system, nasVol], {
      workstation: { ...mockWorkstation, nasRoot: "/Volumes/DIT-NAS/Projects" },
    });
    const next = reducer(s, {
      type: "volumesInserted",
      volumeIds: [system.id, nasVol.id, "/Volumes/GONE"],
    });
    expect(next.quickCopyQueue).toEqual([]);
  });

  it("重复插入去重:已在队列里的不再入队", () => {
    const s = withVolumes([removableCard], {
      quickCopyQueue: [removableCard.id],
    });
    const next = reducer(s, {
      type: "volumesInserted",
      volumeIds: [removableCard.id],
    });
    expect(next.quickCopyQueue).toEqual([removableCard.id]);
  });
});

describe("队列与卷快照的不变量", () => {
  it("volumesUpdated:被拔走的卷自动出队", () => {
    const s = withVolumes([removableCard], {
      quickCopyQueue: [removableCard.id],
    });
    const next = reducer(s, { type: "volumesUpdated", volumes: [] });
    expect(next.quickCopyQueue).toEqual([]);
  });

  it("bootstrapped 整表替换同样修剪队列(悬空队首会饿死后续卡)", () => {
    const s = withVolumes([removableCard], {
      quickCopyQueue: [removableCard.id, mockVolumes[0].id],
    });
    const next = reducer(s, {
      type: "bootstrapped",
      payload: {
        workstation: mockWorkstation,
        projects: [],
        cameras: [],
        cards: [],
        volumes: mockVolumes,
        tasks: [],
      },
    });
    expect(next.quickCopyQueue).toEqual([mockVolumes[0].id]);
  });

  it("quickCopyResolved 只出队指定卷", () => {
    const s = withVolumes([removableCard], {
      quickCopyQueue: [removableCard.id, "/Volumes/OTHER"],
    });
    const next = reducer(s, {
      type: "quickCopyResolved",
      volumeId: removableCard.id,
    });
    expect(next.quickCopyQueue).toEqual(["/Volumes/OTHER"]);
  });

  it("volumeMatchPatched 只改目标卷,不动其它", () => {
    const other: Volume = {
      ...removableCard,
      id: "/Volumes/OTHER",
      mountPath: "/Volumes/OTHER",
    };
    const s = withVolumes([removableCard, other]);
    const next = reducer(s, {
      type: "volumeMatchPatched",
      volumeId: removableCard.id,
      cardId: "card-1",
    });
    expect(next.volumes[0].matchedCardId).toBe("card-1");
    expect(next.volumes[0].matchStatus).toBe("matched");
    expect(next.volumes[1].matchedCardId).toBeUndefined();
  });
});
