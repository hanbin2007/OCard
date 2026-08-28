/**
 * Mock 数据集。仅供 UI 壳阶段使用；Rust 侧命令就绪后 `src/api/index.ts`
 * 内的函数改为 tauri invoke，本文件即可删除。
 */

import type {
  AuditEventDto,
  CameraReg,
  ArchiveResult,
  CapabilityReport,
  CuratedFlowHint,
  DeliveryStatus,
  FfmpegStatus,
  FinalCutReport,
  TranscodeCapabilities,
  DeliverySummary,
  IndexingStatus,
  SortingAsset,
  SortingCategory,
  TrashEntry,
  CopyFileItem,
  CopyTask,
  Project,
  RenamedFile,
  SourceFolder,
  SourcePlan,
  ProjectCards,
  ProjectSettings,
  StorageCard,
  Volume,
  WorkstationInfo,
} from "./types";

const GB = 1024 ** 3;
const MB = 1024 ** 2;

export const mockWorkstation: WorkstationInfo = {
  machineId: "WS-7C4A21",
  operator: "张涵斌",
  nasRoot: "/Volumes/DIT-NAS/Projects",
  recentProjects: [
    {
      id: "p-2026-0824-sports",
      name: "校运会",
      folderName: "20260824_校运会",
      scenario: "B",
      lastOpenedAt: "2026-08-24T14:35:00+08:00",
    },
    {
      id: "p-2026-0822-launch",
      name: "新品发布会",
      folderName: "20260822_新品发布会",
      scenario: "A",
      lastOpenedAt: "2026-08-22T18:02:00+08:00",
    },
  ],
};

/**
 * 项目级设置（标签库 + 备份目的地预设）。缺省项目返回空设置——
 * 与后端「settings.json 不存在 = 空设置」同语义。
 */
export const mockProjectSettings: Record<string, ProjectSettings> = {
  "p-2026-0824-sports": {
    tags: [
      { name: "开幕式", color: "blue" },
      { name: "田赛", color: "green" },
      { name: "径赛", color: "orange" },
      { name: "颁奖", color: "purple" },
      { name: "花絮", color: "pink" },
    ],
    backupPaths: ["/Volumes/BACKUP-01"],
  },
};

export const mockProjects: Project[] = [
  {
    id: "p-2026-0824-sports",
    name: "校运会",
    date: "20260824",
    folderName: "20260824_校运会",
    scenario: "B",
    categories: ["开幕式", "田赛", "径赛", "颁奖"],
    relativePath: "20260824_校运会",
    status: "copying",
    cardsCopied: 5,
    copyIncomplete: true,
    cardRosterTotal: 6,
    cardRosterDone: 5,
    bytesCopied: 412 * GB,
    assetCount: 8421,
    sortedCount: 3180,
    destinationCount: 2,
    updatedAt: "2026-08-24T14:32:00+08:00",
  },
  {
    id: "p-2026-0822-launch",
    name: "年中发布会",
    date: "20260822",
    folderName: "20260822_年中发布会",
    scenario: "A",
    categories: [],
    relativePath: "20260822_年中发布会",
    status: "sorting",
    cardsCopied: 6,
    copyIncomplete: false,
    bytesCopied: 1.24 * 1024 * GB,
    assetCount: 512,
    sortedCount: 0,
    destinationCount: 2,
    updatedAt: "2026-08-23T19:04:00+08:00",
  },
  {
    id: "p-2026-0818-brand",
    name: "品牌宣传片",
    date: "20260818",
    folderName: "20260818_品牌宣传片",
    scenario: "A",
    categories: [],
    relativePath: "20260818_品牌宣传片",
    status: "delivering",
    cardsCopied: 4,
    copyIncomplete: false,
    bytesCopied: 860 * GB,
    assetCount: 297,
    sortedCount: 0,
    destinationCount: 3,
    updatedAt: "2026-08-21T11:47:00+08:00",
  },
  {
    id: "p-2026-0815-rehearsal",
    name: "开学典礼彩排",
    date: "20260815",
    folderName: "20260815_开学典礼彩排",
    scenario: "B",
    categories: ["主席台", "观众席", "后台"],
    relativePath: "20260815_开学典礼彩排",
    status: "done",
    cardsCopied: 3,
    copyIncomplete: false,
    bytesCopied: 128 * GB,
    assetCount: 2140,
    sortedCount: 2140,
    destinationCount: 2,
    updatedAt: "2026-08-16T09:15:00+08:00",
  },
  {
    id: "p-2026-0810-interview",
    name: "教师节人物采访",
    date: "20260810",
    folderName: "20260810_教师节人物采访",
    scenario: "A",
    categories: [],
    relativePath: "20260810_教师节人物采访",
    status: "draft",
    cardsCopied: 0,
    copyIncomplete: false,
    bytesCopied: 0,
    assetCount: 0,
    sortedCount: 0,
    destinationCount: 2,
    updatedAt: "2026-08-10T08:02:00+08:00",
  },
];

