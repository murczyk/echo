import CancelIcon from '@mui/icons-material/Cancel';
import dayjs from 'dayjs';
import type { MouseEvent } from 'react';
import type { CitedMessage } from '../../../../../Bindings';
import { APP_TIME_ZONE } from '../../../utils/misc';
import type { MessageTimeBasis } from '../../../services/api/user-settings';
import type { ReplyNavigation } from './MessageRepliesProvider';

export function CitedMessageCard({
  message,
  deleted = false,
  timeBasis,
  label,
  onNavigate,
}: {
  message?: CitedMessage;
  deleted?: boolean;
  timeBasis: MessageTimeBasis;
  label?: string;
  onNavigate?: ReplyNavigation;
}) {
  if (deleted) {
    return (
      <span className="flex items-center gap-echo-xs text-echo-warning" role="status">
        <CancelIcon fontSize="small" /> Видалено
      </span>
    );
  }
  if (!message) return <span className="text-echo-text-muted">Повідомлення недоступне</span>;
  const timestamp = timeBasis === 'creation' ? message.createdAt : message.timestamp;
  const content = (
    <>
      {label ? <span className="block text-echo-sm text-echo-text-muted">{label}</span> : null}
      <span className="block text-echo-sm text-(--color-action)">
        {timestamp == null
          ? 'Час невідомий'
          : dayjs(timestamp).tz(APP_TIME_ZONE).format('DD.MM.YYYY · HH:mm')}
      </span>
      <span className="block truncate text-echo-text">{message.preview || 'Без тексту'}</span>
    </>
  );
  const className = 'block min-w-0 rounded-echo-xl bg-echo-text/5 p-echo-sm text-left';
  if (!onNavigate) return <div className={className}>{content}</div>;
  return (
    <a
      href={message.href}
      className={`${className} no-underline hover:bg-echo-text/10 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-echo-focus`}
      onClick={(event: MouseEvent<HTMLAnchorElement>) => {
        event.preventDefault();
        onNavigate(message, event.currentTarget);
      }}
    >
      {content}
    </a>
  );
}
