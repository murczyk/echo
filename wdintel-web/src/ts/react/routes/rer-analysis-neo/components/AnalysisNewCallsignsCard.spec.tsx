/**
 * @vitest-environment happy-dom
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';

import { AnalysisNewCallsignsCard } from './AnalysisNewCallsignsCard';

describe('AnalysisNewCallsignsCard', () => {
  let root: Root | null = null;

  afterEach(() => {
    act(() => root?.unmount());
    root = null;
  });

  it('renders uppercase callsigns in collapsed period lists', async () => {
    const container = document.createElement('div');
    root = createRoot(container);

    await act(async () => {
      root?.render(
        <AnalysisNewCallsignsCard
          newCallsigns={{
            notSeen24h: ['комета', 'кот'],
            notSeen7days: ['вітер'],
            notSeen30days: [],
          }}
        />,
      );
    });

    expect(container.textContent).toContain('24 години: 2');
    expect(container.textContent).not.toContain('КОМЕТА');

    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('[aria-label="Розгорнути позивні за 24 години"]')
        ?.click();
    });

    expect(container.textContent).toContain('КОМЕТА');
    expect(container.textContent).toContain('КОТ');
    expect(
      container.querySelector<HTMLAnchorElement>('a[href*="callsign"]')?.getAttribute('href'),
    ).toBe('/rer-callsigns-neo?callsign=%D0%BA%D0%BE%D0%BC%D0%B5%D1%82%D0%B0');
  });
});
