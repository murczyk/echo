import FlagOutlinedIcon from '@mui/icons-material/FlagOutlined';
import { useEffect, useRef, useState } from 'react';
import {
  Alert,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  Switch,
  Typography,
} from '@mui/material';
import { useOptionalPowerSnackbar } from '../PowerSnackbar';
import { importantAdd } from '../../services/api/inbox-message-actions';
import { currentSystemSettings } from '../../services/api/system-settings';

export const IMPORTANT_MESSAGE_REQUEST_EVENT = 'echo-important-message-request';
export const IMPORTANT_MESSAGE_UPDATED_EVENT = 'echo-important-message-updated';

type ImportantMessageRequest = { messageId: number; groupMasterKey?: string | null };

export function requestImportantMessage(request: ImportantMessageRequest) {
  window.dispatchEvent(
    new CustomEvent<ImportantMessageRequest>(IMPORTANT_MESSAGE_REQUEST_EVENT, { detail: request }),
  );
}

function dispatchImportantUpdated(messageId: number, important: boolean) {
  window.dispatchEvent(
    new CustomEvent(IMPORTANT_MESSAGE_UPDATED_EVENT, { detail: { messageId, important } }),
  );
}

async function markImportantWithoutNotification(messageId: number) {
  const important = await importantAdd({
    messageId,
    groupMasterKey: null,
    notifyGroup: false,
    operationId: crypto.randomUUID(),
  });
  dispatchImportantUpdated(messageId, important);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Не вдалося позначити повідомлення.';
}

export function ImportantMessageDialog() {
  const { notify } = useOptionalPowerSnackbar();
  const [request, setRequest] = useState<ImportantMessageRequest | null>(null);
  const [open, setOpen] = useState(false);
  const [notifyGroup, setNotifyGroup] = useState(false);
  const [operationId, setOperationId] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestVersion = useRef(0);
  const closingRequestVersion = useRef<number | null>(null);

  useEffect(() => {
    const openDialog = (detail: ImportantMessageRequest) => {
      closingRequestVersion.current = null;
      setRequest(detail);
      setOpen(true);
      setNotifyGroup(false);
      setOperationId(crypto.randomUUID());
      setError(null);
    };
    const handleRequest = async (event: Event) => {
      const detail = (event as CustomEvent<ImportantMessageRequest>).detail;
      requestVersion.current += 1;
      const version = requestVersion.current;
      try {
        const { importantNotifyAllEnabled } = await currentSystemSettings();
        if (version !== requestVersion.current) return;
        if (importantNotifyAllEnabled) {
          openDialog(detail);
          return;
        }
        await markImportantWithoutNotification(detail.messageId);
      } catch (requestError) {
        notify({ severity: 'error', message: errorMessage(requestError) });
      }
    };
    const listener = (event: Event) => void handleRequest(event);
    window.addEventListener(IMPORTANT_MESSAGE_REQUEST_EVENT, listener);
    return () => window.removeEventListener(IMPORTANT_MESSAGE_REQUEST_EVENT, listener);
  }, [notify]);

  const close = (force = false) => {
    if (pending && !force) return;
    closingRequestVersion.current = requestVersion.current;
    setOpen(false);
  };
  const clearAfterExit = () => {
    if (closingRequestVersion.current !== requestVersion.current) return;
    closingRequestVersion.current = null;
    setRequest(null);
    setError(null);
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
      dispatchImportantUpdated(request.messageId, important);
      close(true);
    } catch (submitError) {
      const message = errorMessage(submitError);
      setError(message);
      notify({ severity: 'error', message });
    } finally {
      setPending(false);
    }
  };
  const canNotify = Boolean(request?.groupMasterKey);

  return (
    <Dialog
      open={open}
      onClose={() => close()}
      aria-labelledby="important-message-title"
      slotProps={{
        transition: { onExited: clearAfterExit },
        paper: { sx: { width: 'min(600px, calc(100vw - 32px))', maxWidth: 'calc(100vw - 32px)' } },
      }}
    >
      <DialogContent className="!border-b !border-[var(--color-border)] !px-[24px] !py-[16px]">
        <div className="flex items-center gap-4 py-4">
          <span className="flex size-[50px] shrink-0 items-center justify-center rounded-lg !border !border-[var(--echo-color-error)] bg-[color-mix(in_srgb,var(--echo-color-error)_15%,transparent)] text-[var(--echo-color-error)]">
            <FlagOutlinedIcon sx={{ fontSize: 24 }} />
          </span>
          <div className="min-w-0 flex-1">
            <Typography
              component="span"
              color="text.secondary"
              className="block text-xs font-normal tracking-[1px]"
            >
              ВАЖЛИВЕ ПОВІДОМЛЕННЯ
            </Typography>
            <h2
              id="important-message-title"
              className="m-0 mt-1 text-[var(--color-text)]"
              style={{ fontSize: '16px', fontWeight: 400, lineHeight: '28px' }}
            >
              Сповістити всіх?
            </h2>
          </div>
          <Switch
            checked={notifyGroup}
            disabled={!canNotify || pending}
            onChange={(_, value) => setNotifyGroup(value)}
            size="small"
            inputProps={{ 'aria-label': 'Сповістити всіх?' }}
          />
        </div>
        {error ? (
          <Alert severity="error" className="mt-4">
            {error}
          </Alert>
        ) : null}
      </DialogContent>
      <DialogActions>
        <Button onClick={() => close()} disabled={pending}>
          Закрити
        </Button>
        <Button variant="contained" onClick={() => void submit()} disabled={pending}>
          {pending ? 'Збереження…' : 'Позначити'}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
