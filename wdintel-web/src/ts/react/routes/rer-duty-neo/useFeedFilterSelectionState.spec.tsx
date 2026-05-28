/**
 * @vitest-environment happy-dom
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { Dispatch, MutableRefObject, SetStateAction } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useFeedFilterSelectionState } from './useFeedFilterSelectionState';

function flushMicrotasks(): Promise<void> {
  return Promise.resolve();
}

function Harness(props: {
  apiRef: MutableRefObject<
    | {
        mode: 'include' | 'exclude';
        localValue: string[];
        setLocalValue: Dispatch<SetStateAction<string[]>>;
        setMode: (mode: 'include' | 'exclude') => void;
      }
    | null
  >;
  includeValues: string[];
  excludeValues: string[];
  onIncludeChange: (next: string[]) => void;
  onExcludeChange: (next: string[]) => void;
}) {
  const state = useFeedFilterSelectionState<string>({
    includeValues: props.includeValues,
    excludeValues: props.excludeValues,
    onIncludeChange: props.onIncludeChange,
    onExcludeChange: props.onExcludeChange,
    toLocalValues: (values) => [...values],
    toParentValues: (values) => [...values],
  });
  props.apiRef.current = state;
  return null;
}

describe('useFeedFilterSelectionState', () => {
  let container: HTMLElement;
  let root: Root;

  beforeEach(() => {
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

  it('resyncs parent-driven include to exclude values without clearing the new selection', async () => {
    const apiRef: MutableRefObject<{
      mode: 'include' | 'exclude';
      localValue: string[];
      setLocalValue: Dispatch<SetStateAction<string[]>>;
      setMode: (mode: 'include' | 'exclude') => void;
    } | null> = { current: null };
    const onIncludeChange = vi.fn();
    const onExcludeChange = vi.fn();

    await act(async () => {
      root.render(
        <Harness
          apiRef={apiRef}
          includeValues={['group-a']}
          excludeValues={[]}
          onIncludeChange={onIncludeChange}
          onExcludeChange={onExcludeChange}
        />,
      );
    });
    await act(async () => {
      await flushMicrotasks();
    });

    expect(apiRef.current?.mode).toBe('include');
    expect(apiRef.current?.localValue).toEqual(['group-a']);
    onIncludeChange.mockClear();
    onExcludeChange.mockClear();

    await act(async () => {
      root.render(
        <Harness
          apiRef={apiRef}
          includeValues={[]}
          excludeValues={['group-a']}
          onIncludeChange={onIncludeChange}
          onExcludeChange={onExcludeChange}
        />,
      );
    });
    await act(async () => {
      await flushMicrotasks();
    });

    expect(apiRef.current?.mode).toBe('exclude');
    expect(apiRef.current?.localValue).toEqual(['group-a']);
    expect(onIncludeChange).not.toHaveBeenCalled();
    expect(onExcludeChange).not.toHaveBeenCalled();
  });

  it('writes back user edits after a prop-driven resync', async () => {
    const apiRef: MutableRefObject<{
      mode: 'include' | 'exclude';
      localValue: string[];
      setLocalValue: Dispatch<SetStateAction<string[]>>;
      setMode: (mode: 'include' | 'exclude') => void;
    } | null> = { current: null };
    const onIncludeChange = vi.fn();
    const onExcludeChange = vi.fn();

    await act(async () => {
      root.render(
        <Harness
          apiRef={apiRef}
          includeValues={['group-a']}
          excludeValues={[]}
          onIncludeChange={onIncludeChange}
          onExcludeChange={onExcludeChange}
        />,
      );
    });
    await act(async () => {
      await flushMicrotasks();
    });

    await act(async () => {
      root.render(
        <Harness
          apiRef={apiRef}
          includeValues={[]}
          excludeValues={['group-a']}
          onIncludeChange={onIncludeChange}
          onExcludeChange={onExcludeChange}
        />,
      );
    });
    await act(async () => {
      await flushMicrotasks();
    });

    await act(async () => {
      apiRef.current?.setLocalValue(['group-b']);
    });
    await act(async () => {
      await flushMicrotasks();
    });

    expect(onExcludeChange).toHaveBeenCalledWith(['group-b']);
  });
});
