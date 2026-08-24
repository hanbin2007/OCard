/**
 * 表单校验（新建项目向导、设备登记）。纯函数，返回逐字段错误，便于单测。
 */

import type { DestinationKind, NewCameraInput, NewProjectInput } from "../api/types";
import {
  hasIllegalChars,
  isReservedName,
  isValidAlias,
  isValidCompactDate,
  isValidPosition,
  normalizeKey,
  normalizePathKey,
  sanitizeSegment,
} from "./naming";

export const PROJECT_NAME_MAX = 40;
export const CATEGORY_NAME_MAX = 16;
export const CATEGORY_MAX_COUNT = 20;

/**
 * 工况 B 的固定夹名。自定义分类不能叫这些，也不能以它们结尾——
 * 后端按「序号 + 名字」拼夹名，重名会和固定夹撞在一起。
 */
export const RESERVED_CATEGORY_NAMES = ["待分类", "精选", "其他"];

/** 是否与固定夹名冲突（相等或以其结尾） */
export function isReservedCategoryName(raw: string): boolean {
  const clean = sanitizeSegment(raw).replace(/\s+/g, "");
  if (!clean) return false;
  return RESERVED_CATEGORY_NAMES.some(
    (reserved) => clean === reserved || clean.endsWith(reserved),
  );
}

export interface NewProjectErrors {
  date?: string;
  name?: string;
  categories?: string;
  /** 分类逐项错误，key 为下标 */
  categoryAt?: Record<number, string>;
}

export interface ValidationResult<E> {
  valid: boolean;
  errors: E;
}

/** 新建项目向导校验（PRD §5.2） */
export function validateNewProject(
  input: NewProjectInput,
): ValidationResult<NewProjectErrors> {
  const errors: NewProjectErrors = {};

  if (!input.date.trim()) {
    errors.date = "请选择拍摄日期";
  } else if (!isValidCompactDate(input.date)) {
    errors.date = "日期格式应为 YYYYMMDD，且必须是真实存在的日期";
  }

  const name = input.name.trim();
  if (!name) {
    errors.name = "请填写项目名";
  } else if (hasIllegalChars(input.name)) {
    errors.name = '项目名不能包含 \\ / : * ? " < > | 等字符';
  } else if (sanitizeSegment(name).length === 0) {
    errors.name = "项目名不能只由空白或句点组成";
  } else if (name.length > PROJECT_NAME_MAX) {
    errors.name = `项目名不超过 ${PROJECT_NAME_MAX} 个字符`;
  } else if (isReservedName(name)) {
    errors.name = "该名称是 Windows 保留设备名，换一个";
  }

  if (input.scenario === "B") {
    const categoryAt: Record<number, string> = {};
    const seen = new Map<string, number>();

    input.categories.forEach((raw, index) => {
      const clean = sanitizeSegment(raw);
      if (!clean) {
        categoryAt[index] = "分类名不能为空";
        return;
      }
      if (hasIllegalChars(raw)) {
        categoryAt[index] = "分类名含非法字符";
        return;
      }
      if (clean.length > CATEGORY_NAME_MAX) {
        categoryAt[index] = `分类名不超过 ${CATEGORY_NAME_MAX} 个字符`;
        return;
      }
      if (isReservedName(clean)) {
        categoryAt[index] = "该名称是 Windows 保留设备名";
        return;
      }
      if (isReservedCategoryName(clean)) {
        categoryAt[index] =
          "不能叫「待分类 / 精选 / 其他」，也不能以它们结尾（会与固定夹重名）";
        return;
      }
      // 用规范化键比对：大小写与空格差异在多数文件系统上仍然是同一个夹
      const key = normalizeKey(raw);
      const prev = seen.get(key);
      if (prev !== undefined) {
        categoryAt[index] = "分类名重复";
        return;
      }
      seen.set(key, index);
    });

    if (input.categories.length === 0) {
      errors.categories = "工况 B 至少需要一个分类";
    } else if (input.categories.length > CATEGORY_MAX_COUNT) {
      errors.categories = `分类最多 ${CATEGORY_MAX_COUNT} 个`;
    }

    if (Object.keys(categoryAt).length > 0) {
      errors.categoryAt = categoryAt;
      if (!errors.categories) errors.categories = "分类名有误，请修正标红项";
    }
  }

  return { valid: Object.keys(errors).length === 0, errors };
}

export interface NewCameraErrors {
  model?: string;
  position?: string;
  operatorAlias?: string;
}