export const mockCameras: CameraReg[] = [
  {
    id: "cam-ronin4d",
    model: "DJI Ronin 4D",
    position: "B",
    operatorAlias: "ZS",
    code: "DJIRonin4D_B_ZS",
    note: "主机位，8K ProRes RAW",
    createdAt: "2026-08-01T09:00:00+08:00",
  },
  {
    id: "cam-a7m4",
    model: "Sony A7M4",
    position: "A",
    operatorAlias: "LM",
    code: "SonyA7M4_A_LM",
    note: "跟拍，S-Log3",
    createdAt: "2026-08-01T09:04:00+08:00",
  },
  {
    id: "cam-r5c",
    model: "Canon R5C",
    position: "C",
    operatorAlias: "WH",
    code: "CanonR5C_C_WH",
    note: "特写机位",
    createdAt: "2026-08-01T09:08:00+08:00",
  },
  {
    id: "cam-mavic3",
    model: "DJI Mavic 3 Pro",
    position: "D",
    operatorAlias: "XY",
    code: "DJIMavic3Pro_D_XY",
    note: "航拍",
    createdAt: "2026-08-03T13:20:00+08:00",
  },
  {
    id: "cam-z9",
    model: "Nikon Z9",
    position: "E",
    operatorAlias: "CQ",
    code: "NikonZ9_E_CQ",
    note: "平面摄影，工况 B 主力",
    createdAt: "2026-08-05T10:41:00+08:00",
  },
];

export const mockStorageCards: StorageCard[] = [
  {
    id: "card-cfe-01",
    label: "CFE-01",
    cameraId: "cam-ronin4d",
    capacityBytes: 1024 * GB,
    serial: "SN-9F31A22C",
    createdAt: "2026-08-01T09:10:00+08:00",
  },
  {
    id: "card-cfe-02",
    label: "CFE-02",
    cameraId: "cam-ronin4d",
    capacityBytes: 1024 * GB,
    serial: "SN-9F31A2D0",
    createdAt: "2026-08-01T09:11:00+08:00",
  },
  {
    id: "card-sd-03",
    label: "SD-03",
    cameraId: "cam-a7m4",
    capacityBytes: 512 * GB,
    serial: "SN-4C08B117",
    createdAt: "2026-08-01T09:12:00+08:00",
  },
  {
    id: "card-cf-04",
    label: "CF-04",
    cameraId: "cam-r5c",
    capacityBytes: 512 * GB,
    serial: "SN-77D2E401",
    createdAt: "2026-08-01T09:14:00+08:00",
  },
  {
    id: "card-sd-05",
    label: "SD-05",
    cameraId: "cam-mavic3",
    capacityBytes: 256 * GB,
    createdAt: "2026-08-03T13:22:00+08:00",
  },
  {
    id: "card-sd-06",
    label: "SD-06",
    cameraId: "cam-z9",
    capacityBytes: 512 * GB,
    serial: "SN-11A9C730",
    createdAt: "2026-08-05T10:45:00+08:00",
  },
];

/** 项目用卡清单(x/y 真分母)。其余项目故意不配置,覆盖「未配置」回退 */
export const mockProjectCards: Record<string, ProjectCards> = {
  "p-2026-0824-sports": {
    cardIds: [
      "card-cfe-01",
      "card-cfe-02",
      "card-sd-03",
      "card-cf-04",
      "card-sd-05",
      "card-sd-06",
    ],
    copiedCardIds: [
      "card-cfe-01",
      "card-cfe-02",
      "card-sd-03",
      "card-cf-04",
      "card-sd-05",
    ],
  },
};

export const mockVolumes: Volume[] = [
  {
    id: "vol-untitled-1",
    name: "SONY_A7M4",
    mountPath: "/Volumes/SONY_A7M4",
    capacityBytes: 512 * GB,
    usedBytes: 386 * GB,
    removable: true,
    isSystem: false,
    matchedCardId: "card-sd-03",
    matchStatus: "matched",
  },
  {
    id: "vol-untitled-2",
    name: "NIKON_Z9",
    mountPath: "/Volumes/NIKON_Z9",
    capacityBytes: 512 * GB,
    usedBytes: 214 * GB,
    removable: true,
    isSystem: false,
    matchedCardId: "card-sd-06",
    matchStatus: "matched",
  },
  {
    id: "vol-untitled-3",
    name: "NO NAME",
    mountPath: "/Volumes/NO NAME",
    capacityBytes: 256 * GB,
    usedBytes: 91 * GB,
    removable: true,
    isSystem: false,
    matchStatus: "unregistered",
  },
  {
    id: "vol-system",
    name: "Macintosh HD",
    mountPath: "/",
    capacityBytes: 1024 * GB,
    usedBytes: 620 * GB,
    removable: false,
    isSystem: true,
  },
];

