import AccountTreeOutlinedIcon from '@mui/icons-material/AccountTreeOutlined';
import { Box, Button, Stack, Typography } from '@mui/material';
import { useId } from 'react';

import type { NetworkCallsignRelationsRsp } from '../../../../../Bindings';
import { ELLIPSIS } from '../../../utils/misc';
import { PowerAlert } from '../../../components/PowerAlert';
import { NetworkDetailsEmptyState } from './NetworkDetailsEmptyState';
import { NetworkDetailsLoadingState } from './NetworkDetailsLoadingState';
import { NetworkCallsignRelationsGraph } from './NetworkCallsignRelationsGraph';

type Props = {
  relations: NetworkCallsignRelationsRsp | null;
  relationsLoaded: boolean;
  relationsLoading: boolean;
  relationsError: string | null;
  relationsSearch: string;
  relationsEnabledFreqs: string[];
  relationsMinIntensity: number;
  relationsShowLabels: boolean;
  relationsSelectedNodeId: string | null;
  relationsSelectedEdgeId: string | null;
  relationsSince: string;
  relationsTill: string;
  onReload: () => void;
  onSearchChange: (value: string) => void;
  onEnabledFreqsChange: (freqs: string[]) => void;
  onMinIntensityChange: (value: number) => void;
  onShowLabelsChange: (value: boolean) => void;
  onSelectNodeId: (nodeId: string | null) => void;
  onSelectEdgeId: (edgeId: string | null) => void;
  onRelationsSinceChange: (value: string) => void;
  onRelationsTillChange: (value: string) => void;
};

export function NetworkCallsignRelationsPanel({
  relations,
  relationsLoaded,
  relationsLoading,
  relationsError,
  relationsSearch,
  relationsEnabledFreqs,
  relationsMinIntensity,
  relationsShowLabels,
  relationsSelectedNodeId,
  relationsSelectedEdgeId,
  relationsSince,
  relationsTill,
  onReload,
  onSearchChange,
  onEnabledFreqsChange,
  onMinIntensityChange,
  onShowLabelsChange,
  onSelectNodeId,
  onSelectEdgeId,
  onRelationsSinceChange,
  onRelationsTillChange,
}: Props) {
  const headingId = useId().replace(/:/g, '-');

  if (relationsError) {
    return (
      <Box sx={{ minHeight: 0, minWidth: 0, width: '100%', height: '100%', display: 'flex', flexDirection: 'column', flex: 1 }}>
        <Stack spacing={2} sx={{ minHeight: 0, minWidth: 0, width: '100%', flex: 1, alignItems: 'center' }}>
          <Typography id={headingId} component="h2" variant="h6">
            Граф зв'язків
          </Typography>
          <PowerAlert severity="error" autoHideDuration={null} sx={{ width: '100%' }}>
            {relationsError}
          </PowerAlert>
          <Button variant="outlined" onClick={onReload}>
            Спробувати ще раз
          </Button>
        </Stack>
      </Box>
    );
  }

  if (!relationsLoaded && relations === null) {
    return (
      <Box sx={{ minHeight: 0, minWidth: 0, width: '100%', height: '100%', display: 'flex', flexDirection: 'column', flex: 1 }}>
        <Stack spacing={2} sx={{ minHeight: 0, minWidth: 0, width: '100%', flex: 1 }}>
          <Typography id={headingId} component="h2" variant="h6">
            Граф зв'язків
          </Typography>
          <NetworkDetailsLoadingState message={`Завантажуємо граф зв'язків${ELLIPSIS}`} />
        </Stack>
      </Box>
    );
  }

  if (!relations) {
    return (
      <Box sx={{ minHeight: 0, minWidth: 0, width: '100%', height: '100%', display: 'flex', flexDirection: 'column', flex: 1 }}>
        <Stack spacing={2} sx={{ minHeight: 0, minWidth: 0, width: '100%', flex: 1 }}>
          <Typography id={headingId} component="h2" variant="h6">
            Граф зв'язків
          </Typography>
          <NetworkDetailsEmptyState
            icon={<AccountTreeOutlinedIcon />}
            title="Немає графових даних"
            description="Граф будується після першого зв'язку між позивними."
            minHeight={360}
            action={
              <Button variant="outlined" onClick={onReload}>
                Оновити
              </Button>
            }
          />
        </Stack>
      </Box>
    );
  }

  return (
    <NetworkCallsignRelationsGraph
      relations={relations}
      relationsSearch={relationsSearch}
      relationsEnabledFreqs={relationsEnabledFreqs}
      relationsMinIntensity={relationsMinIntensity}
      relationsShowLabels={relationsShowLabels}
      relationsSelectedNodeId={relationsSelectedNodeId}
      relationsSelectedEdgeId={relationsSelectedEdgeId}
      relationsSince={relationsSince}
      relationsTill={relationsTill}
      relationsLoading={relationsLoading}
      onSearchChange={onSearchChange}
      onEnabledFreqsChange={onEnabledFreqsChange}
      onMinIntensityChange={onMinIntensityChange}
      onShowLabelsChange={onShowLabelsChange}
      onSelectNodeId={onSelectNodeId}
      onSelectEdgeId={onSelectEdgeId}
      onRelationsSinceChange={onRelationsSinceChange}
      onRelationsTillChange={onRelationsTillChange}
    />
  );
}
