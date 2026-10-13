import { useEffect, useState } from 'react';
import {
  Alert,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControlLabel,
  Switch,
} from '@mui/material';
import { useOptionalPowerSnackbar } from '../PowerSnackbar';
import { importantAdd } from '../../services/api/inbox-message-actions';

export const IMPORTANT_MESSAGE_REQUEST_EVENT = 'echo-important-message-request';
export const IMPORTANT_MESSAGE_UPDATED_EVENT = 'echo-important-message-updated';

type ImportantMessageRequest = { messageId: number; groupMasterKey?: string | null };

export function requestImportantMessage(request: ImportantMessageRequest) {
  window.dispatchEvent(
    new CustomEvent<ImportantMessageRequest>(IMPORTANT_MESSAGE_REQUEST_EVENT, { detail: request }),
  );
}

export function ImportantMessageDialog() {
  const { notify } = useOptionalPowerSnackbar();
  const [request, setRequest] = useState<ImportantMessageRequest | null>(null);
  const [notifyGroup, setNotifyGroup] = useState(false);
  const [operationId, setOperationId] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const open = (event: Event) => {
      setRequest((event as CustomEvent<ImportantMessageRequest>).detail);
      setNotifyGroup(false);
      setOperationId(crypto.randomUUID());
      setError(null);
    };
    window.addEventListener(IMPORTANT_MESSAGE_REQUEST_EVENT, open);
    return () => window.removeEventListener(IMPORTANT_MESSAGE_REQUEST_EVENT, open);
  }, []);

  const close = () => {
    if (!pending) setRequest(null);
  };
  const submit = async () => {
    if (!request) return;
    setPending(true);
    setError(null);
    try {
      const important = await importantAdd({
        messageId: request.messageId,
        groupMasterKey: notifyGroup ? (request.groupMasterKey ?? null) : null,
        notifyGroup,
        operationId,
      });
      window.dispatchEvent(
        new CustomEvent(IMPORTANT_MESSAGE_UPDATED_EVENT, {
          detail: { messageId: request.messageId, important },
        }),
      );
      setRequest(null);
    } catch (submitError) {
      const message =
        submitError instanceof Error ? submitError.message : 'Не вдалося позначити повідомлення.';
      setError(message);
      notify({ severity: 'error', message });
    } finally {
      setPending(false);
    }
  };
  const canNotify = Boolean(request?.groupMasterKey);

  return (
    <Dialog open={request !== null} onClose={close} aria-labelledby="important-message-title">
      <DialogTitle id="important-message-title">
        <span className="block text-sm uppercase tracking-wider text-(--color-text-secondary)">
          Важливе повідомлення
        </span>
        <span className="mt-2 block text-2xl">Хочете сповістити групу?</span>
      </DialogTitle>
      <DialogContent className="min-w-[min(32rem,calc(100vw-2rem))]">
        <p className="m-0 text-(--color-text-secondary)">
          Можна сповістити всіх користувачів, які мають доступ до цієї групи. Вони побачать вашу
          згадку у «Вхідних».
        </p>
        <div className="mt-6 rounded border border-(--color-border) px-4 py-2">
          <FormControlLabel
            className="m-0 w-full"
            control={
              <Switch
                checked={notifyGroup}
                disabled={!canNotify || pending}
                onChange={(_, value) => setNotifyGroup(value)}
              />
            }
            label={
              <span>
                <span className="block font-medium">Сповістити всіх?</span>
                <span className="block text-sm text-(--color-text-secondary)">
                  {canNotify
                    ? 'Усіх користувачів із доступом до групи, крім вас.'
                    : 'Для цього повідомлення немає придатного контексту групи.'}
                </span>
              </span>
            }
          />
        </div>
        {error ? (
          <Alert severity="error" className="mt-4">
            {error}
          </Alert>
        ) : null}
      </DialogContent>
      <DialogActions>
        <Button onClick={close} disabled={pending}>
          Закрити
        </Button>
        <Button variant="contained" onClick={() => void submit()} disabled={pending}>
          {pending ? 'Збереження…' : 'Позначити'}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
