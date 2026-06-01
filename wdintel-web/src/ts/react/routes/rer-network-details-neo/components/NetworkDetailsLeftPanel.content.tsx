import { Box, Button, Chip, Divider, Skeleton, Stack, Typography } from '@mui/material';
import type { ReactNode } from 'react';

import type { Network } from '../../../../../Bindings';
import { NO_DATA_LABEL, formatUtcDateOnly } from '../../../utils/misc';
import { formatAorSummaryText, normalizeLookupName } from '../use-rer-network-details-neo-page.shared';

export type Placement = 'left' | 'top';

export type FieldConfig = {
  key: string;
  label: string;
  value: ReactNode;
};

export type MainInfoSnapshot = {
  unitNames: string[];
  location: string | null | undefined;
  aorLabels: string[];
  aorCollapsedCount: number;
  callsignCount: number | null;
  activityLabel: string | null;
};

export type SummaryItem = {
  key: string;
  label?: string | null;
  value: string;
  tone?: 'default' | 'success';
  minWidth?: number;
};

export function formatUnitLabel(unitCount: number): string {
  return unitCount === 1 ? 'Підрозділ' : 'Підрозділи';
}

export function formatActivityLabel(network: Network | null, statusTone: 'success' | 'warning', statusLabel: string): string | null {
  if (!network) {
    return null;
  }

  if (network?.activeFrom && statusTone === 'success') {
    return `${formatUtcDateOnly(network.activeFrom)} — досі`;
  }

  const trimmed = statusLabel.trim();
  return trimmed === '' || trimmed === NO_DATA_LABEL ? null : trimmed;
}

export function isVisibleCopyValue(value: string | null | undefined): value is string {
  const trimmed = value?.trim() ?? '';
  return trimmed !== '' && trimmed !== NO_DATA_LABEL && trimmed !== '—';
}

export function formatUnitSummaryText(unitNames: string[]): string | null {
  const values = unitNames.map((unitName) => unitName.trim()).filter((unitName) => unitName !== '');
  return values.length > 0 ? values.join(', ') : null;
}

export function buildMainFields({
  unitNames,
  network,
  aorVisible,
  aorCollapsedCount,
  showAllAors,
  onToggleShowAllAors,
  callsignCount,
  statusTone,
  statusLabel,
}: {
  unitNames: string[];
  network: Network | null;
  aorVisible: Array<{ id: number; label: string }>;
  aorCollapsedCount: number;
  showAllAors: boolean;
  onToggleShowAllAors: () => void;
  callsignCount: number | null;
  statusTone: 'success' | 'warning';
  statusLabel: string;
}): FieldConfig[] {
  return [
    {
      key: 'units',
      label: formatUnitLabel(unitNames.length),
      value:
        unitNames.length > 0 ? (
          <Typography variant="body2" sx={{ whiteSpace: 'normal', overflowWrap: 'anywhere', wordBreak: 'break-word' }}>
            {unitNames.join(', ')}
          </Typography>
        ) : (
          <Typography variant="body2" color="text.secondary">
            {NO_DATA_LABEL}
          </Typography>
        ),
    },
    {
      key: 'location',
      label: 'Район функціонування',
      value: <Typography variant="body2">{normalizeLookupName(network?.location)}</Typography>,
    },
    {
      key: 'aor',
      label: 'Смуги',
      value:
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
            {NO_DATA_LABEL}
          </Typography>
        ),
    },
    {
      key: 'callsigns',
      label: 'Склад кореспондентів',
      value: <Typography variant="body2">{callsignCount ?? NO_DATA_LABEL}</Typography>,
    },
    {
      key: 'activity',
      label: 'Активність',
      value:
        statusTone === 'success' && network?.activeFrom ? (
          <Typography variant="body2" sx={{ color: 'success.main', fontWeight: 700 }}>
            {formatUtcDateOnly(network.activeFrom)} — досі
          </Typography>
        ) : (
          <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: 'wrap', alignItems: 'center' }}>
            <Chip size="small" color={statusTone === 'success' ? 'success' : 'warning'} label={statusLabel} />
          </Stack>
        ),
    },
  ];
}

