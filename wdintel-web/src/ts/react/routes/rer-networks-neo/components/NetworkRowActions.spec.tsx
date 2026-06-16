/**
 * @vitest-environment happy-dom
 */
import { act, createElement } from 'react';
import type { ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Network } from '../../../../Bindings';
import { NETWORK_STATUS_ACTIVE } from '../../rer-network-details-neo/network-status';
import { buildNetworkRowView } from '../helpers';
import { NetworkRowActions } from './NetworkRowActions';

vi.mock('@mui/material', () => ({
  Box: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
}));

vi.mock('@mui/icons-material/Delete', () => ({
  default: () => <span>delete-icon</span>,
}));

vi.mock('@mui/icons-material/Edit', () => ({
  default: () => <span>edit-icon</span>,
}));

vi.mock('@mui/icons-material/MapOutlined', () => ({
  default: () => <span>map-icon</span>,
}));

vi.mock('@mui/icons-material/SummarizeOutlined', () => ({
  default: () => <span>report-icon</span>,
}));

vi.mock('../../../components/MrtRowActionButton', () => ({
  MrtRowActionButton: ({
    label,
    opensModal,
  }: {
    label: string;
    opensModal?: boolean;
  }) => (
    <button type="button" data-label={label} data-opens-modal={opensModal === true ? 'true' : 'false'}>
      {label}
    </button>
  ),
  MrtRowActions: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
}));

function buildNetwork(id: number): Network {
  return {
    id,
    freqs: [],
    unitIds: [],
    aorIds: [],
    name: `Network ${id}`,
    location: `Location ${id}`,
    radioStation: null,
    createdAt: 0,
    purpose: null,
    operationMode: null,
    operationType: null,
    operationPeriod: null,
    lastUpdatedAt: 0,
    lastUpdatedBy: 'tester',
    activeFrom: null,
    activeTo: null,
    postIds: [],
    descriptions: [],
    deleted: false,
    status: NETWORK_STATUS_ACTIVE,
  };
}

afterEach(() => {
  document.body.innerHTML = '';
});

describe('NetworkRowActions', () => {
  it('marks modal row actions so they can use the shared focus fix', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    const network = buildNetworkRowView(buildNetwork(1), new Map(), new Map(), new Map());

    act(() => {
      root.render(
        createElement(NetworkRowActions, {
          network,
          canEdit: true,
          canExport: true,
          canDelete: true,
          onOpenReportDialog: vi.fn(),
          onOpenEditDialog: vi.fn(),
          onOpenDeleteDialog: vi.fn(),
        }),
      );
    });

    const buttons = Array.from(container.querySelectorAll('button'));
    expect(buttons.map((button) => button.getAttribute('data-label'))).toEqual(['Еталонний опис', 'Пеленгація', 'Редагувати', 'Видалити']);
    expect(buttons.map((button) => button.getAttribute('data-opens-modal'))).toEqual(['true', 'false', 'true', 'true']);

    root.unmount();
    container.remove();
  });
});
