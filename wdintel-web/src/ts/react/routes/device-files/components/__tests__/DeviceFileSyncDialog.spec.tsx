/**
 * @vitest-environment happy-dom
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { DeviceFileSyncRow } from '../../types';
import { DeviceFileSyncDialog } from '.././DeviceFileSyncDialog';

vi.mock('../../../../components/PowerDateTimePicker', () => ({
  PowerDateTimePicker: ({ label }: { label: string }) => <div>{label}</div>,
}));

const DEVICE_ID = '018f0000-0000-7000-8000-000000000000';
const ROOT_ID = '018f0000-0000-7000-8000-000000000001';
const FILE_ID = '018f0000-0000-7000-8000-000000000002';
const SYNC_ID = '018f0000-0000-7000-8000-000000000003';
const NOW = '2026-07-24T08:00:00Z';

function buildRow(localId: string): DeviceFileSyncRow {
  return {
    localId,
    existing: false,
    absolutePath: 'C:\\rejected.log',
    mimeType: '',
    extension: '',
    fileMetadataCreatedAt: null,
    fileMetadataModifiedAt: null,
    sourceFileState: null,
    fieldErrors: { absolutePath: 'invalid path' },
    result: {
      kind: 'rejected',
      code: 'validation',
      message: 'bad path',
      fieldErrors: [{ path: 'files[0].absolute_path', message: 'invalid path' }],
    },
  };
}

function buildAcceptedRow(): DeviceFileSyncRow {
  return {
    ...buildRow('accepted'),
    result: {
      kind: 'accepted',
      operation: 'updated',
      fileId: FILE_ID,
      revision: 2,
      file: {
        fileId: FILE_ID,
        deviceId: DEVICE_ID,
        parentEntryId: ROOT_ID,
        rootEntryId: ROOT_ID,
        absolutePath: 'C:\\canonical.log',
        hasContent: false,
        name: 'canonical.log',
        pathComponents: ['canonical.log'],
        mimeType: null,
        extension: 'log',
        fileMetadataCreatedAt: null,
        fileMetadataModifiedAt: null,
        createdAt: NOW,
        updatedAt: NOW,
        revision: 2,
        syncId: SYNC_ID,
        sourceFileState: null,
        tags: [],
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

// @test-scope safeguard: prevents accepted file-sync results from being resubmitted and transport-uncertain batches from retrying automatically.
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
          syncSummary={{
            syncId: SYNC_ID,
            deviceId: DEVICE_ID,
            mode: 'automatic',
            status: 'completed_with_errors',
            nextBatchIndex: 1,
            counts: { received: 2, accepted: 1, created: 0, updated: 1, rejected: 1 },
            createdAt: NOW,
            updatedAt: NOW,
            completedAt: NOW,
            expiresAt: null,
          }}
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
    expect(document.body.textContent).toContain(
      `Root ID: ${ROOT_ID}; File ID: ${FILE_ID}; Revision: 2`,
    );
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
          syncSummary={null}
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
