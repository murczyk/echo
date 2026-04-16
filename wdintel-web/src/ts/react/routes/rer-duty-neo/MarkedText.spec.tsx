/**
 * @vitest-environment happy-dom
 */
import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { CALLSIGN_TOOLTIP_ITEM_SX, renderMarkedText } from './MarkedText';
import type { CallsignInfoRes, ContentNode, InboxMessage, Network, Unit } from '../../../../Bindings';

function decodeMapHrefState(href: string | null): { search: string; freqs_selected?: string[] } | null {
  if (href == null || href === '') return null;
  const url = new URL(href, 'https://example.test');
  const legacy = url.searchParams.get('state');
  if (legacy != null && legacy !== '') {
    return JSON.parse(decodeURIComponent(legacy)) as { search: string; freqs_selected?: string[] };
  }
  const search = url.searchParams.get('search') ?? '';
  const freqs = url.searchParams.getAll('freqs');
  return {
    search,
    ...(freqs.length > 0 ? { freqs_selected: freqs } : {}),
  };
}

function TestHost(props: {
  nodes: ContentNode[];
  bodyText: string;
  messagePointEtalons?: string[];
  showPointLinks?: boolean;
  message?: InboxMessage;
  callsignInfoMap?: Record<string, CallsignInfoRes>;
  networks?: Network[];
  unitsMap?: Record<number, Unit>;
}) {
  return (
    <div>
      {renderMarkedText(props.nodes, props.bodyText, props.messagePointEtalons, {
        showPointLinks: props.showPointLinks,
        message: props.message,
        callsignInfoMap: props.callsignInfoMap,
        networks: props.networks,
        unitsMap: props.unitsMap,
        freq: props.message?.freq ?? null,
        networkIds: props.message?.networkIds ?? null,
      })}
    </div>
  );
}

const unitsMap: Record<number, Unit> = {
  1: {
    id: 1,
    company: '1',
    battalion: '10',
    regiment: '100',
    division: '1000',
    army: 'A',
    comment: '',
    name: 'Unit A',
    active: true,
    createdAt: 0,
    createdBy: 'test',
  },
  2: {
    id: 2,
    company: '2',
    battalion: '20',
    regiment: '200',
    division: '2000',
    army: 'B',
    comment: '',
    name: 'Unit B',
    active: true,
    createdAt: 0,
    createdBy: 'test',
  },
};

const networks: Network[] = [
  {
    id: 10,
    freqs: [
      {
        id: 1,
        networkId: 10,
        freq: '100.000',
        deleted: false,
        activeFrom: 0,
        activeTo: null,
        createdAt: 0,
        kind: 'voice',
        modulationId: null,
        encryptionKeys: [],
      },
    ],
    unitIds: [1],
    aorIds: [],
    name: 'Alpha',
    location: 'Kyiv',
    radioStation: null,
    createdAt: 0,
    purpose: null,
    operationMode: null,
    operationType: null,
    operationPeriod: null,
    lastUpdatedAt: 0,
    lastUpdatedBy: null,
    activeFrom: null,
    activeTo: null,
    postIds: [],
    descriptions: [],
    deleted: false,
    status: 'NetworkActive',
  },
];

