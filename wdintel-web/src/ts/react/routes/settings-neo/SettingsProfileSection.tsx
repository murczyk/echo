import { SettingsMessengerAlerts } from './SettingsMessengerAlerts';
import { TextField } from '@mui/material';
import { useEffect, useRef, useState } from 'react';
import { PowerAlert } from '../../components/PowerAlert';
import { PowerButton } from '../../components/PowerButton';
import { PowerSnackbarProvider, usePowerSnackbar } from '../../components/PowerSnackbar';
import { fetchCurrentUser } from '../../services/api/user';
import { saveDisplayName } from '../../services/api/author-identities';
import { refreshAuthors } from '../../author-identities';

function ProfileForm() {
  const { notify } = usePowerSnackbar();
  const mounted = useRef(false);
  const savePending = useRef(false);
  const [login, setLogin] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [savedName, setSavedName] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    mounted.current = true;
    void fetchCurrentUser(controller.signal)
      .then((user) => {
        if (controller.signal.aborted) return;
        setLogin(user.name);
        setDisplayName(user.displayName ?? '');
        setSavedName(user.displayName ?? '');
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setLoadFailed(true);
        setError(
          `Помилка завантаження профілю: ${error instanceof Error ? error.message : 'невідома помилка'}`,
        );
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => {
      mounted.current = false;
      controller.abort();
    };
  }, []);

  async function save() {
    if (savePending.current || loading || loadFailed) return;
    savePending.current = true;
    setSaving(true);
    setError(null);
    try {
      const author = await saveDisplayName({ displayName: displayName || null });
      refreshAuthors(author);
      if (!mounted.current) return;
      setDisplayName(author.displayName ?? '');
      setSavedName(author.displayName ?? '');
      notify({ severity: 'success', message: 'Ім’я збережено' });
    } catch (error) {
      if (!mounted.current) return;
      const message = `Помилка збереження імені: ${error instanceof Error ? error.message : 'невідома помилка'}`;
      setError(message);
      notify({ severity: 'error', message });
    } finally {
      savePending.current = false;
      if (mounted.current) setSaving(false);
    }
  }

  return (
    <form
      className="flex flex-col gap-echo-lg p-echo-lg"
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <h2 className="m-0 text-echo-lg font-bold">Профіль</h2>
      {error ? (
        <PowerAlert severity="error" autoHideDuration={null}>
          {error}
        </PowerAlert>
      ) : null}
      <TextField
        label="Логін"
        value={login}
        slotProps={{ input: { readOnly: true } }}
        disabled={loading}
      />
      <TextField
        label="Відображуване ім’я"
        value={displayName}
        onChange={(event) => setDisplayName(event.target.value)}
        disabled={loading || saving || loadFailed}
        helperText="До 100 символів. Ім’я може збігатися з іменами інших користувачів. Залиште порожнім, щоб показувати логін."
      />
      <SettingsMessengerAlerts />
      <div>
        <PowerButton
          type="submit"
          variant="contained"
          disabled={loading || saving || loadFailed || displayName.trim() === savedName}
        >
          {saving ? 'Збереження…' : 'Зберегти'}
        </PowerButton>
      </div>
    </form>
  );
}

export function SettingsProfileSection() {
  return (
    <section
      id="settings-neo-panel-profile"
      role="tabpanel"
      aria-labelledby="settings-neo-tab-profile"
    >
      <PowerSnackbarProvider>
        <ProfileForm />
      </PowerSnackbarProvider>
    </section>
  );
}
