import CancelIcon from '@mui/icons-material/Cancel';
import { Dialog, DialogActions, DialogContent, DialogTitle } from '@mui/material';
import dayjs from 'dayjs';
import { useState } from 'react';
import type { CitedMessage } from '../../../../../Bindings';
import { PowerButton } from '../../../components/PowerButton';
import { APP_TIME_ZONE } from '../../../utils/misc';
import type { MessageTimeBasis } from '../../../services/api/user-settings';

export function CitedMessageCard({
  message,
  deleted = false,
  timeBasis,
  label,
}: {
  message?: CitedMessage;
  deleted?: boolean;
  timeBasis: MessageTimeBasis;
  label?: string;
}) {
  const [confirmOpen, setConfirmOpen] = useState(false);
  if (deleted) {
    return (
      <span className="flex items-center gap-echo-xs text-echo-warning" role="status">
        <CancelIcon fontSize="small" /> Видалено
      </span>
    );
  }
  if (!message) return <span className="text-echo-text-muted">Повідомлення недоступне</span>;
  const timestamp = timeBasis === 'creation' ? message.createdAt : message.timestamp;
  const openConfirmation = () => setConfirmOpen(true);
  return (
    <div className="min-w-0">
      {label ? (
        <button type="button" className="text-(--color-action)" onClick={openConfirmation}>
          {label}
        </button>
      ) : null}
      <blockquote className="m-0 border-l border-echo-border pl-echo-sm">
        <button
          type="button"
          className="text-echo-sm text-(--color-action)"
          onClick={openConfirmation}
        >
          {timestamp == null
            ? 'Час невідомий'
            : dayjs(timestamp).tz(APP_TIME_ZONE).format('DD.MM · HH:mm')}
        </button>
        <div className="line-clamp-2 whitespace-pre-wrap break-words text-echo-text">
          {message.preview || 'Без тексту'}
        </div>
      </blockquote>
      {confirmOpen ? (
        <Dialog open onClose={() => setConfirmOpen(false)}>
          <DialogTitle>Відкрити повідомлення?</DialogTitle>
          <DialogContent>Повідомлення відкриється в новій вкладці.</DialogContent>
          <DialogActions>
            <PowerButton onClick={() => setConfirmOpen(false)}>Скасувати</PowerButton>
            <PowerButton
              onClick={() => {
                window.open(message.href, '_blank', 'noopener,noreferrer');
                setConfirmOpen(false);
              }}
            >
              Відкрити
            </PowerButton>
          </DialogActions>
        </Dialog>
      ) : null}
    </div>
  );
}
