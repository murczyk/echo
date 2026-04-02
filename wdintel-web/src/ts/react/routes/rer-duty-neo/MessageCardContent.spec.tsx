/**
 * @vitest-environment happy-dom
 */
import type { ReactNode } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { InboxMessage, Network } from '../../../../Bindings';
import { MessageCardEtalonLocationTime } from './MessageCardContent';

type PrimitiveProps = { children?: ReactNode; component?: string } & Record<string, unknown>;

function omitMuiLayoutProps(props: Record<string, unknown>) {
  const clone = { ...props };
  delete clone.sx;
  delete clone.spacing;
  delete clone.direction;
  delete clone.alignItems;
  delete clone.justifyContent;
  delete clone.useFlexGap;
  delete clone.flexWrap;
  delete clone.placement;
  delete clone.title;
  delete clone.variant;
  delete clone.color;
  return clone;
}

vi.mock('@mui/icons-material/ExpandMore', () => ({
  default: () => <span>expand</span>,
}));

vi.mock('@mui/material', () => ({
  Box: ({ children, component, ...props }: PrimitiveProps) => {
    const Component = component ?? 'div';
    return <Component {...omitMuiLayoutProps(props)}>{children}</Component>;
  },
  Button: ({ children, ...props }: { children?: ReactNode } & Record<string, unknown>) => (
    <button {...omitMuiLayoutProps(props)}>{children}</button>
  ),
  Collapse: ({ children, in: open }: { children?: ReactNode; in?: boolean }) => (open ? <>{children}</> : null),
  Link: ({ children, href, ...props }: { children?: ReactNode; href?: string } & Record<string, unknown>) => (
    <a href={href} {...omitMuiLayoutProps(props)}>{children}</a>
  ),
  Stack: ({ children, component, ...props }: PrimitiveProps) => {
    const Component = component ?? 'div';
    return <Component {...omitMuiLayoutProps(props)}>{children}</Component>;
  },
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  Typography: ({ children, component, ...props }: PrimitiveProps) => {
    const Component = component ?? 'div';
    return <Component {...omitMuiLayoutProps(props)}>{children}</Component>;
  },
}));

vi.mock('../../components/PowerChip', () => ({
  PowerChip: ({ label }: { label: ReactNode }) => <button>{label}</button>,
}));

type Rendered = {
  container: HTMLDivElement;
  root: Root;
};

function buildMessage(overrides: Partial<InboxMessage> = {}): InboxMessage {
  return {
    location: 'ЛИМАН ПЕРШИЙ',
    timestamp: 1_709_999_940_000,
    networkIds: [7],
    tags: [],
    inboxTags: [],
    pointTokens: [],
    textMarked: [],
    ...overrides,
  } as InboxMessage;
}

async function renderEtalonLocationTime(): Promise<Rendered> {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);

  await act(async () => {
    root.render(
      <MessageCardEtalonLocationTime
        compact
        networkIds={[7]}
        networkDisplayMap={{ 7: 'р/м Alpha' }}
        networkMap={{ 7: { id: 7, name: 'Alpha', unitIds: [], location: null } as Network }}
        etalonNoNetworkLabel={null}
        msg={buildMessage()}
        relativeTimeMs={1_710_000_000_000}
      />,
    );
  });

  return { container, root };
}

describe('MessageCardEtalonLocationTime', () => {
  const rendered: Rendered[] = [];

  afterEach(() => {
    for (const item of rendered.splice(0)) {
      act(() => {
        item.root.unmount();
      });
      item.container.remove();
    }
  });

  it('renders compact location details in an isolated unit scenario', async () => {
    const view = await renderEtalonLocationTime();
    rendered.push(view);

    expect(view.container.textContent).toContain('р/м Alpha');
    expect(view.container.textContent).toContain('в дорозвідці');
    expect(view.container.textContent).toContain('ЛИМАН ПЕРШИЙ');
    expect(view.container.textContent).toContain('1 хв');
    expect(view.container.querySelector('a')?.getAttribute('href')).toBe('/rer-networks/7');
  });
});
