import { describe, expect, it } from 'vitest';

import type { DeviceDetails } from '../../../../../Bindings';
import {
  buildCreateDeviceReq,
  buildUpdateDevicePatch,
  createDefaultDeviceUpsertForm,
  createDeviceCustomFieldDraft,
  deviceDetailsToUpsertForm,
  parseDeviceServerFieldErrors,
  type DeviceFieldPermissions,
} from '.././device-form';

const DEVICE_ID = '018f0000-0000-7000-8000-000000000000';
const ALL_FIELDS: DeviceFieldPermissions = { sourceData: true, analyticalData: true };
const SOURCE_FIELDS: DeviceFieldPermissions = { sourceData: true, analyticalData: false };
const ANALYTICAL_FIELDS: DeviceFieldPermissions = { sourceData: false, analyticalData: true };

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

describe('device form helpers', () => {
  it('omits analytical fields from Cyber create requests', () => {
    const form = createDefaultDeviceUpsertForm();
    form.name = 'Device Beta';
    form.externalUrl = 'https://example.test/beta';

    expect(buildCreateDeviceReq(form, SOURCE_FIELDS)).toEqual({
      externalUrl: 'https://example.test/beta',
      customFields: {},
    });
  });
  it('uses null for deliberate clears and omits unchanged update fields', () => {
    const device = buildDevice();
    const form = deviceDetailsToUpsertForm(device);
    form.aorIds = [];
    form.unitId = null;
    form.externalUrl = ' ';
    form.customFields = [
      createDeviceCustomFieldDraft({ key: 'inventory_id', value: 'node-2' }),
      createDeviceCustomFieldDraft({ key: 'transport', value: 'ssh' }),
    ];

    expect(buildUpdateDevicePatch(device, form, ALL_FIELDS)).toEqual({
      deviceId: DEVICE_ID,
      aorIds: [],
      unitId: null,
      externalUrl: null,
      customFields: { inventory_id: 'node-2', retired: null, transport: 'ssh' },
    });
  });
  it('filters every changed field group in both permission directions', () => {
    const device = buildDevice();
    const form = deviceDetailsToUpsertForm(device);
    form.name = ' Changed device name ';
    form.aorIds = [];
    form.unitId = null;
    form.externalUrl = 'https://example.test/updated';
    form.customFields = [
      createDeviceCustomFieldDraft({ key: 'inventory_id', value: 'node-2' }),
      createDeviceCustomFieldDraft({ key: 'transport', value: 'ssh' }),
    ];

    expect(buildUpdateDevicePatch(device, form, SOURCE_FIELDS)).toEqual({
      deviceId: DEVICE_ID,
      externalUrl: 'https://example.test/updated',
      customFields: { inventory_id: 'node-2', retired: null, transport: 'ssh' },
    });
    expect(buildUpdateDevicePatch(device, form, ANALYTICAL_FIELDS)).toEqual({
      deviceId: DEVICE_ID,
      name: 'Changed device name',
      aorIds: [],
      unitId: null,
    });
  });
  it('maps backend form errors to editable fields', () => {
    expect(
      parseDeviceServerFieldErrors(
        new Error(
          '[[' +
            '"name","invalid name"' +
            '],["aor_ids","invalid AOR"],["unit_id","invalid unit"],["external_url","invalid URL"],["custom_fields.inventory_id","invalid custom field"],["unknown_field","ignored"]]',
        ),
      ),
    ).toEqual({
      name: 'invalid name',
      aorIds: 'invalid AOR',
      unitId: 'invalid unit',
      externalUrl: 'invalid URL',
      customFields: 'invalid custom field',
    });
    expect(parseDeviceServerFieldErrors(new Error('Пристрій з такою назвою вже існує'))).toEqual(
      {},
    );
    expect(parseDeviceServerFieldErrors(new Error('[["name","invalid"]'))).toEqual({});
  });
});
