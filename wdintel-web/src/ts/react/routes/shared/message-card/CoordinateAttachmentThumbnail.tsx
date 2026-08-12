import 'leaflet/dist/leaflet.css';

import { Box, ButtonBase, Skeleton, Tooltip, Typography } from '@mui/material';
import * as L from 'leaflet';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';

import { getTileLayers } from '../../../../web-components/analysis-map/tile-layers';
import {
  formatCoordinatePreviewPointCount,
  type CoordinatePreviewPoint,
} from './message-coordinate-preview';

const PREVIEW_HEIGHT_PX = 120;
const PREVIEW_MAX_WIDTH_PX = 180;
const PREVIEW_ROOT_MARGIN = '160px 0px';
const PREVIEW_ZOOM = 11;
const PREVIEW_MAX_ZOOM = 13;
const PREVIEW_BOUNDS_PADDING: [number, number] = [20, 20];

function fitMap(map: L.Map, points: CoordinatePreviewPoint[]): void {
  const latLngs = points.map(({ lat, lng }): [number, number] => [lat, lng]);
  if (latLngs.length === 1) {
    map.setView(latLngs[0], PREVIEW_ZOOM, { animate: false });
  } else if (latLngs.length > 1) {
    map.fitBounds(L.latLngBounds(latLngs), {
      animate: false,
      maxZoom: PREVIEW_MAX_ZOOM,
      padding: PREVIEW_BOUNDS_PADDING,
    });
  }
}

function createMarkers(map: L.Map, points: CoordinatePreviewPoint[]): L.CircleMarker[] {
  return points.map(({ lat, lng }) =>
    L.circleMarker([lat, lng], {
      radius: 8,
      color: '#ffffff',
      weight: 3,
      fillColor: '#ff4d2d',
      fillOpacity: 1,
    }).addTo(map),
  );
}

