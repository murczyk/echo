import type { CreateDeviceReq, DeviceDetails, DeviceTag } from '../../../../Bindings';
import type { DeviceUpdatePatchInput } from '../../services/api/devices';
import { formatDeviceErrorMessage } from './helpers';

export const DEVICE_SOURCE_LABEL_MAX_CHARS = 255;
export const DEVICE_NAME_MAX_CHARS = 255;
export const DEVICE_TAGS_MAX_COUNT = 50;
export const DEVICE_TAG_LABEL_MAX_CHARS = 128;
export const DEVICE_TAG_VALUE_MAX_CHARS = 4096;
export const DEVICE_EXTERNAL_URL_MAX_CHARS = 4096;
export const DEVICE_CUSTOM_FIELDS_MAX_COUNT = 50;
export const DEVICE_CUSTOM_FIELD_KEY_MAX_CHARS = 128;
export const DEVICE_CUSTOM_FIELD_VALUE_MAX_CHARS = 4096;

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

export type DeviceCustomFieldDraft = {
  id: string;
  key: string;
  value: string;
};

export type DeviceUpsertForm = {
  sourceLabel: string;
  name: string;
  aorIds: number[];
  unitId: number | null;
  externalUrl: string;
  customFields: DeviceCustomFieldDraft[];
  tags: DeviceTagDraft[];
};

export type DeviceTagDraftError = {
  label?: string;
  value?: string;
};

export type DeviceCustomFieldDraftError = {
  key?: string;
  value?: string;
};

export type DeviceUpsertValidationErrors = {
  sourceLabel?: string;
  name?: string;
  externalUrl?: string;
  customFields?: string;
  tags?: string;
  customFieldRows: Record<string, DeviceCustomFieldDraftError>;
  tagRows: Record<string, DeviceTagDraftError>;
};

export type DeviceServerFieldErrors = Partial<{
  sourceLabel: string;
  name: string;
  aorIds: string;
  unitId: string;
  externalUrl: string;
  customFields: string;
  tags: string;
}>;

function emptyValidationErrors(): DeviceUpsertValidationErrors {
  return { customFieldRows: {}, tagRows: {} };
}

export function createDeviceTagDraft(overrides: Partial<DeviceTagDraft> = {}): DeviceTagDraft {
  return {
    id: overrides.id ?? nextDraftId('tag'),
    label: overrides.label ?? '',
    value: overrides.value ?? '',
  };
}

export function createDeviceCustomFieldDraft(
  overrides: Partial<DeviceCustomFieldDraft> = {},
): DeviceCustomFieldDraft {
  return {
    id: overrides.id ?? nextDraftId('custom-field'),
    key: overrides.key ?? '',
    value: overrides.value ?? '',
  };
}

export function createDefaultDeviceUpsertForm(): DeviceUpsertForm {
  return {
    sourceLabel: '',
    name: '',
    aorIds: [],
    unitId: null,
    externalUrl: '',
    customFields: [],
    tags: [],
  };
}

export function deviceDetailsToUpsertForm(device: DeviceDetails): DeviceUpsertForm {
  return {
    sourceLabel: device.sourceLabel,
    name: device.name,
    aorIds: device.aorIds,
    unitId: device.unitId,
    externalUrl: device.externalUrl ?? '',
    customFields: Object.entries(device.customFields)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, value]) => createDeviceCustomFieldDraft({ key, value })),
    tags: device.tags.map((field) => createDeviceTagDraft(field)),
  };
}

function isValidationErrorsEmpty(errors: DeviceUpsertValidationErrors): boolean {
  return (
    errors.sourceLabel === undefined &&
    errors.name === undefined &&
    errors.externalUrl === undefined &&
    errors.customFields === undefined &&
    errors.tags === undefined &&
    Object.keys(errors.customFieldRows).length === 0 &&
    Object.keys(errors.tagRows).length === 0
  );
}

function validateMaxChars(value: string, max: number): string | undefined {
  return Array.from(value).length > max ? 'Значення занадто довге' : undefined;
}

function validateSourceLabel(sourceLabel: string): string | undefined {
  const trimmed = sourceLabel.trim();
  if (trimmed === '') return 'Вкажіть джерельну мітку.';
  return validateMaxChars(trimmed, DEVICE_SOURCE_LABEL_MAX_CHARS);
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
  } catch {
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
    errors.customFields = 'Забагато кастомних полів.';
  }

  const keys = new Set<string>();
  rows.forEach((row) => {
    const rowErrors: DeviceCustomFieldDraftError = {};
    const key = row.key.trim();

    if (key === '') {
      rowErrors.key = 'Ключ кастомного поля не може бути порожнім.';
    } else {
      const keyLengthError = validateMaxChars(key, DEVICE_CUSTOM_FIELD_KEY_MAX_CHARS);
      if (keyLengthError) {
        rowErrors.key = keyLengthError;
      } else if (keys.has(key)) {
        rowErrors.key = 'Ключі кастомних полів мають бути унікальними.';
      }
    }

    const valueLengthError = validateMaxChars(row.value, DEVICE_CUSTOM_FIELD_VALUE_MAX_CHARS);
    if (valueLengthError) rowErrors.value = valueLengthError;
    if (Object.keys(rowErrors).length > 0) errors.customFieldRows[row.id] = rowErrors;
    if (key !== '') keys.add(key);
  });

  return errors;
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