export function buildOperationalFields({
  network,
  rangeLabel,
  transferTypeLabel,
  postItems,
}: {
  network: Network | null;
  rangeLabel: string;
  transferTypeLabel: string;
  postItems: Array<{ id: number; label: string }>;
}): FieldConfig[] {
  return [
    { key: 'purpose', label: 'Призначення', value: <Typography variant="body2">{normalizeLookupName(network?.purpose)}</Typography> },
    { key: 'range', label: 'Діапазон', value: <Typography variant="body2">{rangeLabel}</Typography> },
    { key: 'transfer', label: 'Тип передачі', value: <Typography variant="body2">{transferTypeLabel}</Typography> },
    { key: 'mode', label: 'Режим', value: <Typography variant="body2">{normalizeLookupName(network?.operationMode)}</Typography> },
    { key: 'type', label: 'Характер', value: <Typography variant="body2">{normalizeLookupName(network?.operationType)}</Typography> },
    { key: 'period', label: 'Період функціонування', value: <Typography variant="body2">{normalizeLookupName(network?.operationPeriod)}</Typography> },
    {
      key: 'posts',
      label: 'Пости',
      value:
        postItems.length > 0 ? (
          <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: 'wrap', alignItems: 'center' }}>
            {postItems.map((item) => (
              <Chip key={item.id} size="small" label={item.label} />
            ))}
          </Stack>
        ) : (
          <Typography variant="body2" color="text.secondary">
            {NO_DATA_LABEL}
          </Typography>
        ),
    },
    {
      key: 'radio',
      label: 'Радіостанція',
      value:
        network?.radioStation?.trim() ? (
          <Typography variant="body2">{normalizeLookupName(network.radioStation)}</Typography>
        ) : (
          <Typography variant="body2" color="text.secondary">
            {NO_DATA_LABEL}
          </Typography>
        ),
    },
  ];
}

export function buildAdditionalFields({ network }: { network: Network | null }): FieldConfig[] {
  return [
    { key: 'created', label: 'Створено', value: <Typography variant="body2">{formatUtcDateOnly(network?.createdAt)}</Typography> },
    { key: 'updated', label: 'Оновлено', value: <Typography variant="body2">{formatUtcDateOnly(network?.lastUpdatedAt)}</Typography> },
    { key: 'operator', label: 'Оператор', value: <Typography variant="body2">{normalizeLookupName(network?.lastUpdatedBy)}</Typography> },
  ];
}

function buildMainSummaryValues(snapshot: MainInfoSnapshot): string[] {
  return [
    formatUnitSummaryText(snapshot.unitNames),
    normalizeLookupName(snapshot.location),
    formatAorSummaryText(snapshot.aorLabels, snapshot.aorCollapsedCount),
    snapshot.callsignCount === null ? NO_DATA_LABEL : String(snapshot.callsignCount),
    snapshot.activityLabel ?? NO_DATA_LABEL,
  ].filter(isVisibleCopyValue);
}

function buildOperationalSummaryValues(network: Network | null, rangeLabel: string, transferTypeLabel: string, postItems: Array<{ id: number; label: string }>): string[] {
  return [
    normalizeLookupName(network?.purpose),
    rangeLabel,
    transferTypeLabel,
    normalizeLookupName(network?.operationMode),
    normalizeLookupName(network?.operationType),
    normalizeLookupName(network?.operationPeriod),
    postItems.length > 0 ? postItems.map((item) => item.label).join(', ') : NO_DATA_LABEL,
    normalizeLookupName(network?.radioStation),
  ].filter(isVisibleCopyValue);
}

function buildAdditionalSummaryValues(network: Network | null): string[] {
  return [
    formatUtcDateOnly(network?.createdAt),
    formatUtcDateOnly(network?.lastUpdatedAt),
    normalizeLookupName(network?.lastUpdatedBy),
  ].filter(isVisibleCopyValue);
}

export function buildTopSummarySections({
  snapshot,
  network,
  rangeLabel,
  transferTypeLabel,
  postItems,
}: {
  snapshot: MainInfoSnapshot;
  network: Network | null;
  rangeLabel: string;
  transferTypeLabel: string;
  postItems: Array<{ id: number; label: string }>;
}): string[][] {
  return [
    buildMainSummaryValues(snapshot),
    buildOperationalSummaryValues(network, rangeLabel, transferTypeLabel, postItems),
    buildAdditionalSummaryValues(network),
  ].filter((section) => section.length > 0);
}

export function buildCollapsedTopSummaryItems({
  snapshot,
  network,
  statusTone,
}: {
  snapshot: MainInfoSnapshot;
  network: Network | null;
  statusTone: 'success' | 'warning';
}): SummaryItem[] {
  const activityValue = snapshot.activityLabel ?? NO_DATA_LABEL;
  const activityTone: SummaryItem['tone'] = statusTone === 'success' ? 'success' : 'default';
  return [
    { key: 'location', label: 'Район функціонування', value: normalizeLookupName(snapshot.location), minWidth: 0 },
    { key: 'aor', label: 'Смуги', value: formatAorSummaryText(snapshot.aorLabels, snapshot.aorCollapsedCount), minWidth: 0 },
    {
      key: 'callsigns',
      label: 'Склад кореспондентів',
      value: snapshot.callsignCount === null ? NO_DATA_LABEL : String(snapshot.callsignCount),
      minWidth: 0,
    },
    { key: 'activity', label: 'Активність', value: activityValue, tone: activityTone, minWidth: 0 },
    { key: 'created', label: 'Створено', value: formatUtcDateOnly(network?.createdAt), minWidth: 0 },
    { key: 'operator', label: 'Оператор', value: normalizeLookupName(network?.lastUpdatedBy), minWidth: 0 },
  ].filter((item) => isVisibleCopyValue(item.value) || item.key === 'callsigns');
}

