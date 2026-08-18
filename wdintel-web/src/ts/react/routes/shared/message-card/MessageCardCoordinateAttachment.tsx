import { Box, Button, CircularProgress, Skeleton, Typography } from '@mui/material';
import { useEffect, useRef, useState } from 'react';

import type { InboxMessage, Tag } from '../../../../../Bindings';
import { useOptionalPowerSnackbar } from '../../../components/PowerSnackbar';
import {
  CoordinatePreviewLookupError,
  resolveMessageCoordinatePreview,
  type CoordinatePreviewPoint,
  type CoordinatePreviewResult,
} from './message-coordinate-preview';
import {
  MessageCardAttachmentPreviewProvider,
  type MessageCardPreviewAttachment,
} from './attachment-preview/MessageCardAttachmentPreviewProvider';
import { CoordinateAttachmentThumbnail } from './CoordinateAttachmentThumbnail';

type Props = {
  msg: InboxMessage;
  tagsMap?: Record<number, Tag>;
  onPointsChange?: (points: CoordinatePreviewPoint[]) => void;
  onOpen?: (index: number) => void;
};

const PREVIEW_HEIGHT_PX = 120;
const PREVIEW_WIDTH_PX = 180;
const PREVIEW_ROOT_MARGIN = '160px 0px';
const EMPTY_TAGS_MAP: Record<number, Tag> = {};
const EMPTY_POINTS: CoordinatePreviewPoint[] = [];

export function MessageCardCoordinateAttachment({ msg, tagsMap, onPointsChange, onOpen }: Props) {
  const previewTagsMap = tagsMap ?? EMPTY_TAGS_MAP;
  const hostRef = useRef<HTMLDivElement | null>(null);
  const resolveRequestIdRef = useRef(0);
  const pendingPreviewLoadRef = useRef(false);
  const [isNearViewport, setIsNearViewport] = useState(false);
  const [preview, setPreview] = useState<CoordinatePreviewResult | null | undefined>(undefined);
  const [retrying, setRetrying] = useState(false);
  const [dialogIndex, setDialogIndex] = useState<number | null>(null);
  const { notify } = useOptionalPowerSnackbar();
  const notifyRef = useRef(notify);
  notifyRef.current = notify;

  useEffect(() => {
    setPreview(undefined);
    setDialogIndex(null);
    setRetrying(false);
    pendingPreviewLoadRef.current = false;
    resolveRequestIdRef.current += 1;
  }, [msg, previewTagsMap]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host || typeof IntersectionObserver === 'undefined') {
      setIsNearViewport(true);
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setIsNearViewport(true);
        }
      },
      { rootMargin: PREVIEW_ROOT_MARGIN, threshold: 0.01 },
    );
    observer.observe(host);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!isNearViewport || pendingPreviewLoadRef.current || (preview !== undefined && !retrying)) {
      return;
    }

    const requestId = resolveRequestIdRef.current + 1;
    resolveRequestIdRef.current = requestId;
    pendingPreviewLoadRef.current = true;

    void resolveMessageCoordinatePreview({ message: msg, tagsMap: previewTagsMap })
      .then((result) => {
        if (resolveRequestIdRef.current !== requestId) {
          return;
        }

        pendingPreviewLoadRef.current = false;
        setPreview(result);
        setRetrying(false);
        if (result?.lookupError?.kind === 'document-coordinates') {
          notifyRef.current({
            severity: 'error',
            message: 'Не вдалося завантажити координати документа.',
          });
        }
      })
      .catch((error: unknown) => {
        if (resolveRequestIdRef.current !== requestId) {
          return;
        }

        pendingPreviewLoadRef.current = false;
        const lookupError =
          error instanceof CoordinatePreviewLookupError
            ? error
            : new CoordinatePreviewLookupError('point-search', error);
        setPreview((current) => ({
          points: current?.points ?? [],
          etalons: current?.etalons ?? [],
          lookupError,
        }));
        setRetrying(false);
      });
  }, [isNearViewport, msg, preview, previewTagsMap, retrying]);

  const points = preview?.points ?? EMPTY_POINTS;
  const previewAttachments: MessageCardPreviewAttachment[] =
    points.length > 0 ? [{ type: 'coordinate', points }] : [];
  const lookupError = preview?.lookupError ?? null;
  const isDialogOpen = dialogIndex != null && points.length > 0;

  useEffect(() => {
    onPointsChange?.(points);
  }, [onPointsChange, points]);

  useEffect(
    () => () => {
      onPointsChange?.(EMPTY_POINTS);
    },
    [onPointsChange],
  );

  if (preview === null && lookupError == null) {
    return null;
  }

  const handleRetry = () => {
    pendingPreviewLoadRef.current = false;
    resolveRequestIdRef.current += 1;
    setRetrying(true);
  };

  return (
    <Box
      ref={hostRef}
      data-coordinate-preview-root="true"
      style={{ width: `${PREVIEW_WIDTH_PX}px` }}
      sx={{
        width: PREVIEW_WIDTH_PX,
        minWidth: PREVIEW_WIDTH_PX,
        maxWidth: PREVIEW_WIDTH_PX,
        minHeight: PREVIEW_HEIGHT_PX,
        alignSelf: 'flex-start',
      }}
    >
      {preview === undefined ? (
        <Skeleton
          variant="rounded"
          height={PREVIEW_HEIGHT_PX}
          animation="wave"
          sx={{ width: PREVIEW_WIDTH_PX, minWidth: PREVIEW_WIDTH_PX }}
        />
      ) : points.length > 0 ? (
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1, minWidth: 0 }}>
          <CoordinateAttachmentThumbnail
            points={points}
            onOpen={() => {
              if (onOpen != null) {
                onOpen(0);
                return;
              }
              setDialogIndex(0);
            }}
          />
          {lookupError != null ? (
            <RetryTile compact error={lookupError} retrying={retrying} onRetry={handleRetry} />
          ) : null}
        </Box>
      ) : lookupError != null ? (
        <RetryTile error={lookupError} retrying={retrying} onRetry={handleRetry} />
      ) : null}

      {onOpen == null && isDialogOpen ? (
        <MessageCardAttachmentPreviewProvider
          attachments={previewAttachments}
          initialIndex={0}
          onClose={() => setDialogIndex(null)}
        />
      ) : null}
    </Box>
  );
}

