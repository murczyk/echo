import 'leaflet/dist/leaflet.css';

import { Box, ButtonBase, Skeleton, Tooltip, Typography } from '@mui/material';
import * as L from 'leaflet';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';

import { getTileLayers } from '../../../../web-components/analysis-map/tile-layers';
import type { CoordinatePreviewPoint } from './message-coordinate-preview';

const PREVIEW_HEIGHT_PX = 120;
const PREVIEW_MAX_WIDTH_PX = 180;
const PREVIEW_ROOT_MARGIN = '160px 0px';
const PREVIEW_ZOOM = 13;

export function MessageCardCoordinatePreviewTile({
  point,
  onOpen,
}: {
  point: CoordinatePreviewPoint;
  onOpen: () => void;
}) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const mapContainerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<L.Map | null>(null);
  const markerRef = useRef<L.CircleMarker | null>(null);
  const [isNearViewport, setIsNearViewport] = useState(false);

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
      }).setView([point.lat, point.lng], PREVIEW_ZOOM);

      const tileLayers = getTileLayers();
      tileLayers.googleHybrid.addTo(map);

      const marker = L.circleMarker([point.lat, point.lng], {
        radius: 8,
        color: '#ffffff',
        weight: 3,
        fillColor: '#ff4d2d',
        fillOpacity: 1,
      }).addTo(map);

      map.getContainer().style.pointerEvents = 'none';
      mapRef.current = map;
      markerRef.current = marker;

      window.requestAnimationFrame(() => {
        if (!cancelled) {
          map.invalidateSize();
        }
      });
    };

    frameId = window.requestAnimationFrame(initMap);

    return () => {
      cancelled = true;
      window.cancelAnimationFrame(frameId);
      markerRef.current?.remove();
      markerRef.current = null;
      mapRef.current?.remove();
      mapRef.current = null;
    };
  }, [isNearViewport, point.lat, point.lng]);

  return (
    <Box
      ref={hostRef}
      style={{ flex: '0 0 180px', maxWidth: 'none' }}
      sx={{
        flex: '0 0 180px',
        maxWidth: 'none',
        alignSelf: 'flex-start',
      }}
    >
      {!isNearViewport ? (
        <Skeleton
          variant="rounded"
          height={PREVIEW_HEIGHT_PX}
          animation="wave"
          sx={{ width: '100%', maxWidth: `${PREVIEW_MAX_WIDTH_PX}px` }}
        />
      ) : (
        <Tooltip title="Відкрити на мапі" placement="top" enterDelay={0} enterNextDelay={0}>
          <ButtonBase
            type="button"
            onClick={onOpen}
            aria-label={`Open ${point.label} on map`}
            style={{ flex: '0 0 180px', width: '180px', height: '120px', maxWidth: 'none' }}
            sx={{
              position: 'relative',
              flex: '0 0 180px',
              width: 180,
              maxWidth: 'none',
              height: PREVIEW_HEIGHT_PX,
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
              sx={{
                position: 'absolute',
                inset: 0,
                '& .leaflet-container': {
                  width: '100%',
                  height: '100%',
                },
              }}
            />
            <Box
              sx={{
                position: 'absolute',
                inset: 0,
                background:
                  'linear-gradient(180deg, rgba(10, 13, 18, 0.08), rgba(10, 13, 18, 0.36) 80%)',
                pointerEvents: 'none',
              }}
            />
            <Box
              sx={{
                position: 'absolute',
                left: 8,
                right: 8,
                top: 8,
                display: 'flex',
                alignItems: 'flex-start',
                justifyContent: 'space-between',
                gap: 0.75,
                pointerEvents: 'none',
              }}
            >
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
            </Box>
          </ButtonBase>
        </Tooltip>
      )}
    </Box>
  );
}
