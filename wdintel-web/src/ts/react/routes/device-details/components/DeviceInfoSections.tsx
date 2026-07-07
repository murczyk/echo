import OpenInNewIcon from '@mui/icons-material/OpenInNew';
import {
  Box,
  Button,
  Card,
  CardContent,
  CardHeader,
  Divider,
  Link,
  Stack,
  Typography,
} from '@mui/material';

import type { DeviceDetails } from '../../../../../Bindings';
import { isSafeExternalUrl } from '../../devices/helpers';
import { formatDeviceSummaryRows, formatOptionalText, formatUnitLabel } from '../helpers';
import { formatAorsLabel } from '../../devices/helpers';

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <Box
      sx={{
        display: 'grid',
        gridTemplateColumns: { xs: '1fr', sm: '180px minmax(0, 1fr)' },
        gap: { xs: 0.5, sm: 2 },
        alignItems: 'baseline',
      }}
    >
      <Typography variant="body2" color="text.secondary">
        {label}
      </Typography>
      <Typography variant="body2" sx={{ minWidth: 0, overflowWrap: 'anywhere' }}>
        {value}
      </Typography>
    </Box>
  );
}

export function DeviceSummarySection({ device }: { device: DeviceDetails }) {
  return (
    <Card variant="outlined">
      <CardHeader title="Зведення" />
      <CardContent>
        <Stack spacing={1.5} divider={<Divider flexItem />}>
          {formatDeviceSummaryRows(device).map((row) => (
            <InfoRow key={row.label} label={row.label} value={row.value} />
          ))}
        </Stack>
      </CardContent>
    </Card>
  );
}

export function DeviceRegistrySection({
  device,
  onOpenExternalUrl,
}: {
  device: DeviceDetails;
  onOpenExternalUrl: (url: string) => void;
}) {
  const externalUrl = device.externalUrl?.trim() ?? '';
  const canOpenExternalUrl = isSafeExternalUrl(externalUrl);

  return (
    <Card variant="outlined">
      <CardHeader title="Реєстрові поля" />
      <CardContent>
        <Stack spacing={1.5} divider={<Divider flexItem />}>
          <InfoRow label="Назва" value={device.name} />
          <InfoRow label="Смуги" value={formatAorsLabel(device.aorIds, device.aorNames)} />
          <InfoRow label="Підрозділ" value={formatUnitLabel(device.unitId, device.unitName)} />
          <Box
            sx={{
              display: 'grid',
              gridTemplateColumns: { xs: '1fr', sm: '180px minmax(0, 1fr)' },
              gap: { xs: 0.5, sm: 2 },
              alignItems: 'center',
            }}
          >
            <Typography variant="body2" color="text.secondary">
              Зовнішнє посилання
            </Typography>
            {canOpenExternalUrl ? (
              <Stack direction="row" spacing={1} alignItems="center" sx={{ minWidth: 0 }}>
                <Link
                  href={externalUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  underline="hover"
                >
                  {externalUrl}
                </Link>
                <Button
                  size="small"
                  startIcon={<OpenInNewIcon fontSize="small" />}
                  onClick={() => onOpenExternalUrl(externalUrl)}
                >
                  Відкрити
                </Button>
              </Stack>
            ) : (
              <Typography variant="body2" sx={{ minWidth: 0, overflowWrap: 'anywhere' }}>
                {formatOptionalText(device.externalUrl)}
              </Typography>
            )}
          </Box>
        </Stack>
      </CardContent>
    </Card>
  );
}

export function DeviceTagsSection({ device }: { device: DeviceDetails }) {
  return (
    <Card variant="outlined">
      <CardHeader title="Теги" />
      <CardContent>
        {device.tags.length === 0 ? (
          <Typography variant="body2" color="text.secondary">
            Теги відсутні.
          </Typography>
        ) : (
          <Stack spacing={1.5} divider={<Divider flexItem />}>
            {device.tags.map((field, index) => (
              <Box
                key={`${field.label}-${index}`}
                sx={{
                  display: 'grid',
                  gridTemplateColumns: { xs: '1fr', sm: '180px minmax(0, 1fr)' },
                  gap: { xs: 0.5, sm: 2 },
                  alignItems: 'baseline',
                }}
              >
                <Typography
                  variant="body2"
                  color="text.secondary"
                  sx={{ overflowWrap: 'anywhere' }}
                >
                  {field.label}
                </Typography>
                <Typography variant="body2" sx={{ minWidth: 0, overflowWrap: 'anywhere' }}>
                  {field.value || '—'}
                </Typography>
              </Box>
            ))}
          </Stack>
        )}
      </CardContent>
    </Card>
  );
}
