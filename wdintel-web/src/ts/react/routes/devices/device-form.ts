import type { DeviceDetails } from '../../../../Bindings';
import type { CreateDeviceInput, DeviceUpdatePatchInput } from '../../services/api/devices';
import { formatDeviceErrorMessage } from './helpers';

export const DEVICE_NAME_MAX_CHARS = 255;
export const DEVICE_DESCRIPTION_MAX_CHARS = 4000;
export const DEVICE_TAG_MAX_CHARS = 64;
export const DEVICE_TAGS_MAX_COUNT = 50;
export const DEVICE_EXTERNAL_URL_MAX_CHARS = 4096;
export const DEVICE_CUSTOM_FIELDS_MAX_COUNT = 50;
export const DEVICE_CUSTOM_FIELD_KEY_MAX_CHARS = 128;
export const DEVICE_CUSTOM_FIELD_VALUE_MAX_CHARS = 4096;

let draftRowSeq = 0;

function nextDraftId(prefix: string): string {
  draftRowSeq += 1;
  return `${prefix}-${draftRowSeq}`;
}

export type DeviceFieldPermissions = {
  sourceData: boolean;
  analyticalData: boolean;
};

export type DeviceCustomFieldDraft = {
  id: string;
  key: string;
  value: string;
};

export type DeviceUpsertForm = {
  description: string;
  tags: string[];
  name: string;
  aorIds: number[];
  unitId: number | null;
  externalUrl: string;
  customFields: DeviceCustomFieldDraft[];
  audioForwarding?: DeviceUpdatePatchInput['audioForwarding'];
};

export type DeviceCustomFieldDraftError = {
  key?: string;
  value?: string;
};

export type DeviceUpsertValidationErrors = {
  description?: string;
  tags?: string;
  name?: string;
  externalUrl?: string;
  customFields?: string;
  customFieldRows: Record<string, DeviceCustomFieldDraftError>;
};

export type DeviceServerFieldErrors = Partial<{
  description: string;
  tags: string;
  name: string;
  aorIds: string;
  unitId: string;
  externalUrl: string;
  customFields: string;
}>;

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
    description: '',
    tags: [],
    name: '',
    aorIds: [],
    unitId: null,
    externalUrl: '',
    customFields: [],
  };
}

export function deviceDetailsToUpsertForm(device: DeviceDetails): DeviceUpsertForm {
  return {
    description: device.description ?? '',
    tags: device.tags ?? [],
    name: device.name ?? '',
    aorIds: device.aors.map((aor) => aor.id),
    unitId: device.unit?.id ?? null,
    externalUrl: device.externalUrl ?? '',
    customFields: Object.entries(device.customFields)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, value]) => createDeviceCustomFieldDraft({ key, value })),
  };
}

function validateMaxChars(value: string, max: number): string | undefined {
  return Array.from(value).length > max ? 'Значення занадто довге' : undefined;
}

