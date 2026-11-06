import { Typography } from '@mui/material';
import type { ReactNode } from 'react';

import { NO_DATA_LABEL, formatDateTime24 } from '../../../utils/misc';
import { MessengerCard } from './MessengerCard';
import type { MessengerAccountItem } from './MessengerAccountList';

type Props = {
  account: MessengerAccountItem;
};

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[10rem_minmax(0,1fr)] gap-2">
      <Typography variant="body2" color="text.secondary">
        {label}
      </Typography>
      <Typography variant="body2" sx={{ overflowWrap: 'anywhere' }}>
        {children}
      </Typography>
    </div>
  );
}

export function MessengerInfoCard({ account }: Props) {
  return (
    <MessengerCard title="Інформація">
      <Row label="Ім'я">{account.name || NO_DATA_LABEL}</Row>
      <Row label="Телефон">{account.phone || NO_DATA_LABEL}</Row>
      <Row label="Ім'я користувача">
        {account.username ? `@${account.username}` : NO_DATA_LABEL}
      </Row>
      <Row label="External ID">{account.externalId || NO_DATA_LABEL}</Row>
      <Row label="User ID">{account.userId || NO_DATA_LABEL}</Row>
      <Row label="Створено">{formatDateTime24(account.createdAt)}</Row>
      <Row label="Оновлено">{formatDateTime24(account.lastSync)}</Row>
    </MessengerCard>
  );
}
