import { useCallback, useEffect, useRef, useState } from 'react';

import { usePowerSnackbar } from '../../components/PowerSnackbar';
import { listLogins } from '../../services/api/logins';
import { listAllReportHistory } from '../../services/api/report-history';
import { uniqueAccounts } from './helpers';

export type Snapshot<T> = {
  data: T | null;
  loading: boolean;
  error: string | null;
  updatedAt: number | null;
};

async function loadAccounts() {
  return uniqueAccounts((await listLogins({ sortBy: null, filterByRoles: null })).users);
}

async function loadReportCount() {
  const response = await listAllReportHistory({
    offset: 0,
    limit: 1,
    globalFilter: '',
    columnFilters: [{ id: 'status', value: 'done' }],
    sorting: [],
  });
  return response.total;
}

function useSnapshot<T>(load: () => Promise<T>, failureMessage: string) {
  const { notify } = usePowerSnackbar();
  const generation = useRef(0);
  const [snapshot, setSnapshot] = useState<Snapshot<T>>({
    data: null,
    loading: true,
    error: null,
    updatedAt: null,
  });

  const reload = useCallback(async () => {
    const request = ++generation.current;
    setSnapshot((previous) => ({ ...previous, loading: true, error: null }));
    try {
      const data = await load();
      if (request !== generation.current) return;
      setSnapshot({ data, loading: false, error: null, updatedAt: Date.now() });
    } catch (error) {
      if (request !== generation.current) return;
      const message = `${failureMessage}: ${error instanceof Error ? error.message : 'Невідома помилка'}`;
      setSnapshot((previous) => ({ ...previous, loading: false, error: message }));
      notify({ severity: 'error', message });
    }
  }, [load, failureMessage, notify]);

  useEffect(() => {
    void reload();
    return () => {
      generation.current += 1;
    };
  }, [reload]);

  return { ...snapshot, reload };
}

export function useKpiData() {
  const accounts = useSnapshot(loadAccounts, 'Не вдалося завантажити облікові записи');
  const reports = useSnapshot(loadReportCount, 'Не вдалося завантажити кількість звітів');
  return { accounts, reports };
}
