import SaveIcon from '@mui/icons-material/Save';
import {
  Alert,
  Box,
  Card,
  CardContent,
  Chip,
  CircularProgress,
  FormControlLabel,
  Stack,
  Switch,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  Typography,
} from '@mui/material';
import React from 'react';

import { PageHeader } from '../../components/PageHeader';
import { Button } from '../../components/mui-customized/button';
import { isUnauthorizedError } from '../../services/api/client';
import {
  activateSystemSettings,
  createSystemSettings,
  listSystemSettings,
  type SystemSettingsItem,
} from '../../services/api/system-settings';

function formatErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }
  if (typeof error === 'string' && error.trim().length > 0) {
    return error;
  }
  return 'Невідома помилка. Спробуйте ще раз.';
}

function formatDate(ts: number): string {
  try {
    return new Intl.DateTimeFormat('uk-UA', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    }).format(new Date(ts));
  } catch (_) {
    return String(ts);
  }
}

function sortItems(items: SystemSettingsItem[]): SystemSettingsItem[] {
  return [...items].sort((left, right) => {
    if (left.deleted !== right.deleted) {
      return left.deleted ? 1 : -1;
    }
    return right.updatedAt - left.updatedAt;
  });
}

export function AdminSystemSettingsNeoPage() {
  const [items, setItems] = React.useState<SystemSettingsItem[]>([]);
  const [draftExactMatchOnlyDefault, setDraftExactMatchOnlyDefault] =
    React.useState(true);
  const [loadInProgress, setLoadInProgress] = React.useState(true);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [saveError, setSaveError] = React.useState<string | null>(null);
  const [saveSuccess, setSaveSuccess] = React.useState<string | null>(null);
  const [saveInProgress, setSaveInProgress] = React.useState(false);
  const [activatingId, setActivatingId] = React.useState<number | null>(null);

  async function load() {
    setLoadInProgress(true);
    setLoadError(null);

    try {
      const settings = await listSystemSettings();
      setItems(sortItems(settings));
    } catch (error) {
      if (isUnauthorizedError(error)) {
        window.location.assign('/login');
        return;
      }
      setLoadError(
        `Помилка завантаження системних налаштувань: ${formatErrorMessage(error)}`,
      );
    } finally {
      setLoadInProgress(false);
    }
  }

  React.useEffect(() => {
    load();
  }, []);

  async function handleCreate(event?: React.FormEvent) {
    event?.preventDefault();
    if (saveInProgress) return;

    setSaveInProgress(true);
    setSaveError(null);
    setSaveSuccess(null);

    try {
      const created = await createSystemSettings(draftExactMatchOnlyDefault);
      setItems((prev) =>
        sortItems(
          prev
            .map((item) =>
              item.deleted
                ? item
                : {
                    ...item,
                    deleted: true,
                    updatedAt: created.updatedAt,
                    updatedBy: created.updatedBy,
                  },
            )
            .concat(created),
        ),
      );
      setSaveSuccess('Нове системне налаштування створено та активовано.');
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

  async function handleActivate(id: number) {
    if (activatingId !== null) return;

    setActivatingId(id);
    setSaveError(null);
    setSaveSuccess(null);

    try {
      const activated = await activateSystemSettings(id);
      setItems((prev) =>
        sortItems(
          prev.map((item) =>
            item.id === activated.id
              ? activated
              : item.deleted
                ? item
                : {
                    ...item,
                    deleted: true,
                    updatedAt: activated.updatedAt,
                    updatedBy: activated.updatedBy,
                  },
          ),
        ),
      );
      setSaveSuccess(`Налаштування #${id} активовано.`);
    } catch (error) {
      if (isUnauthorizedError(error)) {
        window.location.assign('/login');
        return;
      }
      setSaveError(`Помилка активації: ${formatErrorMessage(error)}`);
    } finally {
      setActivatingId(null);
    }
  }

  return (
    <Box className="w-full" sx={{ height: '100%', minHeight: 0, overflow: 'auto' }}>
      <Stack spacing={3} useFlexGap sx={{ minHeight: '100%' }}>
        <PageHeader title="налаштування системи" className="px-4" />

        <Card variant="outlined">
          <CardContent sx={{ p: 3, '&:last-child': { pb: 3 } }}>
            <Box component="form" onSubmit={handleCreate} noValidate>
              <Stack spacing={3}>
                <Typography component="h2" variant="h6" sx={{ m: 0, fontWeight: 600 }}>
                  Активне значення за замовчуванням
                </Typography>

                {loadError ? <Alert severity="error">{loadError}</Alert> : null}
                {saveError ? <Alert severity="error">{saveError}</Alert> : null}
                {saveSuccess ? (
                  <Alert severity="success" role="status">
                    {saveSuccess}
                  </Alert>
                ) : null}

                <FormControlLabel
                  control={
                    <Switch
                      checked={draftExactMatchOnlyDefault}
                      onChange={(_, checked) => {
                        setSaveSuccess(null);
                        setDraftExactMatchOnlyDefault(checked);
                      }}
                    />
                  }
                  label="За замовчуванням на /rer-analysis чекбокс `точний збіг за еталонкою` увімкнений"
                />

                <Box className="flex items-center justify-end">
                  <Button
                    variant="contained"
                    type="submit"
                    disabled={saveInProgress || loadInProgress}
                    startIcon={
                      saveInProgress ? (
                        <CircularProgress size={18} />
                      ) : (
                        <SaveIcon fontSize="small" />
                      )
                    }
                  >
                    зберегти як нове активне
                  </Button>
                </Box>
              </Stack>
            </Box>
          </CardContent>
        </Card>

        <Card variant="outlined">
          <CardContent sx={{ p: 3, '&:last-child': { pb: 3 } }}>
            <Stack spacing={2}>
              <Typography component="h2" variant="h6" sx={{ m: 0, fontWeight: 600 }}>
                Історія системних налаштувань
              </Typography>

              {loadInProgress ? (
                <Box className="flex items-center gap-3 py-3">
                  <CircularProgress size={20} />
                  <Typography variant="body2" color="text.secondary">
                    Завантаження...
                  </Typography>
                </Box>
              ) : null}

              {!loadInProgress ? (
                <Table size="small">
                  <TableHead>
                    <TableRow>
                      <TableCell>ID</TableCell>
                      <TableCell>Статус</TableCell>
                      <TableCell>Точний збіг за замовчуванням</TableCell>
                      <TableCell>Створено</TableCell>
                      <TableCell>Оновлено</TableCell>
                      <TableCell>Ким оновлено</TableCell>
                      <TableCell align="right">Дія</TableCell>
                    </TableRow>
                  </TableHead>
                  <TableBody>
                    {items.map((item) => (
                      <TableRow key={item.id} hover>
                        <TableCell>{item.id}</TableCell>
                        <TableCell>
                          {item.deleted ? (
                            <Chip size="small" label="неактивне" />
                          ) : (
                            <Chip size="small" color="success" label="активне" />
                          )}
                        </TableCell>
                        <TableCell>
                          {item.rerAnalysisUnitsExactMatchOnlyDefault
                            ? 'увімкнено'
                            : 'вимкнено'}
                        </TableCell>
                        <TableCell>{formatDate(item.createdAt)}</TableCell>
                        <TableCell>{formatDate(item.updatedAt)}</TableCell>
                        <TableCell>{item.updatedBy || '—'}</TableCell>
                        <TableCell align="right">
                          <Button
                            variant="outlined"
                            disabled={!item.deleted || activatingId === item.id}
                            onClick={() => handleActivate(item.id)}
                          >
                            {activatingId === item.id ? 'Активація...' : 'Активувати'}
                          </Button>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              ) : null}
            </Stack>
          </CardContent>
        </Card>
      </Stack>
    </Box>
  );
}
