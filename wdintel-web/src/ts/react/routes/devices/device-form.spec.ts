import { describe, expect, it } from 'vitest';

import type { DeviceDetails } from '../../../../Bindings';
import {
  buildCreateDeviceReq,
  buildUpdateDevicePatch,
  createDefaultDeviceUpsertForm,
  createDeviceCustomFieldDraft,
  deviceDetailsToUpsertForm,
  hasDeviceUpdatePatchChanges,
  parseDeviceServerFieldErrors,
  validateDeviceUpsertForm,
  type DeviceFieldPermissions,
} from './device-form';

const DEVICE_ID = '018f0000-0000-7000-8000-000000000000';
const ALL_FIELDS: DeviceFieldPermissions = { sourceData: true, analyticalData: true };
const SOURCE_FIELDS: DeviceFieldPermissions = { sourceData: true, analyticalData: false };

function buildDevice(overrides: Partial<DeviceDetails> = {}): DeviceDetails {
  return {
    id: DEVICE_ID,
    sourceLabel: 'Source device',
    name: 'Device Alpha',
    aors: [{ id: 4, name: 'AOR' }],
    unit: { id: 7, name: 'Unit' },
    externalUrl: 'https://example.test/device',
    customFields: { inventory_id: 'node-1', retired: 'no' },
    createdBy: 'operator',
    archived: false,
    archivedAt: null,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-02T00:00:00Z',
    ...overrides,
  };
}

describe('device form helpers', () => {
  it('builds create requests from source fields only', () => {
    const form = createDefaultDeviceUpsertForm();
    form.sourceLabel = '  Source device  ';
    form.name = '  Device Beta  ';
    form.aorIds = [10, 20];
    form.unitId = 7;
    form.externalUrl = '  https://example.test/beta  ';
    form.customFields = [
      createDeviceCustomFieldDraft({ key: ' inventory_id ', value: ' node-2 ' }),
    ];

    expect(buildCreateDeviceReq(form)).toEqual({
      sourceLabel: 'Source device',
      externalUrl: 'https://example.test/beta',
      customFields: { inventory_id: ' node-2 ' },
    });
  });

  it('submits empty optional source fields explicitly', () => {
    const form = createDefaultDeviceUpsertForm();
    form.sourceLabel = 'Source device';

    expect(buildCreateDeviceReq(form)).toEqual({
      sourceLabel: 'Source device',
      externalUrl: null,
      customFields: {},
    });
  });

  it('builds a presence-aware update patch for every permitted field group', () => {
    const device = buildDevice();
    const form = deviceDetailsToUpsertForm(device);
    form.sourceLabel = ' Updated source ';
    form.name = ' ';
    form.aorIds = [];
    form.unitId = null;
    form.externalUrl = ' ';
    form.customFields = [
      createDeviceCustomFieldDraft({ key: 'inventory_id', value: 'node-2' }),
      createDeviceCustomFieldDraft({ key: 'transport', value: 'ssh' }),
    ];

    expect(buildUpdateDevicePatch(device, form, ALL_FIELDS)).toEqual({
      deviceId: DEVICE_ID,
      sourceLabel: 'Updated source',
      name: null,
      aorIds: [],
      unitId: null,
      externalUrl: null,
      customFields: { inventory_id: 'node-2', retired: null, transport: 'ssh' },
    });
  });

  it('does not send changes from a field group without permission', () => {
    const device = buildDevice();
    const form = deviceDetailsToUpsertForm(device);
    form.sourceLabel = 'Updated source';
    form.name = 'Changed analytical name';
    form.aorIds = [];
    form.unitId = null;

    expect(buildUpdateDevicePatch(device, form, SOURCE_FIELDS)).toEqual({
      deviceId: DEVICE_ID,
      sourceLabel: 'Updated source',
    });
  });

  it('detects no-op update patches', () => {
    const device = buildDevice();
    const patch = buildUpdateDevicePatch(device, deviceDetailsToUpsertForm(device), ALL_FIELDS);

    expect(patch).toEqual({ deviceId: DEVICE_ID });
    expect(hasDeviceUpdatePatchChanges(patch)).toBe(false);
  });

  it('validates only permitted source fields and allows an empty analytical name', () => {
    const form = createDefaultDeviceUpsertForm();
    form.externalUrl = '/relative';
    form.customFields = [
      createDeviceCustomFieldDraft({ id: 'field-a', key: 'inventory_id', value: 'one' }),
      createDeviceCustomFieldDraft({ id: 'field-b', key: ' inventory_id ', value: 'two' }),
    ];

    const errors = validateDeviceUpsertForm(form, ALL_FIELDS);

    expect(errors?.sourceLabel).toBe('Вкажіть джерельну мітку.');
    expect(errors?.name).toBeUndefined();
    expect(errors?.externalUrl).toBe('Посилання має бути абсолютним URL');
    expect(errors?.customFieldRows['field-b'].key).toBe(
      'Ключі кастомних полів мають бути унікальними.',
    );
    expect(
      validateDeviceUpsertForm(
        { ...form, sourceLabel: '', externalUrl: '/relative' },
        { sourceData: false, analyticalData: true },
      ),
    ).toBeNull();
  });

  it('maps backend form errors to editable fields', () => {
    expect(parseDeviceServerFieldErrors(new Error('[[' + '"name","invalid"' + ']]'))).toEqual({
      name: 'invalid',
    });
    expect(
      parseDeviceServerFieldErrors(
        new Error(
          '[[' + '"source_label","invalid source"' + '],["custom_fields","invalid fields"]]',
        ),
      ),
    ).toEqual({
      sourceLabel: 'invalid source',
      customFields: 'invalid fields',
    });
    expect(parseDeviceServerFieldErrors(new Error('Пристрій з такою назвою вже існує'))).toEqual(
      {},
    );
  });
});
