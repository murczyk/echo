import CloseOutlinedIcon from '@mui/icons-material/CloseOutlined';
import ArrowBackOutlinedIcon from '@mui/icons-material/ArrowBackOutlined';
import {
  Box,
  Button,
  Chip,
  CircularProgress,
  Divider,
  IconButton,
  Paper,
  Stack,
  Typography,
} from '@mui/material';
import { alpha, useTheme } from '@mui/material/styles';
import dayjs from 'dayjs';

import type { NetworkCallsignRelationMessage } from '../../../../../Bindings';
import { PowerAlert } from '../../../components/PowerAlert';
import { APP_TIME_ZONE } from '../../../utils/misc';
import type {
  NetworkCallsignRelationsEdgeView,
  NetworkCallsignRelationsNodeView,
} from '../network-relations';
import { isCatalogRelationNode } from '../network-relations';
import { getNetworkRelationsGraphTheme } from './network-relations-graph-theme';

type Props = {
  selectedNode: NetworkCallsignRelationsNodeView | null;
  selectedEdge: NetworkCallsignRelationsEdgeView | null;
  drilldownNode: NetworkCallsignRelationsNodeView | null;
  selectedNodeEdges: NetworkCallsignRelationsEdgeView[];
  selectedMessages: NetworkCallsignRelationMessage[];
  selectedMessagesLoading: boolean;
  selectedMessagesError: string | null;
  showMessages?: boolean;
  selectedEdgeId: string | null;
  onBackToNode: () => void;
  onSelectNodeId: (nodeId: string | null) => void;
  onSelectEdgeId: (edgeId: string | null) => void;
  onOpenNodeEdgeId: (edgeId: string) => void;
};

