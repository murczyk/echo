import { Box, Button, CircularProgress, Stack } from '@mui/material';
import { useEffect, useMemo, useRef, useState } from 'react';

import type { NetworkCallsignRelationsRsp } from '../../../../../Bindings';
import { PowerAlert } from '../../../components/PowerAlert';
import { CompactText } from '../../../components/CompactTypography';
import { NetworkCallsignRelationsGraph } from '../../rer-network-details-neo/components/NetworkCallsignRelationsGraph';
import { findMinimumRenderableNetworkCallsignRelationsIntensity } from '../../rer-network-details-neo/network-relations';

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
  const loadedGraphRef = useRef(callsignGraph);
  const defaultMinIntensity = useMemo(
    () => getSafeIntensity(callsignGraph, '', []),
    [callsignGraph],
  );
  const [relationsSearch, setRelationsSearch] = useState('');
  const [relationsEnabledFreqs, setRelationsEnabledFreqs] = useState<string[]>([]);
  const [relationsMinIntensity, setRelationsMinIntensity] = useState(defaultMinIntensity);
  const [relationsShowLabels, setRelationsShowLabels] = useState(true);
  const [relationsSelectedNodeId, setRelationsSelectedNodeId] = useState<string | null>(null);
  const [relationsSelectedEdgeId, setRelationsSelectedEdgeId] = useState<string | null>(null);

  useEffect(() => {
    if (callsignGraph === loadedGraphRef.current) return;
    loadedGraphRef.current = callsignGraph;
    if (callsignGraph === null) return;

    setRelationsSearch('');
    setRelationsEnabledFreqs([]);
    setRelationsMinIntensity(defaultMinIntensity);
    setRelationsShowLabels(true);
    setRelationsSelectedNodeId(null);
    setRelationsSelectedEdgeId(null);
  }, [callsignGraph, defaultMinIntensity]);

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
        defaultMinIntensity={defaultMinIntensity}
        showDateFilters={false}
        showMessages={false}
        onReload={onLoadCallsignGraph}
        onSearchChange={(search) => {
          setRelationsSearch(search);
          setRelationsMinIntensity((intensity) =>
            clampIntensity(callsignGraph, search, relationsEnabledFreqs, intensity),
          );
        }}
        onEnabledFreqsChange={(enabledFreqs) => {
          setRelationsEnabledFreqs(enabledFreqs);
          setRelationsMinIntensity((intensity) =>
            clampIntensity(callsignGraph, relationsSearch, enabledFreqs, intensity),
          );
        }}
        onMinIntensityChange={(intensity) =>
          setRelationsMinIntensity(
            clampIntensity(callsignGraph, relationsSearch, relationsEnabledFreqs, intensity),
          )
        }
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

function getSafeIntensity(
  callsignGraph: NetworkCallsignRelationsRsp | null,
  search: string,
  enabledFreqs: string[],
): number {
  return (
    findMinimumRenderableNetworkCallsignRelationsIntensity(callsignGraph, search, enabledFreqs) ??
    ANALYSIS_RELATIONS_DEFAULT_MIN_INTENSITY
  );
}

function clampIntensity(
  callsignGraph: NetworkCallsignRelationsRsp,
  search: string,
  enabledFreqs: string[],
  intensity: number,
): number {
  const safeIntensity = findMinimumRenderableNetworkCallsignRelationsIntensity(
    callsignGraph,
    search,
    enabledFreqs,
  );
  return safeIntensity === null ? intensity : Math.max(intensity, safeIntensity);
}
