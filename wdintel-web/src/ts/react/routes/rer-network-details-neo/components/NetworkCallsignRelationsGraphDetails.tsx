import CloseOutlinedIcon from '@mui/icons-material/CloseOutlined';
import { Box, Chip, Divider, IconButton, Paper, Stack, Typography } from '@mui/material';

import {
  filterNetworkCallsignRelationEdgeMessages,
  type NetworkCallsignRelationsEdgeView,
  type NetworkCallsignRelationsNodeView,
  type NetworkCallsignRelationEdgeMessageView,
} from '../network-relations';

type Props = {
  selectedNode: NetworkCallsignRelationsNodeView | null;
  selectedEdge: NetworkCallsignRelationsEdgeView | null;
  selectedEdgeVisibleMessages: NetworkCallsignRelationEdgeMessageView[];
  selectedNodeEdges: NetworkCallsignRelationsEdgeView[];
  selectedEdgeId: string | null;
  overlayBorder: string;
  overlayTextSecondary: string;
  onSelectNodeId: (nodeId: string | null) => void;
  onSelectEdgeId: (edgeId: string | null) => void;
};

export function NetworkCallsignRelationsGraphDetails({
  selectedNode,
  selectedEdge,
  selectedEdgeVisibleMessages,
  selectedNodeEdges,
  selectedEdgeId,
  overlayBorder,
  overlayTextSecondary,
  onSelectNodeId,
  onSelectEdgeId,
}: Props) {
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
          bgcolor: 'rgba(12,12,12,0.94)',
          border: `1px solid ${overlayBorder}`,
          boxShadow: '0 12px 28px rgba(0,0,0,0.35)',
          color: 'inherit',
        }}
      >
        <Box
          sx={{
            p: 1.5,
            position: 'relative',
            pr: selectedEdge || selectedNode ? 4.5 : 1.5,
            borderBottom: selectedEdge || selectedNode ? `1px solid ${overlayBorder}` : 'none',
            flexShrink: 0,
          }}
        >
          {selectedEdge ? (
            <Stack spacing={0.5}>
              <Typography variant="subtitle2" sx={{ fontWeight: 700 }}>
                {selectedEdge.source} ↔ {selectedEdge.target}
              </Typography>
              <Typography variant="caption" sx={{ color: overlayTextSecondary }}>
                {selectedEdge.visibleWeight} перехоплень у {selectedEdge.visibleByFreq.length} частотах
              </Typography>
            </Stack>
          ) : selectedNode ? (
            <Stack spacing={0.5}>
              <Typography variant="subtitle2" sx={{ fontWeight: 700 }}>
                {selectedNode.label}
              </Typography>
              <Typography variant="caption" sx={{ color: overlayTextSecondary }}>
                {selectedNode.position ?? 'Позиція не вказана'} · {selectedNode.unitName ?? 'Підрозділ не вказаний'}
              </Typography>
            </Stack>
          ) : (
            <Stack spacing={0.5}>
              <Typography variant="subtitle2" sx={{ fontWeight: 700 }}>
                Виберіть вузол або зв'язок
              </Typography>
              <Typography variant="caption" sx={{ color: overlayTextSecondary }}>
                Підсвітка сусідів і перехоплень з'явиться тут
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
                    <Chip key={item.freq} size="small" label={`${item.freq} · ${item.weight}`} sx={{ bgcolor: 'rgba(255,255,255,0.06)' }} />
                  ))}
                </Stack>
                <Divider sx={{ borderColor: overlayBorder }} />
                <Stack spacing={1}>
                  {selectedEdgeVisibleMessages.map((message) => (
                    <Paper
                      key={message.id}
                      variant="outlined"
                      sx={{
                        p: 1,
                        bgcolor: 'rgba(255,255,255,0.02)',
                        borderColor: overlayBorder,
                      }}
                    >
                      <Stack spacing={0.5}>
                        <Stack direction="row" justifyContent="space-between" spacing={1}>
                          <Typography variant="caption" sx={{ color: overlayTextSecondary }}>
                            #{message.id}
                          </Typography>
                          <Typography variant="caption" sx={{ color: overlayTextSecondary }}>
                            {message.freq ?? 'без частоти'}
                          </Typography>
                        </Stack>
                        <Typography variant="body2" sx={{ whiteSpace: 'pre-wrap', lineHeight: 1.4 }}>
                          {message.text || 'Без тексту'}
                        </Typography>
                        <Typography variant="caption" sx={{ color: overlayTextSecondary }}>
                          {message.callsigns.join(' · ')}
                        </Typography>
                      </Stack>
                    </Paper>
                  ))}
                  {selectedEdgeVisibleMessages.length === 0 ? (
                    <Typography variant="body2" sx={{ color: overlayTextSecondary }}>
                      Немає перехоплень у поточних фільтрах
                    </Typography>
                  ) : null}
                </Stack>
              </Stack>
            ) : selectedNode ? (
              <Stack spacing={1.5}>
                <Stack direction="row" spacing={0.75} useFlexGap sx={{ flexWrap: 'wrap' }}>
                  <Chip size="small" label={`Активність: ${selectedNode.activityCount}`} />
                  <Chip size="small" label={`Зв'язків: ${selectedNode.relationCount}`} />
                  {selectedNode.knownCallsignId ? <Chip size="small" label={`ID: ${selectedNode.knownCallsignId}`} /> : null}
                </Stack>
                <Divider sx={{ borderColor: overlayBorder }} />
                <Stack spacing={0.75}>
                  <Typography variant="caption" sx={{ color: overlayTextSecondary }}>
                    Хто говорив з цим позивним
                  </Typography>
                  {selectedNodeEdges.length === 0 ? (
                    <Typography variant="body2" sx={{ color: overlayTextSecondary }}>
                      Немає зв'язків у поточних фільтрах
                    </Typography>
                  ) : (
                    selectedNodeEdges.map((edge) => {
                      const partner = edge.source === selectedNode.id ? edge.target : edge.source;
                      const topFreq = edge.visibleByFreq[0];
                      const visiblePreview = filterNetworkCallsignRelationEdgeMessages(edge)[0];
                      return (
                        <Paper
                          key={edge.id}
                          variant="outlined"
                          sx={{
                            p: 1,
                            bgcolor: 'rgba(255,255,255,0.02)',
                            borderColor: selectedEdgeId === edge.id ? 'rgba(224, 162, 94, 0.9)' : overlayBorder,
                            cursor: 'pointer',
                          }}
                          onClick={() => onSelectEdgeId(edge.id)}
                        >
                          <Stack spacing={0.5}>
                            <Stack direction="row" justifyContent="space-between" spacing={1}>
                              <Typography variant="body2" sx={{ fontWeight: 700 }}>
                                {partner}
                              </Typography>
                              <Typography variant="caption" sx={{ color: overlayTextSecondary }}>
                                {edge.visibleWeight}
                              </Typography>
                            </Stack>
                            <Stack direction="row" spacing={0.5} useFlexGap sx={{ flexWrap: 'wrap' }}>
                              {edge.visibleByFreq.slice(0, 3).map((item) => (
                                <Chip key={item.freq} size="small" label={`${item.freq} · ${item.weight}`} sx={{ bgcolor: 'rgba(255,255,255,0.06)' }} />
                              ))}
                            </Stack>
                            {topFreq && visiblePreview ? (
                              <Typography variant="caption" sx={{ color: overlayTextSecondary }} noWrap title={visiblePreview.text ?? ''}>
                                {visiblePreview.text || 'Без тексту'}
                              </Typography>
                            ) : null}
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