function RetryTile({
  error,
  onRetry,
  compact = false,
  retrying,
}: {
  error: CoordinatePreviewLookupError;
  onRetry: () => void;
  compact?: boolean;
  retrying: boolean;
}) {
  const errorLabel =
    error.kind === 'document-coordinates'
      ? 'Не вдалося завантажити координати документа'
      : 'Не вдалося завантажити точку мапи';
  if (compact) {
    return (
      <Box
        sx={{
          display: 'flex',
          flexDirection: 'column',
          gap: 0.5,
          p: 1.25,
          borderRadius: 2,
          border: '1px solid',
          borderColor: 'divider',
          bgcolor: 'background.paper',
        }}
        title={error.cause instanceof Error ? error.cause.message : error.message}
      >
        <Typography variant="caption" sx={{ fontWeight: 700 }}>
          {errorLabel}
        </Typography>
        <Button
          type="button"
          variant="text"
          aria-label="Повторити"
          disabled={retrying}
          onClick={onRetry}
          sx={{ p: 0 }}
        >
          {retrying ? <CircularProgress size={14} /> : 'Повторити'}
        </Button>
      </Box>
    );
  }

  return (
    <Box
      sx={{
        width: '100%',
        minWidth: 0,
        height: PREVIEW_HEIGHT_PX,
        borderRadius: 2,
        border: '1px solid',
        borderColor: 'divider',
        bgcolor: 'background.paper',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 1,
        px: 2,
        textAlign: 'center',
        overflow: 'hidden',
      }}
      title={error.cause instanceof Error ? error.cause.message : error.message}
    >
      <Typography variant="body2" sx={{ color: 'text.primary', fontWeight: 600 }}>
        {errorLabel}
      </Typography>
      <Button
        type="button"
        variant="text"
        aria-label="Повторити"
        disabled={retrying}
        onClick={onRetry}
        sx={{ flexShrink: 0 }}
      >
        {retrying ? <CircularProgress size={14} /> : 'Повторити'}
      </Button>
    </Box>
  );
}
