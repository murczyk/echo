import { Box, Divider, Typography } from '@mui/material';
import type { ReactNode } from 'react';

import type { Network } from '../../../../../Bindings';
import {
  buildAdditionalFields,
  buildMainFields,
  buildOperationalFields,
} from './NetworkDetailsLeftPanel.shared';
import type { FieldConfig, Placement } from './NetworkDetailsLeftPanel.shared';

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