/** 设备登记校验（PRD §5.1） */
export function validateNewCamera(
  input: NewCameraInput,
  existingCodes: string[] = [],
  currentCode = "",
): ValidationResult<NewCameraErrors> {
  const errors: NewCameraErrors = {};

  if (!input.model.trim()) {
    errors.model = "请填写相机型号";
  } else if (hasIllegalChars(input.model)) {
    errors.model = "型号含非法字符";
  }

  if (!input.position.trim()) {
    errors.position = "请填写机位";
  } else if (!isValidPosition(input.position)) {
    errors.position = "机位必须是单个 A–Z 字母";
  }

  if (!input.operatorAlias.trim()) {
    errors.operatorAlias = "请填写使用者代称";
  } else if (!isValidAlias(input.operatorAlias)) {
    errors.operatorAlias = "代称为 1–4 位英文字母";
  }

  if (
    Object.keys(errors).length === 0 &&
    currentCode &&
    existingCodes.some((code) => normalizeKey(code) === normalizeKey(currentCode))
  ) {
    errors.position = "该编码已登记（同型号 + 同机位 + 同代称）";
  }

  return { valid: Object.keys(errors).length === 0, errors };
}

export const OPERATOR_NAME_MAX = 20;

export interface WorkstationErrors {
  operator?: string;
  nasRoot?: string;
}

/**
 * NAS 根路径是否是一个绝对路径。三平台形式都要认（PRD §6.5）：
 * - macOS / Linux 挂载点：`/Volumes/DIT-NAS`、`/mnt/nas`
 * - Windows 盘符：`Z:\Projects`、`Z:/Projects`
 * - Windows UNC：`\\nas\projects`
 */
export function isAbsoluteNasRoot(path: string): boolean {
  const p = path.trim();
  if (!p) return false;
  if (p.startsWith("//") || p.startsWith("\\\\")) return true; // UNC
  if (p.startsWith("/")) return true; // POSIX
  return /^[A-Za-z]:[\\/]/.test(p); // 盘符
}

/** 工作站设置校验：操作人 + NAS 根路径 */
export function validateWorkstation(input: {
  operator: string;
  nasRoot: string;
}): ValidationResult<WorkstationErrors> {
  const errors: WorkstationErrors = {};

  const operator = input.operator.trim();
  if (!operator) {
    errors.operator = "请填写操作人（DIT 名），审计日志按此留痕";
  } else if (operator.length > OPERATOR_NAME_MAX) {
    errors.operator = `操作人不超过 ${OPERATOR_NAME_MAX} 个字符`;
  }

  const nasRoot = input.nasRoot.trim();
  if (!nasRoot) {
    errors.nasRoot = "请填写 NAS 根路径";
  } else if (!isAbsoluteNasRoot(nasRoot)) {
    errors.nasRoot = "请填写绝对路径，如 /Volumes/DIT-NAS 或 Z:\\Projects";
  }

  return { valid: Object.keys(errors).length === 0, errors };
}

/** 拷卡任务发起前的双确认校验（PRD §5.3） */
export interface StartCopyErrors {
  volumeId?: string;
  cameraId?: string;
  note?: string;
  targetPrefix?: string;
  destinations?: string;
  /** 逐行错误，key 为目的地下标（标红该行） */
  destinationAt?: Record<number, string>;
}

export function validateStartCopy(input: {
  volumeId: string;
  cameraId: string;
  note: string;
  targetPrefix: string;
  /**
   * kind 必须带上：kind = "nas" 的路径由项目结构自动推导、用户不填，
   * 不能和「留空的本机/移动盘行」一样判错。
   */
  destinations: Array<{ kind: DestinationKind; path: string }>;
}): ValidationResult<StartCopyErrors> {
  const errors: StartCopyErrors = {};

  if (!input.volumeId) errors.volumeId = "请选择源卷";
  if (!input.cameraId) errors.cameraId = "请选择该卡对应的相机";
  if (!input.note.trim()) errors.note = "内容备注必填（规范要求「适当记录」）";

  const prefix = input.targetPrefix.trim();
  if (!prefix) {
    errors.targetPrefix = "请填写目标夹前缀（日期或时段）";
  } else if (hasIllegalChars(prefix)) {
    errors.targetPrefix = "前缀含非法字符";
  }

  const destinationAt: Record<number, string> = {};
  input.destinations.forEach((dest, index) => {
    // NAS 行由后端按项目结构推导，留空是正常的
    if (dest.kind === "nas") return;
    if (!dest.path.trim()) {
      destinationAt[index] = "请填写目的地路径，或删除这一行";
    }
  });

  // 只对用户自填的行查重（NAS 行路径由后端决定）
  const paths = input.destinations
    .filter((d) => d.kind !== "nas")
    .map((d) => d.path.trim())
    .filter(Boolean);
  const keys = paths.map(normalizePathKey);

  if (input.destinations.length === 0) {
    errors.destinations = "至少需要一个目的地";
  } else if (new Set(keys).size !== keys.length) {
    // 大小写/结尾斜杠不同但指向同一个目录，等于只备份了一份
    errors.destinations = "目的地路径重复";
  }

  if (Object.keys(destinationAt).length > 0) {
    errors.destinationAt = destinationAt;
    if (!errors.destinations) errors.destinations = "目的地有误，请修正标红行";
  }

  return { valid: Object.keys(errors).length === 0, errors };
}
