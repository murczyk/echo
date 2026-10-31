import AddIcon from '@mui/icons-material/Add';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';
import EditIcon from '@mui/icons-material/Edit';
import {
  Autocomplete,
  Box,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  IconButton,
  Stack,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material';
import { useEffect, useState } from 'react';
import type { ApiSender, Login, UpsertApiSenderReq } from '../../../../Bindings';
import { ConfirmDangerDialog } from '../../components/ConfirmDangerDialog';
import { PowerAlert } from '../../components/PowerAlert';
import { PowerButton } from '../../components/PowerButton';
import { usePowerSnackbar } from '../../components/PowerSnackbar';
import { deleteApiSender, listApiSenders, saveApiSender } from '../../services/api/api-senders';
import { listLogins } from '../../services/api/logins';

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : 'Невідома помилка';
}

function SenderDialog({
  apiId,
  sender,
  logins,
  onClose,
  onSaved,
}: {
  apiId: string;
  sender: ApiSender | null;
  logins: Login[];
  onClose: () => void;
  onSaved: (sender: ApiSender) => void;
}) {
  const [draft, setDraft] = useState<UpsertApiSenderReq>({
    apiId,
    senderUuid: sender?.senderUuid ?? null,
    loginId: sender?.loginId ?? '',
    displayName: sender?.displayName ?? '',
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { notify } = usePowerSnackbar();

  async function save() {
    if (saving || !draft.loginId || !draft.displayName.trim()) return;
    setSaving(true);
    setError(null);
    try {
      onSaved(await saveApiSender(draft));
      notify({ severity: 'success', message: 'Відправника збережено.' });
      onClose();
    } catch (error) {
      const message = `Не вдалося зберегти відправника: ${errorText(error)}`;
      setError(message);
      notify({ severity: 'error', message });
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog
      open
      onClose={saving ? undefined : onClose}
      fullWidth
      maxWidth="sm"
      slotProps={{
        paper: {
          component: 'form',
          onSubmit: (event) => {
            event.preventDefault();
            event.stopPropagation();
            void save();
          },
        },
      }}
    >
      <DialogTitle>{sender ? 'Редагувати відправника' : 'Додати відправника'}</DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ pt: 1 }}>
          {error ? <PowerAlert severity="error">{error}</PowerAlert> : null}
          <Autocomplete
            options={logins.filter((login) => !login.deleted || login.id === draft.loginId)}
            value={logins.find((login) => login.id === draft.loginId) ?? null}
            getOptionLabel={(login) => login.login}
            isOptionEqualToValue={(option, value) => option.id === value.id}
            onChange={(_, login) => {
              const previousLogin = logins.find((login) => login.id === draft.loginId);
              setDraft({
                ...draft,
                loginId: login?.id ?? '',
                displayName:
                  !draft.displayName.trim() || draft.displayName === previousLogin?.login
                    ? (login?.login ?? '')
                    : draft.displayName,
              });
            }}
            disabled={saving}
            renderInput={(params) => (
              <TextField {...params} label="Обліковий запис Echo" required />
            )}
          />
          <TextField
            label="Ім’я відправника"
            required
            value={draft.displayName}
            onChange={(event) => setDraft({ ...draft, displayName: event.target.value })}
            disabled={saving}
          />
          {sender ? (
            <Typography variant="body2" sx={{ overflowWrap: 'anywhere' }}>
              UUID: {sender.senderUuid}
            </Typography>
          ) : null}
        </Stack>
      </DialogContent>
      <DialogActions>
        <PowerButton type="button" onClick={onClose} disabled={saving}>
          Скасувати
        </PowerButton>
        <PowerButton
          type="submit"
          variant="contained"
          disabled={saving || !draft.loginId || !draft.displayName.trim()}
        >
          Зберегти
        </PowerButton>
      </DialogActions>
    </Dialog>
  );
}

export function ApiSenders({ apiId, disabled }: { apiId: string; disabled: boolean }) {
  const [senders, setSenders] = useState<ApiSender[]>([]);
  const [logins, setLogins] = useState<Login[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const [editing, setEditing] = useState<{ sender: ApiSender | null } | null>(null);
  const [deleting, setDeleting] = useState<ApiSender | null>(null);
  const [busy, setBusy] = useState(false);
  const { notify } = usePowerSnackbar();

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    setEditing(null);
    setDeleting(null);
    void Promise.all([
      listApiSenders(apiId, controller.signal),
      listLogins({ sortBy: null, filterByRoles: null }),
    ])
      .then(([senders, response]) => {
        if (controller.signal.aborted) return;
        setSenders(senders);
        setLogins(response.users);
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        const message = `Не вдалося завантажити відправників: ${errorText(error)}`;
        setError(message);
        notify({ severity: 'error', message });
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [apiId, reload, notify]);

  async function remove() {
    if (!deleting || busy) return;
    setBusy(true);
    try {
      await deleteApiSender({ apiId, senderUuid: deleting.senderUuid });
      setSenders((senders) =>
        senders.filter((sender) => sender.senderUuid !== deleting.senderUuid),
      );
      setDeleting(null);
      notify({ severity: 'success', message: 'Відправника видалено.' });
    } catch (error) {
      notify({
        severity: 'error',
        message: `Не вдалося видалити відправника: ${errorText(error)}`,
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Stack spacing={1.5} sx={{ gridColumn: '1 / -1' }}>
      <Typography variant="subtitle1">Відправники API</Typography>
      {loading ? (
        <CircularProgress size={20} />
      ) : error ? (
        <PowerAlert
          severity="error"
          action={
            <PowerButton type="button" onClick={() => setReload((value) => value + 1)}>
              Повторити
            </PowerButton>
          }
        >
          {error}
        </PowerAlert>
      ) : (
        <>
          {senders.length === 0 ? (
            <Typography color="text.secondary">Відправників ще немає.</Typography>
          ) : null}
          {senders.map((sender) => (
            <Stack key={sender.senderUuid} direction="row" alignItems="center" spacing={1}>
              <Box sx={{ minWidth: 0, flex: 1, overflowWrap: 'anywhere' }}>
                <Typography>{sender.displayName}</Typography>
                <Typography variant="body2" color="text.secondary">
                  {logins.find((login) => login.id === sender.loginId)?.login ?? sender.loginId}
                </Typography>
                <Typography variant="caption" sx={{ overflowWrap: 'anywhere', userSelect: 'all' }}>
                  {sender.senderUuid}
                </Typography>
              </Box>
              <Tooltip title="Редагувати відправника">
                <span>
                  <IconButton
                    aria-label="Редагувати відправника"
                    disabled={disabled || busy}
                    onClick={() => setEditing({ sender })}
                  >
                    <EditIcon />
                  </IconButton>
                </span>
              </Tooltip>
              <Tooltip title="Видалити відправника">
                <span>
                  <IconButton
                    aria-label="Видалити відправника"
                    disabled={disabled || busy}
                    onClick={() => setDeleting(sender)}
                  >
                    <DeleteOutlineIcon />
                  </IconButton>
                </span>
              </Tooltip>
            </Stack>
          ))}
          <PowerButton
            type="button"
            variant="outlined"
            startIcon={<AddIcon />}
            disabled={disabled || busy}
            onClick={() => setEditing({ sender: null })}
            sx={{ alignSelf: 'flex-start' }}
          >
            Додати відправника
          </PowerButton>
        </>
      )}
      {editing ? (
        <SenderDialog
          apiId={apiId}
          sender={editing.sender}
          logins={logins}
          onClose={() => setEditing(null)}
          onSaved={(saved) =>
            setSenders((senders) =>
              [...senders.filter((sender) => sender.senderUuid !== saved.senderUuid), saved].sort(
                (a, b) => a.displayName.localeCompare(b.displayName),
              ),
            )
          }
        />
      ) : null}
      <ConfirmDangerDialog
        open={deleting !== null}
        onClose={() => setDeleting(null)}
        onConfirm={() => void remove()}
        submitting={busy}
        description={`Видалити відправника «${deleting?.displayName ?? ''}»? Нові повідомлення з цим UUID більше не належатимуть пов’язаному обліковому запису.`}
      />
    </Stack>
  );
}
