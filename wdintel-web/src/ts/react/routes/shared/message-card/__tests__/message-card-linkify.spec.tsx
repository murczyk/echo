/**
 * @vitest-environment happy-dom
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';

import { parseMessageReferenceUrl, renderLinkifiedText } from '../message-card-linkify';

let root: Root | null = null;
let container: HTMLDivElement | null = null;

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
});

async function renderText(text: string, linkWww = false) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(
      <div>
        {renderLinkifiedText(text, {
          currentOrigin: 'https://echo.test',
          groupInfos: {},
          linkWww,
        })}
      </div>,
    );
  });
  return container;
}

describe('parseMessageReferenceUrl', () => {
  it.each([
    ['https://echo.test/rer-analysis-neo?m=analysis-message', 'analysis-message'],
    ['https://echo.test/rer-duty-neo?m=42', '42'],
    [
      'https://echo.test/rer-analysis-neo?m=0198c9ac-07ac-7a53-b233-49c8d897c012',
      '0198c9ac-07ac-7a53-b233-49c8d897c012',
    ],
  ])('recognizes a same-origin Echo message link', (url, messageIdentifier) => {
    expect(parseMessageReferenceUrl(url, 'https://echo.test')).toEqual({ messageIdentifier });
  });

  it.each([
    'https://other-echo.test/rer-analysis-neo?m=message-1',
    'https://echo.test/rer-analysis-neo',
    'https://echo.test/rer-analysis-neo?m=',
    'https://echo.test/rer-analysis?m=message-1',
    'https://echo.test/documents?m=message-1',
  ])('leaves non-message URLs unchanged', (url) => {
    expect(parseMessageReferenceUrl(url, 'https://echo.test')).toBeNull();
  });
});

describe('renderLinkifiedText', () => {
  it('shows an internal message URL as the message reference label', async () => {
    const url = 'https://echo.test/rer-analysis-neo?m=message-1';
    const view = await renderText(`Дивись ${url}.`);

    const link = view.querySelector('a');
    expect(link?.textContent).toBe('повідомлення');
    expect(link?.getAttribute('href')).toBe(url);
    expect(view.textContent).toBe('Дивись повідомлення.');
  });

  it('keeps an external URL visible', async () => {
    const url = 'https://docs.google.com/document/d/hash/edit';
    const view = await renderText(`Дивись ${url}`);

    expect(view.querySelector('a')?.textContent).toBe(url);
  });

  describe('www addresses', () => {
    const hrefs = (c: HTMLElement) =>
      [...c.querySelectorAll('a')].map((a) => a.getAttribute('href'));

    it('leaves a bare www address as text unless asked to link it', async () => {
      const c = await renderText('see www.example.com now');
      expect(c.querySelector('a')).toBeNull();
    });

    it('links a www address as https and keeps the visible text and the trailing punctuation', async () => {
      const c = await renderText('go to www.ArashiShop.ir, then (www.example.com/a_b).', true);
      expect(hrefs(c)).toEqual(['https://www.arashishop.ir/', 'https://www.example.com/a_b']);
      expect([...c.querySelectorAll('a')].map((a) => a.textContent)).toEqual([
        'www.ArashiShop.ir',
        'www.example.com/a_b',
      ]);
      expect(c.textContent).toBe('go to www.ArashiShop.ir, then (www.example.com/a_b).');
    });

    it('still links scheme addresses and does not link www inside words or e-mail addresses', async () => {
      const c = await renderText('https://a.test x@www.b.test awww.c.test http://d.test', true);
      expect(hrefs(c)).toEqual(['https://a.test/', 'http://d.test/']);
    });

    it('ignores "www." without a host', async () => {
      const c = await renderText('www. and www..', true);
      expect(c.querySelector('a')).toBeNull();
    });
  });
});
