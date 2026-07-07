import type {
  CreateDeviceFileItem,
  CreateDeviceFilesReq,
  CreateDeviceReq,
  DeviceTag,
  DeviceDetails,
} from '../../../../Bindings';
import type { DeviceUpdatePatchInput } from '../../services/api/devices';
import { formatDeviceErrorMessage } from './helpers';

export const DEVICE_NAME_MAX_CHARS = 255;
export const DEVICE_TAGS_MAX_COUNT = 50;
export const DEVICE_TAG_LABEL_MAX_CHARS = 128;
export const DEVICE_TAG_VALUE_MAX_CHARS = 4096;
export const DEVICE_EXTERNAL_URL_MAX_CHARS = 4096;
export const DEVICE_FILE_CREATE_BATCH_MAX_COUNT = 100;
export const DEVICE_FILE_ORIGINAL_NAME_MAX_CHARS = 1024;
export const DEVICE_FILE_ORIGINAL_ABSOLUTE_PATH_MAX_CHARS = 4096;

let draftRowSeq = 0;

function nextDraftId(prefix: string): string {
  draftRowSeq += 1;
  return `${prefix}-${draftRowSeq}`;
}

export type DeviceTagDraft = {
  id: string;
  label: string;
  value: string;
};

export type DeviceFileDraft = {
  id: string;
  originalName: string;
  originalAbsolutePath: string;
  originalCreatedAt: string;
  originalModifiedAt: string;
};

export type DeviceUpsertForm = {
  name: string;
  aorIds: number[];
  unitId: number | null;
  externalUrl: string;
  tags: DeviceTagDraft[];
  files: DeviceFileDraft[];
};

export type DeviceTagDraftError = {
  label?: string;
  value?: string;
};

export type DeviceFileDraftError = {
  row?: string;
  originalName?: string;
  originalAbsolutePath?: string;
  originalCreatedAt?: string;
  originalModifiedAt?: string;
};

export type DeviceUpsertValidationErrors = {
  name?: string;
  externalUrl?: string;
  tags?: string;
  files?: string;
  tagRows: Record<string, DeviceTagDraftError>;
  fileRows: Record<string, DeviceFileDraftError>;
};

export type DeviceServerFieldErrors = Partial<{
  name: string;
  aorIds: string;
  unitId: string;
  externalUrl: string;
  tags: string;
  files: string;
}>;

function emptyValidationErrors(): DeviceUpsertValidationErrors {
  return { tagRows: {}, fileRows: {} };
}

export function createDeviceTagDraft(overrides: Partial<DeviceTagDraft> = {}): DeviceTagDraft {
  return {
    id: overrides.id ?? nextDraftId('tag'),
    label: overrides.label ?? '',
    value: overrides.value ?? '',
  };
}

export function createDeviceFileDraft(overrides: Partial<DeviceFileDraft> = {}): DeviceFileDraft {
  return {
    id: overrides.id ?? nextDraftId('file'),
    originalName: overrides.originalName ?? '',
    originalAbsolutePath: overrides.originalAbsolutePath ?? '',
    originalCreatedAt: overrides.originalCreatedAt ?? '',
    originalModifiedAt: overrides.originalModifiedAt ?? '',
  };
}

export function createDefaultDeviceUpsertForm(): DeviceUpsertForm {
  return {
    name: '',
    aorIds: [],
    unitId: null,
    externalUrl: '',
    tags: [],
    files: [],
  };
}

export function deviceDetailsToUpsertForm(device: DeviceDetails): DeviceUpsertForm {
  return {
    name: device.name,
    aorIds: device.aorIds,
    unitId: device.unitId,
    externalUrl: device.externalUrl ?? '',
    tags: device.tags.map((field) => createDeviceTagDraft(field)),
    files: [],
  };
}

function isValidationErrorsEmpty(errors: DeviceUpsertValidationErrors): boolean {
  return (
    errors.name === undefined &&
    errors.externalUrl === undefined &&
    errors.tags === undefined &&
    errors.files === undefined &&
    Object.keys(errors.tagRows).length === 0 &&
    Object.keys(errors.fileRows).length === 0
  );
}

function validateMaxChars(value: string, max: number): string | undefined {
  return Array.from(value).length > max ? 'Значення занадто довге' : undefined;
}

function validateName(name: string): string | undefined {
  const trimmed = name.trim();
  if (trimmed === '') return 'Вкажіть назву пристрою.';
  return validateMaxChars(trimmed, DEVICE_NAME_MAX_CHARS);
}

