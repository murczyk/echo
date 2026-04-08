/**
 * @vitest-environment happy-dom
 */
import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { renderMarkedText } from './MarkedText';
import type { ContentNode, InboxMessage } from '../../../../Bindings';

function decodeMapHrefState(href: string | null): { search: string; freqs_selected?: string[] } {
  const url = new URL(href!, 'https://example.test');
  return JSON.parse(decodeURIComponent(url.searchParams.get('state')!)) as {
    search: string;
    freqs_selected?: string[];
  };
}

function TestHost(props: {
  nodes: ContentNode[];
  bodyText: string;
  messagePointEtalons?: string[];
  showPointLinks?: boolean;
  message?: InboxMessage;
}) {
  return (
    <div>
      {renderMarkedText(props.nodes, props.bodyText, props.messagePointEtalons, {
        showPointLinks: props.showPointLinks,
        message: props.message,
      })}
    </div>
  );
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
      root.render(<TestHost nodes={[{ CNCallsignC: { text: 'abCd', begin: 0, end: 4, etalon: 'abCd' } }]} bodyText="abCd" />);
    });

    const link = container.querySelector('a.content-token--ADP');
    expect(link).not.toBeNull();
    expect(link?.getAttribute('href')).toBe('/rer-callsigns?callsign=ABCD');
    expect(link?.textContent).toBe('ABCD');
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