describe('MarkedText', () => {
  const originalGetComputedStyle = window.getComputedStyle;
  let container: HTMLElement;
  let root: Root;

  beforeEach(() => {
    window.getComputedStyle = originalGetComputedStyle;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
      container.remove();
      document.body.innerHTML = '';
    });
  });

  it('renders callsigns with the updated accent color and border width', async () => {
    await act(async () => {
      root.render(
        <TestHost nodes={[{ CNCallsignC: { text: 'abCd', begin: 0, end: 4, etalon: 'abCd' } }]} bodyText="abCd" />,
      );
    });

    const link = container.querySelector('a.content-token--ADP');
    expect(link).not.toBeNull();
    expect(link?.getAttribute('href')).toBe('/rer-callsigns-neo?callsign=ABCD');
    expect(link?.textContent).toBe('ABCD');
  });

  it('renders a filled badge for callsigns that have matching message-network info', async () => {
    await act(async () => {
      root.render(
        <TestHost
          nodes={[{ CNCallsignC: { text: 'wolf', begin: 0, end: 4, etalon: 'wolf' } }]}
          bodyText="wolf"
          message={{ freq: '100.000', networkIds: [10] } as InboxMessage}
          callsignInfoMap={{
            wolf: {
              callsign: 'wolf',
              res: [
                {
                  id: 1,
                  callsign: 'wolf',
                  position: 'cmd',
                  comment: 'prio',
                  unit1: 'u1',
                  unit2: 'u2',
                  unitId: 1,
                  networkIdsReportedIn: [10],
                },
              ],
            },
          }}
          networks={networks}
          unitsMap={unitsMap}
        />,
      );
    });

    expect(container.querySelector('[data-testid="callsign-hint-badge-network"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="callsign-hint-badge-system"]')).toBeNull();
  });

  it('does not render a badge for callsigns that exist only outside message networks', async () => {
    await act(async () => {
      root.render(
        <TestHost
          nodes={[{ CNCallsignC: { text: 'lone', begin: 0, end: 4, etalon: 'lone' } }]}
          bodyText="lone"
          message={{ freq: '100.000', networkIds: [10] } as InboxMessage}
          callsignInfoMap={{
            lone: {
              callsign: 'lone',
              res: [
                {
                  id: 2,
                  callsign: 'lone',
                  position: 'sys',
                  comment: 'catalog',
                  unit1: 'u',
                  unit2: 'v',
                  unitId: 2,
                  networkIdsReportedIn: [20],
                },
              ],
            },
          }}
          networks={networks}
          unitsMap={unitsMap}
        />,
      );
    });

    expect(container.querySelector('a.content-token--ADP')?.textContent).toBe('LONE');
    expect(container.querySelector('[data-testid="callsign-hint-badge-network"]')).toBeNull();
    expect(container.querySelector('[data-testid="callsign-hint-badge-system"]')).toBeNull();
  });

  it('renders an outlined badge for catalog-only callsigns without message networks', async () => {
    await act(async () => {
      root.render(
        <TestHost
          nodes={[{ CNCallsignC: { text: 'fox', begin: 0, end: 3, etalon: 'fox' } }]}
          bodyText="fox"
          message={{ freq: null, networkIds: null } as InboxMessage}
          callsignInfoMap={{
            fox: {
              callsign: 'fox',
              res: [
                {
                  id: 3,
                  callsign: 'fox',
                  position: 'sys',
                  comment: 'catalog',
                  unit1: 's1',
                  unit2: 's2',
                  unitId: 2,
                  networkIdsReportedIn: [20],
                },
              ],
            },
          }}
          networks={networks}
          unitsMap={unitsMap}
        />,
      );
    });

    expect(container.querySelector('[data-testid="callsign-hint-badge-system"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="callsign-hint-badge-network"]')).toBeNull();
  });

  it('uses multiline wrapping styles for long tooltip rows', async () => {
    await act(async () => {
      root.render(
        <TestHost
          nodes={[{ CNCallsignC: { text: 'boroda', begin: 0, end: 6, etalon: 'boroda' } }]}
          bodyText="boroda"
          message={{ freq: null, networkIds: null } as InboxMessage}
          callsignInfoMap={{
            boroda: {
              callsign: 'boroda',
              res: [
                {
                  id: 30,
                  callsign: 'boroda',
                  position: 'Командир отделения 5 мср',
                  comment: '',
                  unit1: '2 мсб 1431 мсп 11 АК',
                  unit2: '',
                  unitId: 2,
                  networkIdsReportedIn: [20],
                },
              ],
            },
          }}
          networks={networks}
          unitsMap={unitsMap}
        />,
      );
    });

    const link = container.querySelector('a.content-token--ADP');
    expect(link).not.toBeNull();
    expect(CALLSIGN_TOOLTIP_ITEM_SX.whiteSpace).toBe('normal');
    expect(CALLSIGN_TOOLTIP_ITEM_SX.overflowWrap).toBe('anywhere');
    expect(CALLSIGN_TOOLTIP_ITEM_SX.wordBreak).toBe('break-word');
  });

  it('renders highlighted keywords as non-interactive orange badges with black text', async () => {
    await act(async () => {
      root.render(<TestHost nodes={[{ CNHighlightC: { text: 'ключове', begin: 0, end: 8 } }]} bodyText="ключове" />);
    });

    const badge = container.querySelector('.badge-highlighed-token');
    expect(badge).not.toBeNull();
    expect(badge?.tagName).toBe('SPAN');
    expect(badge?.textContent).toBe('ключове');
    expect(badge?.getAttribute('style')).toContain('background-color: #fd884f');
    expect(badge?.getAttribute('style')).toContain('color: #000');
    expect(badge?.querySelector('button')).toBeNull();
    expect(badge?.getAttribute('title')).toBeNull();
  });

  it('does not render empty highlighted keywords', async () => {
    await act(async () => {
      root.render(<TestHost nodes={[{ CNHighlightC: { text: '  ', begin: 0, end: 5 } }]} bodyText="текст" />);
    });

    expect(container.querySelector('.badge-highlighed-token')).toBeNull();
    expect(container.textContent).toBe('');
  });

  it('renders point tokens with a menu action that keeps the map tooltip', async () => {
    await act(async () => {
      root.render(
        <TestHost
          nodes={[{ CNPointC: { begin: 0, end: 3, etalon: 'P-1', text: 'P-1' } }]}
          bodyText="P-1"
          messagePointEtalons={['P-1', 'P-2']}
          message={{ freq: '100.125' } as InboxMessage}
        />,
      );
    });

    const title = 'Відкрити на мапі аналізу: P-1, P-2';
    const badge = container.querySelector('.content-token--point');
    const textNode = container.querySelector('.content-token--point-link');
    const button = container.querySelector('button[aria-label="Показати на мапі"]');
    expect(badge?.getAttribute('title')).toBe(title);
    expect(button?.getAttribute('title')).toBe(title);
    expect(textNode?.textContent).toBe('P-1');

    await act(async () => {
      badge?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    const menuItems = Array.from(document.body.querySelectorAll('[role="menuitem"]'));
    expect(menuItems).toHaveLength(2);
    expect(menuItems[0]?.textContent).toContain('Показати на мапі всі точки');
    expect(decodeMapHrefState(menuItems[0]?.getAttribute('href') ?? null)).toMatchObject({
      search: 'P-1,P-2',
      freqs_selected: ['100.125'],
    });
    expect(menuItems[1]?.textContent).toContain('Показати на мапі цю точку');
    expect(decodeMapHrefState(menuItems[1]?.getAttribute('href') ?? null)).toMatchObject({
      search: 'P-1',
      freqs_selected: ['100.125'],
    });
  });

  it('does not render empty point markers', async () => {
    await act(async () => {
      root.render(
        <TestHost
          nodes={[
            { CNPointC: { begin: 0, end: 3, etalon: 'P-1', text: '  ' } },
            { CNPointC: { begin: 0, end: 3, etalon: '', text: 'P-2' } },
          ]}
          bodyText="P-2"
          messagePointEtalons={['P-1']}
        />,
      );
    });

    expect(container.querySelector('.content-token--point')).toBeNull();
    expect(container.querySelector('button[aria-label="Показати на мапі"]')).toBeNull();
    expect(container.textContent).toBe('P-2');
  });

  it('renders a single point menu item when the message has only one point', async () => {
    await act(async () => {
      root.render(
        <TestHost
          nodes={[{ CNPointC: { begin: 0, end: 3, etalon: 'P-1', text: 'P-1' } }]}
          bodyText="P-1"
          messagePointEtalons={['P-1']}
          message={{ freq: '200' } as InboxMessage}
        />,
      );
    });

    const badge = container.querySelector('.content-token--point');
    await act(async () => {
      badge?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    const menuItems = Array.from(document.body.querySelectorAll('[role="menuitem"]'));
    expect(menuItems).toHaveLength(1);
    expect(menuItems[0]?.textContent).toContain('Показати на мапі');
    expect(decodeMapHrefState(menuItems[0]?.getAttribute('href') ?? null)).toMatchObject({
      search: 'P-1',
      freqs_selected: ['200'],
    });
  });
});
