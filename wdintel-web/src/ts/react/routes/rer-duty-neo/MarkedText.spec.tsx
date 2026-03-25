/**
 * @vitest-environment happy-dom
 */
import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { renderMarkedText } from './MarkedText';
import type { ContentNode } from '../../../../Bindings';

function TestHost(props: {
  nodes: ContentNode[];
  bodyText: string;
  messagePointEtalons?: string[];
  showPointLinks?: boolean;
}) {
  return (
    <div>
      {renderMarkedText(props.nodes, props.bodyText, props.messagePointEtalons, {
        showPointLinks: props.showPointLinks,
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

  it('renders point tokens with a menu action that keeps the map tooltip', async () => {
    await act(async () => {
      root.render(
        <TestHost
          nodes={[{ CNPointC: { begin: 0, end: 3, etalon: 'P-1', text: 'P-1' } }]}
          bodyText="P-1"
          messagePointEtalons={['P-1', 'P-2']}
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
    expect(menuItems[0]?.getAttribute('href')).toBe(
      `/rer-analysis?state=${encodeURIComponent(JSON.stringify({ search: 'P-1,P-2' }))}&showMap=true`,
    );
    expect(menuItems[1]?.textContent).toContain('Показати на мапі цю точку');
    expect(menuItems[1]?.getAttribute('href')).toBe(
      `/rer-analysis?state=${encodeURIComponent(JSON.stringify({ search: 'P-1' }))}&showMap=true`,
    );
  });

  it('renders a single point menu item when the message has only one point', async () => {
    await act(async () => {
      root.render(
        <TestHost
          nodes={[{ CNPointC: { begin: 0, end: 3, etalon: 'P-1', text: 'P-1' } }]}
          bodyText="P-1"
          messagePointEtalons={['P-1']}
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
    expect(menuItems[0]?.getAttribute('href')).toBe(
      `/rer-analysis?state=${encodeURIComponent(JSON.stringify({ search: 'P-1' }))}&showMap=true`,
    );
  });
});
