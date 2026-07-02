import {
  Box,
  Button,
  CircularProgress,
  FormControlLabel,
  Paper,
  Stack,
  Switch,
  Typography,
} from '@mui/material';
import { useEffect, useId, useRef, useState } from 'react';
import { ELLIPSIS, isPresent } from '../../../utils/misc';

import type { NetJsonGraphAndMeta } from '../../../../../Bindings';

type Props = {
  graph: NetJsonGraphAndMeta | null;
  loading: boolean;
  loadVersion: number;
  nolimit: boolean;
  visible?: boolean;
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
  const graphContainer = document.getElementById(elemId);
  if (!graphContainer) return;

  delete window.netjson_graphs[elemId];
  graphContainer.replaceChildren();

  const graph = new NetJSONGraph(graphData, {
    el: graphContainer,
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
  graph.render();
}

export function AnalysisCallsignGraphCard({
  graph,
  loading,
  loadVersion,
  nolimit,
  visible = true,
  onLoad,
  onToggleNolimit,
}: Props) {
  const graphId = useId().replace(/:/g, '-');
  const elementId = `callsign-graph-div-${graphId}`;
  const headingId = `${elementId}-heading`;
  const graphContainerRef = useRef<HTMLDivElement | null>(null);
  const autoloadedVersionRef = useRef<number | null>(null);
  const zoomHintTimeoutRef = useRef<number | null>(null);
  const [zoomHintVisible, setZoomHintVisible] = useState(false);

  useEffect(() => {
    if (!visible || loading || isPresent(graph) || autoloadedVersionRef.current === loadVersion)
      return;
    autoloadedVersionRef.current = loadVersion;
    onLoad();
  }, [graph, loadVersion, loading, onLoad, visible]);

  useEffect(() => {
    if (!graph || !visible) return;
    let active = true;
    void loadNetjsonScript().then(() => {
      if (!active) return;
      renderGraph(elementId, graph);
      window.requestAnimationFrame(() => {
        if (!active) return;
        window.netjson_graphs?.[elementId]?.render?.();
      });
    });
    return () => {
      active = false;
    };
  }, [elementId, graph, visible]);

  useEffect(() => {
    const graphContainer = graphContainerRef.current;
    if (!graphContainer) return;

    const handleWheel = (event: WheelEvent) => {
      if (event.ctrlKey || event.metaKey) return;
      setZoomHintVisible(true);
      if (isPresent(zoomHintTimeoutRef.current)) {
        window.clearTimeout(zoomHintTimeoutRef.current);
      }
      zoomHintTimeoutRef.current = window.setTimeout(() => {
        setZoomHintVisible(false);
      }, 1400);
      event.stopPropagation();
      event.stopImmediatePropagation();
    };

    graphContainer.addEventListener('wheel', handleWheel, { capture: true });
    return () => {
      graphContainer.removeEventListener('wheel', handleWheel, { capture: true });
    };
  }, [graph]);

  useEffect(
    () => () => {
      if (isPresent(zoomHintTimeoutRef.current)) {
        window.clearTimeout(zoomHintTimeoutRef.current);
      }
    },
    [],
  );

  const nodes = graph?.graph.nodes ?? [];

  return (
    <Paper variant="outlined" component="section" aria-labelledby={headingId} sx={{ p: 2 }}>
      <Stack direction="row" alignItems="center" justifyContent="space-between" sx={{ mb: 1.5 }}>
        <Typography id={headingId} variant="subtitle2" component="h2">
          Граф позивних
        </Typography>
        <Button size="small" onClick={onLoad} disabled={loading}>
          {loading ? <CircularProgress size={14} /> : 'Оновити'}
        </Button>
      </Stack>
      {graph ? (
        <Stack direction="row" justifyContent="space-between" alignItems="center" sx={{ mb: 1 }}>
          <Typography variant="caption" color="text.secondary" role="status" aria-live="polite">
            Показано {nodes.length} з {graph.overallCount ?? nodes.length} позивних
          </Typography>
          <FormControlLabel
            control={<Switch checked={nolimit} onChange={onToggleNolimit} />}
            label="показувати всі"
            sx={{ mr: 0 }}
          />
        </Stack>
      ) : null}
      <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 1.5 }}>
        Масштаб: Ctrl/Cmd + колесо миші.
      </Typography>
      {loading && !graph ? (
        <Stack alignItems="center" justifyContent="center" spacing={1} sx={{ minHeight: 220 }}>
          <CircularProgress size={24} />
          <Typography variant="body2" color="text.secondary">
            {`Завантажуємо граф позивних${ELLIPSIS}`}
          </Typography>
        </Stack>
      ) : !graph ? (
        <Stack
          spacing={1}
          alignItems="center"
          justifyContent="center"
          sx={{
            minHeight: 180,
            px: 2,
            textAlign: 'center',
            border: '1px dashed',
            borderColor: 'divider',
          }}
        >
          <Typography variant="body2" color="text.primary">
            Граф завантажується автоматично після відкриття блоку.
          </Typography>
          <Typography variant="caption" color="text.secondary">
            Якщо він не зʼявився, натисніть «Оновити».
          </Typography>
        </Stack>
      ) : (
        <Box sx={{ position: 'relative' }}>
          <Box
            sx={{
              position: 'absolute',
              top: 12,
              right: 12,
              zIndex: 1,
              px: 1.25,
              py: 0.5,
              borderRadius: 1,
              backgroundColor: 'rgba(18, 18, 18, 0.86)',
              border: '1px solid',
              borderColor: 'divider',
              color: 'text.secondary',
              typography: 'caption',
              pointerEvents: 'none',
              opacity: zoomHintVisible ? 1 : 0,
              transition: 'opacity 160ms ease',
            }}
          >
            Утримуйте Ctrl/Cmd для масштабу
          </Box>
          <div
            ref={graphContainerRef}
            id={elementId}
            role="img"
            aria-label="Граф зв'язків позивних"
            style={{ height: 600, position: 'relative', transform: 'translateZ(0)' }}
          />
        </Box>
      )}
    </Paper>
  );
}