function validateExternalUrl(value: string): string | undefined {
  const trimmed = value.trim();
  if (trimmed === '') return undefined;

  const lengthError = validateMaxChars(trimmed, DEVICE_EXTERNAL_URL_MAX_CHARS);
  if (lengthError) return lengthError;

  try {
    const url = new URL(trimmed);
    if ((url.protocol !== 'http:' && url.protocol !== 'https:') || !url.host) {
      return 'Посилання має починатися з http:// або https://';
    }
  } catch (_) {
    return 'Посилання має бути абсолютним URL';
  }

  return undefined;
}

export function validateDeviceTags(
  rows: DeviceTagDraft[],
): Pick<DeviceUpsertValidationErrors, 'tags' | 'tagRows'> {
  const errors: Pick<DeviceUpsertValidationErrors, 'tags' | 'tagRows'> = {
    tagRows: {},
  };

  if (rows.length > DEVICE_TAGS_MAX_COUNT) {
    errors.tags = 'Забагато тегів.';
  }

  const labels = new Set<string>();
  rows.forEach((row) => {
    const rowErrors: DeviceTagDraftError = {};
    const label = row.label.trim();
    const value = row.value.trim();

    if (label === '') {
      rowErrors.label = 'Назва тегу не може бути порожньою.';
    } else {
      const labelLengthError = validateMaxChars(label, DEVICE_TAG_LABEL_MAX_CHARS);
      if (labelLengthError) {
        rowErrors.label = labelLengthError;
      } else if (labels.has(label)) {
        rowErrors.label = 'Тег з такою назвою вже існує.';
      }
    }

    const valueLengthError = validateMaxChars(value, DEVICE_TAG_VALUE_MAX_CHARS);
    if (valueLengthError) rowErrors.value = valueLengthError;
    if (Object.keys(rowErrors).length > 0) errors.tagRows[row.id] = rowErrors;
    if (label !== '') labels.add(label);
  });

  return errors;
}

function parseDateTimeLocalMs(value: string): number | null {
  const trimmed = value.trim();
  if (trimmed === '') return null;
  const ms = new Date(trimmed).getTime();
  return Number.isFinite(ms) ? ms : null;
}

export function validateDeviceFileRows(
  rows: DeviceFileDraft[],
  options: { rejectEmpty: boolean },
): Pick<DeviceUpsertValidationErrors, 'files' | 'fileRows'> {
  const errors: Pick<DeviceUpsertValidationErrors, 'files' | 'fileRows'> = { fileRows: {} };

  if (options.rejectEmpty && rows.length === 0) {
    errors.files = 'Додайте принаймні один файл.';
  }
  if (rows.length > DEVICE_FILE_CREATE_BATCH_MAX_COUNT) {
    errors.files = 'Забагато файлів у запиті.';
  }

  rows.forEach((row) => {
    const rowErrors: DeviceFileDraftError = {};
    const originalName = row.originalName.trim();
    const originalAbsolutePath = row.originalAbsolutePath.trim();

    if (originalName === '' && originalAbsolutePath === '') {
      rowErrors.row = 'Потрібна назва файлу або абсолютний шлях.';
    }

    const nameLengthError = validateMaxChars(originalName, DEVICE_FILE_ORIGINAL_NAME_MAX_CHARS);
    if (nameLengthError) rowErrors.originalName = nameLengthError;

    const pathLengthError = validateMaxChars(
      originalAbsolutePath,
      DEVICE_FILE_ORIGINAL_ABSOLUTE_PATH_MAX_CHARS,
    );
    if (pathLengthError) rowErrors.originalAbsolutePath = pathLengthError;

    if (
      row.originalCreatedAt.trim() !== '' &&
      parseDateTimeLocalMs(row.originalCreatedAt) === null
    ) {
      rowErrors.originalCreatedAt = 'Некоректний час файлу.';
    }
    if (
      row.originalModifiedAt.trim() !== '' &&
      parseDateTimeLocalMs(row.originalModifiedAt) === null
    ) {
      rowErrors.originalModifiedAt = 'Некоректний час файлу.';
    }

    if (Object.keys(rowErrors).length > 0) errors.fileRows[row.id] = rowErrors;
  });

  return errors;
}

export function validateDeviceUpsertForm(
  form: DeviceUpsertForm | null,
  options: { rejectEmptyFiles: boolean } = { rejectEmptyFiles: false },
): DeviceUpsertValidationErrors | null {
  if (form === null) return emptyValidationErrors();

  const errors = emptyValidationErrors();
  const nameError = validateName(form.name);
  if (nameError) errors.name = nameError;

  const externalUrlError = validateExternalUrl(form.externalUrl);
  if (externalUrlError) errors.externalUrl = externalUrlError;

  const tagErrors = validateDeviceTags(form.tags);
  errors.tags = tagErrors.tags;
  errors.tagRows = tagErrors.tagRows;

  const fileErrors = validateDeviceFileRows(form.files, {
    rejectEmpty: options.rejectEmptyFiles,
  });
  errors.files = fileErrors.files;
  errors.fileRows = fileErrors.fileRows;

  return isValidationErrorsEmpty(errors) ? null : errors;
}

