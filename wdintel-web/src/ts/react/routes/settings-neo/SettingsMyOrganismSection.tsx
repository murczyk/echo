import { Box, CircularProgress, Stack, Typography } from '@mui/material';
import type { MRT_ColumnDef } from 'material-react-table';
import { useEffect, useMemo, useState } from 'react';

import type { TagAdmin } from '../../../../Bindings';
import { SectionEmptyState } from '../../components/SectionEmptyState';
import { SectionErrorState } from '../../components/SectionErrorState';
import { GlobalFilterTextField } from '../../components/mui-customized/table/components/table-top-toolbar/components/global-filter-text-field';
import { CUSTOM_STYLES } from '../../components/mui-customized/table/custom-styles';
import {
  TableStateProvider,
  useTableStateContext,
} from '../../components/mui-customized/table/table-state-provider';
import { listCurrentOrganismTags } from '../../services/api/tags';
import { SettingsNeoTable } from './SettingsNeoTable';

type LoadStatus = 'idle' | 'loading' | 'success' | 'error';

const MY_ORGANISM_TAGS_COLUMN_ORDER = [
  'mrt-row-numbers',
  'tagId',
  'label',
  'extra',
  'ord',
  'isPalitra',
];

const MY_ORGANISM_TAGS_COLUMN_VISIBILITY = {
  tagId: true,
  label: true,
  extra: true,
  ord: true,
  isPalitra: true,
};

function formatErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  try {
    return JSON.stringify(error);
  } catch (_) {
    return 'невідома помилка';
  }
}

function formatBoolean(value: boolean | null | undefined): string {
  return value ? 'так' : 'ні';
}

function TagsSearchField() {
  const tableStateContext = useTableStateContext();
  return (
    <GlobalFilterTextField
      globalFilter={tableStateContext.globalFilter}
      setGlobalFilter={tableStateContext.onChangeGlobalFilter}
    />
  );
}

export function SettingsMyOrganismSection() {
  const [status, setStatus] = useState<LoadStatus>('idle');
  const [tags, setTags] = useState<TagAdmin[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const abortController = new AbortController();

    async function loadTags() {
      setStatus('loading');
      setError(null);
      try {
        const data = await listCurrentOrganismTags({ signal: abortController.signal });
        if (abortController.signal.aborted) return;
        setTags(data);
        setStatus('success');
      } catch (loadError) {
        if (abortController.signal.aborted) return;
        setTags([]);
        setError(`Помилка завантаження тегів організму: ${formatErrorMessage(loadError)}`);
        setStatus('error');
      }
    }

    void loadTags();

    return () => {
      abortController.abort();
    };
  }, []);

  const visibleTags = useMemo(() => tags.filter((tag) => tag.enabled), [tags]);

  const columns = useMemo<MRT_ColumnDef<TagAdmin>[]>(() => {
    const noWrapHeadCellProps = {
      sx: { ...CUSTOM_STYLES.muiTableHeadCellProps.sx, whiteSpace: 'nowrap' },
    };
    const noWrapBodyCellProps = {
      sx: { ...CUSTOM_STYLES.muiTableBodyCellProps.sx, whiteSpace: 'nowrap' },
    };
    return [
      { header: 'ID', accessorKey: 'tagId', size: 80 },
      { header: 'Назва', accessorKey: 'label', size: 200 },
      {
        header: 'Додатковий',
        id: 'extra',
        accessorFn: (row) => formatBoolean(row.extra),
        size: 150,
        muiTableHeadCellProps: noWrapHeadCellProps,
        muiTableBodyCellProps: noWrapBodyCellProps,
      },
      {
        header: 'Порядок',
        id: 'ord',
        accessorFn: (row) => (row.ord == null ? '—' : row.ord),
        size: 130,
        muiTableHeadCellProps: noWrapHeadCellProps,
        muiTableBodyCellProps: noWrapBodyCellProps,
      },
      {
        header: 'Палітра',
        id: 'isPalitra',
        accessorFn: (row) => formatBoolean(row.isPalitra),
        size: 130,
        muiTableHeadCellProps: noWrapHeadCellProps,
        muiTableBodyCellProps: noWrapBodyCellProps,
      },
    ];
  }, []);

  return (
    <Box
      id="settings-neo-panel-my-organism"
      role="tabpanel"
      aria-labelledby="settings-neo-tab-my-organism"
    >
      <Box sx={{ p: 3 }}>
        <Stack spacing={3} sx={{ maxWidth: 960 }}>
          <Stack spacing={1}>
            <Typography component="h2" variant="h6" sx={{ fontWeight: 700, lineHeight: 1.25 }}>
              Мій організм
            </Typography>
            <Typography variant="body2" sx={{ color: 'text.secondary', lineHeight: 1.6 }}>
              Теги організму — це спільні теги вашого підрозділу/організму. Їх можна ставити на
              повідомлення одним кліком, як і глобальні теги. Якщо потрібен новий тег або зміна
              існуючого, зверніться до адміністратора вашого організму.
            </Typography>
          </Stack>

          {status === 'loading' || status === 'idle' ? (
            <Box sx={{ py: 2 }} aria-label="Завантаження тегів організму">
              <CircularProgress size={20} />
            </Box>
          ) : null}

          {status === 'error' ? (
            <SectionErrorState message={error ?? 'Помилка завантаження тегів організму'} />
          ) : null}

          {status === 'success' && visibleTags.length === 0 ? (
            <SectionEmptyState message="У вашого організму ще немає активних тегів" />
          ) : null}

          {status === 'success' && visibleTags.length > 0 ? (
            <TableStateProvider
              tableId="settings-my-organism-tags-neo"
              defaultColumnOrder={MY_ORGANISM_TAGS_COLUMN_ORDER}
              defaultColumnVisibility={MY_ORGANISM_TAGS_COLUMN_VISIBILITY}
              defaultEnableColumnOrdering={false}
            >
              <Stack spacing={2}>
                <Box sx={{ maxWidth: 320 }}>
                  <TagsSearchField />
                </Box>
                <SettingsNeoTable columns={columns} data={visibleTags} layoutMode="grid" />
              </Stack>
            </TableStateProvider>
          ) : null}
        </Stack>
      </Box>
    </Box>
  );
}
