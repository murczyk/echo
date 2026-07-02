/**
 * @vitest-environment happy-dom
 */
import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTheme } from '@mui/material/styles';

import { CALLSIGN_TOOLTIP_ITEM_SX, renderMarkedText } from './MarkedText';
import type {
  CallsignInfoRes,
  ContentNode,
  InboxMessage,
  Network,
  Unit,
} from '../../../../../Bindings';

function decodeMapHrefState(
  href: string | null,
): { search: string; freqs_selected?: string[] } | null {
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
  linkCallsigns?: boolean;
  message?: InboxMessage;
  searchText?: string | null;
  callsignInfoMap?: Record<string, CallsignInfoRes>;
  networks?: Network[];
  unitsMap?: Record<number, Unit>;
}) {
  return (
    <div>
      {renderMarkedText(props.nodes, props.bodyText, props.messagePointEtalons, {
        showPointLinks: props.showPointLinks,
        linkCallsigns: props.linkCallsigns,
        message: props.message,
        callsignInfoMap: props.callsignInfoMap,
        networks: props.networks,
        unitsMap: props.unitsMap,
        freq: props.message?.freq ?? null,
        networkIds: props.message?.networkIds ?? null,
        searchText: props.searchText ?? null,
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

const LIGHT_CARD_BG = '#F8F9FB';
const DARK_CARD_BG = '#2C2C2E';
const LIGHT_CALLSIGN_COLOR = '#1565c0';
const DARK_CALLSIGN_COLOR = '#90caf9';

function normalizeCssColor(value: string): { r: number; g: number; b: number; a: number } {
  const trimmed = value.trim();
  if (trimmed.startsWith('#')) {
    const hex = trimmed.slice(1);
    const normalized =
      hex.length === 3
        ? hex
            .split('')
            .map((part) => part + part)
            .join('')
        : hex;
    return {
      r: Number.parseInt(normalized.slice(0, 2), 16),
      g: Number.parseInt(normalized.slice(2, 4), 16),
      b: Number.parseInt(normalized.slice(4, 6), 16),
      a: 1,
    };
  }
  const rgbaMatch = trimmed.match(/^rgba?\(([^)]+)\)$/i);
  if (!rgbaMatch) throw new Error(`Unsupported color format: ${value}`);
  const parts = rgbaMatch[1].split(',').map((part) => part.trim());
  return {
    r: Number.parseFloat(parts[0]),
    g: Number.parseFloat(parts[1]),
    b: Number.parseFloat(parts[2]),
    a: parts[3] != null ? Number.parseFloat(parts[3]) : 1,
  };
}

function compositeOver(
  fg: { r: number; g: number; b: number; a: number },
  bg: { r: number; g: number; b: number; a: number },
) {
  const alpha = fg.a + bg.a * (1 - fg.a);
  return {
    r: Math.round((fg.r * fg.a + bg.r * bg.a * (1 - fg.a)) / alpha),
    g: Math.round((fg.g * fg.a + bg.g * bg.a * (1 - fg.a)) / alpha),
    b: Math.round((fg.b * fg.a + bg.b * bg.a * (1 - fg.a)) / alpha),
    a: alpha,
  };
}

function relativeLuminance({ r, g, b }: { r: number; g: number; b: number }): number {
  const srgb = [r, g, b].map((channel) => {
    const normalized = channel / 255;
    return normalized <= 0.03928 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * srgb[0] + 0.7152 * srgb[1] + 0.0722 * srgb[2];
}

function contrastRatio(fg: string, bg: string): number {
  const foreground = normalizeCssColor(fg);
  const background = normalizeCssColor(bg);
  const composed = foreground.a < 1 ? compositeOver(foreground, background) : foreground;
  const fgLum = relativeLuminance(composed);
  const bgLum = relativeLuminance(background);
  const lighter = Math.max(fgLum, bgLum);
  const darker = Math.min(fgLum, bgLum);
  return (lighter + 0.05) / (darker + 0.05);
}

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
        <TestHost
          nodes={[{ CNCallsignC: { text: 'abCd', begin: 0, end: 4, etalon: 'abCd' } }]}
          bodyText="abCd"
        />,
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

    expect(container.querySelector('a.content-token--ADP')?.textContent).toBe('WOLF');
    expect(container.querySelector('[data-testid="callsign-hint-badge-network"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="callsign-hint-badge-system"]')).toBeNull();
  });

  it('renders the filled-badge network state without linking when callsign links are disabled', async () => {
    await act(async () => {
      root.render(
        <TestHost
          nodes={[{ CNCallsignC: { text: 'wolf', begin: 0, end: 4, etalon: 'wolf' } }]}
          bodyText="wolf"
          linkCallsigns={false}
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

    expect(container.querySelector('a.content-token--ADP')).toBeNull();
    expect(container.querySelector('[data-testid="callsign-hint-badge-network"]')).not.toBeNull();
    expect(container.textContent).toContain('WOLF');
  });

  it('renders a linked network-related callsign without a direct message-network match', async () => {
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
                  id: 2,
                  callsign: 'wolf',
                  position: 'sys',
                  comment: 'catalog',
                  unit1: 'u',
                  unit2: 'v',
                  unitId: 1,
                  networkIdsReportedIn: [999],
                },
              ],
            },
          }}
          networks={networks}
          unitsMap={unitsMap}
        />,
      );
    });

    expect(container.querySelector('a.content-token--ADP')?.textContent).toBe('WOLF');
    expect(container.querySelector('a.content-token--ADP')?.getAttribute('href')).toBe(
      '/rer-callsigns-neo?callsign=WOLF',
    );
    expect(container.querySelector('[data-testid="callsign-hint-badge-network"]')).toBeNull();
    expect(container.querySelector('[data-testid="callsign-hint-badge-system"]')).toBeNull();
  });

  it('renders duplicate callsigns verbatim', async () => {
    await act(async () => {
      root.render(
        <TestHost
          nodes={[
            { CNTextC: { text: 'УКХ р/м управління 4 мср 2 мсб', begin: 0, end: 29 } },
            'CNNewlineC',
            { CNCallsignC: { text: 'тихий', begin: 0, end: 5, etalon: 'тихий' } },
            'CNNewlineC',
            { CNCallsignC: { text: 'почта', begin: 6, end: 11, etalon: 'почта' } },
            'CNNewlineC',
            { CNTextC: { text: 'Базовий текст', begin: 12, end: 24 } },
          ]}
          bodyText="УКХ р/м управління 4 мср 2 мсб\nТИХИЙ\nПОЧТА\nБазовий текст"
        />,
      );
    });

    expect(container.textContent).toContain('УКХ р/м управління 4 мср 2 мсб');
    expect(container.textContent).toContain('Базовий текст');
    expect(container.textContent).toContain('ТИХИЙ');
    expect(container.textContent).toContain('ПОЧТА');
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
                  unitId: 1,
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

    expect(container.querySelector('a.content-token--ADP')?.textContent).toBe('FOX');
    expect(container.querySelector('[data-testid="callsign-hint-badge-system"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="callsign-hint-badge-network"]')).toBeNull();
  });

  it('renders an outlined badge for catalog-only callsigns even when message networks are present', async () => {
    await act(async () => {
      root.render(
        <TestHost
          nodes={[{ CNCallsignC: { text: 'fox', begin: 0, end: 3, etalon: 'fox' } }]}
          bodyText="fox"
          message={{ freq: null, networkIds: [10] } as InboxMessage}
          callsignInfoMap={{
            fox: {
              callsign: 'fox',
              res: [
                {
                  id: 33,
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
          unitsMap={{
            ...unitsMap,
            99: {
              id: 99,
              company: '',
              battalion: '',
              regiment: '',
              division: '',
              army: 'Z',
              comment: '',
              name: 'Unmapped unit',
              active: true,
              createdAt: 0,
              createdBy: 'test',
            },
          }}
        />,
      );
    });

    expect(container.querySelector('a.content-token--ADP')?.textContent).toBe('FOX');
    expect(container.querySelector('[data-testid="callsign-hint-badge-system"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="callsign-hint-badge-network"]')).toBeNull();
  });

  it('normalizes catalog lookup keys before rendering the hint badge', async () => {
    await act(async () => {
      root.render(
        <TestHost
          nodes={[{ CNCallsignC: { text: '  БеТоН  ', begin: 0, end: 8, etalon: '  БеТоН  ' } }]}
          bodyText="  БеТоН  "
          message={{ freq: null, networkIds: null } as InboxMessage}
          callsignInfoMap={{
            бетон: {
              callsign: 'БЕТОН',
              res: [
                {
                  id: 4,
                  callsign: 'БЕТОН',
                  position: 'sys',
                  comment: 'catalog',
                  unit1: 's1',
                  unit2: 's2',
                  unitId: 1,
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

    expect(container.querySelector('a.content-token--ADP')?.textContent).toBe('БЕТОН');
    expect(container.querySelector('[data-testid="callsign-hint-badge-system"]')).not.toBeNull();
  });

  it('renders the outlined-badge catalog state without linking when callsign links are disabled', async () => {
    await act(async () => {
      root.render(
        <TestHost
          nodes={[{ CNCallsignC: { text: 'fox', begin: 0, end: 3, etalon: 'fox' } }]}
          bodyText="fox"
          linkCallsigns={false}
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

    expect(container.querySelector('a.content-token--ADP')).toBeNull();
    expect(container.querySelector('[data-testid="callsign-hint-badge-system"]')).not.toBeNull();
    expect(container.textContent).toContain('FOX');
  });

  it('renders a plain attention state for callsigns that are not in the network etalon catalog', async () => {
    await act(async () => {
      root.render(
        <TestHost
          nodes={[{ CNCallsignC: { text: 'ghost', begin: 0, end: 5, etalon: 'ghost' } }]}
          bodyText="ghost"
          message={{ freq: '100.000', networkIds: [10] } as InboxMessage}
          callsignInfoMap={{}}
          networks={networks}
          unitsMap={unitsMap}
        />,
      );
    });

    const muted = container.querySelector('[data-testid="callsign-hint-plain-missing"]');
    expect(muted).not.toBeNull();
    expect(muted?.textContent).toBe('GHOST');
    expect(muted?.getAttribute('title')).toBeNull();
    expect(container.querySelector('a.content-token--ADP')).toBeNull();
    expect(container.querySelector('span.content-token--ADP')).toBeNull();
    expect(container.querySelector('[data-testid="callsign-hint-badge-network"]')).toBeNull();
    expect(container.querySelector('[data-testid="callsign-hint-badge-system"]')).toBeNull();
  });

  it('renders search-highlighted callsigns with the same orange token style as keyword highlights', async () => {
    await act(async () => {
      root.render(
        <TestHost
          nodes={[
            { CNHighlightC: { text: 'РЖАВИЙ', begin: 0, end: 6 } },
            { CNCallsignC: { text: 'РЖАВИЙ', begin: 0, end: 6, etalon: 'РЖАВИЙ' } },
          ]}
          bodyText="РЖАВИЙ"
          message={{ freq: '100.000', networkIds: [10] } as InboxMessage}
          callsignInfoMap={{
            ржавий: {
              callsign: 'РЖАВИЙ',
              res: [
                {
                  id: 44,
                  callsign: 'РЖАВИЙ',
                  position: 'sys',
                  comment: 'catalog',
                  unit1: 's1',
                  unit2: 's2',
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

    expect(container.querySelector('a.content-token--ADP')?.textContent).toBe('РЖАВИЙ');
    expect(container.querySelector('[data-testid="callsign-hint-badge-network"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="callsign-hint-badge-system"]')).toBeNull();
  });

  it('highlights a callsign token when it matches the active search text', async () => {
    await act(async () => {
      root.render(
        <TestHost
          nodes={[{ CNCallsignC: { text: 'ЛУНА', begin: 0, end: 4, etalon: 'ЛУНА' } }]}
          bodyText="ЛУНА"
          searchText="ЛУНА"
          message={{ freq: '100.000', networkIds: [10] } as InboxMessage}
          callsignInfoMap={{
            луна: {
              callsign: 'ЛУНА',
              res: [
                {
                  id: 77,
                  callsign: 'ЛУНА',
                  position: 'sys',
                  comment: 'catalog',
                  unit1: 's1',
                  unit2: 's2',
                  unitId: 1,
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

    expect(container.querySelector('a.content-token--ADP')?.textContent).toBe('ЛУНА');
    expect(container.querySelector('[data-testid="callsign-hint-badge-network"]')).toBeNull();
    expect(container.querySelector('[data-testid="callsign-hint-badge-system"]')).toBeNull();
  });

  it('keeps search-highlighted non-catalog callsigns as plain text', async () => {
    await act(async () => {
      root.render(
        <TestHost
          nodes={[{ CNCallsignC: { text: 'ГЛОБУС', begin: 0, end: 6, etalon: 'ГЛОБУС' } }]}
          bodyText="ГЛОБУС"
          searchText="ГЛОБУС"
          message={{ freq: '100.000', networkIds: [10] } as InboxMessage}
          callsignInfoMap={{}}
          networks={networks}
          unitsMap={unitsMap}
        />,
      );
    });

    expect(container.querySelector('a.content-token--ADP')).toBeNull();
    expect(
      container.querySelector('[data-testid="callsign-hint-plain-missing"]')?.textContent,
    ).toBe('ГЛОБУС');
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

  it('keeps callsign contrast above WCAG AA in light and dark themes', () => {
    const lightTheme = createTheme({ palette: { mode: 'light' } });
    const darkTheme = createTheme({ palette: { mode: 'dark' } });

    expect(contrastRatio(LIGHT_CALLSIGN_COLOR, LIGHT_CARD_BG)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(DARK_CALLSIGN_COLOR, DARK_CARD_BG)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(lightTheme.palette.text.primary, LIGHT_CARD_BG)).toBeGreaterThanOrEqual(
      4.5,
    );
    expect(contrastRatio(darkTheme.palette.text.primary, DARK_CARD_BG)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(lightTheme.palette.text.secondary, LIGHT_CARD_BG)).toBeGreaterThanOrEqual(
      4.5,
    );
    expect(contrastRatio(darkTheme.palette.text.secondary, DARK_CARD_BG)).toBeGreaterThanOrEqual(
      4.5,
    );
  });

  it('renders highlighted keywords as non-interactive orange badges with black text', async () => {
    await act(async () => {
      root.render(
        <TestHost
          nodes={[{ CNHighlightC: { text: 'ключове', begin: 0, end: 8 } }]}
          bodyText="ключове"
        />,
      );
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
      root.render(
        <TestHost nodes={[{ CNHighlightC: { text: '  ', begin: 0, end: 5 } }]} bodyText="текст" />,
      );
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
