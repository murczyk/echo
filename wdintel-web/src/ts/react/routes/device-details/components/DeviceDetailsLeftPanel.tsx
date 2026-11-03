import { AuthorLabel } from '../../../components/AuthorLabel';
import ChevronRightIcon from '@mui/icons-material/ChevronRight';
import OpenInNewIcon from '@mui/icons-material/OpenInNew';
import {
  Accordion,
  AccordionDetails,
  AccordionSummary,
  Box,
  Chip,
  Divider,
  Link,
  Skeleton,
  Stack,
  Typography,
} from '@mui/material';
import type { ReactNode } from 'react';

import type { DeviceDetails } from '../../../../../Bindings';
import { formatDeviceDateTime, formatUnitLabel, isSafeExternalUrl } from '../../devices/helpers';
import { formatDeviceLifecycleLabel } from '../helpers';

type Props = {
  device: DeviceDetails | null;
  loading: boolean;
  embedded?: boolean;
};

type FieldConfig = {
  key: string;
  label: string;
  value: ReactNode;
};

function DeviceDetailsLeftPanelSkeleton() {
  const rowHeights = [36, 36, 36, 36, 36, 36, 36, 36, 36];

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

function FieldList({
  fields,
  horizontal = false,
}: {
  fields: FieldConfig[];
  horizontal?: boolean;
}) {
  return (
    <dl
      className={
        horizontal
          ? `m-0 grid grid-cols-1 gap-echo-lg echo-sm:grid-cols-2 ${fields.length === 3 ? 'echo-xl:grid-cols-3' : 'echo-xl:grid-cols-5'}`
          : 'm-0 flex flex-col gap-echo-lg'
      }
    >
      {fields.map((field) => (
        <div key={field.key} className="min-w-0">
          <dt className="mb-echo-sm font-medium">{field.label}</dt>
          <dd className="m-0 min-w-0">{field.value}</dd>
        </div>
      ))}
    </dl>
  );
}

function SectionTitle({ children }: { children: ReactNode }) {
  return (
    <Typography component="h3" variant="overline" fontWeight={400}>
      {children}
    </Typography>
  );
}

function DeviceSection({
  title,
  fields,
  horizontal = false,
}: {
  title?: string;
  fields: FieldConfig[];
  horizontal?: boolean;
}) {
  return (
    <section className="flex flex-col gap-echo-md p-echo-lg">
      {title ? <SectionTitle>{title}</SectionTitle> : null}
      <FieldList fields={fields} horizontal={horizontal} />
    </section>
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
  if (device.name === null) return <DeviceTextValue muted>—</DeviceTextValue>;

  const externalUrl = device.externalUrl?.trim() ?? '';
  if (!isSafeExternalUrl(externalUrl)) return <DeviceTextValue>{device.name}</DeviceTextValue>;

  return (
    <Link
      href={externalUrl}
      target="_blank"
      rel="noopener noreferrer"
      underline="hover"
      variant="body2"
      sx={{ overflowWrap: 'anywhere', wordBreak: 'break-word' }}
    >
      {device.name}
      <OpenInNewIcon
        aria-hidden="true"
        sx={{ ml: 0.5, fontSize: 16, verticalAlign: 'text-bottom' }}
      />
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
      key: 'name',
      label: 'Назва',
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
      value: (
        <DeviceTextValue>
          <AuthorLabel login={device.createdBy} />
        </DeviceTextValue>
      ),
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

function DeviceCustomFieldsSection({
  device,
  horizontal,
}: {
  device: DeviceDetails;
  horizontal: boolean;
}) {
  const customFields = Object.entries(device.customFields).sort(([left], [right]) =>
    left.localeCompare(right),
  );

  return (
    <section className="flex flex-col gap-echo-md p-echo-lg">
      <SectionTitle>Кастомні поля</SectionTitle>
      {customFields.length === 0 ? (
        <DeviceTextValue muted>Кастомні поля відсутні.</DeviceTextValue>
      ) : (
        <FieldList
          horizontal={horizontal}
          fields={customFields.map(([key, value]) => ({
            key,
            label: key,
            value: <DeviceTextValue muted={value === ''}>{value || '—'}</DeviceTextValue>,
          }))}
        />
      )}
    </section>
  );
}

function DeviceLeftPanelContent({
  device,
  horizontal = false,
}: {
  device: DeviceDetails;
  horizontal?: boolean;
}) {
  return (
    <>
      <DeviceSection
        title={horizontal ? undefined : 'Основне'}
        fields={buildMainFields(device)}
        horizontal={horizontal}
      />
      <Divider />
      <DeviceCustomFieldsSection device={device} horizontal={horizontal} />
      <Divider />
      <DeviceSection
        title="Додатково"
        fields={buildAdditionalFields(device)}
        horizontal={horizontal}
      />
    </>
  );
}

export function DeviceDetailsLeftPanel({ device, loading, embedded = false }: Props) {
  const content =
    loading && device === null ? (
      <DeviceDetailsLeftPanelSkeleton />
    ) : device ? (
      <DeviceLeftPanelContent device={device} horizontal={embedded} />
    ) : null;

  if (embedded) {
    return (
      <Accordion
        disableGutters
        variant="outlined"
        data-testid="device-details-overview"
        className="!m-0 !rounded-echo-xl !bg-echo-background before:!hidden"
      >
        <AccordionSummary
          expandIcon={<ChevronRightIcon />}
          id="device-overview-header"
          aria-controls="device-overview-content"
          className="!min-h-[64px]"
          sx={{
            '& .MuiAccordionSummary-expandIconWrapper.Mui-expanded': { transform: 'rotate(90deg)' },
          }}
        >
          <Typography component="h2" variant="h5" fontWeight={400}>
            Основне
          </Typography>
        </AccordionSummary>
        <AccordionDetails id="device-overview-content" className="!p-0">
          {content}
        </AccordionDetails>
      </Accordion>
    );
  }

  return (
    <aside
      data-testid="device-details-left-panel"
      className="h-full min-h-0 overflow-auto rounded-echo-md border border-echo-border bg-echo-surface"
    >
      {content}
    </aside>
  );
}
