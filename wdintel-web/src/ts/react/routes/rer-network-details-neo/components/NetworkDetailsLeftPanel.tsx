import { Box, Button, Chip, Divider, Paper, Skeleton, Stack, Typography } from '@mui/material';
import type { ReactNode } from 'react';

import type { Network } from '../../../../../Bindings';

function FieldRow({ label, value }: { label: string; value: ReactNode }) {
  return (
    <Box
      sx={{
        display: 'grid',
        gridTemplateColumns: { xs: '1fr', sm: '180px minmax(0,1fr)' },
        gap: 1,
        alignItems: 'start',
      }}
    >
      <Typography variant="body2" sx={{ color: 'text.secondary', fontWeight: 600 }}>
        {label}
      </Typography>
      <Box sx={{ minWidth: 0 }}>{value}</Box>
    </Box>
  );
}

function SectionTitle({ children }: { children: ReactNode }) {
  return (
    <Typography
      variant="overline"
      sx={{
        display: 'block',
        fontSize: '0.95rem',
        lineHeight: 1.2,
        fontWeight: 700,
        letterSpacing: '0.04em',
        color: 'text.secondary',
      }}
    >
      {children}
    </Typography>
  );
}

function ChipList({
  labels,
  collapsedCountLabel,
  onToggleCollapsed,
  collapsed,
}: {
  labels: string[];
  collapsedCountLabel?: string;
  onToggleCollapsed?: () => void;
  collapsed?: boolean;
}) {
  return (
    <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: 'wrap', alignItems: 'center' }}>
      {labels.map((label) => (
        <Chip key={label} size="small" label={label} />
      ))}
      {collapsedCountLabel && onToggleCollapsed ? (
        <Button size="small" onClick={onToggleCollapsed} variant="text" sx={{ minWidth: 0, px: 0.5 }}>
          {collapsed ? collapsedCountLabel : 'Згорнути'}
        </Button>
      ) : null}
    </Stack>
  );
}

function formatNetworkName(networkName: string | null | undefined): string {
  const value = networkName?.trim() ?? '';
  return value === '' ? '—' : value;
}

function formatUnitLabel(unitCount: number): string {
  return unitCount === 1 ? 'Підрозділ' : 'Підрозділи';
}

function formatDateOnly(value: number | null | undefined): string {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  const year = String(date.getUTCFullYear()).slice(-2);
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  return `${day}.${month}.${year}`;
}

function LeftPanelSkeleton() {
  return (
    <Box
      sx={{
        flex: 1,
        minHeight: 0,
        display: 'flex',
        flexDirection: 'column',
        gap: 2,
      }}
    >
      <Skeleton variant="text" width="28%" height={28} />
      <Skeleton variant="rounded" height={28} />
      <Skeleton variant="rounded" height={88} />
      <Skeleton variant="rounded" height={28} />
      <Skeleton variant="rounded" height={28} />
      <Skeleton variant="text" width="24%" height={28} />
      <Skeleton variant="rounded" height={28} />
      <Skeleton variant="rounded" height={28} />
      <Skeleton variant="rounded" height={88} />
      <Skeleton variant="text" width="24%" height={28} />
      <Skeleton variant="rounded" height={28} />
      <Skeleton variant="rounded" height={28} />
      <Skeleton variant="rounded" height={28} />
    </Box>
  );
}

type Props = {
  isLoading: boolean;
  unitNames: string[];
  network: Network | null;
  aorVisible: Array<{ id: number; label: string }>;
  aorCollapsedCount: number;
  showAllAors: boolean;
  onToggleShowAllAors: () => void;
  callsignCount: number | null;
  statusTone: 'success' | 'warning';
  statusLabel: string;
  rangeLabel: string;
  transferTypeLabel: string;
  postItems: Array<{ id: number; label: string }>;
};

