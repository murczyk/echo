import { Button, CircularProgress, FormControlLabel, Paper, Stack, Switch, Typography } from '@mui/material';
import { useEffect, useId } from 'react';

import type { NetJsonGraphAndMeta } from '../../../../../Bindings';

type Props = {
  graph: NetJsonGraphAndMeta | null;
  loading: boolean;
  nolimit: boolean;
  onLoad: () => void;
  onToggleNolimit: () => void;
};

let netjsonScriptLoaded = false;

async function loadNetjsonScript() {
  if (!netjsonScriptLoaded) {
    netjsonScriptLoaded = true;
    await import('../../../../../../static/netjsongraph/netjsongraph.min.js');
  }
}

function renderGraph(elemId: string, graphDataAndMeta: NetJsonGraphAndMeta) {
  const graphData = { ...graphDataAndMeta.graph, type: graphDataAndMeta.graph.type_ };
  if (!window.netjson_graphs) window.netjson_graphs = {};

  let graph = window.netjson_graphs[elemId];
  if (graph) {
    graph.utils.JSONDataUpdate(graphData);
  } else {
    graph = new NetJSONGraph(graphData, {
      el: document.getElementById(elemId),
      graphConfig: {
        series: {
          nodeSize: (node: { count: number }) => {
            if (node.count <= 20) {
              return Math.sqrt(node.count) * 4;
            }
            return 20 + Math.log(node.count);
          },
        },
        baseOptions: {
          backgroundColor: '#211a11',
        },
      },
      linkCategories: graphDataAndMeta.linkCategories,
    });
    window.netjson_graphs[elemId] = graph;
  }
  graph.render();
}

export function AnalysisCallsignGraphCard({ graph, loading, nolimit, onLoad, onToggleNolimit }: Props) {
  const graphId = useId().replace(/:/g, '-');
  const elementId = `callsign-graph-div-${graphId}`;
  const headingId = `${elementId}-heading`;

  useEffect(() => {
    if (!graph) return;
    let active = true;
    void loadNetjsonScript().then(() => {
      if (!active) return;
      renderGraph(elementId, graph);
    });
    return () => {
      active = false;
    };
  }, [elementId, graph]);

  const nodes = graph?.graph.nodes ?? [];

  return (
    <Paper variant="outlined" component="section" aria-labelledby={headingId} sx={{ p: 2 }}>
      <Stack direction="row" alignItems="center" justifyContent="space-between" sx={{ mb: 1.5 }}>
        <Typography id={headingId} variant="subtitle2" component="h2">
          Граф позивних
        </Typography>
        <Button size="small" onClick={onLoad} disabled={loading}>
          {loading ? <CircularProgress size={14} /> : 'Завантажити'}
        </Button>
      </Stack>
      {graph ? (
        <Stack direction="row" justifyContent="space-between" alignItems="center" sx={{ mb: 1 }}>
          <Typography variant="caption" color="text.secondary" role="status" aria-live="polite">
            Показано {nodes.length} з {graph.overallCount ?? nodes.length} позивних
          </Typography>
          <FormControlLabel control={<Switch checked={nolimit} onChange={onToggleNolimit} />} label="показувати всі" sx={{ mr: 0 }} />
        </Stack>
      ) : null}
      {loading && !graph ? (
        <Stack alignItems="center" justifyContent="center" sx={{ height: 260 }}>
          <CircularProgress size={24} />
        </Stack>
      ) : (
        <div
          id={elementId}
          role="img"
          aria-label="Граф зв'язків позивних"
          style={{ height: 600, position: 'relative', transform: 'translateZ(0)' }}
        />
      )}
    </Paper>
  );
}
