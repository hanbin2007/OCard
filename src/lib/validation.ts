/**
 * 表单校验（新建项目向导、设备登记）。纯函数，返回逐字段错误，便于单测。
 */

import type { NewCameraInput, NewProjectInput } from "../api/types";
import {
  hasIllegalChars,
  isValidAlias,
  isValidCompactDate,
  isValidPosition,
  sanitizeSegment,
} from "./naming";

export const PROJECT_NAME_MAX = 40;
export const CATEGORY_NAME_MAX = 16;
export const CATEGORY_MAX_COUNT = 20;

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
      const prev = seen.get(clean);
      if (prev !== undefined) {
        categoryAt[index] = "分类名重复";
        return;
      }
      seen.set(clean, index);
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
    existingCodes.includes(currentCode)
  ) {
    errors.position = "该编码已登记（同型号 + 同机位 + 同代称）";
  }

  return { valid: Object.keys(errors).length === 0, errors };
}

/** 拷卡任务发起前的双确认校验（PRD §5.3） */
export interface StartCopyErrors {
  volumeId?: string;
  cameraId?: string;
  note?: string;
  destinations?: string;
}

export function validateStartCopy(input: {
  volumeId: string;
  cameraId: string;
  note: string;
  destinations: string[];
}): ValidationResult<StartCopyErrors> {
  const errors: StartCopyErrors = {};

  if (!input.volumeId) errors.volumeId = "请选择源卷";
  if (!input.cameraId) errors.cameraId = "请选择该卡对应的相机";
  if (!input.note.trim()) errors.note = "内容备注必填（规范要求「适当记录」）";

  const paths = input.destinations.map((p) => p.trim()).filter(Boolean);
  if (paths.length === 0) {
    errors.destinations = "至少需要一个目的地";
  } else if (new Set(paths).size !== paths.length) {
    errors.destinations = "目的地路径重复";
  }

  return { valid: Object.keys(errors).length === 0, errors };
}
