/**
 * @vitest-environment happy-dom
 */
import type { ReactNode } from 'react';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { HoverPopoverState } from './NetworkHoverPopovers';
import { NetworkHoverPopovers } from './NetworkHoverPopovers';

vi.mock('@mui/material', () => ({
  Box: ({ children, ...props }: { children?: ReactNode; [key: string]: unknown }) => (
    <div {...props}>{children}</div>
  ),
  Paper: ({ children, ...props }: { children?: ReactNode; [key: string]: unknown }) => (
    <div {...props}>{children}</div>
  ),
  Popper: ({
    children,
    open,
    ...props
  }: {
    children?: ReactNode;
    open?: boolean;
    [key: string]: unknown;
  }) => (open ? <div {...props}>{children}</div> : null),
  Stack: ({ children, ...props }: { children?: ReactNode; [key: string]: unknown }) => (
    <div {...props}>{children}</div>
  ),
}));

function buildRow() {
  return {
    activeFrequencies: [
      {
        id: 1,
        freq: '145.125',
        kind: 'DMR',
        encryptionKeys: [
          {
            id: 11,
            description: 'AES',
            key: 'k1',
            keyHash: null,
            modulationId: null,
            sigintNetworkId: null,
            sigintNetworkFreqIds: [],
          },
        ],
      },
    ],
    inactiveFrequencies: [
      {
        id: 2,
        freq: '433.700',
        kind: 'FM',
        encryptionKeys: [
          {
            id: 12,
            description: 'SECRET',
            key: 'k2',
            keyHash: null,
            modulationId: null,
            sigintNetworkId: null,
            sigintNetworkFreqIds: [],
          },
        ],
      },
    ],
    network: {
      location: 'Київ',
    },
  } as never;
}

describe('NetworkHoverPopovers', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('shows grouped frequencies without metadata chips', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    const hoverPopover: HoverPopoverState = {
      kind: 'freq',
      anchorEl: document.createElement('div'),
      row: buildRow(),
    };

    act(() => {
      root.render(
        createElement(NetworkHoverPopovers, {
          hoverPopover,
          onClose: () => undefined,
          onPointerEnter: () => undefined,
          onPointerLeave: () => undefined,
        }),
      );
    });

    expect(document.body.textContent).toContain('Активні');
    expect(document.body.textContent).toContain('145.125');
    expect(document.body.textContent).toContain('Неактивні');
    expect(document.body.textContent).toContain('433.700');
    expect(document.body.textContent).not.toContain('DMR');
    expect(document.body.textContent).not.toContain('FM');
    expect(document.body.textContent).not.toContain('AES');
    expect(document.body.textContent).not.toContain('SECRET');

    act(() => {
      root.unmount();
    });
    container.remove();
  });
});
