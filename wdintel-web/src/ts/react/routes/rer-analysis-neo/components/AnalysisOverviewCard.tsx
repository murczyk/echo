import { useRadioFeatures } from '../../shared/RadioFeatures';
import { Paper, Stack } from '@mui/material';

import type { CountStatsRsp } from '../../../../../Bindings';
import { PowerChip } from '../../../components/PowerChip';
import { NO_DATA_LABEL } from '../../../utils/misc';

type Props = {
  counts: Partial<CountStatsRsp> | null;
};

export function AnalysisOverviewCard({ counts }: Props) {
  const radioFeaturesAllowed = useRadioFeatures();
  return (
    <Paper variant="outlined" component="section" aria-label="Зведення" sx={{ p: 2 }}>
      <Stack direction="row" gap={1} flexWrap="wrap" role="list" aria-label="Основні показники">
        <PowerChip label={`Групи: ${counts?.groupsCount ?? NO_DATA_LABEL}`} color="default" />
        <PowerChip
          label={`Відправники: ${counts?.sendersCount ?? NO_DATA_LABEL}`}
          color="default"
        />
        {radioFeaturesAllowed ? (
          <PowerChip label={`Частоти: ${counts?.freqsCount ?? NO_DATA_LABEL}`} color="default" />
        ) : null}
        <PowerChip label={`Позивні: ${counts?.callsignsCount ?? NO_DATA_LABEL}`} color="default" />
        <PowerChip label={`Підрозділи: ${counts?.unitsCount ?? NO_DATA_LABEL}`} color="default" />
        <PowerChip label={`Локації: ${counts?.locationsCount ?? NO_DATA_LABEL}`} color="default" />
        {radioFeaturesAllowed ? (
          <PowerChip
            size="small"
            label={`Пости: ${counts?.postsCount ?? NO_DATA_LABEL}`}
            color="default"
          />
        ) : null}
        <PowerChip
          size="small"
          label={`Теги: ${counts?.tagsCount ?? NO_DATA_LABEL}`}
          color="default"
        />
        <PowerChip
          size="small"
          label={`AOR: ${counts?.aorsCount ?? NO_DATA_LABEL}`}
          color="default"
        />
        <PowerChip
          size="small"
          label={`Мережі: ${counts?.networksCount ?? NO_DATA_LABEL}`}
          color="default"
        />
      </Stack>
    </Paper>
  );
}
