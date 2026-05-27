import CloseOutlinedIcon from '@mui/icons-material/CloseOutlined';
import { Box, Chip, Divider, IconButton, Paper, Stack, Typography } from '@mui/material';
import { useTheme } from '@mui/material/styles';

import type {
  NetworkCallsignRelationsEdgeView,
  NetworkCallsignRelationsNodeView,
} from '../network-relations';
import { getNetworkRelationsGraphTheme } from './network-relations-graph-theme';

type Props = {
  selectedNode: NetworkCallsignRelationsNodeView | null;
  selectedEdge: NetworkCallsignRelationsEdgeView | null;
  selectedNodeEdges: NetworkCallsignRelationsEdgeView[];
  selectedEdgeId: string | null;
  onSelectNodeId: (nodeId: string | null) => void;
  onSelectEdgeId: (edgeId: string | null) => void;
};

export function NetworkCallsignRelationsGraphDetails({
  selectedNode,
  selectedEdge,
  selectedNodeEdges,
  selectedEdgeId,
  onSelectNodeId,
  onSelectEdgeId,
}: Props) {
  const theme = useTheme();
  const graphTheme = getNetworkRelationsGraphTheme(theme);

  return (
    <Box
      sx={{
        position: 'absolute',
        right: 16,
        bottom: 16,
        zIndex: 3,
        width: { xs: 'calc(100% - 32px)', md: 360 },
        maxHeight: 'calc(100% - 32px)',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'stretch',
        overflow: 'hidden',
      }}
    >
      <Box
        sx={{
          width: '100%',
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
          borderRadius: 2,
          bgcolor: graphTheme.overlayBg,
          border: `1px solid ${graphTheme.overlayBorder}`,
          boxShadow: graphTheme.overlayShadow,
          color: graphTheme.overlayText,
        }}
      >
        <Box
          sx={{
            p: 1.5,
            position: 'relative',
            pr: selectedEdge || selectedNode ? 4.5 : 1.5,
            borderBottom: selectedEdge || selectedNode ? `1px solid ${graphTheme.overlayBorder}` : 'none',
            flexShrink: 0,
          }}
        >
          {selectedEdge ? (
            <Stack spacing={0.5}>
              <Typography variant="subtitle2" sx={{ fontWeight: 700 }}>
                {selectedEdge.source} ↔ {selectedEdge.target}
              </Typography>
              <Typography variant="caption" sx={{ color: graphTheme.overlayTextSecondary }}>
                {selectedEdge.visibleWeight} перехоплень у {selectedEdge.visibleByFreq.length} частотах
              </Typography>
            </Stack>
          ) : selectedNode ? (
            <Stack spacing={0.5}>
              <Typography variant="subtitle2" sx={{ fontWeight: 700 }}>
                {selectedNode.label}
              </Typography>
              <Typography variant="caption" sx={{ color: graphTheme.overlayTextSecondary }}>
                {selectedNode.position ?? 'Позиція не вказана'} · {selectedNode.unitName ?? 'Підрозділ не вказаний'}
              </Typography>
            </Stack>
          ) : (
            <Stack spacing={0.5}>
              <Typography variant="subtitle2" sx={{ fontWeight: 700 }}>
                Виберіть вузол або зв'язок
              </Typography>
              <Typography variant="caption" sx={{ color: graphTheme.overlayTextSecondary }}>
                Підсвітка сусідів з'явиться тут
              </Typography>
            </Stack>
          )}
          {selectedEdge ? (
            <IconButton
              size="small"
              onClick={() => onSelectEdgeId(null)}
              aria-label="Закрити деталі зв'язку"
              sx={{
                position: 'absolute',
                top: 8,
                right: 8,
              }}
            >
              <CloseOutlinedIcon fontSize="small" />
            </IconButton>
          ) : selectedNode ? (
            <IconButton
              size="small"
              onClick={() => onSelectNodeId(null)}
              aria-label="Закрити деталі вузла"
              sx={{
                position: 'absolute',
                top: 8,
                right: 8,
              }}
            >
              <CloseOutlinedIcon fontSize="small" />
            </IconButton>
          ) : null}
        </Box>

        {(selectedEdge || selectedNode) ? (
          <Box sx={{ p: 1.5, overflow: 'auto', minHeight: 0, flex: 1 }}>
            {selectedEdge ? (
              <Stack spacing={1.5}>
                <Stack direction="row" spacing={0.75} useFlexGap sx={{ flexWrap: 'wrap' }}>
                  {selectedEdge.visibleByFreq.map((item) => (
                    <Chip key={item.freq} size="small" label={`${item.freq} · ${item.weight}`} sx={{ bgcolor: graphTheme.surfaceBg }} />
                  ))}
                </Stack>
                <Divider sx={{ borderColor: graphTheme.overlayBorder }} />
                <Typography variant="body2" sx={{ color: graphTheme.overlayTextSecondary }}>
                  Зв'язок побудовано за перехопленнями та частотами.
                </Typography>
              </Stack>
            ) : selectedNode ? (
              <Stack spacing={1.5}>
                <Stack direction="row" spacing={0.75} useFlexGap sx={{ flexWrap: 'wrap' }}>
                  <Chip size="small" label={`Активність: ${selectedNode.activityCount}`} />
                  <Chip size="small" label={`Зв'язків: ${selectedNode.relationCount}`} />
                  {selectedNode.knownCallsignId ? <Chip size="small" label={`ID: ${selectedNode.knownCallsignId}`} /> : null}
                </Stack>
                <Divider sx={{ borderColor: graphTheme.overlayBorder }} />
                <Stack spacing={0.75}>
                  <Typography variant="caption" sx={{ color: graphTheme.overlayTextSecondary }}>
                    Хто говорив з цим позивним
                  </Typography>
                  {selectedNodeEdges.length === 0 ? (
                    <Typography variant="body2" sx={{ color: graphTheme.overlayTextSecondary }}>
                      Немає зв'язків у поточних фільтрах
                    </Typography>
                  ) : (
                    selectedNodeEdges.map((edge) => {
                      const partner = edge.source === selectedNode.id ? edge.target : edge.source;
                      return (
                        <Paper
                          key={edge.id}
                          variant="outlined"
                          sx={{
                            p: 1,
                            bgcolor: graphTheme.surfaceBg,
                            borderColor: selectedEdgeId === edge.id ? theme.palette.primary.main : graphTheme.surfaceBorder,
                            cursor: 'pointer',
                          }}
                          onClick={() => onSelectEdgeId(edge.id)}
                        >
                          <Stack spacing={0.5}>
                            <Stack direction="row" justifyContent="space-between" spacing={1}>
                              <Typography variant="body2" sx={{ fontWeight: 700 }}>
                                {partner}
                              </Typography>
                              <Typography variant="caption" sx={{ color: graphTheme.overlayTextSecondary }}>
                                {edge.visibleWeight}
                              </Typography>
                            </Stack>
                            <Stack direction="row" spacing={0.5} useFlexGap sx={{ flexWrap: 'wrap' }}>
                              {edge.visibleByFreq.slice(0, 3).map((item) => (
                                <Chip key={item.freq} size="small" label={`${item.freq} · ${item.weight}`} sx={{ bgcolor: graphTheme.surfaceBg }} />
                              ))}
                            </Stack>
                          </Stack>
                        </Paper>
                      );
                    })
                  )}
                </Stack>
              </Stack>
            ) : null}
          </Box>
        ) : null}
      </Box>
    </Box>
  );
}
