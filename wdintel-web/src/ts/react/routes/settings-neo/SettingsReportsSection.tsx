import { Box, CircularProgress, Stack, TextField, Typography } from '@mui/material';
import { useEffect, useMemo, useState } from 'react';

import type {
  AreaOfResponsibility,
  UpdateAreaOfResponsibilityReportOrderReq,
} from '../../../../Bindings';
import { PowerAlert } from '../../components/PowerAlert';
import { PowerButton } from '../../components/PowerButton';
import { isUnauthorizedError } from '../../services/api/client';
import { listAors, updateAorReportOrders } from '../../services/api/aor';

type ReportsRow = {
  id: number;
  name: string;
  orderInput: string;
  initialOrder: number;
};

type Props = {
  active: boolean;
  userRoles: string[];
};

type LoadStatus = 'idle' | 'loading' | 'ready' | 'error';

function formatErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return error.message;
  if (typeof error === 'string' && error.trim()) return error;
  return 'Невідома помилка. Спробуйте ще раз.';
}

function toRows(aors: AreaOfResponsibility[]): ReportsRow[] {
  return [...aors]
    .filter((aor) => aor.isTopLevel)
    .sort(
      (left, right) =>
        left.orderForReport - right.orderForReport
        || left.name.localeCompare(right.name, 'uk'),
    )
    .map((aor) => ({
      id: aor.id,
      name: aor.name,
      orderInput: String(aor.orderForReport),
      initialOrder: aor.orderForReport,
    }));
}

function parseOrderInput(value: string): number | null {
  if (value.trim() === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function SettingsReportsSection({ active, userRoles }: Props) {
  const [rows, setRows] = useState<ReportsRow[]>([]);
  const [loadStatus, setLoadStatus] = useState<LoadStatus>('idle');
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saveSuccess, setSaveSuccess] = useState<string | null>(null);
  const [saveInProgress, setSaveInProgress] = useState(false);

  const canRead = useMemo(
    () => userRoles.some((role) => ['Admin', 'Rer', 'UnitsEditor'].includes(role)),
    [userRoles],
  );
  const canEdit = useMemo(
    () => userRoles.some((role) => ['Admin', 'Rer'].includes(role)),
    [userRoles],
  );

  useEffect(() => {
    if (!active || !canRead || loadStatus !== 'idle') return;

    let cancelled = false;

    async function load() {
      setLoadStatus('loading');
      setLoadError(null);

      try {
        const aors = await listAors({ sortBy: 'AreaOfResponsibilityNameAsc' });
        if (cancelled) return;
        setRows(toRows(aors));
        setLoadStatus('ready');
      } catch (error) {
        if (cancelled) return;
        if (isUnauthorizedError(error)) {
          window.location.assign('/login');
          return;
        }
        setLoadError(`Помилка завантаження: ${formatErrorMessage(error)}`);
        setLoadStatus('error');
      }
    }

    load();

    return () => {
      cancelled = true;
    };
  }, [active, canRead, loadStatus]);

  const hasInvalidRows = rows.some((row) => parseOrderInput(row.orderInput) == null);
  const isDirty = rows.some((row) => parseOrderInput(row.orderInput) !== row.initialOrder);

  async function handleSave() {
    if (!canEdit || hasInvalidRows || !isDirty || saveInProgress) return;

    setSaveError(null);
    setSaveSuccess(null);
    setSaveInProgress(true);

    try {
      const req: UpdateAreaOfResponsibilityReportOrderReq = {
        items: rows.map((row) => ({
          id: row.id,
          orderForReport: parseOrderInput(row.orderInput) ?? row.initialOrder,
        })),
      };
      const updated = await updateAorReportOrders(req);
      setRows(toRows(updated));
      setSaveSuccess('Порядок звітів збережено');
    } catch (error) {
      if (isUnauthorizedError(error)) {
        window.location.assign('/login');
        return;
      }
      setSaveError(`Помилка збереження: ${formatErrorMessage(error)}`);
    } finally {
      setSaveInProgress(false);
    }
  }

  return (
    <Box id="settings-neo-panel-reports" role="tabpanel" aria-labelledby="settings-neo-tab-reports" sx={{ p: 3 }}>
      <Stack spacing={3}>
        <Box>
          <Typography variant="body2" color="text.secondary">
            Порядок визначає послідовність аркушів у GOI-звіті. Менші значення йдуть раніше; AOR без даних пропускаються.
          </Typography>
        </Box>

        {!canRead ? (
          <PowerAlert severity="info">У вас немає доступу до налаштування порядку звітів.</PowerAlert>
        ) : null}
        {loadError ? <PowerAlert severity="error">{loadError}</PowerAlert> : null}
        {saveError ? <PowerAlert severity="error">{saveError}</PowerAlert> : null}
        {saveSuccess ? (
          <PowerAlert severity="success" role="status">
            {saveSuccess}
          </PowerAlert>
        ) : null}
        {canRead && !canEdit ? (
          <PowerAlert severity="info">Редагування доступне ролям `Admin` або `Rer`.</PowerAlert>
        ) : null}

        {canRead && loadStatus === 'loading' ? (
          <Box sx={{ display: 'flex', justifyContent: 'center', py: 4 }}>
            <CircularProgress size={28} />
          </Box>
        ) : null}

        {canRead && loadStatus === 'ready' ? (
          <Stack spacing={2.5}>
            {rows.map((row) => {
              const invalid = parseOrderInput(row.orderInput) == null;
              return (
                <Box
                  key={row.id}
                  sx={{
                    display: 'grid',
                    gap: 2,
                    gridTemplateColumns: { xs: '1fr', sm: 'minmax(0, 1fr) 180px' },
                    alignItems: 'start',
                  }}
                >
                  <Box>
                    <Typography variant="subtitle2">{row.name}</Typography>
                  </Box>
                  <TextField
                    label="Порядок"
                    value={row.orderInput}
                    onChange={(event) => {
                      setSaveSuccess(null);
                      setRows((currentRows) =>
                        currentRows.map((currentRow) =>
                          currentRow.id === row.id
                            ? { ...currentRow, orderInput: event.target.value }
                            : currentRow,
                        ),
                      );
                    }}
                    type="number"
                    size="small"
                    error={invalid}
                    helperText={invalid ? 'Вкажіть число' : 'Менше значення вище в звіті'}
                    disabled={!canEdit || saveInProgress}
                    slotProps={{ htmlInput: { step: 0.1 } }}
                  />
                </Box>
              );
            })}

            <Box sx={{ display: 'flex', justifyContent: 'flex-end', pt: 1 }}>
              <PowerButton
                variant="contained"
                onClick={handleSave}
                disabled={!canEdit || hasInvalidRows || !isDirty || saveInProgress}
                startIcon={saveInProgress ? <CircularProgress size={18} /> : undefined}
              >
                зберегти
              </PowerButton>
            </Box>
          </Stack>
        ) : null}
      </Stack>
    </Box>
  );
}
