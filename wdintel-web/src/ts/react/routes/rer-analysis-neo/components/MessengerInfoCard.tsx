import { Link, Typography } from '@mui/material';
import type { ReactNode } from 'react';

import { NO_DATA_LABEL, formatDateTime24 } from '../../../utils/misc';
import { MessengerCard } from './MessengerCard';
import { isHttpUrl, type MessengerAccountItem } from './MessengerAccountList';

type Props = {
  account: MessengerAccountItem;
};

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    // On a phone the label column is narrower, so the values keep more of the width. `!` on the gap: Bootstrap's `.gap-2`
    // is `!important` and beats a plain variant.
    <div className="grid grid-cols-[10rem_minmax(0,1fr)] gap-2 group-data-[mobile=true]/messenger:grid-cols-[7rem_minmax(0,1fr)] group-data-[mobile=true]/messenger:!gap-1">
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
      <Row label="Посилання">
        {account.externalUrl && isHttpUrl(account.externalUrl) ? (
          <Link href={account.externalUrl} target="_blank" rel="noopener noreferrer">
            Відкрити джерело
          </Link>
        ) : (
          NO_DATA_LABEL
        )}
      </Row>
      <Row label="Створено">{formatDateTime24(account.createdAt)}</Row>
      <Row label="Оновлено">{formatDateTime24(account.lastSync)}</Row>
    </MessengerCard>
  );
}
