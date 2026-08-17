import RefreshIcon from '@mui/icons-material/Refresh';
import {
  Box,
  Card,
  CardContent,
  IconButton,
  Link,
  Stack,
  Tooltip,
  Typography,
} from '@mui/material';
import type { MRT_ColumnDef } from 'material-react-table';
import { useCallback, useEffect, useMemo, useState } from 'react';

import type { InconsistentUnit } from '../../../../Bindings';
import { PowerAlert } from '../../components/PowerAlert';
import { TablePageToolbar } from '../../components/TablePageToolbar';
import { TableStateProvider } from '../../components/mui-customized/table/table-state-provider';
import { getInconsistentUnits } from '../../services/api/units';
import { handleNavigateWithinSpaClick } from '../../utils/browser';
import { SettingsNeoTable } from '../settings-neo/SettingsNeoTable';
import { formatUnitError } from '../rer-units-neo/helpers';

const DEFAULT_COLUMN_ORDER = ['mrt-row-numbers', 'name', 'reasons', 'problematicEchelons'];

const DEFAULT_COLUMN_VISIBILITY = {
  name: true,
  reasons: true,
  problematicEchelons: true,
};

type AdminUnitInconsistentPageProps = {
  embedded?: boolean;
};

export function AdminUnitInconsistentPage({ embedded = false }: AdminUnitInconsistentPageProps) {
  const [units, setUnits] = useState<InconsistentUnit[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const loadUnits = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    setLoadError(null);
    try {
      setUnits(await getInconsistentUnits(signal ? { signal } : undefined));
    } catch (error) {
      if (!signal?.aborted) setLoadError(formatUnitError(error));
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void loadUnits(controller.signal);
    return () => controller.abort();
  }, [loadUnits]);

  const columns = useMemo<MRT_ColumnDef<InconsistentUnit>[]>(
    () => [
      {
        id: 'name',
        accessorKey: 'name',
        header: 'Назва підрозділу',
        size: 320,
        Cell: ({ row }) => {
          const href = `/rer-units/${row.original.sigintUnitId}`;
          return (
            <Link href={href} onClick={(event) => handleNavigateWithinSpaClick(event, href)}>
              {row.original.name.trim() || `#${row.original.sigintUnitId}`}
            </Link>
          );
        },
      },
      {
        id: 'reasons',
        accessorFn: (row) => row.reasons?.join(', ') ?? '',
        header: 'Причина',
        size: 300,
        Cell: ({ cell }) => String(cell.getValue() || '—'),
      },
      {
        id: 'problematicEchelons',
        accessorFn: (row) => row.problematicEchelons?.join(', ') ?? '',
        header: 'Проблемні ешелони',
        size: 300,
        Cell: ({ cell }) => String(cell.getValue() || '—'),
      },
    ],
    [],
  );

  return (
    <TableStateProvider
      tableId="admin-unit-inconsistent"
      defaultColumnOrder={DEFAULT_COLUMN_ORDER}
      defaultColumnVisibility={DEFAULT_COLUMN_VISIBILITY}
      defaultEnableColumnOrdering={false}
    >
      <Stack spacing={1.5} sx={{ height: '100%', minHeight: 0, p: embedded ? 0 : 2 }}>
        <TablePageToolbar
          title="Неконсистентні підрозділи"
          withGlobalTextFilter
          trailingActionsAfterInternal={
            <Tooltip title="Оновити">
              <span>
                <IconButton size="small" disabled={loading} onClick={() => void loadUnits()}>
                  <RefreshIcon fontSize="small" />
                </IconButton>
              </span>
            </Tooltip>
          }
        />
        <Card variant="outlined">
          <CardContent>
            <Typography variant="h6" gutterBottom>
              Чому підрозділи потрапляють до цього списку
            </Typography>
            <Typography variant="body2" color="text.secondary">
              Підрозділ потребує перевірки, якщо він має кілька активних прив’язок ORBIT або
              найнижчий ешелон прив’язаного підрозділу ORBIT нижчий за найнижчий ешелон SIGINT.
              Відкрийте підрозділ за посиланням, виправте його ієрархію або прив’язки та збережіть
              зміни — стан буде перераховано автоматично.
            </Typography>
          </CardContent>
        </Card>
        {loadError ? <PowerAlert severity="error">{loadError}</PowerAlert> : null}
        <Box sx={{ flex: 1, minHeight: 0 }}>
          <SettingsNeoTable
            columns={columns}
            data={units}
            loading={loading}
            layoutMode="grid"
            tablePaperSx={{ height: '100%', minHeight: 0 }}
            tableContainerSx={{ maxHeight: '100%' }}
          />
        </Box>
      </Stack>
    </TableStateProvider>
  );
}