function file(
  index: number,
  name: string,
  sizeBytes: number,
  status: CopyFileItem["status"],
  hash?: string,
  error?: string,
): CopyFileItem {
  return {
    id: `f-${String(index).padStart(3, "0")}`,
    path: `DCIM/100MSDCF/${name}`,
    name,
    sizeBytes,
    status,
    hash,
    error,
  };
}

const taskFiles: CopyFileItem[] = [
  file(1, "C0001.MP4", 12.4 * GB, "verified", "8f2a1c04b7d9e355"),
  file(2, "C0002.MP4", 9.8 * GB, "verified", "1d77b0e5a2c46f18"),
  file(3, "C0003.MP4", 14.1 * GB, "verified", "c3e90a4471bd2286"),
  file(4, "C0004.MP4", 11.2 * GB, "verified", "6b5f28d1930ea74c"),
  file(5, "C0005.MP4", 13.7 * GB, "copied", "a04c7e2b81f5d963"),
  file(6, "C0006.MP4", 10.9 * GB, "copied", "77ba31c0e6482dd1"),
  file(
    7,
    "C0007.MP4",
    12.0 * GB,
    "failed",
    undefined,
    "回读校验不一致，目标 NAS 写入中断",
  ),
  file(8, "C0008.MP4", 15.3 * GB, "pending"),
  file(9, "C0009.MP4", 8.6 * GB, "pending"),
  file(10, "C0010.MP4", 11.8 * GB, "pending"),
  file(11, "M4ROOT_PROXY_0001.MP4", 486 * MB, "pending"),
  file(12, "AVCHD_INDEX.BDM", 24 * MB, "pending"),
];

/** 源卷探查的 mock：假定卡内素材拍摄于当天上午 */
export const mockInspection = {
  earliestShotAt: "2026-08-24T08:41:00+08:00",
  latestShotAt: "2026-08-24T11:07:00+08:00",
  fileCount: 12,
};

/* ---------- 源「按文件夹多选」的 mock（契约 2026-08-28） ---------- */

/**
 * 卡内目录的 mock 底稿：连**文件名**一起给，plan 才能真算出重名。
 *
 * 刻意造出跨目录重名（三处都有 C0001.MP4）——「加前缀 = 系统替用户改了
 * 文件名」是本次改动最需要被看见的降级，浏览器预览与测试都必须能复现它。
 */
interface MockSourceEntry {
  relPath: string;
  files: Array<{ name: string; sizeBytes: number }>;
}

const MOCK_SOURCE_TREE: MockSourceEntry[] = [
  // 卷根只有一个相机写的索引文件，但它有子目录，按契约要列出来
  { relPath: "", files: [{ name: "AVCHD_INDEX.BDM", sizeBytes: 24 * MB }] },
  { relPath: "DCIM", files: [] },
  {
    relPath: "DCIM/100MSDCF",
    files: [
      { name: "C0001.MP4", sizeBytes: 12.4 * GB },
      { name: "C0002.MP4", sizeBytes: 9.8 * GB },
      { name: "C0003.MP4", sizeBytes: 14.1 * GB },
    ],
  },
  {
    relPath: "DCIM/101MSDCF",
    files: [
      { name: "C0001.MP4", sizeBytes: 11.2 * GB },
      { name: "C0002.MP4", sizeBytes: 13.7 * GB },
      { name: "C0009.MP4", sizeBytes: 8.6 * GB },
    ],
  },
  { relPath: "PRIVATE", files: [] },
  { relPath: "PRIVATE/M4ROOT", files: [] },
  {
    relPath: "PRIVATE/M4ROOT/CLIP",
    files: [
      { name: "C0001.MP4", sizeBytes: 10.9 * GB },
      // 与 100MSDCF 再撞一个：三个目录一起勾时改名清单会超过折叠阈值，
      // 「展开查看全部 N 条」这条路径在浏览器预览里也走得到
      { name: "C0003.MP4", sizeBytes: 7.7 * GB },
      { name: "C0007.MP4", sizeBytes: 12.0 * GB },
    ],
  },
  {
    relPath: "PRIVATE/M4ROOT/SUB",
    files: [{ name: "C0001S01.MP4", sizeBytes: 486 * MB }],
  },
];