function validateName(name: string): string | undefined {
  const trimmed = name.trim();
  return trimmed === ''
    ? 'Вкажіть назву пристрою.'
    : validateMaxChars(trimmed, DEVICE_NAME_MAX_CHARS);
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

export function validateDeviceUpsertForm(
  form: DeviceUpsertForm | null,
  permissions: DeviceFieldPermissions,
  nameRequired = true,
): DeviceUpsertValidationErrors | null {
  const errors: DeviceUpsertValidationErrors = { customFieldRows: {} };
  if (form === null) return errors;

  if (permissions.sourceData) {
    errors.description = validateMaxChars(form.description.trim(), DEVICE_DESCRIPTION_MAX_CHARS);
    const externalUrlError = validateExternalUrl(form.externalUrl);
    if (externalUrlError) errors.externalUrl = externalUrlError;

    const customFieldErrors = validateDeviceCustomFields(form.customFields);
    errors.customFields = customFieldErrors.customFields;
    errors.customFieldRows = customFieldErrors.customFieldRows;
  }

  if (permissions.analyticalData && (nameRequired || form.name.trim() !== '')) {
    const nameError = validateName(form.name);
    if (nameError) errors.name = nameError;
  }

  if (permissions.analyticalData) {
    if (form.tags.length > DEVICE_TAGS_MAX_COUNT) errors.tags = 'Забагато тегів.';
    else if (
      form.tags.some(
        (tag) => tag.trim() === '' || Array.from(tag.trim()).length > DEVICE_TAG_MAX_CHARS,
      )
    ) {
      errors.tags = 'Тег має містити від 1 до 64 символів.';
    }
  }

  const isEmpty =
    errors.description === undefined &&
    errors.tags === undefined &&
    errors.name === undefined &&
    errors.externalUrl === undefined &&
    errors.customFields === undefined &&
    Object.keys(errors.customFieldRows).length === 0;
  return isEmpty ? null : errors;
}

export function normalizeDeviceCustomFields(
  rows: DeviceCustomFieldDraft[],
): Record<string, string> {
  return Object.fromEntries(rows.map((row) => [row.key.trim(), row.value]));
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

export function buildCreateDeviceReq(
  form: DeviceUpsertForm,
  permissions: DeviceFieldPermissions,
): CreateDeviceInput {
  const externalUrl = form.externalUrl.trim();
  const req: CreateDeviceInput = {
    externalUrl: externalUrl === '' ? null : externalUrl,
    customFields: normalizeDeviceCustomFields(form.customFields),
  };
  if (permissions.analyticalData) req.name = form.name.trim();
  return req;
}

export function buildUpdateDevicePatch(
  device: DeviceDetails,
  form: DeviceUpsertForm,
  permissions: DeviceFieldPermissions,
): DeviceUpdatePatchInput {
  const req: DeviceUpdatePatchInput = { deviceId: device.id };

  if (permissions.sourceData) {
    const externalUrlValue = form.externalUrl.trim();
    const description = form.description.trim() || null;
    if (description !== (device.description ?? null)) req.description = description;
    const externalUrl = externalUrlValue === '' ? null : externalUrlValue;
    const customFields = normalizeDeviceCustomFields(form.customFields);
    const customFieldsPatch = buildCustomFieldsPatch(customFields, device.customFields);

    if (externalUrl !== device.externalUrl) req.externalUrl = externalUrl;
    if (customFieldsPatch !== undefined) req.customFields = customFieldsPatch;
  }

  if (permissions.analyticalData) {
    if (form.audioForwarding !== undefined) req.audioForwarding = form.audioForwarding;
    if (JSON.stringify(form.tags) !== JSON.stringify(device.tags ?? [])) req.tags = form.tags;
    const name = form.name.trim();
    const deviceAorIds = device.aors.map((aor) => aor.id);
    const arraysEqual =
      form.aorIds.length === deviceAorIds.length &&
      form.aorIds.every((value, index) => value === deviceAorIds[index]);

    if (name !== (device.name ?? '')) req.name = name;
    if (!arraysEqual) req.aorIds = form.aorIds;
    if (form.unitId !== (device.unit?.id ?? null)) req.unitId = form.unitId;
  }

  return req;
}

export function hasDeviceUpdatePatchChanges(patch: DeviceUpdatePatchInput): boolean {
  return (
    patch.description !== undefined ||
    patch.tags !== undefined ||
    patch.rating !== undefined ||
    patch.audioForwarding !== undefined ||
    patch.name !== undefined ||
    patch.aorIds !== undefined ||
    patch.unitId !== undefined ||
    patch.externalUrl !== undefined ||
    patch.customFields !== undefined
  );
}

function fieldNameFromBackend(field: string): keyof DeviceServerFieldErrors | null {
  switch (field) {
    case 'description':
      return 'description';
    case 'tags':
      return 'tags';
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
    default:
      if (field.startsWith('custom_fields.')) return 'customFields';
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
    // Keep the generic error shown by the caller.
  }

  return result;
}
