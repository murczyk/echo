import ErrorOutlineIcon from '@mui/icons-material/ErrorOutline';
import RefreshOutlinedIcon from '@mui/icons-material/RefreshOutlined';
import { Button, CircularProgress, Skeleton } from '@mui/material';
import { useEffect, useId, useRef, useState } from 'react';

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
    <div
      ref={hostRef}
      data-coordinate-preview-root="true"
      className="message-card-coordinate-preview"
    >
      {preview === undefined ? (
        <Skeleton
          variant="rounded"
          height="100%"
          animation="wave"
          sx={{ width: '100%', minWidth: 0, height: '100%' }}
        />
      ) : points.length > 0 ? (
        <>
          <CoordinateAttachmentThumbnail
            points={points}
            messageCardTile
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
        </>
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
    </div>
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
  const errorDescriptionId = useId();
  const errorLabel =
    error.kind === 'document-coordinates'
      ? 'Не вдалося завантажити координати документа'
      : 'Не вдалося завантажити точку мапи';
  if (compact) {
    return (
      <div
        data-coordinate-preview-retry-overlay="true"
        className="message-card-coordinate-retry-overlay"
        title={error.cause instanceof Error ? error.cause.message : error.message}
      >
        <Button
          type="button"
          className="message-card-coordinate-retry-button"
          aria-label="Повторити завантаження координат"
          title={errorLabel}
          disabled={retrying}
          onClick={onRetry}
        >
          {retrying ? <CircularProgress size={14} /> : <RefreshOutlinedIcon fontSize="small" />}
        </Button>
      </div>
    );
  }

  return (
    <div
      data-coordinate-preview-retry-tile="true"
      className="message-card-coordinate-retry-tile"
      title={error.cause instanceof Error ? error.cause.message : error.message}
    >
      <ErrorOutlineIcon className="message-card-coordinate-retry-error-icon" aria-hidden />
      <span id={errorDescriptionId} className="message-card-coordinate-retry-description">
        {`${errorLabel}. ${error.cause instanceof Error ? error.cause.message : error.message}`}
      </span>
      <Button
        type="button"
        className="message-card-coordinate-retry-button"
        aria-label="Повторити завантаження координат"
        aria-describedby={errorDescriptionId}
        title={errorLabel}
        disabled={retrying}
        onClick={onRetry}
      >
        {retrying ? <CircularProgress size={14} /> : <RefreshOutlinedIcon fontSize="small" />}
      </Button>
    </div>
  );
}
