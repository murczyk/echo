import { Divider, Paper, Stack, Typography } from '@mui/material';
import React from 'react';

import type { CountStatsRsp } from '../../../../../Bindings';
import { PowerChip } from '../../../components/PowerChip';

type Props = {
  counts: CountStatsRsp | null;
};

export function AnalysisOverviewCard({ counts }: Props) {
  const headingId = React.useId().replace(/:/g, '-');

  return (
    <Paper variant="outlined" component="section" aria-labelledby={headingId} sx={{ p: 2 }}>
      <Typography id={headingId} variant="subtitle1" component="h2" sx={{ fontWeight: 600, mb: 1.5 }}>
        Зведення
      </Typography>
      <Stack direction="row" gap={1} flexWrap="wrap" role="list" aria-label="Основні показники">
        <PowerChip label={`Групи: ${counts?.groupsCount ?? 0}`} color="default" />
        <PowerChip label={`Відправники: ${counts?.sendersCount ?? 0}`} color="default" />
        <PowerChip label={`Частоти: ${counts?.freqsCount ?? 0}`} color="default" />
        <PowerChip label={`Позивні: ${counts?.callsignsCount ?? 0}`} color="default" />
        <PowerChip label={`Підрозділи: ${counts?.unitsCount ?? 0}`} color="default" />
        <PowerChip label={`Локації: ${counts?.locationsCount ?? 0}`} color="default" />
      </Stack>
      <Divider sx={{ my: 1.5 }} />
      <Stack direction="row" gap={1} flexWrap="wrap" role="list" aria-label="Додаткові показники">
        <PowerChip size="small" label={`Пости: ${counts?.postsCount ?? 0}`} color="default" />
        <PowerChip size="small" label={`Теги: ${counts?.tagsCount ?? 0}`} color="default" />
        <PowerChip size="small" label={`AOR: ${counts?.aorsCount ?? 0}`} color="default" />
        <PowerChip size="small" label={`Мережі: ${counts?.networksCount ?? 0}`} color="default" />
      </Stack>
    </Paper>
  );
}
