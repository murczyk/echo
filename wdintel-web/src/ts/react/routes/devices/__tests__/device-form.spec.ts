import { describe, expect, it } from 'vitest';

import type { DeviceDetails } from '../../../../../Bindings';
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
} from '.././device-form';

const DEVICE_ID = '018f0000-0000-7000-8000-000000000000';
const ALL_FIELDS: DeviceFieldPermissions = { sourceData: true, analyticalData: true };
const SOURCE_FIELDS: DeviceFieldPermissions = { sourceData: true, analyticalData: false };

function buildDevice(overrides: Partial<DeviceDetails> = {}): DeviceDetails {
  return {
    id: DEVICE_ID,
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

// @test-scope parser: device create and update request payload fixtures.
describe('device form helpers', () => {
  it('builds create requests from every permitted create field', () => {
    const form = createDefaultDeviceUpsertForm();
    form.name = '  Device Beta  ';
    form.aorIds = [10, 20];
    form.unitId = 7;
    form.externalUrl = '  https://example.test/beta  ';
    form.customFields = [
      createDeviceCustomFieldDraft({ key: ' inventory_id ', value: ' node-2 ' }),
    ];

    expect(buildCreateDeviceReq(form, ALL_FIELDS)).toEqual({
      name: 'Device Beta',
      externalUrl: 'https://example.test/beta',
      customFields: { inventory_id: ' node-2 ' },
    });
  });

  it('omits analytical fields from Cyber create requests', () => {
    const form = createDefaultDeviceUpsertForm();
    form.name = 'Device Beta';
    form.externalUrl = 'https://example.test/beta';

    expect(buildCreateDeviceReq(form, SOURCE_FIELDS)).toEqual({
      externalUrl: 'https://example.test/beta',
      customFields: {},
    });
  });
  it('maps a missing device name to an empty editable value', () => {
    expect(deviceDetailsToUpsertForm(buildDevice({ name: null })).name).toBe('');
  });

  it('builds a presence-aware update patch for every permitted field group', () => {
    const device = buildDevice();
    const form = deviceDetailsToUpsertForm(device);
    form.name = ' Device Gamma ';
    form.aorIds = [];
    form.unitId = null;
    form.externalUrl = ' ';
    form.customFields = [
      createDeviceCustomFieldDraft({ key: 'inventory_id', value: 'node-2' }),
      createDeviceCustomFieldDraft({ key: 'transport', value: 'ssh' }),
    ];

    expect(buildUpdateDevicePatch(device, form, ALL_FIELDS)).toEqual({
      deviceId: DEVICE_ID,
      name: 'Device Gamma',
      aorIds: [],
      unitId: null,
      externalUrl: null,
      customFields: { inventory_id: 'node-2', retired: null, transport: 'ssh' },
    });
  });

  it('does not send changes from a field group without permission', () => {
    const device = buildDevice();
    const form = deviceDetailsToUpsertForm(device);
    form.name = 'Changed device name';
    form.aorIds = [];
    form.unitId = null;
    form.externalUrl = 'https://example.test/updated';

    expect(buildUpdateDevicePatch(device, form, SOURCE_FIELDS)).toEqual({
      deviceId: DEVICE_ID,
      externalUrl: 'https://example.test/updated',
    });
  });

  it('detects no-op update patches', () => {
    const device = buildDevice();
    const patch = buildUpdateDevicePatch(device, deviceDetailsToUpsertForm(device), ALL_FIELDS);

    expect(patch).toEqual({ deviceId: DEVICE_ID });
    expect(hasDeviceUpdatePatchChanges(patch)).toBe(false);
  });

  it('validates only permitted fields and requires a name', () => {
    const form = createDefaultDeviceUpsertForm();
    form.externalUrl = '/relative';
    form.customFields = [
      createDeviceCustomFieldDraft({ id: 'field-a', key: 'inventory_id', value: 'one' }),
      createDeviceCustomFieldDraft({ id: 'field-b', key: ' inventory_id ', value: 'two' }),
    ];

    const errors = validateDeviceUpsertForm(form, ALL_FIELDS);

    expect(errors?.name).toBe('Вкажіть назву пристрою.');
    expect(errors?.externalUrl).toBe('Посилання має бути абсолютним URL');
    expect(errors?.customFieldRows['field-b'].key).toBe(
      'Ключі кастомних полів мають бути унікальними.',
    );
    expect(
      validateDeviceUpsertForm(
        { ...form, externalUrl: '/relative' },
        { sourceData: false, analyticalData: true },
      )?.name,
    ).toBe('Вкажіть назву пристрою.');
  });

  it('maps backend form errors to editable fields', () => {
    expect(parseDeviceServerFieldErrors(new Error('[[' + '"name","invalid"' + ']]'))).toEqual({
      name: 'invalid',
    });
    expect(
      parseDeviceServerFieldErrors(
        new Error('[[' + '"external_url","invalid URL"' + '],["custom_fields","invalid fields"]]'),
      ),
    ).toEqual({
      externalUrl: 'invalid URL',
      customFields: 'invalid fields',
    });
    expect(parseDeviceServerFieldErrors(new Error('Пристрій з такою назвою вже існує'))).toEqual(
      {},
    );
  });
});