/** 某条目是否还有子目录（子目录自身另有独立条目） */
function hasSubfolders(relPath: string): boolean {
  const prefix = relPath === "" ? "" : `${relPath}/`;
  return MOCK_SOURCE_TREE.some(
    (e) =>
      e.relPath !== relPath &&
      e.relPath.startsWith(prefix) &&
      !e.relPath.slice(prefix.length).includes("/"),
  );
}

/** `list_source_folders` 的浏览器/测试回退 */
export function mockSourceFolders(_volumeId: string): SourceFolder[] {
  return MOCK_SOURCE_TREE
    // 契约：只列「含直接子文件」或「含子目录」的，空目录不列
    .filter((e) => e.files.length > 0 || hasSubfolders(e.relPath))
    .map((e) => ({
      relPath: e.relPath,
      fileCount: e.files.length,
      totalBytes: e.files.reduce((sum, f) => sum + f.sizeBytes, 0),
      hasSubfolders: hasSubfolders(e.relPath),
    }))
    // 契约：relPath 字典序，"" 恒排第一
    .sort((a, b) =>
      a.relPath === "" ? -1 : b.relPath === "" ? 1 : a.relPath.localeCompare(b.relPath),
    );
}

/**
 * `plan_source_selection` 的浏览器/测试回退。
 *
 * 与后端同一套规则：扁平化后同名的那一组，从最深一级目录名起逐级向上
 * 追加前缀，直到组内唯一（最短可区分前缀）；不冲突的名字一个字都不改。
 * `folders` 为空 = 整卷，整卷保留原层级、不会撞名，故改名清单恒为空。
 */
export function mockSourcePlan(_volumeId: string, folders: string[]): SourcePlan {
  if (folders.length === 0) {
    const all = MOCK_SOURCE_TREE.flatMap((e) => e.files);
    return {
      fileCount: all.length,
      totalBytes: all.reduce((sum, f) => sum + f.sizeBytes, 0),
      renamedFiles: [],
    };
  }

  const picked = MOCK_SOURCE_TREE.filter((e) => folders.includes(e.relPath)).flatMap(
    (e) => e.files.map((f) => ({ dir: e.relPath, name: f.name, sizeBytes: f.sizeBytes })),
  );

  const byName = new Map<string, typeof picked>();
  for (const f of picked) {
    const bucket = byName.get(f.name);
    if (bucket) bucket.push(f);
    else byName.set(f.name, [f]);
  }

  const renamedFiles: RenamedFile[] = [];
  for (const [name, group] of byName) {
    if (group.length < 2) continue;
    const segments = group.map((f) => (f.dir === "" ? [] : f.dir.split("/")));
    // 逐级向上加，直到组内唯一；到卷根仍撞名就用完整路径（mock 里到不了）
    const depth = Math.max(...segments.map((s) => s.length));
    let level = 1;
    for (; level <= depth; level += 1) {
      const names = segments.map((s) => [...s.slice(-level), name].join("_"));
      if (new Set(names).size === names.length) break;
    }
    group.forEach((f, i) => {
      renamedFiles.push({
        sourceRel: f.dir === "" ? name : `${f.dir}/${name}`,
        targetRel: [...segments[i].slice(-level), name].join("_"),
      });
    });
  }

  return {
    fileCount: picked.length,
    totalBytes: picked.reduce((sum, f) => sum + f.sizeBytes, 0),
    renamedFiles,
  };
}