export function NetworkDetailsLeftPanel({
  isLoading,
  unitNames,
  network,
  aorVisible,
  aorCollapsedCount,
  showAllAors,
  onToggleShowAllAors,
  callsignCount,
  statusTone,
  statusLabel,
  rangeLabel,
  transferTypeLabel,
  postItems,
}: Props) {
  return (
    <Paper
      variant="outlined"
      sx={{
        height: '100%',
        minHeight: 0,
        display: 'flex',
        flexDirection: 'column',
        boxSizing: 'border-box',
        overflow: 'auto',
      }}
    >
      <Box
        sx={{
          minHeight: 0,
          p: 2,
          display: 'flex',
          flexDirection: 'column',
          gap: 2.5,
          boxSizing: 'border-box',
        }}
      >
        {isLoading ? (
          <LeftPanelSkeleton />
        ) : (
          <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2.5 }}>
            <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
              <SectionTitle>Основне</SectionTitle>
              <FieldRow
                label={formatUnitLabel(unitNames.length)}
                value={
                  unitNames.length > 0 ? (
                    <Typography
                      variant="body2"
                      sx={{
                        whiteSpace: 'normal',
                        overflowWrap: 'anywhere',
                        wordBreak: 'break-word',
                      }}
                    >
                      {unitNames.join(', ')}
                    </Typography>
                  ) : (
                    <Typography variant="body2" color="text.secondary">
                      —
                    </Typography>
                  )
                }
              />
              <FieldRow label="Район функціонування" value={<Typography variant="body2">{formatNetworkName(network?.location)}</Typography>} />
              <FieldRow
                label="Смуги"
                value={
                  aorVisible.length > 0 ? (
                    <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: 'wrap', alignItems: 'center' }}>
                      {aorVisible.map((item) => (
                        <Chip key={item.id} size="small" label={item.label} />
                      ))}
                      {aorCollapsedCount > 0 ? (
                        <Button size="small" onClick={onToggleShowAllAors} sx={{ minWidth: 0, px: 0.5 }}>
                          {showAllAors ? 'Згорнути' : `+${aorCollapsedCount}`}
                        </Button>
                      ) : null}
                    </Stack>
                  ) : (
                    <Typography variant="body2" color="text.secondary">
                      —
                    </Typography>
                  )
                }
              />
              <FieldRow label="Склад кореспондентів" value={<Typography variant="body2">{callsignCount ?? '—'}</Typography>} />
              <FieldRow
                label="Активність"
                value={
                  statusTone === 'success' && network?.activeFrom ? (
                    <Typography variant="body2" sx={{ color: 'success.main', fontWeight: 700 }}>
                      {formatDateOnly(network.activeFrom)} — досі
                    </Typography>
                  ) : (
                    <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: 'wrap', alignItems: 'center' }}>
                      <Chip size="small" color={statusTone === 'success' ? 'success' : 'warning'} label={statusLabel} />
                    </Stack>
                  )
                }
              />
            </Box>

            <Divider />

            <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
              <SectionTitle>Операційні</SectionTitle>
              <FieldRow label="Призначення" value={<Typography variant="body2">{formatNetworkName(network?.purpose)}</Typography>} />
              <FieldRow label="Діапазон" value={<Typography variant="body2">{rangeLabel}</Typography>} />
              <FieldRow label="Тип передачі" value={<Typography variant="body2">{transferTypeLabel}</Typography>} />
              <FieldRow label="Режим" value={<Typography variant="body2">{formatNetworkName(network?.operationMode)}</Typography>} />
              <FieldRow label="Характер" value={<Typography variant="body2">{formatNetworkName(network?.operationType)}</Typography>} />
              <FieldRow
                label="Період функціонування"
                value={<Typography variant="body2">{formatNetworkName(network?.operationPeriod)}</Typography>}
              />
              <FieldRow
                label="Пости"
                value={
                  postItems.length > 0 ? (
                    <ChipList labels={postItems.map((item) => item.label)} />
                  ) : (
                    <Typography variant="body2" color="text.secondary">
                      —
                    </Typography>
                  )
                }
              />
              <FieldRow
                label="Радіостанція"
                value={
                  network?.radioStation?.trim() ? (
                    <Typography variant="body2">{formatNetworkName(network.radioStation)}</Typography>
                  ) : (
                    <Typography variant="body2" color="text.secondary">
                      —
                    </Typography>
                  )
                }
              />
            </Box>

            <Divider />

            <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2, pb: 2 }}>
              <SectionTitle>Додатково</SectionTitle>
              <FieldRow label="Створено" value={<Typography variant="body2">{formatDateOnly(network?.createdAt)}</Typography>} />
              <FieldRow label="Оновлено" value={<Typography variant="body2">{formatDateOnly(network?.lastUpdatedAt)}</Typography>} />
              <FieldRow label="Оператор" value={<Typography variant="body2">{formatNetworkName(network?.lastUpdatedBy)}</Typography>} />
            </Box>
          </Box>
        )}
      </Box>
    </Paper>
  );
}
