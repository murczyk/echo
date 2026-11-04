/**
 * @vitest-environment happy-dom
 */
import { act, Suspense, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { AnalysisQueryState } from '../../types';
import { AnalysisSearchControls } from '../AnalysisSearchControls';

describe('Analysis search responsiveness', () => {
  let container: HTMLDivElement;
  let root: Root;
  let resumeResults: () => void;
  let blockResults: boolean;
  let setExternalSearch: (search: string) => void;

  beforeEach(async () => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    blockResults = true;
    const pendingResults = new Promise<void>((resolve) => {
      resumeResults = () => {
        blockResults = false;
        resolve();
      };
    });

    function Results({ search }: { search: string }) {
      if (search && blockResults) throw pendingResults;
      return <output>{search || 'All messages'}</output>;
    }

    function Page() {
      const [queryState, setQueryState] = useState({ search: '' } as AnalysisQueryState);
      setExternalSearch = (search) => setQueryState((current) => ({ ...current, search }));
      return (
        <Suspense fallback={<p>Loading results</p>}>
          <AnalysisSearchControls
            queryState={queryState}
            updateQueryState={(patch) => setQueryState((current) => ({ ...current, ...patch }))}
            isCompactLayout={false}
            onClose={() => {}}
          />
          <Results search={queryState.search ?? ''} />
        </Suspense>
      );
    }

    await act(async () => root.render(<Page />));
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  function input() {
    return container.querySelector<HTMLInputElement>('input[aria-label="Пошук"]')!;
  }

  async function type(search: string) {
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(
        input(),
        search,
      );
      input().dispatchEvent(new Event('input', { bubbles: true }));
    });
  }

  it('keeps typing visible while results are pending and applies the latest text', async () => {
    await type('ро');
    await type('рота');

    expect(input().value).toBe('рота');
    expect(container.textContent).not.toContain('Loading results');
    expect(container.querySelector('output')?.textContent).toBe('All messages');

    await act(async () => resumeResults());

    expect(input().value).toBe('рота');
    expect(container.querySelector('output')?.textContent).toBe('рота');
  });

  it('clears a pending search without restoring it when results resume', async () => {
    await type('рота');
    await act(async () => {
      container.querySelector<HTMLButtonElement>('button[aria-label="Очистити пошук"]')!.click();
    });
    await act(async () => resumeResults());

    expect(input().value).toBe('');
    expect(container.querySelector('output')?.textContent).toBe('All messages');
  });

  it('honors an external reset while a search is pending', async () => {
    await type('рота');
    await act(async () => setExternalSearch(''));
    await act(async () => resumeResults());

    expect(input().value).toBe('');
    expect(container.querySelector('output')?.textContent).toBe('All messages');

    await act(async () => setExternalSearch('інший'));

    expect(input().value).toBe('інший');
    expect(container.querySelector('output')?.textContent).toBe('інший');
  });
});
