import RefreshIcon from '@mui/icons-material/Refresh';
import { Box, Card, CardContent, Stack, Tooltip, Typography } from '@mui/material';
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { MouseEvent as ReactMouseEvent } from 'react';

import type { InconsistentUnit } from '../../../../Bindings';
import { PowerAlert } from '../../components/PowerAlert';
import { PowerIconButton } from '../../components/PowerIconButton';
import { TablePageToolbar } from '../../components/TablePageToolbar';
import {
  type AppMrtColumnDef,
  mrtCustomCell,
  mrtTextCell,
} from '../../components/mui-customized/table/get-default-table-options';
import { MrtOverflowText } from '../../components/mui-customized/table/mrt-overflow';
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

  const columns = useMemo<AppMrtColumnDef<InconsistentUnit>[]>(
    () => [
      {
        id: 'name',
        accessorKey: 'name',
        header: 'Назва підрозділу',
        size: 320,
        meta: { overflowMode: 'custom', overflowOwner: 'shared-text', interactive: true },
        Cell: mrtCustomCell<InconsistentUnit>(({ row }) => {
          const href = `/rer-units/${row.original.sigintUnitId}`;
          const label = row.original.name.trim() || `#${row.original.sigintUnitId}`;
          return (
            <MrtOverflowText
              displayValue={label}
              fullValue={label}
              interactive
              component="a"
              componentProps={{
                href,
                onClick: (event: ReactMouseEvent<HTMLElement>) =>
                  handleNavigateWithinSpaClick(event, href),
              }}
            />
          );
        }),
      },
      {
        id: 'reasons',
        accessorFn: (row) => row.reasons?.join(', ') ?? '',
        header: 'Причина',
        size: 300,
        meta: { overflowMode: 'text' },
        Cell: mrtTextCell({
          displayValue: ({ cell }) => String(cell.getValue() || '—'),
          fullValue: ({ cell }) => String(cell.getValue() || '—'),
        }),
      },
      {
        id: 'problematicEchelons',
        accessorFn: (row) => row.problematicEchelons?.join(', ') ?? '',
        header: 'Проблемні ешелони',
        size: 300,
        meta: { overflowMode: 'text' },
        Cell: mrtTextCell({
          displayValue: ({ cell }) => String(cell.getValue() || '—'),
          fullValue: ({ cell }) => String(cell.getValue() || '—'),
        }),
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
          additionalInternalActions={
            <Tooltip title="Оновити">
              <span>
                <PowerIconButton
                  aria-label="Оновити"
                  size="small"
                  disabled={loading}
                  onClick={() => void loadUnits()}
                >
                  <RefreshIcon fontSize="small" />
                </PowerIconButton>
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
