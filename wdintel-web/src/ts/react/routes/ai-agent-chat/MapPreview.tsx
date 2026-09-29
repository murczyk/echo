import MapOutlinedIcon from '@mui/icons-material/MapOutlined';
import { lazy, Suspense, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { AiAgentMapSummary } from '../../../../Bindings';
import { MapSelectionContext, useMapDocument } from './map-documents';
import './maps.css';

const CoordinatePreviewMapSurface = lazy(() =>
  import('../shared/message-card/CoordinatePreviewMapSurface').then((module) => ({
    default: module.CoordinatePreviewMapSurface,
  })),
);

export function MapPreview({
  summary,
  inline = false,
}: {
  summary: AiAgentMapSummary;
  inline?: boolean;
}) {
  const select = useContext(MapSelectionContext);
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const [visible, setVisible] = useState(false);
  const { document } = useMapDocument(summary, visible);
  useEffect(() => {
    if (!buttonRef.current || typeof IntersectionObserver === 'undefined') {
      setVisible(true);
      return;
    }
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        setVisible(true);
        observer.disconnect();
      }
    });
    observer.observe(buttonRef.current);
    return () => observer.disconnect();
  }, []);
  const points = useMemo(
    () =>
      document?.records.flatMap((record) =>
        record.latitude != null && record.longitude != null
          ? [
              {
                lat: record.latitude,
                lng: record.longitude,
                label: record.name,
                source: 'document' as const,
              },
            ]
          : [],
      ) ?? [],
    [document],
  );
  return (
    <button
      ref={buttonRef}
      type="button"
      className={inline ? 'ai-map-chip' : 'ai-map-preview'}
      aria-label={`Відкрити мапу: ${summary.title}`}
      title={`${summary.title}: ${summary.validCount} з ${summary.totalCount} точок`}
      onClick={(event) => select?.(summary, event.currentTarget)}
    >
      <span className={inline ? 'ai-map-chip-image' : 'ai-map-preview-image'} aria-hidden="true">
        {points.length ? (
          <Suspense fallback={<MapOutlinedIcon fontSize="small" />}>
            <CoordinatePreviewMapSurface
              points={points}
              mode="thumbnail"
              className={inline ? 'ai-map-chip-surface' : 'ai-map-preview-surface'}
            />
          </Suspense>
        ) : (
          <MapOutlinedIcon fontSize="small" />
        )}
      </span>
      <span>
        {inline ? 'мапа' : `${summary.title} · ${summary.validCount}/${summary.totalCount} точок`}
      </span>
    </button>
  );
}
