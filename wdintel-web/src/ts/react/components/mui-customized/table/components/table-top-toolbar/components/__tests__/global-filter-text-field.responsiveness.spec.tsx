/**
 * @vitest-environment happy-dom
 */
import { act, Suspense, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { GlobalFilterTextField } from '../global-filter-text-field';

describe('#4019 global filter responsiveness', () => {
  let container: HTMLDivElement;
  let root: Root;
  let resumeResults: () => void;
  let blockResults: boolean;
  let restoreFilter: (value: string) => void;

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

    function Results({ filter }: { filter: string }) {
      if (filter && blockResults) throw pendingResults;
      return <output>{filter || 'All rows'}</output>;
    }

    function Table() {
      const [filter, setFilter] = useState('');
      restoreFilter = setFilter;
      return (
        <Suspense fallback={<p>Loading rows</p>}>
          <GlobalFilterTextField globalFilter={filter} setGlobalFilter={setFilter} />
          <Results filter={filter} />
        </Suspense>
      );
    }

    await act(async () => root.render(<Table />));
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  function input() {
    return container.querySelector<HTMLInputElement>('input[placeholder="Пошук"]')!;
  }

  async function type(value: string) {
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(
        input(),
        value,
      );
      input().dispatchEvent(new Event('input', { bubbles: true }));
    });
  }

  it('keeps successive edits visible while rows are pending and applies the latest text', async () => {
    await type('ро');
    await type('рота');

    expect(input().value).toBe('рота');
    expect(container.textContent).not.toContain('Loading rows');
    expect(container.querySelector('output')?.textContent).toBe('All rows');

    await act(async () => resumeResults());

    expect(input().value).toBe('рота');
    expect(container.querySelector('output')?.textContent).toBe('рота');
  });

  it.each(['Escape', 'button'])('clears a pending filter with %s', async (method) => {
    await type('рота');
    await act(async () => {
      if (method === 'Escape') {
        input().dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      } else {
        container.querySelector<HTMLButtonElement>('button[aria-label="clear-filter"]')!.click();
      }
    });

    expect(input().value).toBe('');
    await act(async () => resumeResults());

    expect(input().value).toBe('');
    expect(container.querySelector('output')?.textContent).toBe('All rows');
  });

  it('honors an external reset and restores an external filter', async () => {
    await type('рота');
    await act(async () => restoreFilter(''));
    await act(async () => resumeResults());

    expect(input().value).toBe('');
    expect(container.querySelector('output')?.textContent).toBe('All rows');

    await act(async () => restoreFilter('інший'));

    expect(input().value).toBe('інший');
    expect(container.querySelector('output')?.textContent).toBe('інший');
  });
});
