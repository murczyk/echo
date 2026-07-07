import { describe, expect, it } from 'vitest';

import type { DeviceDetails } from '../../../../Bindings';
import {
  buildCreateDeviceFilesReq,
  buildCreateDeviceReq,
  buildUpdateDevicePatch,
  createDefaultDeviceUpsertForm,
  createDeviceCustomFieldDraft,
  createDeviceFileDraft,
  deviceDetailsToUpsertForm,
  hasDeviceUpdatePatchChanges,
  parseDeviceServerFieldErrors,
  validateDeviceFileRows,
  validateDeviceUpsertForm,
} from './device-form';

const DEVICE_ID = '018f0000-0000-7000-8000-000000000000';

function buildDevice(overrides: Partial<DeviceDetails> = {}): DeviceDetails {
  return {
    id: DEVICE_ID,
    name: 'Device Alpha',
    createdBy: 'operator',
    aorId: 4,
    aorName: 'AOR',
    unitId: 7,
    unitName: 'Unit',
    customFields: [{ label: 'Serial', value: '123' }],
    externalUrl: 'https://example.test/device',
    deleted: false,
    createdAtMs: 10,
    updatedAtMs: 20,
    deletedAtMs: null,
    ...overrides,
  };
}

describe('device form helpers', () => {
  it('builds create request with trimmed fields, null clears, and optional files', () => {
    const form = createDefaultDeviceUpsertForm();
    form.name = '  Device Beta  ';
    form.aorId = 10;
    form.unitId = null;
    form.externalUrl = '  https://example.test/beta  ';
    form.customFields = [createDeviceCustomFieldDraft({ label: ' Serial ', value: ' 123 ' })];
    form.files = [
      createDeviceFileDraft({
        originalName: ' scan.pdf ',
        originalAbsolutePath: ' ',
        originalCreatedAt: '2026-07-07T10:30',
      }),
    ];

    const req = buildCreateDeviceReq(form);

    expect(req).toMatchObject({
      name: 'Device Beta',
      aorId: 10,
      unitId: null,
      customFields: [{ label: 'Serial', value: '123' }],
      externalUrl: 'https://example.test/beta',
    });
    expect(req.files).toHaveLength(1);
    expect(req.files?.[0].originalName).toBe('scan.pdf');
    expect(req.files?.[0].originalAbsolutePath).toBeNull();
    expect(req.files?.[0].originalCreatedAtMs).toEqual(expect.any(Number));
  });

  it('submits create customFields empty array and files null by default', () => {
    const form = createDefaultDeviceUpsertForm();
    form.name = 'Device Beta';

    expect(buildCreateDeviceReq(form)).toEqual({
      name: 'Device Beta',
      aorId: null,
      unitId: null,
      customFields: [],
      externalUrl: null,
      files: null,
    });
  });

  it('builds update patch with only dirty fields and explicit null clears', () => {
    const device = buildDevice();
    const form = deviceDetailsToUpsertForm(device);
    form.name = ' Device Alpha Prime ';
    form.aorId = null;
    form.unitId = null;
    form.externalUrl = ' ';
    form.customFields = [];
    form.files = [createDeviceFileDraft({ originalAbsolutePath: '/tmp/new.bin' })];

    expect(buildUpdateDevicePatch(device, form)).toEqual({
      deviceId: DEVICE_ID,
      name: 'Device Alpha Prime',
      aorId: null,
      unitId: null,
      customFields: [],
      externalUrl: null,
      files: [
        {
          originalName: null,
          originalAbsolutePath: '/tmp/new.bin',
          originalCreatedAtMs: null,
          originalModifiedAtMs: null,
        },
      ],
    });
  });

  it('detects no-op update patches', () => {
    const device = buildDevice();
    const patch = buildUpdateDevicePatch(device, deviceDetailsToUpsertForm(device));

    expect(patch).toEqual({ deviceId: DEVICE_ID });
    expect(hasDeviceUpdatePatchChanges(patch)).toBe(false);
  });

  it('validates custom fields, duplicate labels, file rows, and URL', () => {
    const form = createDefaultDeviceUpsertForm();
    form.name = 'Device';
    form.externalUrl = '/relative';
    form.customFields = [
      createDeviceCustomFieldDraft({ id: 'a', label: 'Serial', value: '1' }),
      createDeviceCustomFieldDraft({ id: 'b', label: ' Serial ', value: '2' }),
    ];
    form.files = [createDeviceFileDraft({ id: 'f', originalCreatedAt: 'not-a-date' })];

    const errors = validateDeviceUpsertForm(form);

    expect(errors?.externalUrl).toBe('Посилання має бути абсолютним URL');
    expect(errors?.customFieldRows.b.label).toBe('Додаткове поле з такою назвою вже існує.');
    expect(errors?.fileRows.f.row).toBe('Потрібна назва файлу або абсолютний шлях.');
    expect(errors?.fileRows.f.originalCreatedAt).toBe('Некоректний час файлу.');
  });

  it('requires file rows for standalone batch create', () => {
    expect(validateDeviceFileRows([], { rejectEmpty: true }).files).toBe(
      'Додайте принаймні один файл.',
    );

    expect(
      buildCreateDeviceFilesReq(DEVICE_ID, [createDeviceFileDraft({ originalName: 'scan.pdf' })]),
    ).toEqual({
      deviceId: DEVICE_ID,
      files: [
        {
          originalName: 'scan.pdf',
          originalAbsolutePath: null,
          originalCreatedAtMs: null,
          originalModifiedAtMs: null,
        },
      ],
    });
  });

  it('maps backend form errors to fields including duplicate name', () => {
    expect(parseDeviceServerFieldErrors(new Error('[["name","duplicate"]]'))).toEqual({
      name: 'duplicate',
    });
    expect(parseDeviceServerFieldErrors(new Error('Пристрій з такою назвою вже існує'))).toEqual({
      name: 'Пристрій з такою назвою вже існує',
    });
  });
});