export function validateDeviceUpsertForm(
  form: DeviceUpsertForm | null,
): DeviceUpsertValidationErrors | null {
  if (form === null) return emptyValidationErrors();

  const errors = emptyValidationErrors();
  const sourceLabelError = validateSourceLabel(form.sourceLabel);
  if (sourceLabelError) errors.sourceLabel = sourceLabelError;

  const nameError = validateName(form.name);
  if (nameError) errors.name = nameError;

  const externalUrlError = validateExternalUrl(form.externalUrl);
  if (externalUrlError) errors.externalUrl = externalUrlError;

  const customFieldErrors = validateDeviceCustomFields(form.customFields);
  errors.customFields = customFieldErrors.customFields;
  errors.customFieldRows = customFieldErrors.customFieldRows;

  const tagErrors = validateDeviceTags(form.tags);
  errors.tags = tagErrors.tags;
  errors.tagRows = tagErrors.tagRows;

  return isValidationErrorsEmpty(errors) ? null : errors;
}

export function normalizeDeviceTags(rows: DeviceTagDraft[]): DeviceTag[] {
  return rows.map((row) => ({ label: row.label.trim(), value: row.value.trim() }));
}

export function normalizeDeviceCustomFields(
  rows: DeviceCustomFieldDraft[],
): Record<string, string> {
  return Object.fromEntries(rows.map((row) => [row.key.trim(), row.value]));
}

function normalizeExternalUrl(value: string): string | null {
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
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

function buildCustomFieldsPatch(
  current: Record<string, string>,
  previous: Record<string, string>,
): Record<string, string | null> | undefined {
  const entries: Array<[string, string | null]> = [];

  Object.entries(current).forEach(([key, value]) => {
    if (previous[key] !== value) entries.push([key, value]);
  });
  Object.keys(previous).forEach((key) => {
    if (!(key in current)) entries.push([key, null]);
  });

  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

export function buildCreateDeviceReq(form: DeviceUpsertForm): CreateDeviceReq {
  return {
    sourceLabel: form.sourceLabel.trim(),
    name: form.name.trim(),
    aorIds: form.aorIds,
    unitId: form.unitId,
    tags: normalizeDeviceTags(form.tags),
    externalUrl: normalizeExternalUrl(form.externalUrl),
    customFields: normalizeDeviceCustomFields(form.customFields),
  };
}

export function buildUpdateDevicePatch(
  device: DeviceDetails,
  form: DeviceUpsertForm,
): DeviceUpdatePatchInput {
  const req: DeviceUpdatePatchInput = { deviceId: device.id };
  const sourceLabel = form.sourceLabel.trim();
  const name = form.name.trim();
  const tags = normalizeDeviceTags(form.tags);
  const externalUrl = normalizeExternalUrl(form.externalUrl);
  const customFields = normalizeDeviceCustomFields(form.customFields);
  const customFieldsPatch = buildCustomFieldsPatch(customFields, device.customFields);

  if (sourceLabel !== device.sourceLabel) req.sourceLabel = sourceLabel;
  if (name !== device.name) req.name = name;
  if (!numberArraysEqual(form.aorIds, device.aorIds)) req.aorIds = form.aorIds;
  if (form.unitId !== device.unitId) req.unitId = form.unitId;
  if (externalUrl !== device.externalUrl) req.externalUrl = externalUrl;
  if (!tagsEqual(tags, device.tags)) req.tags = tags;
  if (customFieldsPatch !== undefined) req.customFields = customFieldsPatch;

  return req;
}

export function hasDeviceUpdatePatchChanges(patch: DeviceUpdatePatchInput): boolean {
  return (
    patch.sourceLabel !== undefined ||
    patch.name !== undefined ||
    patch.aorIds !== undefined ||
    patch.unitId !== undefined ||
    patch.tags !== undefined ||
    patch.externalUrl !== undefined ||
    patch.customFields !== undefined
  );
}

function fieldNameFromBackend(field: string): keyof DeviceServerFieldErrors | null {
  switch (field) {
    case 'source_label':
      return 'sourceLabel';
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
    case 'tags':
      return 'tags';
    default:
      if (field.startsWith('custom_fields.')) return 'customFields';
      if (field.startsWith('tags.')) return 'tags';
      return null;
  }
}

export function parseDeviceServerFieldErrors(error: unknown): DeviceServerFieldErrors {
  const message = formatDeviceErrorMessage(error);
  const result: DeviceServerFieldErrors = {};

  try {
    const parsed: unknown = JSON.parse(message);
    if (Array.isArray(parsed)) {
      parsed.forEach((item) => {
        if (!Array.isArray(item) || item.length < 2) return;
        const [field, value] = item;
        if (typeof field !== 'string' || typeof value !== 'string') return;
        const mappedField = fieldNameFromBackend(field);
        if (mappedField && result[mappedField] === undefined) result[mappedField] = value;
      });
    }
  } catch {
    // keep fallback below
  }

  return result;
}
