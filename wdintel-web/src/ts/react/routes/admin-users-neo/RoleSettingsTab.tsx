import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';
import EditIcon from '@mui/icons-material/Edit';
import {
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControlLabel,
  MenuItem,
  Switch,
  TextField,
} from '@mui/material';
import { useCallback, useEffect, useState } from 'react';
import type { RoleMessageSettings } from '../../../../Bindings';
import { PageHeader } from '../../components/PageHeader';
import { PageErrorState } from '../../components/PageErrorState';
import { PowerAlert } from '../../components/PowerAlert';
import { PowerButton } from '../../components/PowerButton';
import { usePowerSnackbar } from '../../components/PowerSnackbar';
import {
  deleteRoleMessageSettings,
  listRoleMessageSettings,
  saveRoleMessageSettings,
} from '../../services/api/role-message-settings';

const RULES = [
  { key: 'unitRequired', label: 'Обов’язковий підрозділ', description: '' },
  {
    key: 'deviceRequired',
    label: 'Обов’язкова назва пристрою',
    description: 'Застосовується, коли сервер і права користувача дозволяють роботу з пристроями.',
  },
  { key: 'allowUnitCreation', label: 'Дозволено створювати підрозділи', description: '' },
] as const;

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : 'Не вдалося виконати дію.';
}