export function CoordinateAttachmentThumbnail({
  points,
  onOpen,
  fullWidth = false,
}: {
  points: CoordinatePreviewPoint[];
  onOpen: () => void;
  fullWidth?: boolean;
}) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const mapContainerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<L.Map | null>(null);
  const markerRefs = useRef<L.CircleMarker[]>([]);
  const pointsRef = useRef(points);
  const [isNearViewport, setIsNearViewport] = useState(false);

  pointsRef.current = points;

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

  useLayoutEffect(() => {
    const container = mapContainerRef.current;
    if (!isNearViewport || !container || mapRef.current) {
      return;
    }

    let cancelled = false;
    let frameId = 0;
    let resizeObserver: ResizeObserver | null = null;

    const initMap = () => {
      if (cancelled || mapRef.current || mapContainerRef.current !== container) {
        return;
      }

      const rect = container.getBoundingClientRect();
      if (rect.width < 48 || rect.height < 48) {
        frameId = window.requestAnimationFrame(initMap);
        return;
      }

      const map = L.map(container, {
        zoomControl: false,
        attributionControl: false,
        dragging: false,
        scrollWheelZoom: false,
        doubleClickZoom: false,
        touchZoom: false,
        boxZoom: false,
        keyboard: false,
        preferCanvas: true,
        minZoom: 2,
        maxZoom: 17,
      });

      const tileLayers = getTileLayers();
      tileLayers.googleHybrid.addTo(map);

      map.getContainer().style.pointerEvents = 'none';
      mapRef.current = map;
      markerRefs.current = createMarkers(map, pointsRef.current);
      fitMap(map, pointsRef.current);

      window.requestAnimationFrame(() => {
        if (!cancelled) {
          map.invalidateSize();
          fitMap(map, pointsRef.current);
        }
      });

      resizeObserver =
        typeof ResizeObserver === 'undefined'
          ? null
          : new ResizeObserver(() => {
              if (!cancelled) {
                map.invalidateSize({ animate: false, pan: false });
                fitMap(map, pointsRef.current);
              }
            });
      resizeObserver?.observe(container);
    };

    frameId = window.requestAnimationFrame(initMap);

    return () => {
      cancelled = true;
      window.cancelAnimationFrame(frameId);
      resizeObserver?.disconnect();
      markerRefs.current.forEach((marker) => marker.remove());
      markerRefs.current = [];
      mapRef.current?.remove();
      mapRef.current = null;
    };
  }, [isNearViewport]);

  useLayoutEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    markerRefs.current.forEach((marker) => marker.remove());
    markerRefs.current = createMarkers(map, points);
    fitMap(map, points);
  }, [points]);

  const point = points[0];
  if (point == null) {
    return null;
  }

  const widthStyle = fullWidth ? '100%' : '180px';
  const heightStyle = fullWidth ? '100%' : '120px';
  const flexStyle = fullWidth ? '1 1 auto' : '0 0 180px';
  const maxWidthStyle = fullWidth ? '100%' : 'none';

  return (
    <Box
      ref={hostRef}
      data-coordinate-preview-tile="true"
      style={{
        flex: flexStyle,
        width: widthStyle,
        height: heightStyle,
        aspectRatio: fullWidth ? '1 / 1' : undefined,
        maxWidth: maxWidthStyle,
      }}
      sx={{
        flex: flexStyle,
        width: fullWidth ? '100%' : 180,
        height: fullWidth ? '100%' : PREVIEW_HEIGHT_PX,
        aspectRatio: fullWidth ? '1 / 1' : undefined,
        maxWidth: maxWidthStyle,
        alignSelf: 'flex-start',
      }}
    >
      {!isNearViewport ? (
        <Skeleton
          variant="rounded"
          height={fullWidth ? '100%' : PREVIEW_HEIGHT_PX}
          animation="wave"
          sx={{
            width: '100%',
            height: fullWidth ? '100%' : PREVIEW_HEIGHT_PX,
            maxWidth: fullWidth ? '100%' : `${PREVIEW_MAX_WIDTH_PX}px`,
            aspectRatio: fullWidth ? '1 / 1' : undefined,
          }}
        />
      ) : (
        <Tooltip title="Відкрити на мапі" placement="top" enterDelay={0} enterNextDelay={0}>
          <ButtonBase
            type="button"
            onClick={onOpen}
            aria-label={`Open ${point.label} on map`}
            style={{
              flex: flexStyle,
              width: widthStyle,
              height: heightStyle,
              aspectRatio: fullWidth ? '1 / 1' : undefined,
              maxWidth: maxWidthStyle,
            }}
            sx={{
              position: 'relative',
              flex: flexStyle,
              width: fullWidth ? '100%' : 180,
              maxWidth: maxWidthStyle,
              height: fullWidth ? '100%' : PREVIEW_HEIGHT_PX,
              aspectRatio: fullWidth ? '1 / 1' : undefined,
              overflow: 'hidden',
              borderRadius: 2,
              border: '1px solid',
              borderColor: 'divider',
              bgcolor: 'background.paper',
              color: 'common.white',
              textAlign: 'left',
              display: 'block',
              '&:focus-visible': {
                outline: 'none',
                boxShadow: '0 0 0 3px rgba(25, 118, 210, 0.32)',
              },
            }}
          >
            <Box
              ref={mapContainerRef}
              aria-hidden="true"
              style={{ zIndex: 0 }}
              sx={{
                position: 'absolute',
                inset: 0,
                zIndex: 0,
                '& .leaflet-container': {
                  width: '100%',
                  height: '100%',
                },
              }}
            />
            <Box
              style={{ zIndex: 1 }}
              sx={{
                position: 'absolute',
                inset: 0,
                zIndex: 1,
                background:
                  'linear-gradient(180deg, rgba(10, 13, 18, 0.08), rgba(10, 13, 18, 0.36) 80%)',
                pointerEvents: 'none',
              }}
            />
            <Box
              style={{ zIndex: 2 }}
              sx={{
                position: 'absolute',
                left: 8,
                right: 8,
                top: 8,
                display: 'flex',
                alignItems: 'flex-start',
                justifyContent: 'flex-start',
                gap: 0.75,
                pointerEvents: 'none',
                zIndex: 2,
              }}
            >
              {points.length === 1 ? (
                <Typography
                  variant="caption"
                  sx={{
                    px: 0.75,
                    py: 0.5,
                    borderRadius: 1.5,
                    bgcolor: 'rgba(10, 13, 18, 0.7)',
                    color: 'common.white',
                    fontWeight: 700,
                    lineHeight: 1.2,
                    backdropFilter: 'blur(6px)',
                    maxWidth: '100%',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {point.label}
                </Typography>
              ) : (
                <Typography
                  variant="caption"
                  data-coordinate-preview-count="true"
                  sx={{
                    px: 0.75,
                    py: 0.5,
                    borderRadius: 1.5,
                    bgcolor: 'rgba(10, 13, 18, 0.7)',
                    color: 'common.white',
                    fontWeight: 700,
                    lineHeight: 1.2,
                    backdropFilter: 'blur(6px)',
                  }}
                >
                  {formatCoordinatePreviewPointCount(points.length)}
                </Typography>
              )}
            </Box>
          </ButtonBase>
        </Tooltip>
      )}
    </Box>
  );
}
