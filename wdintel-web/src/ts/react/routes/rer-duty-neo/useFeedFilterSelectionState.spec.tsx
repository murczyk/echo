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
  apiRef: MutableRefObject<{
    mode: 'include' | 'exclude';
    localValue: string[];
    setLocalValue: Dispatch<SetStateAction<string[]>>;
    setMode: (mode: 'include' | 'exclude') => void;
  } | null>;
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

    expect(apiRef.current?.localValue).toEqual(['group-b']);
    expect(onExcludeChange).toHaveBeenCalledWith(['group-b']);
  });

  it('preserves parent unit names before the option catalog is available', async () => {
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
          includeValues={['3 мсб']}
          excludeValues={[]}
          onIncludeChange={onIncludeChange}
          onExcludeChange={onExcludeChange}
        />,
      );
    });
    await act(async () => {
      await flushMicrotasks();
    });

    expect(apiRef.current?.localValue).toEqual(['3 мсб']);
    expect(onIncludeChange).not.toHaveBeenCalled();
    expect(onExcludeChange).not.toHaveBeenCalled();

    await act(async () => {
      root.render(
        <Harness
          apiRef={apiRef}
          includeValues={['3 мсб']}
          excludeValues={[]}
          onIncludeChange={vi.fn(onIncludeChange)}
          onExcludeChange={vi.fn(onExcludeChange)}
        />,
      );
    });
    await act(async () => {
      await flushMicrotasks();
    });

    expect(apiRef.current?.localValue).toEqual(['3 мсб']);
    expect(onIncludeChange).not.toHaveBeenCalledWith([]);
    expect(onExcludeChange).not.toHaveBeenCalled();
  });

  it('refreshes local labels when reference data changes but the parent selection stays the same', async () => {
    function SenderHarness(props: {
      apiRef: MutableRefObject<{
        mode: 'include' | 'exclude';
        localValue: Array<{ id: string; label: string }>;
        setLocalValue: Dispatch<SetStateAction<Array<{ id: string; label: string }>>>;
        setMode: (mode: 'include' | 'exclude') => void;
      } | null>;
      labelSuffix: string;
      onIncludeChange: (next: string[]) => void;
      onExcludeChange: (next: string[]) => void;
    }) {
      const state = useFeedFilterSelectionState<{ id: string; label: string }>({
        includeValues: ['sender-1'],
        excludeValues: [],
        onIncludeChange: props.onIncludeChange,
        onExcludeChange: props.onExcludeChange,
        toLocalValues: (values) =>
          values.map((id) => ({ id, label: `${id}-${props.labelSuffix}` })),
        toParentValues: (values) => values.map((option) => option.id),
      });
      props.apiRef.current = state;
      return null;
    }

    const apiRef: MutableRefObject<{
      mode: 'include' | 'exclude';
      localValue: Array<{ id: string; label: string }>;
      setLocalValue: Dispatch<SetStateAction<Array<{ id: string; label: string }>>>;
      setMode: (mode: 'include' | 'exclude') => void;
    } | null> = { current: null };
    const onIncludeChange = vi.fn();
    const onExcludeChange = vi.fn();

    await act(async () => {
      root.render(
        <SenderHarness
          apiRef={apiRef}
          labelSuffix="v1"
          onIncludeChange={onIncludeChange}
          onExcludeChange={onExcludeChange}
        />,
      );
    });
    await act(async () => {
      await flushMicrotasks();
    });

    expect(apiRef.current?.localValue).toEqual([{ id: 'sender-1', label: 'sender-1-v1' }]);

    await act(async () => {
      root.render(
        <SenderHarness
          apiRef={apiRef}
          labelSuffix="v2"
          onIncludeChange={onIncludeChange}
          onExcludeChange={onExcludeChange}
        />,
      );
    });
    await act(async () => {
      await flushMicrotasks();
    });

    expect(apiRef.current?.localValue).toEqual([{ id: 'sender-1', label: 'sender-1-v2' }]);
    expect(onIncludeChange).not.toHaveBeenCalled();
    expect(onExcludeChange).not.toHaveBeenCalled();
  });
});
