import OpenInNewIcon from '@mui/icons-material/OpenInNew';
import {
  Box,
  Button,
  Chip,
  Divider,
  Link,
  Paper,
  Skeleton,
  Stack,
  Typography,
} from '@mui/material';
import type { ReactNode } from 'react';

import type { DeviceDetails } from '../../../../../Bindings';
import { formatDeviceDateTime, isSafeExternalUrl } from '../../devices/helpers';
import { formatDeviceLifecycleLabel, formatOptionalText, formatUnitLabel } from '../helpers';

type Props = {
  device: DeviceDetails | null;
  loading: boolean;
  onOpenExternalUrl: (url: string) => void;
};

type FieldConfig = {
  key: string;
  label: string;
  value: ReactNode;
};

function DeviceDetailsLeftPanelSkeleton() {
  const rowHeights = [36, 36, 36, 36, 36, 36, 36, 36];

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
  if (device.aorIds.length > 0) {
    return device.aorIds.map((id, index) => ({
      id,
      label: device.aorNames[index]?.trim() || `AOR #${id} — назва недоступна`,
    }));
  }

  return device.aorNames
    .map((name, index) => ({ id: index, label: name.trim() }))
    .filter((item) => item.label !== '');
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

function DeviceExternalUrlValue({
  externalUrl,
  onOpenExternalUrl,
}: {
  externalUrl: string | null;
  onOpenExternalUrl: (url: string) => void;
}) {
  const url = externalUrl?.trim() ?? '';
  const canOpenExternalUrl = isSafeExternalUrl(url);

  if (!canOpenExternalUrl) {
    return <DeviceTextValue muted={!url}>{formatOptionalText(externalUrl)}</DeviceTextValue>;
  }

  return (
    <Stack direction="row" spacing={1} alignItems="center" sx={{ minWidth: 0 }}>
      <Link
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        underline="hover"
        variant="body2"
        sx={{ overflowWrap: 'anywhere', wordBreak: 'break-word' }}
      >
        {url}
      </Link>
      <Button
        size="small"
        startIcon={<OpenInNewIcon fontSize="small" />}
        onClick={() => onOpenExternalUrl(url)}
        sx={{ flexShrink: 0 }}
      >
        Відкрити
      </Button>
    </Stack>
  );
}

function buildMainFields({
  device,
  onOpenExternalUrl,
}: {
  device: DeviceDetails;
  onOpenExternalUrl: (url: string) => void;
}): FieldConfig[] {
  return [
    {
      key: 'name',
      label: 'Назва',
      value: <DeviceTextValue>{device.name}</DeviceTextValue>,
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
            color={device.deleted ? 'warning' : 'success'}
            label={formatDeviceLifecycleLabel(device.deleted)}
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
      value: <DeviceTextValue>{formatUnitLabel(device.unitId, device.unitName)}</DeviceTextValue>,
    },
    {
      key: 'externalUrl',
      label: 'Зовнішнє посилання',
      value: (
        <DeviceExternalUrlValue
          externalUrl={device.externalUrl}
          onOpenExternalUrl={onOpenExternalUrl}
        />
      ),
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
      value: <DeviceTextValue>{formatDeviceDateTime(device.createdAtMs)}</DeviceTextValue>,
    },
    {
      key: 'updatedAt',
      label: 'Оновлено',
      value: <DeviceTextValue>{formatDeviceDateTime(device.updatedAtMs)}</DeviceTextValue>,
    },
    ...(device.deleted
      ? [
          {
            key: 'deletedAt',
            label: 'Видалено',
            value: <DeviceTextValue>{formatDeviceDateTime(device.deletedAtMs)}</DeviceTextValue>,
          },
        ]
      : []),
  ];
}

function DeviceLeftPanelContent({
  device,
  onOpenExternalUrl,
}: {
  device: DeviceDetails;
  onOpenExternalUrl: (url: string) => void;
}) {
  return (
    <>
      <DeviceSection title="Основне" fields={buildMainFields({ device, onOpenExternalUrl })} />
      <Divider />
      <DeviceSection title="Додатково" fields={buildAdditionalFields(device)} />
    </>
  );
}

export function DeviceDetailsLeftPanel({ device, loading, onOpenExternalUrl }: Props) {
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
          <DeviceLeftPanelContent device={device} onOpenExternalUrl={onOpenExternalUrl} />
        ) : null}
      </Box>
    </Paper>
  );
}
