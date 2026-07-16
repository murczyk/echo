import { describe, expect, it } from 'vitest';

import type { DeviceDetails } from '../../../../Bindings';
import {
  buildCreateDeviceFilesReq,
  buildCreateDeviceReq,
  buildUpdateDevicePatch,
  createDefaultDeviceUpsertForm,
  createDeviceTagDraft,
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
    aorIds: [4],
    aorNames: ['AOR'],
    unitId: 7,
    unitName: 'Unit',
    tags: [{ label: 'Serial', value: '123' }],
    externalUrl: 'https://example.test/device',
    hostname: null,
    sshPort: null,
    archived: false,
    createdAtMs: 10,
    updatedAtMs: 20,
    archivedAtMs: null,
    ...overrides,
  };
}

describe('device form helpers', () => {
  it('builds create request with trimmed fields, null clears, and optional files', () => {
    const form = createDefaultDeviceUpsertForm();
    form.name = '  Device Beta  ';
    form.aorIds = [10, 20];
    form.unitId = null;
    form.externalUrl = '  https://example.test/beta  ';
    form.hostname = '  device.example  ';
    form.sshPort = '2222';
    form.tags = [createDeviceTagDraft({ label: ' Serial ', value: ' 123 ' })];
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
      aorIds: [10, 20],
      unitId: null,
      tags: [{ label: 'Serial', value: '123' }],
      externalUrl: 'https://example.test/beta',
      hostname: 'device.example',
      sshPort: 2222,
    });
    expect(req.files).toHaveLength(1);
    expect(req.files?.[0].originalName).toBe('scan.pdf');
    expect(req.files?.[0].originalAbsolutePath).toBeNull();
    expect(req.files?.[0].originalCreatedAtMs).toEqual(expect.any(Number));
  });

  it('submits create tags empty array and files null by default', () => {
    const form = createDefaultDeviceUpsertForm();
    form.name = 'Device Beta';

    expect(buildCreateDeviceReq(form)).toEqual({
      name: 'Device Beta',
      aorIds: [],
      unitId: null,
      tags: [],
      externalUrl: null,
      hostname: null,
      sshPort: null,
      files: null,
    });
  });

  it('builds update patch with only dirty fields and explicit null clears', () => {
    const device = buildDevice({ hostname: 'device.example', sshPort: 22 });
    const form = deviceDetailsToUpsertForm(device);
    form.name = ' Device Alpha Prime ';
    form.aorIds = [];
    form.unitId = null;
    form.externalUrl = ' ';
    form.hostname = ' ';
    form.sshPort = '';
    form.tags = [];
    form.files = [createDeviceFileDraft({ originalAbsolutePath: '/tmp/new.bin' })];

    expect(buildUpdateDevicePatch(device, form)).toEqual({
      deviceId: DEVICE_ID,
      name: 'Device Alpha Prime',
      aorIds: [],
      unitId: null,
      tags: [],
      externalUrl: null,
      hostname: null,
      sshPort: null,
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
    const device = buildDevice({ hostname: 'device.example', sshPort: 22 });
    const patch = buildUpdateDevicePatch(device, deviceDetailsToUpsertForm(device));

    expect(patch).toEqual({ deviceId: DEVICE_ID });
    expect(hasDeviceUpdatePatchChanges(patch)).toBe(false);
  });

  it('validates tags, duplicate labels, file rows, and URL', () => {
    const form = createDefaultDeviceUpsertForm();
    form.name = 'Device';
    form.externalUrl = '/relative';
    form.hostname = 'x'.repeat(256);
    form.sshPort = '65536';
    form.tags = [
      createDeviceTagDraft({ id: 'a', label: 'Serial', value: '1' }),
      createDeviceTagDraft({ id: 'b', label: ' Serial ', value: '2' }),
    ];
    form.files = [createDeviceFileDraft({ id: 'f', originalCreatedAt: 'not-a-date' })];

    const errors = validateDeviceUpsertForm(form);

    expect(errors?.externalUrl).toBe('Посилання має бути абсолютним URL');
    expect(errors?.hostname).toBe('Значення занадто довге');
    expect(errors?.sshPort).toBe('SSH-порт має бути від 1 до 65535');
    expect(errors?.tagRows.b.label).toBe('Тег з такою назвою вже існує.');
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

  it('maps backend form errors to fields', () => {
    expect(parseDeviceServerFieldErrors(new Error('[["name","invalid"]]'))).toEqual({
      name: 'invalid',
    });
    expect(
      parseDeviceServerFieldErrors(
        new Error('[["hostname","invalid host"],["ssh_port","invalid port"]]'),
      ),
    ).toEqual({
      hostname: 'invalid host',
      sshPort: 'invalid port',
    });
    expect(parseDeviceServerFieldErrors(new Error('Пристрій з такою назвою вже існує'))).toEqual(
      {},
    );
  });
});
