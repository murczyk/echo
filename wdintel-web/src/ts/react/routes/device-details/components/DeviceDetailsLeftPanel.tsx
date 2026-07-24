import { Box, Chip, Divider, Link, Paper, Skeleton, Stack, Typography } from '@mui/material';
import type { ReactNode } from 'react';

import type { DeviceDetails } from '../../../../../Bindings';
import { formatDeviceDateTime, formatUnitLabel, isSafeExternalUrl } from '../../devices/helpers';
import { formatDeviceLifecycleLabel } from '../helpers';

type Props = {
  device: DeviceDetails | null;
  loading: boolean;
};

type FieldConfig = {
  key: string;
  label: string;
  value: ReactNode;
};

function DeviceDetailsLeftPanelSkeleton() {
  const rowHeights = [36, 36, 36, 36, 36, 36, 36, 36, 36, 36];

  return (
    <Box
      sx={{
        flex: 1,
        minHeight: 0,
        display: 'flex',
        flexDirection: 'column',
        gap: 1.25,
        height: '100%',
      }}
      data-testid="device-details-left-panel-skeleton"
    >
      <Skeleton variant="text" width="38%" height={30} />
      <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.25, minHeight: 0 }}>
        {rowHeights.map((height, index) => (
          <Skeleton key={index} variant="rounded" height={height} />
        ))}
      </Box>
    </Box>
  );
}

function FieldRow({ label, value }: { label: string; value: ReactNode }) {
  return (
    <Box
      sx={{
        display: 'grid',
        gridTemplateColumns: { xs: '1fr', sm: '180px minmax(0,1fr)' },
        gap: 1,
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

function FieldList({ fields }: { fields: FieldConfig[] }) {
  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      {fields.map((field) => (
        <FieldRow key={field.key} label={field.label} value={field.value} />
      ))}
    </Box>
  );
}

function DeviceSection({ title, fields }: { title: string; fields: FieldConfig[] }) {
  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      <SectionTitle>{title}</SectionTitle>
      <FieldList fields={fields} />
    </Box>
  );
}

function DeviceTextValue({ children, muted = false }: { children: ReactNode; muted?: boolean }) {
  return (
    <Typography
      variant="body2"
      color={muted ? 'text.secondary' : 'text.primary'}
      sx={{ whiteSpace: 'normal', overflowWrap: 'anywhere', wordBreak: 'break-word' }}
    >
      {children}
    </Typography>
  );
}

function buildAorItems(device: DeviceDetails): Array<{ id: number; label: string }> {
  return device.aors.map((aor) => ({
    id: aor.id,
    label: aor.name.trim() || `AOR #${aor.id} — назва недоступна`,
  }));
}

function DeviceAorsValue({ device }: { device: DeviceDetails }) {
  const aorItems = buildAorItems(device);

  if (aorItems.length === 0) {
    return <DeviceTextValue muted>—</DeviceTextValue>;
  }

  return (
    <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: 'wrap', alignItems: 'center' }}>
      {aorItems.map((item) => (
        <Chip key={item.id} size="small" label={item.label} />
      ))}
    </Stack>
  );
}

function DeviceNameValue({ device }: { device: DeviceDetails }) {
  return <DeviceTextValue muted={device.name === null}>{device.name ?? '—'}</DeviceTextValue>;
}

function DeviceExternalUrlValue({ device }: { device: DeviceDetails }) {
  const externalUrl = device.externalUrl?.trim() ?? '';
  if (externalUrl === '') return <DeviceTextValue muted>—</DeviceTextValue>;
  if (!isSafeExternalUrl(externalUrl)) return <DeviceTextValue>{externalUrl}</DeviceTextValue>;

  return (
    <Link
      href={externalUrl}
      target="_blank"
      rel="noopener noreferrer"
      underline="hover"
      variant="body2"
      sx={{ overflowWrap: 'anywhere', wordBreak: 'break-word' }}
    >
      {externalUrl}
    </Link>
  );
}

