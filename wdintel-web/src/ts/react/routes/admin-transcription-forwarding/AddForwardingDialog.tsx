import {
  Autocomplete,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  TextField,
} from '@mui/material';
import { PowerAlert } from '../../components/PowerAlert';
import { PowerButton } from '../../components/PowerButton';
import { DevicePicker } from './DevicePicker';
import { useAddForwarding } from './use-add-forwarding';

export function AddForwardingDialog({
  onClose,
  onSaved,
}: {
  onClose: () => void;
  onSaved: () => void;
}) {
  const { device, setDevice, settings, group, setGroup, busy, error, reload, save } =
    useAddForwarding(onSaved);
  return (
    <Dialog
      open
      onClose={busy ? undefined : onClose}
      fullWidth
      maxWidth="sm"
      aria-labelledby="add-forwarding-title"
    >
      <DialogTitle id="add-forwarding-title">Додати пересилання</DialogTitle>
      <DialogContent>
        <div className="flex flex-col gap-echo-lg pt-echo-sm">
          {error && (
            <PowerAlert
              severity="error"
              action={
                <PowerButton disabled={busy} onClick={reload}>
                  Оновити групи
                </PowerButton>
              }
            >
              {error}
            </PowerAlert>
          )}
          <DevicePicker
            value={device}
            disabled={busy}
            onChange={(next) => {
              setDevice(next);
              reload();
            }}
          />
          <Autocomplete
            value={group}
            options={settings?.groups.filter((item) => !item.selected) ?? []}
            disabled={!settings || busy}
            loading={Boolean(device && !settings && !error)}
            getOptionLabel={(item) => item.name}
            getOptionKey={(item) => item.masterKey}
            isOptionEqualToValue={(left, right) => left.masterKey === right.masterKey}
            onChange={(_, value) => setGroup(value)}
            noOptionsText="Немає доступних груп для додавання"
            renderInput={(params) => <TextField {...params} label="Група Echo Native" />}
          />
          {device && !settings && !error && <p role="status">Завантаження груп…</p>}
          {settings && !settings.enabled && (
            <PowerAlert severity="info">
              Додавання ввімкне пересилання для всіх налаштованих груп цього пристрою.
            </PowerAlert>
          )}
        </div>
      </DialogContent>
      <DialogActions>
        <PowerButton disabled={busy} onClick={onClose}>
          Скасувати
        </PowerButton>
        <PowerButton
          variant="contained"
          disabled={!group || !settings || busy}
          onClick={() => void save()}
        >
          Додати
        </PowerButton>
      </DialogActions>
    </Dialog>
  );
}
