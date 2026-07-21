import { describe, expect, it } from 'vitest';

import type { DeviceDetails } from '../../../../Bindings';
import {
  buildCreateDeviceReq,
  buildUpdateDevicePatch,
  createDefaultDeviceUpsertForm,
  createDeviceCustomFieldDraft,
  createDeviceTagDraft,
  deviceDetailsToUpsertForm,
  hasDeviceUpdatePatchChanges,
  parseDeviceServerFieldErrors,
  validateDeviceUpsertForm,
} from './device-form';

const DEVICE_ID = '018f0000-0000-7000-8000-000000000000';

function buildDevice(overrides: Partial<DeviceDetails> = {}): DeviceDetails {
  return {
    id: DEVICE_ID,
    sourceLabel: 'Source device',
    name: 'Device Alpha',
    createdBy: 'operator',
    aorIds: [4],
    aorNames: ['AOR'],
    unitId: 7,
    unitName: 'Unit',
    tags: [{ label: 'Serial', value: '123' }],
    externalUrl: 'https://example.test/device',
    customFields: { inventory_id: 'node-1', retired: 'no' },
    archived: false,
    createdAtMs: 10,
    updatedAtMs: 20,
    archivedAtMs: null,
    ...overrides,
  };
}

describe('device form helpers', () => {
  it('builds create request with trimmed source metadata', () => {
    const form = createDefaultDeviceUpsertForm();
    form.sourceLabel = '  Source device  ';
    form.name = '  Device Beta  ';
    form.aorIds = [10, 20];
    form.unitId = null;
    form.externalUrl = '  https://example.test/beta  ';
    form.customFields = [
      createDeviceCustomFieldDraft({ key: ' inventory_id ', value: ' node-2 ' }),
    ];
    form.tags = [createDeviceTagDraft({ label: ' Serial ', value: ' 123 ' })];

    expect(buildCreateDeviceReq(form)).toEqual({
      sourceLabel: 'Source device',
      name: 'Device Beta',
      aorIds: [10, 20],
      unitId: null,
      tags: [{ label: 'Serial', value: '123' }],
      externalUrl: 'https://example.test/beta',
      customFields: { inventory_id: ' node-2 ' },
    });
  });

  it('submits empty tags and custom fields by default', () => {
    const form = createDefaultDeviceUpsertForm();
    form.sourceLabel = 'Source device';
    form.name = 'Device Beta';

    expect(buildCreateDeviceReq(form)).toEqual({
      sourceLabel: 'Source device',
      name: 'Device Beta',
      aorIds: [],
      unitId: null,
      tags: [],
      externalUrl: null,
      customFields: {},
    });
  });

  it('builds update patch with source-label and custom-field changes', () => {
    const device = buildDevice();
    const form = deviceDetailsToUpsertForm(device);
    form.sourceLabel = ' Updated source ';
    form.name = ' Device Alpha Prime ';
    form.aorIds = [];
    form.unitId = null;
    form.externalUrl = ' ';
    form.tags = [];
    form.customFields = [
      createDeviceCustomFieldDraft({ key: 'inventory_id', value: 'node-2' }),
      createDeviceCustomFieldDraft({ key: 'transport', value: 'ssh' }),
    ];

    expect(buildUpdateDevicePatch(device, form)).toEqual({
      deviceId: DEVICE_ID,
      sourceLabel: 'Updated source',
      name: 'Device Alpha Prime',
      aorIds: [],
      unitId: null,
      tags: [],
      externalUrl: null,
      customFields: { inventory_id: 'node-2', retired: null, transport: 'ssh' },
    });
  });

  it('detects no-op update patches', () => {
    const device = buildDevice();
    const patch = buildUpdateDevicePatch(device, deviceDetailsToUpsertForm(device));

    expect(patch).toEqual({ deviceId: DEVICE_ID });
    expect(hasDeviceUpdatePatchChanges(patch)).toBe(false);
  });

  it('validates source metadata, custom fields, tags, and URL', () => {
    const form = createDefaultDeviceUpsertForm();
    form.externalUrl = '/relative';
    form.tags = [
      createDeviceTagDraft({ id: 'tag-a', label: 'Serial', value: '1' }),
      createDeviceTagDraft({ id: 'tag-b', label: ' Serial ', value: '2' }),
    ];
    form.customFields = [
      createDeviceCustomFieldDraft({ id: 'field-a', key: 'inventory_id', value: 'one' }),
      createDeviceCustomFieldDraft({ id: 'field-b', key: ' inventory_id ', value: 'two' }),
    ];

    const errors = validateDeviceUpsertForm(form);

    expect(errors?.sourceLabel).toBe('Вкажіть джерельну мітку.');
    expect(errors?.name).toBe('Вкажіть назву пристрою.');
    expect(errors?.externalUrl).toBe('Посилання має бути абсолютним URL');
    expect(errors?.customFieldRows['field-b'].key).toBe(
      'Ключі кастомних полів мають бути унікальними.',
    );
    expect(errors?.tagRows['tag-b'].label).toBe('Тег з такою назвою вже існує.');
  });

  it('maps backend form errors to fields', () => {
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
