/**
 * @vitest-environment happy-dom
 */
import { act, useEffect, useRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { useRerDutyPollingErrors } from './useRerDutyPollingErrors';
import { useRerDutySavedFilterActions } from './useRerDutySavedFilterActions';

describe('Duty action error notifications', () => {
  let root: Root | null = null;
  let container: HTMLElement | null = null;

  afterEach(() => {
    act(() => root?.unmount());
    container?.remove();
    root = null;
    container = null;
  });

  it('#3400 delivers each repeated duplicate-filter failure to the snackbar boundary', async () => {
    const notify = vi.fn();
    let saveFilter: ((feedId: string, name: string) => Promise<boolean>) | null = null;

    const Harness = () => {
      const errors = useRerDutyPollingErrors();
      const notifiedErrorRef = useRef<string | null>(null);
      const actions = useRerDutySavedFilterActions({
        messageFeeds: [],
        savedFilters: [{ id: 1, name: 'Duplicate' }] as never,
        setSavedFilters: vi.fn(),
        selectedSavedIdByFeedId: {},
        setSelectedSavedIdByFeedId: vi.fn(),
        saveFilterNameByFeedId: {},
        setSaveFilterNameByFeedId: vi.fn(),
        applyFilter: vi.fn(),
        setError: errors.setError,
      });
      useEffect(() => {
        if (!errors.error) return;
        const key = `${errors.errorNotificationVersion}:${errors.error}`;
        if (notifiedErrorRef.current === key) return;
        notifiedErrorRef.current = key;
        notify({ message: errors.error, severity: 'error' });
      }, [errors.error, errors.errorNotificationVersion]);
      saveFilter = actions.handleSaveFilter;
      return null;
    };

    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root!.render(<Harness />);
    });
    await act(async () => {
      await saveFilter!('mf-0', 'Duplicate');
    });
    await act(async () => {
      await saveFilter!('mf-0', 'Duplicate');
    });

    expect(notify).toHaveBeenCalledTimes(2);
    expect(notify).toHaveBeenLastCalledWith({
      message: 'Фільтр з назвою "Duplicate" вже існує',
      severity: 'error',
    });
  });
});