function FieldRow({
  label,
  value,
  compact = false,
  labelWidth = null,
}: {
  label: string;
  value: ReactNode;
  compact?: boolean;
  labelWidth?: string | null;
}) {
  const gridTemplateColumns = compact
    ? `${labelWidth ?? 'minmax(140px, max-content)'} minmax(0,1fr)`
    : { xs: '1fr', sm: '180px minmax(0,1fr)' };

  return (
    <Box
      sx={{
        display: 'grid',
        gridTemplateColumns,
        gap: compact ? 0.75 : 1,
        alignItems: 'start',
        minWidth: 0,
      }}
    >
      <Typography variant="body2" sx={{ color: 'text.primary', fontWeight: 600 }}>
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
        color: 'text.primary',
      }}
    >
      {children}
    </Typography>
  );
}

function FieldList({
  layout,
  compact,
  columns = 1,
  labelWidth = null,
  fields,
}: {
  layout: Placement;
  compact: boolean;
  columns?: number;
  labelWidth?: string | null;
  fields: FieldConfig[];
}) {
  if (layout === 'top') {
    return (
      <Box
        sx={{
          display: 'grid',
          gridTemplateColumns: { xs: '1fr', md: `repeat(${columns}, minmax(0, 1fr))` },
          gap: 1,
          minWidth: 0,
        }}
      >
        {fields.map((field) => (
          <FieldRow key={field.key} compact={compact} label={field.label} labelWidth={labelWidth} value={field.value} />
        ))}
      </Box>
    );
  }

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      {fields.map((field) => (
        <FieldRow key={field.key} compact={compact} label={field.label} labelWidth={labelWidth} value={field.value} />
      ))}
    </Box>
  );
}

const COLLAPSED_SUMMARY_LABELS: Record<string, string | null> = {
  unit: 'Підрозділ',
  location: 'Район функціонування',
  aor: 'Смуги',
  callsigns: null,
  activity: 'Активність',
  purpose: 'Призначення',
  range: 'Діапазон',
  transfer: 'Тип передачі',
  mode: 'Режим',
  period: 'Період функціонування',
  posts: 'Пости',
  radio: 'Радіостанція',
  created: 'Створено',
  updated: 'Оновлено',
  operator: 'Оператор',
};

export function TopSummaryRow({ items }: { items: SummaryItem[] }) {
  if (items.length === 0) {
    return null;
  }

  return (
    <Box
      sx={{
        minWidth: 0,
        overflow: 'hidden',
        display: 'flex',
        alignItems: 'center',
        gap: 1.5,
        whiteSpace: 'nowrap',
      }}
    >
      {items.map((item) => {
        const label = item.label ?? COLLAPSED_SUMMARY_LABELS[item.key];
        const showLabel = label !== null;
        const isHighPriority = item.key === 'unit' || item.key === 'location' || item.key === 'aor' || item.key === 'callsigns' || item.key === 'activity';
        const tokenSx = {
          display: 'inline-flex',
          alignItems: 'baseline',
          gap: 0.75,
          minWidth: item.minWidth ?? 0,
          flex: isHighPriority ? '0 0 auto' : '0 1 auto',
          overflow: 'hidden',
        } as const;

        return (
          <Box
            key={item.key}
            component="span"
            data-summary-key={item.key}
            data-summary-tone={item.tone ?? 'default'}
            sx={tokenSx}
            title={showLabel ? `${label}: ${item.value}` : item.value}
          >
            {showLabel ? (
              <Typography
                component="span"
                sx={{
                  fontSize: '0.8125rem',
                  lineHeight: 1.25,
                  fontWeight: 600,
                  color: 'text.secondary',
                  whiteSpace: 'nowrap',
                  flexShrink: 0,
                }}
              >
                {label}
              </Typography>
            ) : null}
            {item.key === 'aor' ? (
              <Box
                component="span"
                sx={{
                  display: 'inline-flex',
                  flexWrap: 'wrap',
                  gap: 0.5,
                  minWidth: 0,
                  overflow: 'hidden',
                }}
                title={item.value}
              >
                {item.value.split(', ').map((part) => (
                  <Chip key={part} size="small" label={part} />
                ))}
              </Box>
            ) : (
              <Typography
                component="span"
                sx={{
                  minWidth: 0,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                  fontSize: '1rem',
                  lineHeight: 1.25,
                  color: item.tone === 'success' ? 'success.main' : 'text.primary',
                  fontWeight: item.tone === 'success' ? 700 : 500,
                }}
                title={item.value}
              >
                {item.value}
              </Typography>
            )}
          </Box>
        );
      })}
    </Box>
  );
}

