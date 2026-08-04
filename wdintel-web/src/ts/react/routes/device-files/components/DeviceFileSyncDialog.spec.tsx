/**
 * @vitest-environment happy-dom
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { DeviceFileSyncRow } from '../types';
import { DeviceFileSyncDialog } from './DeviceFileSyncDialog';

vi.mock('../../../components/PowerDateTimePicker', () => ({
  PowerDateTimePicker: ({ label }: { label: string }) => <div>{label}</div>,
}));

const DEVICE_ID = '018f0000-0000-7000-8000-000000000000';
const ROOT_ID = '018f0000-0000-7000-8000-000000000001';
const FILE_ID = '018f0000-0000-7000-8000-000000000002';
const NOW = '2026-07-24T08:00:00Z';

function buildRow(localId: string): DeviceFileSyncRow {
  return {
    localId,
    fileId: null,
    absolutePath: 'C:\\rejected.log',
    mimeType: '',
    extension: '',
    fileMetadataCreatedAt: null,
    fileMetadataModifiedAt: null,
    fieldErrors: { absolutePath: 'invalid path' },
    result: {
      kind: 'rejected',
      error: {
        kind: 'validation',
        message: 'bad path',
        fieldErrors: [['files[0].absolute_path', 'invalid path']],
      },
    },
  };
}

function buildAcceptedRow(): DeviceFileSyncRow {
  return {
    ...buildRow('accepted'),
    result: {
      kind: 'accepted',
      operation: 'updated',
      root: {
        entryId: ROOT_ID,
        deviceId: DEVICE_ID,
        parentEntryId: null,
        kind: 'directory',
        name: 'C:\\',
        createdAt: NOW,
        updatedAt: NOW,
      },
      file: {
        fileId: FILE_ID,
        deviceId: DEVICE_ID,
        parentEntryId: ROOT_ID,
        rootEntryId: ROOT_ID,
        absolutePath: 'C:\\canonical.log',
        name: 'canonical.log',
        pathComponents: ['canonical.log'],
        mimeType: null,
        extension: 'log',
        fileMetadataCreatedAt: null,
        fileMetadataModifiedAt: null,
        createdAt: NOW,
        updatedAt: NOW,
      },
    },
  };
}

let container: HTMLDivElement | null = null;
let root: Root | null = null;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  document.body.replaceChildren();
  root = null;
  container = null;
});

describe('DeviceFileSyncDialog', () => {
  it('freezes accepted rows and keeps rejected fields correctable', () => {
    const onSubmit = vi.fn();
    act(() => {
      root?.render(
        <DeviceFileSyncDialog
          open
          rows={[buildAcceptedRow(), buildRow('rejected')]}
          submitting={false}
          batchError={null}
          transportUncertain={false}
          canSubmit
          onClose={vi.fn()}
          onAddRow={vi.fn()}
          onRemoveRow={vi.fn()}
          onChangeRowField={vi.fn()}
          onSubmit={onSubmit}
        />,
      );
    });

    expect(document.body.textContent).toContain('Оновлено: C:\\canonical.log');
    expect(document.body.textContent).toContain(`Root ID: ${ROOT_ID}; File ID: ${FILE_ID}`);
    expect(document.body.textContent).toContain('validation: bad path');
    const pathInput = document.body.querySelector('input[value="C:\\\\rejected.log"]');
    expect(pathInput).not.toBeNull();
    expect(document.body.textContent).toContain('invalid path');
    expect(document.body.textContent).toContain('Абсолютний шлях Windows');
    expect(document.body.textContent).not.toContain('Синтаксис шляхів');

    const submitButton = Array.from(document.body.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('Повторити відхилені'),
    );
    act(() => submitButton?.click());
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it('shows transport uncertainty without presenting an automatic retry', () => {
    act(() => {
      root?.render(
        <DeviceFileSyncDialog
          open
          rows={[buildRow('uncertain')]}
          submitting={false}
          batchError="Результат запиту невідомий"
          transportUncertain
          canSubmit
          onClose={vi.fn()}
          onAddRow={vi.fn()}
          onRemoveRow={vi.fn()}
          onChangeRowField={vi.fn()}
          onSubmit={vi.fn()}
        />,
      );
    });

    expect(document.body.textContent).toContain('Автоматичний повтор вимкнено');
    expect(document.body.textContent).not.toContain('Повторити автоматично');
  });
});