export const mockCopyTasks: CopyTask[] = [
  {
    id: "task-0824-a7m4",
    projectId: "p-2026-0824-sports",
    volumeId: "vol-untitled-1",
    volumeName: "SONY_A7M4",
    cameraId: "cam-a7m4",
    cameraCode: "SonyA7M4_A_LM",
    note: "田赛、4×100决赛",
    tags: ["田赛", "4×100决赛"],
    targetFolder: "0824上午_SonyA7M4_A_LM",
    destinations: [
      {
        id: "d-nas",
        kind: "nas",
        path: "/Volumes/DIT-NAS/Projects/20260824_校运会/1. 待分类",
        state: "writing",
        writtenBytes: 71.4 * GB,
      },
      {
        id: "d-ext",
        kind: "external",
        path: "/Volumes/BACKUP-T7/20260824_校运会/1. 待分类",
        state: "writing",
        writtenBytes: 69.8 * GB,
      },
    ],
    files: taskFiles,
    totalBytes: taskFiles.reduce((sum, f) => sum + f.sizeBytes, 0),
    copiedBytes: 71.4 * GB,
    speedBytesPerSec: 268 * MB,
    state: "running",
    operator: "张涵斌",
    startedAt: "2026-08-24T14:06:00+08:00",
  },
  {
    id: "task-0824-z9",
    projectId: "p-2026-0824-sports",
    volumeId: "vol-untitled-2",
    volumeName: "NIKON_Z9",
    cameraId: "cam-z9",
    cameraCode: "NikonZ9_E_CQ",
    note: "开幕式",
    tags: ["开幕式"],
    targetFolder: "0824上午_NikonZ9_E_CQ",
    destinations: [
      {
        id: "d-nas-2",
        kind: "nas",
        path: "/Volumes/DIT-NAS/Projects/20260824_校运会/1. 待分类",
        state: "done",
        writtenBytes: 214 * GB,
      },
      {
        id: "d-ext-2",
        kind: "external",
        path: "/Volumes/BACKUP-T7/20260824_校运会/1. 待分类",
        state: "done",
        writtenBytes: 214 * GB,
      },
    ],
    files: [
      file(1, "DSC_0001.NEF", 52 * MB, "verified", "b71e0c9a34d8f215"),
      file(2, "DSC_0002.NEF", 51 * MB, "verified", "e2c4a7150fb93d68"),
      file(3, "DSC_0003.NEF", 54 * MB, "verified", "9a03d81c5e2b47f0"),
      file(4, "DSC_0004.NEF", 49 * MB, "verified", "4f8b26e07ac1d539"),
    ],
    totalBytes: 214 * GB,
    copiedBytes: 214 * GB,
    speedBytesPerSec: 0,
    state: "done",
    operator: "李默",
    startedAt: "2026-08-24T10:22:00+08:00",
    finishedAt: "2026-08-24T11:35:00+08:00",
  },
];

// 全量状态计数(评审 2.5):真实后端在快照/进度事件里聚合,mock 从 files 现算
for (const t of mockCopyTasks) {
  const counts = { pending: 0, copied: 0, verified: 0, failed: 0 };
  for (const f of t.files) counts[f.status] += 1;
  t.statusCounts = counts;
}

/* ------------------------------------------------------------------ *
 * 分类工作台 mock
 * ------------------------------------------------------------------ */

