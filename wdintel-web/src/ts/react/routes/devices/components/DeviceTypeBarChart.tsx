import { Box, Chip, Stack, Tooltip, Typography } from '@mui/material';

import {
  formatDeviceBytes,
  formatDeviceCount,
  type DeviceTypeBreakdown,
  type DeviceTypeTotals,
} from '../device-activity';
import { FILE_TYPE_CATEGORIES } from '../file-type-categories';

export type DeviceTypeMetric = 'count' | 'bytes';

/** One bar split into category segments by `metric`; each category row below lists its
 * extensions as chips with the same metric. */
export function DeviceTypeBarChart({
  breakdown,
  metric,
}: {
  breakdown: DeviceTypeBreakdown;
  metric: DeviceTypeMetric;
}) {
  const total = value(breakdown, metric);
  if (breakdown.categories.length === 0 || total === 0n) {
    return (
      <Typography variant="body2" color="text.secondary">
        —
      </Typography>
    );
  }

  const categories = [...breakdown.categories]
    .filter((category) => value(category, metric) > 0n)
    .sort((left, right) => compareBigIntDesc(value(left, metric), value(right, metric)));

  return (
    <Stack spacing={1.5}>
      <Box
        role="img"
        aria-label={metric === 'count' ? 'Кількість файлів за типами' : 'Розмір файлів за типами'}
        sx={{ display: 'flex', height: 18, borderRadius: '4px', overflow: 'hidden', gap: '1px' }}
      >
        {categories.map((category) => (
          <Tooltip
            key={category.category}
            title={`${category.category}: ${formatMetric(category, metric)} · ${formatShare(value(category, metric), total)}`}
            disableInteractive
          >
            <Box
              sx={{
                flexGrow: Number(value(category, metric)),
                flexBasis: 0,
                minWidth: 2,
                bgcolor: FILE_TYPE_CATEGORIES[category.category]?.color,
              }}
            />
          </Tooltip>
        ))}
      </Box>

      <Box component="ul" aria-label="Типи файлів" sx={{ listStyle: 'none', m: 0, p: 0 }}>
        {categories.map((category) => {
          const extensions = [...category.extensions]
            .filter((extension) => value(extension, metric) > 0n)
            .sort((left, right) => compareBigIntDesc(value(left, metric), value(right, metric)));
          return (
            <Box
              key={category.category}
              component="li"
              sx={{
                display: 'grid',
                gridTemplateColumns: { xs: '1fr', sm: 'minmax(160px, 240px) minmax(0, 1fr)' },
                columnGap: 2,
                rowGap: 0.5,
                alignItems: 'start',
                py: 0.75,
                '& + &': { borderTop: '1px solid', borderColor: 'divider' },
              }}
            >
              <Stack direction="row" spacing={1} alignItems="center" sx={{ minWidth: 0, pt: 0.25 }}>
                <Box
                  sx={{
                    width: 12,
                    height: 12,
                    borderRadius: '3px',
                    bgcolor: FILE_TYPE_CATEGORIES[category.category]?.color,
                    flexShrink: 0,
                  }}
                />
                <Typography variant="body2" noWrap sx={{ flex: 1, minWidth: 0 }}>
                  {category.category}
                </Typography>
                <Typography
                  variant="body2"
                  sx={{ whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums' }}
                >
                  <b>{formatMetric(category, metric)}</b>
                  <Box component="span" sx={{ color: 'text.secondary', ml: 1 }}>
                    {formatShare(value(category, metric), total)}
                  </Box>
                </Typography>
              </Stack>
              <Stack direction="row" useFlexGap flexWrap="wrap" gap={0.5}>
                {extensions.map((extension) => (
                  <Chip
                    key={extension.extension}
                    size="small"
                    variant="outlined"
                    label={
                      <>
                        {extension.extension === '' ? 'без розширення' : `.${extension.extension}`}
                        <Box component="span" sx={{ color: 'text.secondary', ml: 0.75 }}>
                          {formatMetric(extension, metric)}
                        </Box>
                      </>
                    }
                    sx={{ fontVariantNumeric: 'tabular-nums' }}
                  />
                ))}
              </Stack>
            </Box>
          );
        })}
      </Box>
    </Stack>
  );
}

function value(totals: DeviceTypeTotals, metric: DeviceTypeMetric): bigint {
  return metric === 'count' ? totals.contentCount : totals.contentBytes;
}

function formatMetric(totals: DeviceTypeTotals, metric: DeviceTypeMetric): string {
  return metric === 'count'
    ? formatDeviceCount(totals.contentCount)
    : formatDeviceBytes(totals.contentBytes);
}

function compareBigIntDesc(left: bigint, right: bigint): number {
  return left === right ? 0 : left > right ? -1 : 1;
}

/** Percentage with one decimal, computed in BigInt. */
function formatShare(part: bigint, total: bigint): string {
  if (total === 0n) return '0 %';
  const tenths = (part * 1000n + total / 2n) / total;
  const whole = (tenths / 10n).toString();
  const fraction = tenths % 10n;
  return fraction === 0n ? `${whole} %` : `${whole},${fraction} %`;
}
