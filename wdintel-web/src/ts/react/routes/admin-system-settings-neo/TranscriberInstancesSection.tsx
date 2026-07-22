import {
  Button,
  Card,
  CardContent,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle,
  FormControlLabel,
  Stack,
  Switch,
  TextField,
  Typography,
} from '@mui/material';
import { useCallback, useEffect, useState } from 'react';

import { PowerAlert } from '../../components/PowerAlert';
import { usePowerSnackbar } from '../../components/PowerSnackbar';
import {
  checkTranscriberInstance,
  createTranscriberInstance,
  deleteTranscriberInstance,
  listTranscriberInstances,
  type TranscriberInstance,
  type TranscriberInstanceHealth,
  type TranscriberInstanceInput,
  type TranscriberMutationResult,
  updateTranscriberInstance,
} from '../../services/api/transcriber';

const GPU_INSTANCE_TEXT_MAX_CHARS = 255;
const POSTGRES_INTEGER_MAX = 2_147_483_647;

function emptyInputForInstances(instances: TranscriberInstance[]): TranscriberInstanceInput {
  return {
    name: '',
    host: '',
    rs_port: 3001,
    py_port: 3000,
    ordering: Math.max(0, ...instances.map((instance) => instance.ordering)) + 1,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function validate(input: TranscriberInstanceInput): string | null {
  if (!input.name.trim()) return 'Вкажіть назву інстансу.';
  if (!input.host.trim()) return 'Вкажіть хост інстансу.';
  if (
    [...input.name].length > GPU_INSTANCE_TEXT_MAX_CHARS ||
    [...input.host].length > GPU_INSTANCE_TEXT_MAX_CHARS
  ) {
    return `Назва та хост мають містити не більше ${GPU_INSTANCE_TEXT_MAX_CHARS} символів.`;
  }
  if (
    !Number.isInteger(input.ordering) ||
    input.ordering < 1 ||
    input.ordering > POSTGRES_INTEGER_MAX
  ) {
    return `Порядок має бути цілим числом від 1 до ${POSTGRES_INTEGER_MAX}.`;
  }
  if (
    ![input.rs_port, input.py_port].every(
      (port) => Number.isInteger(port) && port >= 1 && port <= 65535,
    )
  ) {
    return 'Порти мають бути цілими числами від 1 до 65535.';
  }
  return null;
}

function healthText(health: TranscriberInstanceHealth['rust']): string {
  if (health.ok) return 'доступний';
  const details = [health.status, health.error].filter(
    (value): value is number | string => value !== null && value !== '',
  );
  return details.length > 0 ? `недоступний (${details.join(': ')})` : 'недоступний';
}

type PendingMutation = {
  title: string;
  instanceId?: string;
  run: () => Promise<TranscriberMutationResult>;
};

function sortInstances(instances: TranscriberInstance[]): TranscriberInstance[] {
  return [...instances].sort(
    (left, right) =>
      left.ordering - right.ordering ||
      left.created_at - right.created_at ||
      left.id.localeCompare(right.id),
  );
}

export function TranscriberInstancesSection() {
  const [instances, setInstances] = useState<TranscriberInstance[]>([]);
  const [input, setInput] = useState(() => emptyInputForInstances([]));
  const [editingId, setEditingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [restartWarning, setRestartWarning] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [pendingMutation, setPendingMutation] = useState<PendingMutation | null>(null);
  const [health, setHealth] = useState<Record<string, TranscriberInstanceHealth>>({});
  const { notify } = usePowerSnackbar();

  const refresh = useCallback(async (): Promise<TranscriberInstance[] | null> => {
    setLoading(true);
    setError(null);
    try {
      const nextInstances = await listTranscriberInstances();
      setInstances(nextInstances);
      setHealth({});
      return nextInstances;
    } catch (nextError) {
      setError(`Помилка завантаження GPU інстансів: ${errorMessage(nextError)}`);
      return null;
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh().then((nextInstances) => {
      if (nextInstances) {
        setInput((current) =>
          current.name || current.host ? current : emptyInputForInstances(nextInstances),
        );
      }
    });
  }, [refresh]);

  function requestSave() {
    const normalized = { ...input, name: input.name.trim(), host: input.host.trim() };
    const validationError = validate(normalized);
    if (validationError) {
      setError(validationError);
      return;
    }
    const instanceId = editingId ?? undefined;
    setPendingMutation({
      title: editingId ? 'Зберегти зміни GPU інстансу?' : 'Створити GPU інстанс?',
      instanceId,
      run: () =>
        instanceId
          ? updateTranscriberInstance(instanceId, normalized)
          : createTranscriberInstance(normalized),
    });
  }

  async function runConfirmedMutation() {
    const mutation = pendingMutation;
    if (!mutation) return;
    setPendingMutation(null);
    setLoading(true);
    setError(null);
    setRestartWarning(null);
    try {
      const result = await mutation.run();
      if (result.restart_status === 'failed') {
        setRestartWarning(
          `Конфігурацію збережено, але її не вдалося повністю застосувати: ${result.restart_error ?? 'невідома помилка'}`,
        );
      } else {
        notify({
          severity: 'success',
          message: 'Конфігурацію GPU збережено; воркер перезапускається.',
        });
      }
      setEditingId(null);
      const affectedInstanceId = result.instance?.id ?? mutation.instanceId;
      const knownInstances = sortInstances(
        result.instance
          ? [
              ...instances.filter((instance) => instance.id !== result.instance?.id),
              result.instance,
            ]
          : result.deleted && mutation.instanceId
            ? instances.filter((instance) => instance.id !== mutation.instanceId)
            : instances,
      );
      setInstances(knownInstances);
      if (affectedInstanceId) {
        setHealth((current) => {
          const next = { ...current };
          delete next[affectedInstanceId];
          return next;
        });
      }
      const nextInstances = await refresh();
      setInput(emptyInputForInstances(nextInstances ?? knownInstances));
    } catch (nextError) {
      setError(`Помилка зміни GPU інстансу: ${errorMessage(nextError)}`);
    } finally {
      setLoading(false);
    }
  }

  async function check(instance: TranscriberInstance) {
    setLoading(true);
    setError(null);
    setHealth((current) => {
      const next = { ...current };
      delete next[instance.id];
      return next;
    });
    try {
      const result = await checkTranscriberInstance(instance.id);
      setHealth((current) => ({ ...current, [instance.id]: result }));
    } catch (nextError) {
      setError(`Помилка перевірки інстансу: ${errorMessage(nextError)}`);
    } finally {
      setLoading(false);
    }
  }

  return (
    <Stack spacing={2}>
      <Typography component="h2" variant="subtitle1" sx={{ fontWeight: 600 }}>
        Echo GPU інстанси
      </Typography>
      {error ? <PowerAlert severity="error">{error}</PowerAlert> : null}
      {restartWarning ? <PowerAlert severity="warning">{restartWarning}</PowerAlert> : null}

      <Stack direction={{ xs: 'column', md: 'row' }} spacing={1}>
        <TextField
          label="Назва"
          value={input.name}
          onChange={(event) => setInput((value) => ({ ...value, name: event.target.value }))}
        />
        <TextField
          label="Хост"
          value={input.host}
          onChange={(event) => setInput((value) => ({ ...value, host: event.target.value }))}
        />
        <TextField
          label="Rust порт"
          type="number"
          value={input.rs_port}
          onChange={(event) =>
            setInput((value) => ({ ...value, rs_port: Number(event.target.value) }))
          }
        />
        <TextField
          label="Python порт"
          type="number"
          value={input.py_port}
          onChange={(event) =>
            setInput((value) => ({ ...value, py_port: Number(event.target.value) }))
          }
        />
        <TextField
          label="Порядок"
          type="number"
          value={input.ordering}
          slotProps={{ htmlInput: { min: 1, max: POSTGRES_INTEGER_MAX } }}
          onChange={(event) =>
            setInput((value) => ({ ...value, ordering: Number(event.target.value) }))
          }
        />
      </Stack>
      <Stack direction="row" spacing={1}>
        <Button variant="contained" disabled={loading} onClick={requestSave}>
          {editingId ? 'зберегти інстанс' : 'додати інстанс'}
        </Button>
        {editingId ? (
          <Button
            onClick={() => {
              setEditingId(null);
              setInput(emptyInputForInstances(instances));
            }}
            disabled={loading}
          >
            скасувати
          </Button>
        ) : null}
        <Button disabled={loading} onClick={() => void refresh()}>
          оновити
        </Button>
      </Stack>

      {instances.map((instance) => {
        const instanceHealth = health[instance.id];
        return (
          <Card key={instance.id} variant="outlined">
            <CardContent>
              <Stack spacing={1}>
                <Typography sx={{ fontWeight: 600 }}>{instance.name}</Typography>
                <Typography variant="body2">
                  {instance.host}:{instance.rs_port} / {instance.py_port}; порядок{' '}
                  {instance.ordering}
                </Typography>
                <FormControlLabel
                  control={
                    <Switch
                      checked={instance.is_active}
                      disabled={loading}
                      onChange={(_, is_active) =>
                        setPendingMutation({
                          title: is_active
                            ? 'Активувати GPU інстанс?'
                            : 'Деактивувати GPU інстанс?',
                          instanceId: instance.id,
                          run: () => updateTranscriberInstance(instance.id, { is_active }),
                        })
                      }
                    />
                  }
                  label="Активний"
                />
                {instanceHealth ? (
                  <Typography variant="body2">
                    Rust: {healthText(instanceHealth.rust)}; Python:{' '}
                    {healthText(instanceHealth.python)}
                  </Typography>
                ) : null}
                <Stack direction="row" spacing={1}>
                  <Button
                    disabled={loading}
                    onClick={() => {
                      setEditingId(instance.id);
                      setInput({
                        name: instance.name,
                        host: instance.host,
                        rs_port: instance.rs_port,
                        py_port: instance.py_port,
                        ordering: instance.ordering,
                      });
                    }}
                  >
                    редагувати
                  </Button>
                  <Button disabled={loading} onClick={() => void check(instance)}>
                    перевірити
                  </Button>
                  <Button
                    color="error"
                    disabled={loading}
                    onClick={() =>
                      setPendingMutation({
                        title: 'Видалити GPU інстанс?',
                        instanceId: instance.id,
                        run: () => deleteTranscriberInstance(instance.id),
                      })
                    }
                  >
                    видалити
                  </Button>
                </Stack>
              </Stack>
            </CardContent>
          </Card>
        );
      })}

      <Dialog open={pendingMutation !== null} onClose={() => setPendingMutation(null)}>
        <DialogTitle>{pendingMutation?.title}</DialogTitle>
        <DialogContent>
          <DialogContentText>
            Після підтвердження wdintel-rs-bgworker буде коректно перезапущено. Поточне
            транскрибування матиме час завершитися.
          </DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setPendingMutation(null)}>скасувати</Button>
          <Button variant="contained" onClick={() => void runConfirmedMutation()}>
            підтвердити
          </Button>
        </DialogActions>
      </Dialog>
    </Stack>
  );
}
