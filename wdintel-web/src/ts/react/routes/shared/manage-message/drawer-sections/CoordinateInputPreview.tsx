import MapOutlinedIcon from '@mui/icons-material/MapOutlined';
import { Box, Tooltip, Typography } from '@mui/material';
import { useEffect, useMemo, useState } from 'react';

import { getCoordinateText } from '../../../../../maps/coordinate-format';
import { parseCoordinateBlock } from '../../../../../maps/coordinate-parser';
import { mapCoordinates, type MappedCoordinate } from '../../../../services/api/location';
import { CoordinateAttachmentThumbnail } from '../../message-card/CoordinateAttachmentThumbnail';
import { MessageCardAttachmentPreviewProvider } from '../../message-card/attachment-preview/MessageCardAttachmentPreviewProvider';
import type { CoordinatePreviewPoint } from '../../message-card/message-coordinate-preview';
import { COORDINATE_PANEL_MAX_HEIGHT_PX } from './coordinate-input.constants';

const LOOKUP_DEBOUNCE_MS = 300;

type Props = {
  value: string;
  busy: boolean;
  onError: (message: string) => void;
};

export function CoordinateInputPreview({ value, busy, onError }: Props) {
  const points = useMemo(() => parseCoordinateBlock(value), [value]);
  const [open, setOpen] = useState(false);
  const [mapped, setMapped] = useState<MappedCoordinate[]>([]);

  useEffect(() => {
    if (!value.trim() || points.length === 0) setOpen(false);
  }, [points.length, value]);

  useEffect(() => {
    if (!open || points.length === 0 || busy) {
      setMapped([]);
      return;
    }

    const controller = new AbortController();
    const timeout = window.setTimeout(() => {
      void mapCoordinates(
        points.map(({ lat, lng }) => ({ lat, lon: lng })),
        { signal: controller.signal },
      )
        .then(setMapped)
        .catch((error: unknown) => {
          if (controller.signal.aborted) return;
          setMapped([]);
          onError(
            error instanceof Error
              ? `Не вдалося визначити локацію: ${error.message}`
              : 'Не вдалося визначити локацію',
          );
        });
    }, LOOKUP_DEBOUNCE_MS);

    return () => {
      window.clearTimeout(timeout);
      controller.abort();
    };
  }, [busy, onError, open, points]);

  const previewPoints = useMemo<CoordinatePreviewPoint[]>(
    () =>
      points.map((point, index) => ({
        source: 'direct',
        lat: point.lat,
        lng: point.lng,
        label: point.source || getCoordinateText('wgs', point),
        locality: mapped[index]?.locality ?? null,
      })),
    [points, mapped],
  );

  const canPreview = !busy && points.length > 0;

  return (
    <Box
      sx={{
        flex: 1,
        minWidth: 0,
        width: '100%',
        aspectRatio: '1 / 1',
        maxHeight: COORDINATE_PANEL_MAX_HEIGHT_PX,
        overflow: 'hidden',
        alignSelf: 'flex-start',
      }}
    >
      {canPreview ? (
        <CoordinateAttachmentThumbnail
          points={previewPoints}
          onOpen={() => setOpen(true)}
          fullWidth
        />
      ) : (
        <Tooltip title="Додайте координату для превʼю">
          <Box
            sx={{
              width: '100%',
              height: '100%',
              aspectRatio: '1 / 1',
              borderRadius: 2,
              border: '1px dashed',
              borderColor: 'divider',
              bgcolor: 'action.hover',
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 0.5,
              color: 'text.disabled',
              userSelect: 'none',
              boxSizing: 'border-box',
            }}
          >
            <MapOutlinedIcon sx={{ fontSize: 24, opacity: 0.6 }} />
            <Typography variant="caption" color="text.secondary" sx={{ fontSize: 11 }}>
              Превʼю координат
            </Typography>
          </Box>
        </Tooltip>
      )}

      {open && previewPoints.length > 0 ? (
        <MessageCardAttachmentPreviewProvider
          attachments={[{ type: 'coordinate', points: previewPoints }]}
          initialIndex={0}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </Box>
  );
}
