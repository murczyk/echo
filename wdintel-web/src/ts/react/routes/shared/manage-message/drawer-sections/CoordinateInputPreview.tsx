import MapOutlinedIcon from '@mui/icons-material/MapOutlined';
import { IconButton, Tooltip } from '@mui/material';
import { useEffect, useMemo, useState } from 'react';

import { getCoordinateText } from '../../../../../maps/coordinate-format';
import { parseCoordinateBlock } from '../../../../../maps/coordinate-parser';
import { mapCoordinates, type MappedCoordinate } from '../../../../services/api/location';
import { MessageCardAttachmentPreviewProvider } from '../../message-card/attachment-preview/MessageCardAttachmentPreviewProvider';
import type { CoordinatePreviewPoint } from '../../message-card/message-coordinate-preview';

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
    <>
      <Tooltip title={canPreview ? 'Превʼю координат' : 'Додайте координату для превʼю'}>
        <span>
          <IconButton
            size="small"
            color={canPreview ? 'primary' : 'default'}
            aria-label="Превʼю координат"
            onClick={() => setOpen(true)}
            disabled={!canPreview}
          >
            <MapOutlinedIcon fontSize="small" />
          </IconButton>
        </span>
      </Tooltip>

      {open && previewPoints.length > 0 ? (
        <MessageCardAttachmentPreviewProvider
          attachments={[{ type: 'coordinate', points: previewPoints }]}
          initialIndex={0}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </>
  );
}
