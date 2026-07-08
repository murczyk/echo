import RefreshOutlinedIcon from '@mui/icons-material/RefreshOutlined';
import {
  Box,
  CircularProgress,
  FormControlLabel,
  IconButton,
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
  loadError?: string | null;
  nolimit: boolean;
  visible?: boolean;
  onLoad: () => void;
  onToggleNolimit: () => void;
};

type GraphRootKey = 'primary' | 'secondary';

let netjsonScriptLoaded = false;

async function loadNetjsonScript() {
  if (!netjsonScriptLoaded) {
    netjsonScriptLoaded = true;
    await import('../../../../../../static/netjsongraph/netjsongraph.min.js');
  }
}

function renderGraph(graphContainer: HTMLElement, graphDataAndMeta: NetJsonGraphAndMeta) {
  const graphData = { ...graphDataAndMeta.graph, type: graphDataAndMeta.graph.type_ };
  if (!window.netjson_graphs) window.netjson_graphs = {};

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
  graph.render();

  if (graphContainer.childNodes.length === 0) {
    throw new Error('NetJSON graph render produced no content');
  }

  return graph;
}

function getRootStyle(isVisible: boolean) {
  return {
    position: isVisible ? 'relative' : 'absolute',
    inset: isVisible ? 'auto' : 0,
    width: '100%',
    height: '100%',
    visibility: isVisible ? 'visible' : 'hidden',
    pointerEvents: isVisible ? 'auto' : 'none',
  } as const;
}

export function AnalysisCallsignGraphCard({
  graph,
  loading,
  loadVersion,
  loadError = null,
  nolimit,
  visible = true,
  onLoad,
  onToggleNolimit,
}: Props) {
  const headingId = useId().replace(/:/g, '-');
  const graphHostRef = useRef<HTMLDivElement | null>(null);
  const primaryGraphRootRef = useRef<HTMLDivElement | null>(null);
  const secondaryGraphRootRef = useRef<HTMLDivElement | null>(null);
  const autoloadedVersionRef = useRef<number | null>(graph ? loadVersion : null);
  const visibleGraphRootKeyRef = useRef<GraphRootKey>('primary');
  const hasRenderedGraphRef = useRef(false);
  const renderSequenceRef = useRef(0);
  const zoomHintTimeoutRef = useRef<number | null>(null);
  const [renderError, setRenderError] = useState<string | null>(null);
  const [zoomHintVisible, setZoomHintVisible] = useState(false);
  const [visibleGraphRootKey, setVisibleGraphRootKey] = useState<GraphRootKey>('primary');

  useEffect(() => {
    if (!visible || loading || autoloadedVersionRef.current === loadVersion) return;
    autoloadedVersionRef.current = loadVersion;
    onLoad();
  }, [loadVersion, loading, onLoad, visible]);

  useEffect(() => {
    if (!graph || !visible) return;

    const renderSequence = renderSequenceRef.current + 1;
    renderSequenceRef.current = renderSequence;
    let active = true;

    const targetRootKey: GraphRootKey = hasRenderedGraphRef.current
      ? visibleGraphRootKeyRef.current === 'primary'
        ? 'secondary'
        : 'primary'
      : visibleGraphRootKeyRef.current;

    const targetRoot =
      targetRootKey === 'primary' ? primaryGraphRootRef.current : secondaryGraphRootRef.current;

    if (!targetRoot) return;
    targetRoot.replaceChildren();

    void loadNetjsonScript().then(() => {
      if (!active || renderSequence !== renderSequenceRef.current) return;

      try {
        const renderedGraph = renderGraph(targetRoot, graph);
        if (!active || renderSequence !== renderSequenceRef.current) return;

        if (!window.netjson_graphs) window.netjson_graphs = {};
        window.netjson_graphs.callsignGraph = renderedGraph;

        visibleGraphRootKeyRef.current = targetRootKey;
        setVisibleGraphRootKey(targetRootKey);
        hasRenderedGraphRef.current = true;
        setRenderError(null);
      } catch {
        if (!active) return;
        targetRoot.replaceChildren();
        setRenderError('Не вдалося відобразити граф');
      }
    });

    return () => {
      active = false;
    };
  }, [graph, visible]);

  useEffect(() => {
    const graphContainer = graphHostRef.current;
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
  const isRefreshing = loading && graph !== null;
  const graphStatus = renderError ?? loadError;

  return (
    <Paper variant="outlined" component="section" aria-labelledby={headingId} sx={{ p: 2 }}>
      <Stack
        direction="row"
        alignItems="center"
        justifyContent="space-between"
        spacing={1.5}
        sx={{ mb: 1.5 }}
      >
        <Typography id={headingId} variant="subtitle2" component="h2">
          Граф позивних
        </Typography>
        <Stack direction="row" alignItems="center" spacing={1}>
          {isRefreshing ? (
            <Typography variant="caption" color="text.secondary" role="status" aria-live="polite">
              Оновлюється...
            </Typography>
          ) : null}
          <IconButton
            aria-label="Оновити граф"
            onClick={onLoad}
            disabled={loading}
            size="small"
            sx={{ width: 32, height: 32 }}
            title="Оновити граф"
          >
            <RefreshOutlinedIcon fontSize="small" />
          </IconButton>
        </Stack>
      </Stack>
      {graph ? (
        <Stack spacing={0.5} sx={{ mb: 1 }}>
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
      {graphStatus ? (
        <Typography variant="caption" color="error" sx={{ display: 'block', mb: 1 }}>
          {graph ? 'Не вдалося оновити, показано попередній граф.' : graphStatus}
        </Typography>
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
      ) : graphStatus && !graph ? (
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
          <Typography variant="body2" color="error">
            Не вдалося завантажити граф позивних.
          </Typography>
          <Typography variant="caption" color="text.secondary">
            {graphStatus}
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
            ref={graphHostRef}
            id="callsign-graph-div"
            className="analysis-callsign-graph"
            role="img"
            aria-label="Граф зв'язків позивних"
            style={{ height: 600, position: 'relative', transform: 'translateZ(0)' }}
          >
            <div
              ref={primaryGraphRootRef}
              data-root="primary"
              style={getRootStyle(visibleGraphRootKey === 'primary')}
            />
            <div
              ref={secondaryGraphRootRef}
              data-root="secondary"
              style={getRootStyle(visibleGraphRootKey === 'secondary')}
            />
          </div>
        </Box>
      )}
    </Paper>
  );
}
