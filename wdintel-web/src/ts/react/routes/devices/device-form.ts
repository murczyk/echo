import type {
  CreateDeviceFileItem,
  CreateDeviceFilesReq,
  CreateDeviceReq,
  DeviceCustomField,
  DeviceDetails,
} from '../../../../Bindings';
import type { DeviceUpdatePatchInput } from '../../services/api/devices';
import { formatDeviceErrorMessage } from './helpers';

export const DEVICE_NAME_MAX_CHARS = 255;
export const DEVICE_CUSTOM_FIELDS_MAX_COUNT = 50;
export const DEVICE_CUSTOM_FIELD_LABEL_MAX_CHARS = 128;
export const DEVICE_CUSTOM_FIELD_VALUE_MAX_CHARS = 4096;
export const DEVICE_EXTERNAL_URL_MAX_CHARS = 4096;
export const DEVICE_FILE_CREATE_BATCH_MAX_COUNT = 100;
export const DEVICE_FILE_ORIGINAL_NAME_MAX_CHARS = 1024;
export const DEVICE_FILE_ORIGINAL_ABSOLUTE_PATH_MAX_CHARS = 4096;

let draftRowSeq = 0;

function nextDraftId(prefix: string): string {
  draftRowSeq += 1;
  return `${prefix}-${draftRowSeq}`;
}

export type DeviceCustomFieldDraft = {
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
  customFields: DeviceCustomFieldDraft[];
  files: DeviceFileDraft[];
};

export type DeviceCustomFieldDraftError = {
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
  customFields?: string;
  files?: string;
  customFieldRows: Record<string, DeviceCustomFieldDraftError>;
  fileRows: Record<string, DeviceFileDraftError>;
};

export type DeviceServerFieldErrors = Partial<{
  name: string;
  aorIds: string;
  unitId: string;
  externalUrl: string;
  customFields: string;
  files: string;
}>;

function emptyValidationErrors(): DeviceUpsertValidationErrors {
  return { customFieldRows: {}, fileRows: {} };
}

export function createDeviceCustomFieldDraft(
  overrides: Partial<DeviceCustomFieldDraft> = {},
): DeviceCustomFieldDraft {
  return {
    id: overrides.id ?? nextDraftId('custom-field'),
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
    customFields: [],
    files: [],
  };
}

export function deviceDetailsToUpsertForm(device: DeviceDetails): DeviceUpsertForm {
  return {
    name: device.name,
    aorIds: device.aorIds,
    unitId: device.unitId,
    externalUrl: device.externalUrl ?? '',
    customFields: device.customFields.map((field) => createDeviceCustomFieldDraft(field)),
    files: [],
  };
}

function isValidationErrorsEmpty(errors: DeviceUpsertValidationErrors): boolean {
  return (
    errors.name === undefined &&
    errors.externalUrl === undefined &&
    errors.customFields === undefined &&
    errors.files === undefined &&
    Object.keys(errors.customFieldRows).length === 0 &&
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

export function validateDeviceCustomFields(
  rows: DeviceCustomFieldDraft[],
): Pick<DeviceUpsertValidationErrors, 'customFields' | 'customFieldRows'> {
  const errors: Pick<DeviceUpsertValidationErrors, 'customFields' | 'customFieldRows'> = {
    customFieldRows: {},
  };

  if (rows.length > DEVICE_CUSTOM_FIELDS_MAX_COUNT) {
    errors.customFields = 'Забагато додаткових полів.';
  }

  const labels = new Set<string>();
  rows.forEach((row) => {
    const rowErrors: DeviceCustomFieldDraftError = {};
    const label = row.label.trim();
    const value = row.value.trim();

    if (label === '') {
      rowErrors.label = 'Назва додаткового поля не може бути порожньою.';
    } else {
      const labelLengthError = validateMaxChars(label, DEVICE_CUSTOM_FIELD_LABEL_MAX_CHARS);
      if (labelLengthError) {
        rowErrors.label = labelLengthError;
      } else if (labels.has(label)) {
        rowErrors.label = 'Додаткове поле з такою назвою вже існує.';
      }
    }

    const valueLengthError = validateMaxChars(value, DEVICE_CUSTOM_FIELD_VALUE_MAX_CHARS);
    if (valueLengthError) rowErrors.value = valueLengthError;
    if (Object.keys(rowErrors).length > 0) errors.customFieldRows[row.id] = rowErrors;
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

  const customFieldErrors = validateDeviceCustomFields(form.customFields);
  errors.customFields = customFieldErrors.customFields;
  errors.customFieldRows = customFieldErrors.customFieldRows;

  const fileErrors = validateDeviceFileRows(form.files, {
    rejectEmpty: options.rejectEmptyFiles,
  });
  errors.files = fileErrors.files;
  errors.fileRows = fileErrors.fileRows;

  return isValidationErrorsEmpty(errors) ? null : errors;
}

export function normalizeDeviceCustomFields(rows: DeviceCustomFieldDraft[]): DeviceCustomField[] {
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
    customFields: normalizeDeviceCustomFields(form.customFields),
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

function customFieldsEqual(left: DeviceCustomField[], right: DeviceCustomField[]): boolean {
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
  const customFields = normalizeDeviceCustomFields(form.customFields);
  const externalUrl = normalizeExternalUrl(form.externalUrl);
  const files = normalizeDeviceFileRows(form.files);

  if (name !== device.name) req.name = name;
  if (!numberArraysEqual(form.aorIds, device.aorIds)) req.aorIds = form.aorIds;
  if (form.unitId !== device.unitId) req.unitId = form.unitId;
  if (externalUrl !== device.externalUrl) req.externalUrl = externalUrl;
  if (!customFieldsEqual(customFields, device.customFields)) req.customFields = customFields;
  if (files.length > 0) req.files = files;

  return req;
}

export function hasDeviceUpdatePatchChanges(patch: DeviceUpdatePatchInput): boolean {
  return (
    patch.name !== undefined ||
    patch.aorIds !== undefined ||
    patch.unitId !== undefined ||
    patch.customFields !== undefined ||
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
    case 'custom_fields':
      return 'customFields';
    case 'files':
      return 'files';
    default:
      if (field.startsWith('custom_fields.')) return 'customFields';
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
