import { Box, CircularProgress, Stack, TextField, Typography } from '@mui/material';
import { useEffect, useMemo, useState } from 'react';

import type {
  AreaOfResponsibility,
  UpdateAreaOfResponsibilityReportOrderReq,
} from '../../../../Bindings';
import { PowerAlert } from '../../components/PowerAlert';
import { PowerButton } from '../../components/PowerButton';
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
  rolesLoading: boolean;
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

export function SettingsReportsSection({ active, userRoles, rolesLoading }: Props) {
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
    if (!active || !canRead) return;

    const abortController = new AbortController();

    async function load() {
      setLoadStatus('loading');
      setLoadError(null);

      try {
        const aors = await listAors(
          { sortBy: 'AreaOfResponsibilityNameAsc' },
          abortController.signal,
        );
        if (abortController.signal.aborted) return;
        setRows(toRows(aors));
        setLoadStatus('ready');
      } catch (error) {
        if (abortController.signal.aborted) return;
        setLoadError(`Помилка завантаження: ${formatErrorMessage(error)}`);
        setLoadStatus('error');
      }
    }

    load();

    return () => {
      abortController.abort();
    };
  }, [active, canRead]);

  const hasInvalidRows = rows.some((row) => (parseOrderInput(row.orderInput) === null || parseOrderInput(row.orderInput) === undefined));
  const isDirty = rows.some((row) => parseOrderInput(row.orderInput) !== row.initialOrder);
  const rowPairs = useMemo(() => {
    const pairs: Array<[ReportsRow, ReportsRow | null]> = [];
    for (let index = 0; index < rows.length; index += 2) {
      pairs.push([rows[index], rows[index + 1] ?? null]);
    }
    return pairs;
  }, [rows]);

  function setRowOrderInput(rowId: number, value: string) {
    setSaveSuccess(null);
    setRows((currentRows) =>
      currentRows.map((currentRow) =>
        currentRow.id === rowId
          ? { ...currentRow, orderInput: value }
          : currentRow,
      ),
    );
  }

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
            Менше значення порядку відображається вище в звіті.
          </Typography>
        </Box>

        {!rolesLoading && !canRead ? (
          <PowerAlert severity="info">У вас немає доступу до налаштування порядку звітів.</PowerAlert>
        ) : null}
        {loadError ? <PowerAlert severity="error">{loadError}</PowerAlert> : null}
        {saveError ? <PowerAlert severity="error">{saveError}</PowerAlert> : null}
        {saveSuccess ? (
          <PowerAlert severity="success" role="status">
            {saveSuccess}
          </PowerAlert>
        ) : null}
        {!rolesLoading && canRead && !canEdit ? (
          <PowerAlert severity="info">Редагування доступне ролям `Admin` або `Rer`.</PowerAlert>
        ) : null}

        {canRead && (rolesLoading || loadStatus === 'loading') ? (
          <Box sx={{ display: 'flex', justifyContent: 'center', py: 4 }}>
            <CircularProgress size={28} />
          </Box>
        ) : null}

        {canRead && !rolesLoading && loadStatus === 'ready' ? (
          <Stack spacing={2.5}>
            <Box
              sx={{
                width: '100%',
                maxWidth: '100%',
                mx: 'auto',
              }}
            >
              <Box
                sx={{
                  display: { xs: 'none', md: 'grid' },
                  gridTemplateColumns: 'minmax(0, 1fr) 40px minmax(0, 1fr)',
                  alignItems: 'end',
                  pb: 1.5,
                }}
              >
                <Box sx={{ display: 'flex', justifyContent: 'space-between', gap: 2 }}>
                  <Typography variant="body2" color="text.secondary">
                    Смуга
                  </Typography>
                </Box>
                <Box />
                <Box sx={{ display: 'flex', justifyContent: 'space-between', gap: 2 }}>
                  <Typography variant="body2" color="text.secondary">
                    Смуга
                  </Typography>
                </Box>
              </Box>

              {rowPairs.map(([leftRow, rightRow], rowIndex) => {
                const leftInvalid = (parseOrderInput(leftRow.orderInput) === null || parseOrderInput(leftRow.orderInput) === undefined);
                const rightInvalid = (rightRow === null || rightRow === undefined) ? false : (parseOrderInput(rightRow.orderInput) === null || parseOrderInput(rightRow.orderInput) === undefined);
                const topBorderSx = rowIndex > 0 ? { borderTop: 1, borderColor: 'divider' } : undefined;
                return (
                  <Box
                    key={leftRow.id}
                    sx={{
                      display: { xs: 'none', md: 'grid' },
                      gridTemplateColumns: 'minmax(0, 1fr) 40px minmax(0, 1fr)',
                      alignItems: 'center',
                    }}
                  >
                    <Box
                      sx={{
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'center',
                        gap: 2,
                        minWidth: 0,
                        py: 2,
                        ...topBorderSx,
                      }}
                    >
                      <Typography variant="subtitle2" sx={{ minWidth: 0 }}>
                        {leftRow.name}
                      </Typography>
                      <TextField
                        label="Порядок"
                        value={leftRow.orderInput}
                        onChange={(event) => setRowOrderInput(leftRow.id, event.target.value)}
                        type="number"
                        size="small"
                        error={leftInvalid}
                        helperText={leftInvalid ? 'Вкажіть число' : undefined}
                        disabled={!canEdit || saveInProgress}
                        slotProps={{ htmlInput: { step: 0.1 } }}
                        sx={{ width: 220, flexShrink: 0 }}
                      />
                    </Box>
                    <Box />
                    {rightRow ? (
                      <Box
                        sx={{
                          display: 'flex',
                          justifyContent: 'space-between',
                          alignItems: 'center',
                          gap: 2,
                          minWidth: 0,
                          py: 2,
                          ...topBorderSx,
                        }}
                      >
                        <Typography variant="subtitle2" sx={{ minWidth: 0 }}>
                          {rightRow.name}
                        </Typography>
                        <TextField
                          label="Порядок"
                          value={rightRow.orderInput}
                          onChange={(event) => setRowOrderInput(rightRow.id, event.target.value)}
                          type="number"
                          size="small"
                          error={rightInvalid}
                          helperText={rightInvalid ? 'Вкажіть число' : undefined}
                          disabled={!canEdit || saveInProgress}
                          slotProps={{ htmlInput: { step: 0.1 } }}
                          sx={{ width: 220, flexShrink: 0 }}
                        />
                      </Box>
                    ) : (
                      <Box />
                    )}
                  </Box>
                );
              })}

              <Box
                sx={{
                  display: { xs: 'grid', md: 'none' },
                  gridTemplateColumns: '1fr',
                  rowGap: 1.5,
                }}
              >
                <Typography variant="body2" color="text.secondary">
                  Смуга
                </Typography>
                {rows.map((row) => {
                  const invalid = (parseOrderInput(row.orderInput) === null || parseOrderInput(row.orderInput) === undefined);
                  return (
                    <Box
                      key={row.id}
                      sx={{
                        display: 'grid',
                        gridTemplateColumns: '1fr',
                        rowGap: 1,
                        borderTop: 1,
                        borderColor: 'divider',
                        pt: 1.5,
                      }}
                    >
                      <Typography variant="subtitle2">{row.name}</Typography>
                      <TextField
                        label="Порядок"
                        value={row.orderInput}
                        onChange={(event) => setRowOrderInput(row.id, event.target.value)}
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
              </Box>

            </Box>

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