/** 生成一张纯色缩略图（data URL）；真实实现由 media_indexer 产出 JPEG base64 */
function mockThumb(hue: number): string {
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="8" height="6">` +
    `<rect width="8" height="6" fill="hsl(${hue} 30% 62%)"/></svg>`;
  return `data:image/svg+xml;base64,${btoa(svg)}`;
}

const SORTING_TOTAL = 1240;

/** 千张级素材：用来压虚拟滚动，不是摆设 */
export const mockPendingAssets: SortingAsset[] = Array.from(
  { length: SORTING_TOTAL },
  (_, i) => {
    const index = i + 1;
    const isRaw = index % 7 === 0;
    const isVideo = index % 23 === 0;
    const shot = new Date(Date.UTC(2026, 7, 24, 1, 0, 0) + i * 4000);
    return {
      id: `1. 待分类/0824上午_NikonZ9_E_CQ/DSC_${String(index).padStart(5, "0")}.${
        isVideo ? "MP4" : isRaw ? "NEF" : "JPG"
      }`,
      fileName: `DSC_${String(index).padStart(5, "0")}.${
        isVideo ? "MP4" : isRaw ? "NEF" : "JPG"
      }`,
      sizeBytes: (isVideo ? 240 : isRaw ? 52 : 9) * 1024 * 1024,
      shotAt: shot.toISOString(),
      // 每 11 张有一张取不到 EXIF，走 mtime 回退
      shotAtFallback: index % 11 === 0,
      // 每 13 张有一张还没索引出缩略图，界面要显示占位
      // 每 13 张有一张还没索引出缩略图：thumbnail 为空且 thumbReady=false
      thumbnail: index % 13 === 0 ? undefined : mockThumb((i * 37) % 360),
      thumbReady: index % 13 !== 0,
      kind: isVideo ? "video" : isRaw ? "raw" : "photo",
      // 连拍组：放在列表靠后位置（40–44），避免打乱前若干格的单件语义
      groupId: i >= 40 && i <= 44 ? "burst-1" : undefined,
      // 分析跑过后才有 judgement；这里给几件带上，用于角标与「建议保留」
      judgement:
        i >= 40 && i <= 44
          ? {
              groupId: "burst-1",
              score: i === 42 ? 86 : 31,
              // 组里混一张 null：人脸检测不可用与「检出 0 张」必须能分辨
              faces: i === 43 ? null : i === 42 ? 3 : 2,
              blurry: i === 41,
              overExposed: i === 43,
              underExposed: false,
              suggestedKeep: i === 42,
            }
          : i === 5
            ? {
                score: 22,
                // 确实检出 0 张脸——与下面的 null 是两回事
                faces: 0,
                blurry: true,
                overExposed: false,
                underExposed: true,
                suggestedKeep: false,
              }
            : i === 7
              ? {
                  // 客观指标算出来了，但这轮人脸检测不可用（模型缺失/推理失败）：
                  // faces = null 是「不知道」，界面不许说成「没有人脸」
                  score: 58,
                  faces: null,
                  blurry: false,
                  overExposed: true,
                  underExposed: false,
                  suggestedKeep: false,
                }
              : undefined,
    } satisfies SortingAsset;
  },
);

export const mockCategories: SortingCategory[] = [
  {
    id: "inbox",
    name: "待分类",
    folderName: "1. 待分类",
    kind: "inbox",
    count: SORTING_TOTAL,
  },
  { id: "cat-1", name: "开幕式", folderName: "2. 开幕式", kind: "custom", count: 312, hotkey: 1 },
  { id: "cat-2", name: "田赛", folderName: "3. 田赛", kind: "custom", count: 208, hotkey: 2 },
  { id: "cat-3", name: "径赛", folderName: "4. 径赛", kind: "custom", count: 174, hotkey: 3 },
  { id: "cat-4", name: "颁奖", folderName: "5. 颁奖", kind: "custom", count: 96, hotkey: 4 },
  { id: "curated", name: "精选", folderName: "6. 精选", kind: "curated", count: 41 },
  { id: "other", name: "其他", folderName: "7. 其他", kind: "other", count: 63 },
];

export const mockTrash: TrashEntry[] = [
  {
    id: ".ocard/trash/DSC_00412.JPG",
    fileName: "DSC_00412.JPG",
    sizeBytes: 9 * 1024 * 1024,
    originalPath: "1. 待分类/0824上午_NikonZ9_E_CQ/DSC_00412.JPG",
    trashedAt: "2026-08-24T13:20:00+08:00",
    operator: "张涵斌",
  },
  {
    id: ".ocard/trash/DSC_00587.JPG",
    fileName: "DSC_00587.JPG",
    sizeBytes: 9 * 1024 * 1024,
    originalPath: "1. 待分类/0824上午_NikonZ9_E_CQ/DSC_00587.JPG",
    trashedAt: "2026-08-24T13:22:00+08:00",
    operator: "张涵斌",
  },
];

export const mockIndexing: IndexingStatus = {
  projectId: "p-2026-0824-sports",
  indexed: 1144,
  total: SORTING_TOTAL,
  running: true,
  failed: 3,
  missing: 2,
  round: 1,
};

/** 交付打包 mock：两个半天包（fileCount/bytes 为包内实况总量）+ 一条同名冲突 */
export const mockDelivery: DeliverySummary = {
  packages: [
    { name: "0824上午", fileCount: 412, bytes: 38 * 1024 ** 3 },
    { name: "0824下午", fileCount: 357, bytes: 31 * 1024 ** 3 },
  ],
  totalFiles: 769,
  totalBytes: 69 * 1024 ** 3,
  alreadyDelivered: 24,
  failures: [
    {
      assetId: "6. 精选/已修/DSC_00931.JPG",
      message: "包内已有同名文件但内容不同，未交付，请人工核对",
      kind: "name-collision",
    },
  ],
  deliveryPath: "/Volumes/DIT-NAS/Projects/20260824_校运会/交付/20260824",
};

/* ------------------------------------------------------------------ *
 * 转码 mock
 * ------------------------------------------------------------------ */

const mockFfmpegInfo = {
  version: "7.1",
  ffmpegPath: "/Applications/OCard.app/Contents/Resources/ffmpeg",
  ffprobePath: "/Applications/OCard.app/Contents/Resources/ffprobe",
};

export const mockFfmpegStatus: FfmpegStatus = {
  status: "ready",
  info: mockFfmpegInfo,
};

const readyReport: CapabilityReport = {
  ffmpeg: mockFfmpegInfo,
  winners: {
    "h264-encode": "h264_videotoolbox",
    "hevc-encode": "hevc_videotoolbox",
    "hevc-10bit": "hevc_videotoolbox",
  },
  probes: [
    ["h264-encode", "h264_videotoolbox", true],
    ["h264-encode", "libx264", true],
    ["hevc-encode", "hevc_videotoolbox", true],
    ["hevc-10bit", "hevc_nvenc", false],
    ["hevc-10bit", "hevc_videotoolbox", true],
  ],
  probedAt: "2026-08-24T09:00:00+08:00",
};

let capabilityProbing = false;

/** mock：refresh 会进入一次 probing，再次调用才 ready——用来验证轮询终止条件 */
export function mockCapabilities(refresh: boolean): TranscodeCapabilities {
  if (refresh) {
    capabilityProbing = true;
    return { status: "probing" };
  }
  if (capabilityProbing) {
    capabilityProbing = false;
    return { status: "ready", report: readyReport };
  }
  return { status: "ready", report: readyReport };
}

export const mockDiagnostics: Record<string, unknown> = {
  app: "OCard",
  platform: "darwin",
  ffmpeg: mockFfmpegInfo,
  winners: readyReport.winners,
  probes: readyReport.probes,
  probedAt: readyReport.probedAt,
};

/* ------------------------------------------------------------------ *
 * W8 mock
 * ------------------------------------------------------------------ */

export const mockFinalCuts: FinalCutReport = {
  items: [
    {
      fileName: "20260822_年中发布会_4K_官网_v3.mp4",
      valid: true,
      issues: [],
      class: "成品",
      parsed: { date: "20260822", title: "年中发布会", resolution: "4K" },
    },
    {
      fileName: "发布会终版.mp4",
      valid: false,
      issues: ["缺少日期前缀", "缺少分辨率与用途", "缺少版本号"],
    },
    {
      fileName: "20260822_年中发布会_4K_官网_v2.mp4",
      valid: true,
      issues: [],
      class: "成品",
      resolutionMismatch: "命名声明 4K，实际探测为 1280x720",
    },
    {
      fileName: "20260822_年中发布会_720p_预览_v1.mov",
      valid: true,
      issues: [],
      class: "预览版",
      uncheckable: "ffprobe 无法读取该容器，未校验分辨率",
    },
  ],
  warnings: ["「6. 成片」下有 2 个非视频文件已跳过"],
};

export const mockFlowHints: CuratedFlowHint[] = [
  {
    todoAssetId: "6. 精选/待修/DSC_00311.NEF",
    doneFileName: "DSC_00311.jpg",
  },
  {
    todoAssetId: "6. 精选/待修/DSC_00476.NEF",
    doneFileName: "DSC_00476.jpg",
  },
];

export const mockDeliveryStatus: DeliveryStatus = {
  uploaded: false,
};

/**
 * 项目级审计日志（PRD §5.10）。
 *
 * 一条真实工作日的时间线：本机（WS-7C4A21 / 张涵斌）与他机
 * （WS-1F93B0 / 李萌）交替作业——审计日志的用处正是"谁在哪台机上动了什么"，
 * 全是本机记录就演不出双岗互相监督这件事。
 *
 * 刻意留了两处"不好看"的数据，它们不是疏漏而是断言：
 *   ① 有一条 `data: null`（旧版本补录的事件没带明细）；
 *   ② 有一条 kind 是前端尚未收录的值（后端随时会加新 kind）。
 * 界面对这两条都必须照常渲染——不认识不等于可以丢掉。
 *
 * 按 ts 倒序（最新在前），与后端约定一致。
 */
export const mockAuditLog: AuditEventDto[] = [
  {
    ts: "2026-08-24T17:05:59+08:00",
    machine: "WS-7C4A21",
    operator: "张涵斌",
    // 前端尚未收录的 kind：必须回落成体面呈现，而不是消失
    kind: "project_note_added",
    data: { note: "颁奖环节补拍素材明天上午补入", scope: "project" },
  },
  {
    ts: "2026-08-24T16:38:03+08:00",
    machine: "WS-1F93B0",
    operator: "李萌",
    kind: "transcode_cancelled",
    data: {
      mode: "archive",
      converted: 21,
      total: 64,
      reason: "操作人在归档过半时取消",
      usedEncoder: "hevc_videotoolbox",
    },
  },
  {
    ts: "2026-08-24T16:20:11+08:00",
    machine: "WS-1F93B0",
    operator: "李萌",
    kind: "transcode_started",
    data: {
      mode: "archive",
      tier: "balanced",
      total: 64,
      encoder: "hevc_videotoolbox",
      outputDir: "/Volumes/ARCHIVE-2026/20260824_校运会",
    },
  },
  {
    ts: "2026-08-24T15:44:26+08:00",
    machine: "WS-7C4A21",
    operator: "张涵斌",
    kind: "delivery_built",
    data: {
      packages: 6,
      files: 769,
      totalBytes: 84 * GB,
      outputDir: "5. 交付",
      durationSec: 412,
    },
  },
  {
    ts: "2026-08-24T15:10:00+08:00",
    machine: "WS-7C4A21",
    operator: "张涵斌",
    kind: "delivery_cancelled",
    data: {
      packages: 2,
      reason: "NAS 断连，已按实况写清单",
      totalBytes: 21 * GB,
    },
  },
  {
    ts: "2026-08-24T14:32:40+08:00",
    machine: "WS-7C4A21",
    operator: "张涵斌",
    kind: "trash_emptied",
    data: { removed: 33, failed: 0, freedBytes: 12.4 * GB },
  },
  {
    ts: "2026-08-24T14:07:12+08:00",
    machine: "WS-7C4A21",
    operator: "张涵斌",
    kind: "assets_restored",
    data: { succeeded: 4, failed: 0 },
  },
  {
    ts: "2026-08-24T14:02:56+08:00",
    machine: "WS-7C4A21",
    operator: "张涵斌",
    kind: "assets_trashed",
    data: { count: 37, reason: "重复与糊片" },
  },
  {
    ts: "2026-08-24T13:52:30+08:00",
    machine: "WS-1F93B0",
    operator: "李萌",
    kind: "assets_moved",
    // 旧版本补录的事件没带明细：界面只显示时间/事件/人，绝不能因此报错
    data: null,
  },
  {
    ts: "2026-08-24T13:31:08+08:00",
    machine: "WS-1F93B0",
    operator: "李萌",
    kind: "assets_curated",
    data: { succeeded: 86, failed: 0, categoryName: "精选/待修" },
  },
  {
    ts: "2026-08-24T13:05:44+08:00",
    machine: "WS-1F93B0",
    operator: "李萌",
    kind: "assets_moved",
    data: { count: 240, categoryName: "开幕式" },
  },
  {
    ts: "2026-08-24T12:03:19+08:00",
    machine: "WS-7C4A21",
    operator: "张涵斌",
    kind: "transcode_completed",
    data: {
      mode: "proxy",
      converted: 127,
      failed: 1,
      alreadyTranscoded: 12,
      encoder: "h264_videotoolbox",
      outputDir: "3. 代理",
      durationSec: 2594,
    },
  },
  {
    ts: "2026-08-24T11:47:52+08:00",
    machine: "WS-7C4A21",
    operator: "张涵斌",
    kind: "transcode_failed",
    data: {
      rel: "2. 原始素材/20260824_DJIRonin4D_B_ZS/DJI_0602.MOV",
      message: "ffmpeg 退出码 1：unsupported pixel format yuv422p10le",
      encoder: "h264_videotoolbox",
    },
  },
  {
    ts: "2026-08-24T11:20:05+08:00",
    machine: "WS-7C4A21",
    operator: "张涵斌",
    kind: "transcode_started",
    data: { mode: "proxy", total: 128, encoder: "h264_videotoolbox" },
  },
  {
    ts: "2026-08-24T10:52:31+08:00",
    machine: "WS-1F93B0",
    operator: "李萌",
    kind: "copy_completed",
    data: {
      succeeded: 962,
      failed: 0,
      totalBytes: 118 * GB,
      durationSec: 2241,
      verified: true,
    },
  },
  {
    ts: "2026-08-24T10:15:10+08:00",
    machine: "WS-1F93B0",
    operator: "李萌",
    kind: "copy_started",
    data: {
      volumeName: "SD-03",
      targetFolder: "上午_A7M4_A_LM",
      fileCount: 962,
      totalBytes: 118 * GB,
      destinations: 2,
    },
  },
  {
    ts: "2026-08-24T09:58:47+08:00",
    machine: "WS-7C4A21",
    operator: "张涵斌",
    kind: "copy_completed",
    data: {
      succeeded: 1283,
      failed: 1,
      totalBytes: 411.6 * GB,
      durationSec: 2804,
      verified: true,
    },
  },
  {
    ts: "2026-08-24T09:41:22+08:00",
    machine: "WS-7C4A21",
    operator: "张涵斌",
    kind: "copy_file_failed",
    data: {
      rel: "DCIM/100MEDIA/DJI_0421.MOV",
      message: "读取超时：源卡 I/O 错误",
      attempt: 2,
    },
  },
  {
    ts: "2026-08-24T09:12:03+08:00",
    machine: "WS-7C4A21",
    operator: "张涵斌",
    kind: "copy_started",
    data: {
      volumeName: "CFE-01",
      targetFolder: "上午_DJIRonin4D_B_ZS",
      fileCount: 1284,
      totalBytes: 412 * GB,
      destinations: 2,
    },
  },
];

/** 归档转码 mock 结果 */
export const mockArchiveResult: ArchiveResult = {
  mode: "archive",
  converted: 38,
  alreadyArchived: 6,
  failures: [
    { rel: "2. 原始素材/20260822_A7M4_A_LM/C0044.MP4", message: "写入目标磁盘空间不足" },
  ],
  usedEncoder: "hevc_videotoolbox",
  outputDir: "/Volumes/ARCHIVE-2026/20260822_年中发布会",
};
