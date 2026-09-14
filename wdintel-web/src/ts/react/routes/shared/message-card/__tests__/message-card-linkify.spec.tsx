/**
 * @vitest-environment happy-dom
 */
// @test-scope parser: Echo message-reference URL grammar fixture.
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

async function renderText(text: string) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(
      <div>
        {renderLinkifiedText(text, {
          currentOrigin: 'https://echo.test',
          groupInfos: {},
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
});
