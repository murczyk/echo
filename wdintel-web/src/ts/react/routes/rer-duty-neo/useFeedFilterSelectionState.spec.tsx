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

  it('transfers include values to exclude in order and keeps local selections', async () => {
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
          includeValues={['A', 'B']}
          excludeValues={[]}
          onIncludeChange={onIncludeChange}
          onExcludeChange={onExcludeChange}
        />,
      );
    });
    await act(async () => apiRef.current?.setMode('exclude'));

    expect(apiRef.current?.mode).toBe('exclude');
    expect(apiRef.current?.localValue).toEqual(['A', 'B']);
    expect(onExcludeChange).toHaveBeenCalledWith(['A', 'B']);
    expect(onIncludeChange).toHaveBeenCalledWith([]);

    await act(async () => {
      root.render(
        <Harness
          apiRef={apiRef}
          includeValues={[]}
          excludeValues={['A', 'B']}
          onIncludeChange={onIncludeChange}
          onExcludeChange={onExcludeChange}
        />,
      );
    });
    expect(apiRef.current?.localValue).toEqual(['A', 'B']);
  });

  it('transfers object selections using parent identifiers', async () => {
    const apiRef = { current: null } as MutableRefObject<{
      mode: 'include' | 'exclude';
      localValue: Array<{ id: string; label: string }>;
      setLocalValue: Dispatch<SetStateAction<Array<{ id: string; label: string }>>>;
      setMode: (mode: 'include' | 'exclude') => void;
    } | null>;
    const onIncludeChange = vi.fn();
    const onExcludeChange = vi.fn();
    const selected = [{ id: 'sender-a', label: 'Sender A' }];

    function SenderHarness() {
      const state = useFeedFilterSelectionState({
        includeValues: ['sender-a'],
        excludeValues: [],
        onIncludeChange,
        onExcludeChange,
        toLocalValues: (values: readonly string[]) =>
          values.map((id) => selected.find((option) => option.id === id) ?? { id, label: id }),
        toParentValues: (values: typeof selected) => values.map((option) => option.id),
      });
      apiRef.current = state;
      return null;
    }

    await act(async () => root.render(<SenderHarness />));
    await act(async () => apiRef.current?.setMode('exclude'));

    expect(onExcludeChange).toHaveBeenCalledWith(['sender-a']);
    expect(onIncludeChange).toHaveBeenCalledWith([]);
    expect(apiRef.current?.localValue).toEqual([{ id: 'sender-a', label: 'Sender A' }]);
  });

  it('transfers exclude values to include in order and keeps local selections', async () => {
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
          includeValues={[]}
          excludeValues={['A', 'B']}
          onIncludeChange={onIncludeChange}
          onExcludeChange={onExcludeChange}
        />,
      );
    });
    await act(async () => apiRef.current?.setMode('include'));

    expect(apiRef.current?.mode).toBe('include');
    expect(apiRef.current?.localValue).toEqual(['A', 'B']);
    expect(onIncludeChange).toHaveBeenCalledWith(['A', 'B']);
    expect(onExcludeChange).toHaveBeenCalledWith([]);

    await act(async () => {
      root.render(
        <Harness
          apiRef={apiRef}
          includeValues={['A', 'B']}
          excludeValues={[]}
          onIncludeChange={onIncludeChange}
          onExcludeChange={onExcludeChange}
        />,
      );
    });
    expect(apiRef.current?.localValue).toEqual(['A', 'B']);
  });

  it.each([
    ['include', 'exclude'],
    ['exclude', 'include'],
  ] as const)('switches empty %s mode to %s without writing values', async (from, to) => {
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
          includeValues={[]}
          excludeValues={[]}
          onIncludeChange={onIncludeChange}
          onExcludeChange={onExcludeChange}
        />,
      );
    });
    await act(async () => apiRef.current?.setMode(from));
    await act(async () => apiRef.current?.setMode(to));

    expect(apiRef.current?.mode).toBe(to);
    expect(apiRef.current?.localValue).toEqual([]);
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