function MainSection({
  layout,
  compact,
  labelWidth,
  fields,
}: {
  layout: Placement;
  compact: boolean;
  labelWidth: string | null;
  fields: FieldConfig[];
}) {
  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: layout === 'top' ? 1.25 : 2 }}>
      <SectionTitle>Основне</SectionTitle>
      <FieldList layout={layout} compact={compact} columns={1} labelWidth={labelWidth} fields={fields} />
    </Box>
  );
}

function OperationalSection({
  layout,
  compact,
  labelWidth,
  fields,
}: {
  layout: Placement;
  compact: boolean;
  labelWidth: string | null;
  fields: FieldConfig[];
}) {
  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: layout === 'top' ? 1.25 : 2 }}>
      <SectionTitle>Операційні</SectionTitle>
      <FieldList layout={layout} compact={compact} columns={layout === 'top' ? 2 : 1} labelWidth={labelWidth} fields={fields} />
    </Box>
  );
}

function AdditionalSection({
  layout,
  compact,
  labelWidth,
  fields,
}: {
  layout: Placement;
  compact: boolean;
  labelWidth: string | null;
  fields: FieldConfig[];
}) {
  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: layout === 'top' ? 1.25 : 2, pb: layout === 'top' ? 0.5 : 2 }}>
      <SectionTitle>Додатково</SectionTitle>
      <FieldList layout={layout} compact={compact} columns={1} labelWidth={labelWidth} fields={fields} />
    </Box>
  );
}

export function MainContentSections({
  layout,
  compact,
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
}: {
  layout: Placement;
  compact: boolean;
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
}) {
  const mainFields = buildMainFields({
    unitNames,
    network,
    aorVisible,
    aorCollapsedCount,
    showAllAors,
    onToggleShowAllAors,
    callsignCount,
    statusTone,
    statusLabel,
  });
  const operationalFields = buildOperationalFields({
    network,
    rangeLabel,
    transferTypeLabel,
    postItems,
  });
  const additionalFields = buildAdditionalFields({ network });

  if (layout === 'top') {
    return (
      <Box
        sx={{
          display: 'grid',
          gridTemplateColumns: { xs: '1fr', md: 'minmax(0, 1fr) minmax(0, 2fr) minmax(0, 1fr)' },
          gap: { xs: 1.5, md: 2 },
          alignItems: 'start',
        }}
      >
        <MainSection layout={layout} compact={compact} labelWidth="180px" fields={mainFields} />
        <OperationalSection layout={layout} compact={compact} labelWidth="minmax(176px, max-content)" fields={operationalFields} />
        <AdditionalSection layout={layout} compact={compact} labelWidth="minmax(120px, max-content)" fields={additionalFields} />
      </Box>
    );
  }

  return (
    <>
      <MainSection layout={layout} compact={compact} labelWidth={null} fields={mainFields} />
      <Divider />
      <OperationalSection layout={layout} compact={compact} labelWidth={null} fields={operationalFields} />
      <Divider />
      <AdditionalSection layout={layout} compact={compact} labelWidth={null} fields={additionalFields} />
    </>
  );
}

function LeftPanelSkeleton() {
  return (
    <Box
      sx={{
        flex: 1,
        minHeight: 0,
        display: 'flex',
        flexDirection: 'column',
        gap: 2.5,
      }}
    >
      <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.5 }}>
        <Skeleton variant="text" width="32%" height={30} />
        <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', md: 'repeat(3, minmax(0, 1fr))' }, gap: 2 }}>
          <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.25 }}>
            <Skeleton variant="text" width="42%" height={28} />
            <Skeleton variant="rounded" height={24} />
            <Skeleton variant="rounded" height={24} />
            <Skeleton variant="rounded" height={24} />
          </Box>
          <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.25 }}>
            <Skeleton variant="text" width="40%" height={28} />
            <Skeleton variant="rounded" height={24} />
            <Skeleton variant="rounded" height={24} />
            <Skeleton variant="rounded" height={24} />
          </Box>
          <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.25 }}>
            <Skeleton variant="text" width="36%" height={28} />
            <Skeleton variant="rounded" height={24} />
            <Skeleton variant="rounded" height={24} />
          </Box>
        </Box>
      </Box>
    </Box>
  );
}

export function NetworkDetailsLeftPanelSkeleton() {
  return <LeftPanelSkeleton />;
}