export function normalizeDeviceTags(rows: DeviceTagDraft[]): DeviceTag[] {
  return rows.map((row) => ({ label: row.label.trim(), value: row.value.trim() }));
}

export function normalizeDeviceFileRows(rows: DeviceFileDraft[]): CreateDeviceFileItem[] {
  return rows.map((row) => {
    const originalName = row.originalName.trim();
    const originalAbsolutePath = row.originalAbsolutePath.trim();
    return {
      originalName: originalName === '' ? null : originalName,
      originalAbsolutePath: originalAbsolutePath === '' ? null : originalAbsolutePath,
      originalCreatedAtMs: parseDateTimeLocalMs(row.originalCreatedAt),
      originalModifiedAtMs: parseDateTimeLocalMs(row.originalModifiedAt),
    };
  });
}

function normalizeExternalUrl(value: string): string | null {
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

export function buildCreateDeviceReq(form: DeviceUpsertForm): CreateDeviceReq {
  const files = normalizeDeviceFileRows(form.files);
  return {
    name: form.name.trim(),
    aorIds: form.aorIds,
    unitId: form.unitId,
    tags: normalizeDeviceTags(form.tags),
    externalUrl: normalizeExternalUrl(form.externalUrl),
    files: files.length > 0 ? files : null,
  };
}

export function buildCreateDeviceFilesReq(
  deviceId: string,
  rows: DeviceFileDraft[],
): CreateDeviceFilesReq {
  return { deviceId, files: normalizeDeviceFileRows(rows) };
}

function numberArraysEqual(left: number[], right: number[]): boolean {
  if (left.length !== right.length) return false;
  return left.every((value, index) => value === right[index]);
}

function tagsEqual(left: DeviceTag[], right: DeviceTag[]): boolean {
  if (left.length !== right.length) return false;
  return left.every((field, index) => {
    const other = right[index];
    return field.label === other.label && field.value === other.value;
  });
}

export function buildUpdateDevicePatch(
  device: DeviceDetails,
  form: DeviceUpsertForm,
): DeviceUpdatePatchInput {
  const req: DeviceUpdatePatchInput = { deviceId: device.id };
  const name = form.name.trim();
  const tags = normalizeDeviceTags(form.tags);
  const externalUrl = normalizeExternalUrl(form.externalUrl);
  const files = normalizeDeviceFileRows(form.files);

  if (name !== device.name) req.name = name;
  if (!numberArraysEqual(form.aorIds, device.aorIds)) req.aorIds = form.aorIds;
  if (form.unitId !== device.unitId) req.unitId = form.unitId;
  if (externalUrl !== device.externalUrl) req.externalUrl = externalUrl;
  if (!tagsEqual(tags, device.tags)) req.tags = tags;
  if (files.length > 0) req.files = files;

  return req;
}

export function hasDeviceUpdatePatchChanges(patch: DeviceUpdatePatchInput): boolean {
  return (
    patch.name !== undefined ||
    patch.aorIds !== undefined ||
    patch.unitId !== undefined ||
    patch.tags !== undefined ||
    patch.externalUrl !== undefined ||
    (patch.files !== undefined && patch.files.length > 0)
  );
}

function fieldNameFromBackend(field: string): keyof DeviceServerFieldErrors | null {
  switch (field) {
    case 'name':
      return 'name';
    case 'aor_ids':
      return 'aorIds';
    case 'unit_id':
      return 'unitId';
    case 'external_url':
      return 'externalUrl';
    case 'tags':
      return 'tags';
    case 'files':
      return 'files';
    default:
      if (field.startsWith('tags.')) return 'tags';
      if (field.startsWith('files.')) return 'files';
      return null;
  }
}

export function parseDeviceServerFieldErrors(error: unknown): DeviceServerFieldErrors {
  const message = formatDeviceErrorMessage(error);
  const result: DeviceServerFieldErrors = {};

  try {
    const parsed = JSON.parse(message) as unknown;
    if (Array.isArray(parsed)) {
      parsed.forEach((item) => {
        if (!Array.isArray(item) || item.length < 2) return;
        const [field, value] = item;
        if (typeof field !== 'string' || typeof value !== 'string') return;
        const mappedField = fieldNameFromBackend(field);
        if (mappedField && result[mappedField] === undefined) result[mappedField] = value;
      });
    }
  } catch (_) {
    // keep fallback below
  }

  if (result.name === undefined && message.includes('Пристрій з такою назвою вже існує')) {
    result.name = 'Пристрій з такою назвою вже існує';
  }

  return result;
}
