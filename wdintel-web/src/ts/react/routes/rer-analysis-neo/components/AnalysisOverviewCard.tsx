import { Paper, Stack } from '@mui/material';

import type { CountStatsRsp } from '../../../../../Bindings';
import { PowerChip } from '../../../components/PowerChip';

type Props = {
  counts: CountStatsRsp | null;
};

export function AnalysisOverviewCard({ counts }: Props) {
  return (
    <Paper variant="outlined" component="section" aria-label="Зведення" sx={{ p: 2 }}>
      <Stack direction="row" gap={1} flexWrap="wrap" role="list" aria-label="Основні показники">
        <PowerChip label={`Групи: ${counts?.groupsCount ?? 0}`} color="default" />
        <PowerChip label={`Відправники: ${counts?.sendersCount ?? 0}`} color="default" />
        <PowerChip label={`Частоти: ${counts?.freqsCount ?? 0}`} color="default" />
        <PowerChip label={`Позивні: ${counts?.callsignsCount ?? 0}`} color="default" />
        <PowerChip label={`Підрозділи: ${counts?.unitsCount ?? 0}`} color="default" />
        <PowerChip label={`Локації: ${counts?.locationsCount ?? 0}`} color="default" />
        <PowerChip size="small" label={`Пости: ${counts?.postsCount ?? 0}`} color="default" />
        <PowerChip size="small" label={`Теги: ${counts?.tagsCount ?? 0}`} color="default" />
        <PowerChip size="small" label={`AOR: ${counts?.aorsCount ?? 0}`} color="default" />
        <PowerChip size="small" label={`Мережі: ${counts?.networksCount ?? 0}`} color="default" />
      </Stack>
    </Paper>
  );
}