export function NetworkCallsignRelationsGraphDetails({
  selectedNode,
  selectedEdge,
  drilldownNode,
  selectedNodeEdges,
  selectedMessages,
  selectedMessagesLoading,
  selectedMessagesError,
  showMessages = true,
  selectedEdgeId,
  onBackToNode,
  onSelectNodeId,
  onSelectEdgeId,
  onOpenNodeEdgeId,
}: Props) {
  const theme = useTheme();
  const graphTheme = getNetworkRelationsGraphTheme(theme);
  const panelBorder = alpha(
    theme.palette.text.primary,
    theme.palette.mode === 'dark' ? 0.14 : 0.12,
  );

  return (
    <Box
      sx={{
        position: 'absolute',
        right: 16,
        bottom: 16,
        zIndex: 3,
        width: selectedEdge || selectedNode ? { xs: 'calc(100% - 32px)', md: 360 } : 'fit-content',
        maxWidth: 'calc(100% - 32px)',
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
          borderRadius: 1,
          bgcolor: alpha(
            theme.palette.background.paper,
            theme.palette.mode === 'dark' ? 0.82 : 0.92,
          ),
          border: `1px solid ${panelBorder}`,
          boxShadow:
            theme.palette.mode === 'dark'
              ? '0 4px 12px rgba(0,0,0,0.18)'
              : '0 4px 12px rgba(0,0,0,0.06)',
          color: graphTheme.overlayText,
        }}
      >
        <Box
          sx={{
            p: 1.5,
            position: 'relative',
            pr: selectedEdge || selectedNode ? 4.5 : 1.5,
            borderBottom: selectedEdge || selectedNode ? `1px solid ${panelBorder}` : 'none',
            flexShrink: 0,
          }}
        >
          {selectedEdge ? (
            <Stack spacing={0.5}>
              <Typography variant="subtitle2" sx={{ fontWeight: 700 }}>
                {selectedEdge.source} ↔ {selectedEdge.target}
              </Typography>
              {drilldownNode ? (
                <Button
                  size="small"
                  variant="text"
                  startIcon={<ArrowBackOutlinedIcon fontSize="small" />}
                  onClick={onBackToNode}
                  sx={{
                    alignSelf: 'flex-start',
                    minWidth: 0,
                    px: 0,
                    py: 0.25,
                    textTransform: 'none',
                  }}
                >
                  До списку {drilldownNode.label}
                </Button>
              ) : null}
              <Typography variant="caption" sx={{ color: graphTheme.overlayTextSecondary }}>
                {selectedEdge.visibleWeight} перехоплень у {selectedEdge.visibleByFreq.length}{' '}
                частотах
              </Typography>
            </Stack>
          ) : selectedNode ? (
            <Stack spacing={0.5}>
              <Typography variant="subtitle2" sx={{ fontWeight: 700 }}>
                {selectedNode.label}
              </Typography>
              <Typography variant="caption" sx={{ color: graphTheme.overlayTextSecondary }}>
                {selectedNode.position ?? 'Позиція не вказана'} ·{' '}
                {selectedNode.unitName ?? 'Підрозділ не вказаний'}
              </Typography>
            </Stack>
          ) : (
            <Typography variant="subtitle2" sx={{ fontWeight: 700, whiteSpace: 'nowrap' }}>
              Виберіть вузол або зв'язок
            </Typography>
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

        {selectedEdge || selectedNode ? (
          <Box sx={{ p: 1.5, overflow: 'auto', minHeight: 0, flex: 1 }}>
            {selectedEdge ? (
              <Stack spacing={1.5}>
                <Stack direction="row" spacing={0.75} useFlexGap sx={{ flexWrap: 'wrap' }}>
                  {selectedEdge.visibleByFreq.map((item) => (
                    <Chip
                      key={item.freq}
                      size="small"
                      label={`${item.freq} · ${item.weight}`}
                      sx={{ bgcolor: graphTheme.surfaceBg }}
                    />
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
                  {selectedNode.knownCallsignId ? (
                    <Chip size="small" label={`ID: ${selectedNode.knownCallsignId}`} />
                  ) : null}
                  {isCatalogRelationNode(selectedNode) ? (
                    <Chip size="small" color="warning" label="Каталог · не підтверджено" />
                  ) : null}
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
                            borderColor:
                              selectedEdgeId === edge.id
                                ? theme.palette.primary.main
                                : graphTheme.surfaceBorder,
                            cursor: 'pointer',
                          }}
                          onClick={() => onOpenNodeEdgeId(edge.id)}
                        >
                          <Stack spacing={0.5}>
                            <Stack direction="row" justifyContent="space-between" spacing={1}>
                              <Typography variant="body2" sx={{ fontWeight: 700 }}>
                                {partner}
                              </Typography>
                              <Typography
                                variant="caption"
                                sx={{ color: graphTheme.overlayTextSecondary }}
                              >
                                {edge.visibleWeight}
                              </Typography>
                            </Stack>
                            <Stack
                              direction="row"
                              spacing={0.5}
                              useFlexGap
                              sx={{ flexWrap: 'wrap' }}
                            >
                              {edge.visibleByFreq.slice(0, 3).map((item) => (
                                <Chip
                                  key={item.freq}
                                  size="small"
                                  label={`${item.freq} · ${item.weight}`}
                                  sx={{ bgcolor: graphTheme.surfaceBg }}
                                />
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

            {showMessages && (selectedEdge || selectedNode) ? (
              <Stack spacing={1.5} sx={{ mt: 1.5 }}>
                <Divider sx={{ borderColor: graphTheme.overlayBorder }} />
                <Stack spacing={0.75}>
                  <Typography variant="caption" sx={{ color: graphTheme.overlayTextSecondary }}>
                    Повідомлення
                  </Typography>
                  {selectedMessagesError ? (
                    <PowerAlert severity="error" autoHideDuration={null} sx={{ width: '100%' }}>
                      {selectedMessagesError}
                    </PowerAlert>
                  ) : selectedMessagesLoading ? (
                    <Stack direction="row" spacing={1.25} alignItems="center" sx={{ py: 1 }}>
                      <CircularProgress size={18} />
                      <Typography variant="body2" sx={{ color: graphTheme.overlayTextSecondary }}>
                        Завантажуємо повідомлення...
                      </Typography>
                    </Stack>
                  ) : selectedMessages.length === 0 ? (
                    <Typography variant="body2" sx={{ color: graphTheme.overlayTextSecondary }}>
                      Немає повідомлень для цієї вибірки
                    </Typography>
                  ) : (
                    <Stack spacing={1}>
                      {selectedMessages.map((message) => (
                        <Paper
                          key={message.id}
                          variant="outlined"
                          sx={{
                            p: 1,
                            bgcolor: graphTheme.surfaceBg,
                            borderColor: graphTheme.surfaceBorder,
                          }}
                        >
                          <Stack spacing={0.75}>
                            <Stack
                              direction="row"
                              justifyContent="space-between"
                              spacing={1}
                              useFlexGap
                              sx={{ flexWrap: 'wrap' }}
                            >
                              <Typography variant="body2" sx={{ fontWeight: 700 }}>
                                {message.timestamp
                                  ? dayjs(message.timestamp)
                                      .tz(APP_TIME_ZONE)
                                      .format('DD.MM.YYYY HH:mm')
                                  : 'Час невідомий'}
                              </Typography>
                              {message.freq ? (
                                <Chip
                                  size="small"
                                  label={message.freq}
                                  sx={{ bgcolor: graphTheme.surfaceBg }}
                                />
                              ) : null}
                            </Stack>
                            <Typography variant="body2" sx={{ whiteSpace: 'pre-wrap' }}>
                              {message.text}
                            </Typography>
                            {message.callsigns.length > 0 ? (
                              <Stack
                                direction="row"
                                spacing={0.5}
                                useFlexGap
                                sx={{ flexWrap: 'wrap' }}
                              >
                                {message.callsigns.map((callsign) => (
                                  <Chip
                                    key={`${message.id}-${callsign}`}
                                    size="small"
                                    label={callsign}
                                    sx={{ bgcolor: graphTheme.surfaceBg }}
                                  />
                                ))}
                              </Stack>
                            ) : null}
                          </Stack>
                        </Paper>
                      ))}
                    </Stack>
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