function buildMainFields(device: DeviceDetails): FieldConfig[] {
  return [
    {
      key: 'id',
      label: 'ID',
      value: <DeviceTextValue>{device.id}</DeviceTextValue>,
    },
    {
      key: 'sourceLabel',
      label: 'Джерельна мітка',
      value: <DeviceTextValue>{device.sourceLabel}</DeviceTextValue>,
    },
    {
      key: 'externalUrl',
      label: 'Зовнішнє посилання',
      value: <DeviceExternalUrlValue device={device} />,
    },
    {
      key: 'name',
      label: 'Аналітична назва',
      value: <DeviceNameValue device={device} />,
    },
    {
      key: 'lifecycle',
      label: 'Статус',
      value: (
        <Stack
          direction="row"
          spacing={1}
          useFlexGap
          sx={{ flexWrap: 'wrap', alignItems: 'center' }}
        >
          <Chip
            size="small"
            color={device.archived ? 'warning' : 'success'}
            label={formatDeviceLifecycleLabel(device.archived)}
          />
        </Stack>
      ),
    },
    {
      key: 'aors',
      label: 'Смуги',
      value: <DeviceAorsValue device={device} />,
    },
    {
      key: 'unit',
      label: 'Підрозділ',
      value: <DeviceTextValue>{formatUnitLabel(device.unit)}</DeviceTextValue>,
    },
  ];
}

function buildAdditionalFields(device: DeviceDetails): FieldConfig[] {
  return [
    {
      key: 'createdBy',
      label: 'Створив',
      value: <DeviceTextValue>{device.createdBy}</DeviceTextValue>,
    },
    {
      key: 'createdAt',
      label: 'Створено',
      value: <DeviceTextValue>{formatDeviceDateTime(device.createdAt)}</DeviceTextValue>,
    },
    {
      key: 'updatedAt',
      label: 'Оновлено',
      value: <DeviceTextValue>{formatDeviceDateTime(device.updatedAt)}</DeviceTextValue>,
    },
    ...(device.archived
      ? [
          {
            key: 'archivedAt',
            label: 'Архівовано',
            value: <DeviceTextValue>{formatDeviceDateTime(device.archivedAt)}</DeviceTextValue>,
          },
        ]
      : []),
  ];
}

function DeviceCustomFieldsSection({ device }: { device: DeviceDetails }) {
  const customFields = Object.entries(device.customFields).sort(([left], [right]) =>
    left.localeCompare(right),
  );

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      <SectionTitle>Кастомні поля</SectionTitle>
      {customFields.length === 0 ? (
        <DeviceTextValue muted>Кастомні поля відсутні.</DeviceTextValue>
      ) : (
        <FieldList
          fields={customFields.map(([key, value]) => ({
            key,
            label: key,
            value: <DeviceTextValue muted={value === ''}>{value || '—'}</DeviceTextValue>,
          }))}
        />
      )}
    </Box>
  );
}

function DeviceLeftPanelContent({ device }: { device: DeviceDetails }) {
  return (
    <>
      <DeviceSection title="Основне" fields={buildMainFields(device)} />
      <Divider />
      <DeviceCustomFieldsSection device={device} />
      <Divider />
      <DeviceSection title="Додатково" fields={buildAdditionalFields(device)} />
    </>
  );
}

export function DeviceDetailsLeftPanel({ device, loading }: Props) {
  return (
    <Paper
      variant="outlined"
      data-testid="device-details-left-panel"
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
          pr: 4,
          display: 'flex',
          flexDirection: 'column',
          gap: 2.5,
          boxSizing: 'border-box',
          overflow: 'visible',
          position: 'relative',
        }}
      >
        {loading && device === null ? (
          <DeviceDetailsLeftPanelSkeleton />
        ) : device ? (
          <DeviceLeftPanelContent device={device} />
        ) : null}
      </Box>
    </Paper>
  );
}
