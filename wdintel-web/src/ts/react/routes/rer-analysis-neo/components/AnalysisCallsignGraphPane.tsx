import { Box, Button, CircularProgress, Stack } from '@mui/material';
import { useState } from 'react';

import type { NetworkCallsignRelationsRsp } from '../../../../../Bindings';
import { PowerAlert } from '../../../components/PowerAlert';
import { CompactText } from '../../../components/CompactTypography';
import { NetworkCallsignRelationsGraph } from '../../rer-network-details-neo/components/NetworkCallsignRelationsGraph';

type Props = {
  callsignGraph: NetworkCallsignRelationsRsp | null;
  callsignGraphLoading: boolean;
  callsignGraphLoadError?: string | null;
  onLoadCallsignGraph: () => void;
};

const ANALYSIS_RELATIONS_DEFAULT_MIN_INTENSITY = 1;

export function AnalysisCallsignGraphPane({
  callsignGraph,
  callsignGraphLoading,
  callsignGraphLoadError,
  onLoadCallsignGraph,
}: Props) {
  const [relationsSearch, setRelationsSearch] = useState('');
  const [relationsEnabledFreqs, setRelationsEnabledFreqs] = useState<string[]>([]);
  const [relationsMinIntensity, setRelationsMinIntensity] = useState(
    ANALYSIS_RELATIONS_DEFAULT_MIN_INTENSITY,
  );
  const [relationsShowLabels, setRelationsShowLabels] = useState(true);
  const [relationsSelectedNodeId, setRelationsSelectedNodeId] = useState<string | null>(null);
  const [relationsSelectedEdgeId, setRelationsSelectedEdgeId] = useState<string | null>(null);
  if (!callsignGraph) {
    return (
      <Stack spacing={2} alignItems="center" justifyContent="center" sx={{ minHeight: 360, p: 2 }}>
        {callsignGraphLoading ? (
          <>
            <CircularProgress size={24} />
            <CompactText color="text.secondary">Завантажуємо граф зв'язків позивних…</CompactText>
          </>
        ) : callsignGraphLoadError ? (
          <>
            <PowerAlert severity="error" autoHideDuration={null} sx={{ width: '100%' }}>
              {callsignGraphLoadError}
            </PowerAlert>
            <Button variant="outlined" onClick={onLoadCallsignGraph}>
              Спробувати ще раз
            </Button>
          </>
        ) : (
          <>
            <CompactText color="text.secondary" textAlign="center">
              Побудова графа може потребувати значного обсягу даних за вибраний період.
            </CompactText>
            <Button variant="outlined" onClick={onLoadCallsignGraph}>
              Завантажити
            </Button>
          </>
        )}
      </Stack>
    );
  }

  return (
    <Box
      sx={{
        p: 2,
        minWidth: 0,
        minHeight: 640,
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      {callsignGraphLoadError ? (
        <PowerAlert severity="error" autoHideDuration={null} sx={{ width: '100%', mb: 2 }}>
          {callsignGraphLoadError}
        </PowerAlert>
      ) : null}
      <NetworkCallsignRelationsGraph
        networkId={null}
        relations={callsignGraph}
        relationsSearch={relationsSearch}
        relationsEnabledFreqs={relationsEnabledFreqs}
        relationsMinIntensity={relationsMinIntensity}
        relationsShowLabels={relationsShowLabels}
        relationsSelectedNodeId={relationsSelectedNodeId}
        relationsSelectedEdgeId={relationsSelectedEdgeId}
        relationsSince=""
        relationsTill=""
        relationsLoading={callsignGraphLoading}
        contextDescription="Позивні, зв'язки та перехоплення за параметрами аналізу, інтенсивністю й частотами."
        defaultMinIntensity={ANALYSIS_RELATIONS_DEFAULT_MIN_INTENSITY}
        showDateFilters={false}
        showMessages={false}
        onReload={onLoadCallsignGraph}
        onSearchChange={setRelationsSearch}
        onEnabledFreqsChange={setRelationsEnabledFreqs}
        onMinIntensityChange={setRelationsMinIntensity}
        onShowLabelsChange={setRelationsShowLabels}
        onSelectNodeId={(nodeId) => {
          setRelationsSelectedNodeId(nodeId);
          setRelationsSelectedEdgeId(null);
        }}
        onSelectEdgeId={(edgeId) => {
          setRelationsSelectedEdgeId(edgeId);
          if (edgeId !== null) setRelationsSelectedNodeId(null);
        }}
        onRelationsSinceChange={() => undefined}
        onRelationsTillChange={() => undefined}
      />
    </Box>
  );
}
