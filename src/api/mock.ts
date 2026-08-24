/**
 * Mock 数据集。仅供 UI 壳阶段使用；Rust 侧命令就绪后 `src/api/index.ts`
 * 内的函数改为 tauri invoke，本文件即可删除。
 */

import type {
  CameraReg,
  CapabilityReport,
  FfmpegStatus,
  TranscodeCapabilities,
  DeliverySummary,
  IndexingStatus,
  SortingAsset,
  SortingCategory,
  TrashEntry,
  CopyFileItem,
  CopyTask,
  Project,
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
    cardsTotal: 8,
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
    cardsTotal: 6,
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
    cardsTotal: 4,
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
    cardsTotal: 3,
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
    cardsTotal: 2,
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

export const mockVolumes: Volume[] = [
  {
    id: "vol-untitled-1",
    name: "SONY_A7M4",
    mountPath: "/Volumes/SONY_A7M4",
    capacityBytes: 512 * GB,
    usedBytes: 386 * GB,
    removable: true,
    matchedCardId: "card-sd-03",
  },
  {
    id: "vol-untitled-2",
    name: "NIKON_Z9",
    mountPath: "/Volumes/NIKON_Z9",
    capacityBytes: 512 * GB,
    usedBytes: 214 * GB,
    removable: true,
    matchedCardId: "card-sd-06",
  },
  {
    id: "vol-untitled-3",
    name: "NO NAME",
    mountPath: "/Volumes/NO NAME",
    capacityBytes: 256 * GB,
    usedBytes: 91 * GB,
    removable: true,
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

export const mockCopyTasks: CopyTask[] = [
  {
    id: "task-0824-a7m4",
    projectId: "p-2026-0824-sports",
    volumeId: "vol-untitled-1",
    volumeName: "SONY_A7M4",
    cameraId: "cam-a7m4",
    cameraCode: "SonyA7M4_A_LM",
    note: "上午田赛，含 4×100 决赛全程",
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
    note: "开幕式方阵入场",
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
      // groupId 现阶段后端恒为空，连拍分组归 M3；groupBurst 已兼容缺省值
      groupId: undefined,
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
