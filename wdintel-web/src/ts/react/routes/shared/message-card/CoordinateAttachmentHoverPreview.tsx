import { Paper, Popper } from '@mui/material';
import type * as L from 'leaflet';
import { useState } from 'react';

import type { CoordinatePreviewPoint } from './message-coordinate-preview';
import { CoordinatePreviewMapSurface } from './CoordinatePreviewMapSurface';

type Props = {
  anchorEl: HTMLElement | null;
  open: boolean;
  points: CoordinatePreviewPoint[];
  id: string;
  onEnter: () => void;
  onLeave: () => void;
  title?: string;
};
export function CoordinateAttachmentHoverPreview({
  anchorEl,
  open,
  points,
  id,
  onEnter,
  onLeave,
  title,
}: Props) {
  const [detailViewportBounds, setDetailViewportBounds] = useState<L.LatLngBounds | null>(null);
  if (!open || anchorEl == null) return null;
  return (
    <Popper
      open
      anchorEl={anchorEl}
      placement="top-start"
      modifiers={[
        { name: 'offset', options: { offset: [0, 8] } },
        {
          name: 'flip',
          options: { fallbackPlacements: ['bottom-start', 'top-end', 'bottom-end'] },
        },
        {
          name: 'preventOverflow',
          options: { boundary: 'viewport', padding: 8, altAxis: true, tether: false },
        },
      ]}
      sx={{ zIndex: (theme) => theme.zIndex.tooltip }}
    >
      <Paper
        id={id}
        role="tooltip"
        data-coordinate-hover-preview="true"
        elevation={8}
        className={`coordinate-hover-preview${title != null ? ' flex flex-col' : ''}`}
        onPointerEnter={onEnter}
        onPointerLeave={onLeave}
        onFocus={onEnter}
        onBlur={onLeave}
      >
        {title != null ? (
          <div className="shrink-0 px-echo-sm py-echo-xs text-echo-sm">{title}</div>
        ) : null}
        <div className={`coordinate-hover-preview__maps${title != null ? ' min-h-0 flex-1' : ''}`}>
          <CoordinatePreviewMapSurface
            points={points}
            mode="overview"
            detailViewportBounds={detailViewportBounds}
            className="coordinate-hover-preview__map-region"
          />
          <CoordinatePreviewMapSurface
            points={points}
            mode="detail"
            onDetailViewportBoundsChange={setDetailViewportBounds}
            className="coordinate-hover-preview__map-region"
          />
        </div>
      </Paper>
    </Popper>
  );
}