function RoleSettingsDialog({
  initial,
  roles,
  editing,
  onClose,
  onSaved,
}: {
  initial: RoleMessageSettings;
  roles: string[];
  editing: boolean;
  onClose: () => void;
  onSaved: (settings: RoleMessageSettings) => void;
}) {
  const [settings, setSettings] = useState(initial);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { notify } = usePowerSnackbar();

  async function save(event: React.FormEvent) {
    event.preventDefault();
    if (saving || !settings.role) return;
    setSaving(true);
    setError(null);
    try {
      onSaved(await saveRoleMessageSettings(settings, editing));
      notify({ message: 'Налаштування ролі збережено.', severity: 'success' });
    } catch (error) {
      const message = errorText(error);
      setError(message);
      notify({ message, severity: 'error' });
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open onClose={saving ? undefined : onClose} fullWidth maxWidth="sm">
      <form onSubmit={save}>
        <DialogTitle>
          {editing ? 'Редагувати налаштування ролі' : 'Додати налаштування'}
        </DialogTitle>
        <DialogContent>
          <div className="flex flex-col gap-echo-lg pt-echo-sm">
            {error ? <PowerAlert severity="error">{error}</PowerAlert> : null}
            <TextField
              select
              required
              autoFocus
              label="Роль"
              value={settings.role}
              disabled={saving || editing}
              onChange={(event) => setSettings({ ...settings, role: event.target.value })}
              fullWidth
              size="small"
            >
              {roles.map((role) => (
                <MenuItem key={role} value={role}>
                  {role}
                </MenuItem>
              ))}
            </TextField>
            {RULES.map(({ key, label, description }) => (
              <div key={key}>
                <FormControlLabel
                  label={label}
                  control={
                    <Switch
                      checked={settings[key]}
                      disabled={saving}
                      onChange={(_, checked) => setSettings({ ...settings, [key]: checked })}
                    />
                  }
                />
                {description ? (
                  <p className="text-echo-sm text-echo-text-muted">{description}</p>
                ) : null}
              </div>
            ))}
          </div>
        </DialogContent>
        <DialogActions>
          <PowerButton onClick={onClose} disabled={saving}>
            Скасувати
          </PowerButton>
          <PowerButton type="submit" variant="contained" disabled={saving || !settings.role}>
            Зберегти
          </PowerButton>
        </DialogActions>
      </form>
    </Dialog>
  );
}

export function RoleSettingsTab() {
  const [settings, setSettings] = useState<RoleMessageSettings[]>([]);
  const [roles, setRoles] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [dialog, setDialog] = useState<{ initial: RoleMessageSettings; editing: boolean } | null>(
    null,
  );
  const [deleting, setDeleting] = useState<RoleMessageSettings | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const { notify } = usePowerSnackbar();

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const response = await listRoleMessageSettings();
      setSettings(response.settings);
      setRoles(response.roles);
    } catch (error) {
      const message = errorText(error);
      setLoadError(message);
      notify({ message, severity: 'error' });
    } finally {
      setLoading(false);
    }
  }, [notify]);

  useEffect(() => {
    void load();
  }, [load]);

  async function confirmDelete() {
    if (!deleting || deleteBusy) return;
    setDeleteBusy(true);
    try {
      await deleteRoleMessageSettings(deleting.role);
      setSettings((previous) => previous.filter(({ role }) => role !== deleting.role));
      setDeleting(null);
      notify({ message: 'Налаштування ролі видалено.', severity: 'success' });
    } catch (error) {
      notify({ message: errorText(error), severity: 'error' });
    } finally {
      setDeleteBusy(false);
    }
  }

  const availableRoles = roles.filter((role) => !settings.some((item) => item.role === role));

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-echo-lg overflow-auto">
      <PageHeader
        title="Налаштування ролей"
        actions={
          <PowerButton
            variant="contained"
            disabled={loading || Boolean(loadError) || availableRoles.length === 0}
            onClick={() =>
              setDialog({
                editing: false,
                initial: {
                  role: '',
                  unitRequired: false,
                  deviceRequired: false,
                  allowUnitCreation: true,
                },
              })
            }
          >
            Додати налаштування
          </PowerButton>
        }
      />
      <p className="text-echo-sm text-echo-text-muted">
        Правила діють під час створення повідомлень і розвіддонесень та мають пріоритет над
        особистими налаштуваннями. Серверні обмеження мають вищий пріоритет. Для кількох
        налаштованих ролей застосовуються найменш обмежувальні значення кожного правила.
      </p>
      {loading ? (
        <div role="status" aria-label="Завантаження налаштувань ролей">
          <CircularProgress />
        </div>
      ) : loadError ? (
        <PageErrorState message={loadError} actionLabel="Повторити" onAction={load} />
      ) : settings.length === 0 ? (
        <PowerAlert severity="info">Налаштувань ролей ще немає.</PowerAlert>
      ) : (
        <div className="grid gap-echo-lg echo-lg:grid-cols-2">
          {settings.map((item) => (
            <article
              key={item.role}
              aria-label={`Налаштування ролі ${item.role}`}
              className="flex flex-col gap-echo-md rounded-echo-md border border-echo-border bg-echo-surface p-echo-lg"
            >
              <h2 className="font-semibold">{item.role}</h2>
              <dl className="flex flex-col gap-echo-sm">
                {RULES.map(({ key, label }) => (
                  <div key={key} className="flex justify-between gap-echo-md">
                    <dt>{label}</dt>
                    <dd>{item[key] ? 'Так' : 'Ні'}</dd>
                  </div>
                ))}
              </dl>
              <div className="flex flex-wrap gap-echo-sm">
                <PowerButton
                  startIcon={<EditIcon />}
                  onClick={() => setDialog({ initial: item, editing: true })}
                >
                  Редагувати
                </PowerButton>
                <PowerButton
                  color="error"
                  startIcon={<DeleteOutlineIcon />}
                  onClick={() => setDeleting(item)}
                >
                  Видалити
                </PowerButton>
              </div>
            </article>
          ))}
        </div>
      )}
      {dialog ? (
        <RoleSettingsDialog
          {...dialog}
          roles={dialog.editing ? [dialog.initial.role] : availableRoles}
          onClose={() => setDialog(null)}
          onSaved={(saved) => {
            setSettings((previous) =>
              [...previous.filter(({ role }) => role !== saved.role), saved].sort((a, b) =>
                a.role.localeCompare(b.role),
              ),
            );
            setDialog(null);
          }}
        />
      ) : null}
      <Dialog open={deleting !== null} onClose={deleteBusy ? undefined : () => setDeleting(null)}>
        <DialogTitle>Видалити налаштування ролі {deleting?.role}?</DialogTitle>
        <DialogContent>Для цієї ролі знову діятимуть типові правила створення.</DialogContent>
        <DialogActions>
          <PowerButton disabled={deleteBusy} onClick={() => setDeleting(null)}>
            Скасувати
          </PowerButton>
          <PowerButton disabled={deleteBusy} color="error" onClick={confirmDelete}>
            Видалити
          </PowerButton>
        </DialogActions>
      </Dialog>
    </div>
  );
}
