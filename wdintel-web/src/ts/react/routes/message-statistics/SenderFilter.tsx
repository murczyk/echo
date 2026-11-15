import { Button } from '@mui/material';
import { useEffect, useState } from 'react';
import type {
  DailyMessageStatsReq,
  DailyMessageStatsSenderLabel,
  DailyMessageStatsSendersRsp,
} from '../../../../Bindings';
import { StatisticsFilter } from './StatisticsFilter';
import { fetchDailyMessageStatsSenders } from '../../services/api/daily-message-stats';
import { senderValue } from './state';
import { facetFilter } from './facet-request';
import type { useStatsCatalog } from './use-stats-catalog';
import { useStatsResource } from './use-stats-resource';

type Pages = {
  scope: string;
  options: DailyMessageStatsSenderLabel[];
  next: string | null;
  total: number;
};
export function SenderFilter({
  request,
  selected,
  onChange,
  catalog,
}: {
  request: DailyMessageStatsReq | null;
  selected: string[];
  onChange: (value: string[]) => void;
  catalog: ReturnType<typeof useStatsCatalog>;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [debounced, setDebounced] = useState('');
  const [pagination, setPagination] = useState({ scope: '', cursor: null as string | null });
  const [pages, setPages] = useState<Pages>({ scope: '', options: [], next: null, total: 0 });
  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(search), search ? 250 : 0);
    return () => window.clearTimeout(timer);
  }, [search]);
  const filter = request ? facetFilter(request, 'Senders') : null;
  const scope = JSON.stringify([catalog.scopeVersion, catalog.accessRevision, filter, debounced]);
  const cursor = pagination.scope === scope ? pagination.cursor : null;
  const searchReady = search === debounced;
  const resource = useStatsResource<DailyMessageStatsSendersRsp>({
    cache: catalog.cache,
    resourceKey:
      filter && catalog.accessRevision ? JSON.stringify(['Senders', scope, cursor]) : null,
    active: open && searchReady && !catalog.denied,
    load: (signal) =>
      fetchDailyMessageStatsSenders(
        { filter: filter!, search: debounced || null, cursor },
        { signal },
      ),
    accept: catalog.checkResponse,
    onDenied: catalog.reject,
  });
  useEffect(() => {
    const response = resource.data;
    if (!response) return;
    catalog.rememberSenders(response.options, response.accessRevision);
    setPages((current) => ({
      scope,
      options:
        cursor && current.scope === scope
          ? [
              ...current.options,
              ...response.options.filter(
                (entry) => !current.options.some((old) => old.key === entry.key),
              ),
            ]
          : response.options,
      next: response.nextCursor,
      total: response.total,
    }));
  }, [resource.data, scope, cursor, catalog.rememberSenders]);
  const current = pages.scope === scope ? pages : null;
  const options = searchReady ? (current?.options ?? resource.data?.options ?? []) : [];
  const next = resource.data?.nextCursor ?? current?.next ?? null;
  const labels = new Map(catalog.senderLabels);
  selected.forEach((key) => {
    if (!labels.has(key))
      labels.set(key, key === 'null' ? 'Невідомий відправник' : 'Недоступний відправник');
  });
  return (
    <div className="message-statistics-sender-filter">
      <StatisticsFilter
        label="Відправник"
        searchPlaceholder="Пошук відправника"
        total={resource.data?.total ?? current?.total}
        options={options.map((entry) => ({ value: senderValue(entry.key), label: entry.label }))}
        value={selected}
        labels={labels}
        loading={resource.loading || (open && !searchReady)}
        disabled={!request || !catalog.accessRevision}
        onOpenChange={(value) => {
          setOpen(value);
          if (value) setPagination({ scope, cursor: null });
        }}
        onSearch={(value) => {
          setSearch(value);
          if (!value) setDebounced('');
        }}
        onChange={onChange}
        footer={
          <>
            {next && searchReady ? (
              <Button
                size="small"
                disabled={resource.loading}
                onClick={() => setPagination({ scope, cursor: next })}
              >
                Ще відправники
              </Button>
            ) : null}
            {resource.error ? (
              <Button size="small" onClick={resource.retry}>
                Повторити завантаження відправників
              </Button>
            ) : null}
          </>
        }
      />
    </div>
  );
}
