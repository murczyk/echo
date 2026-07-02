import type { Palitra as ReadPalitra } from '../../../../../Bindings';
import type { PalitraReadV2 } from '../../../../../Bindings';
import type {
  PalitraManagerCallbacks,
  PalitraManagerOptions,
} from '../../../../maps/palitra-types';

export type PalitraPreviewDialogProps = {
  open: boolean;
  palitra: ReadPalitra | null;
  preview: PalitraReadV2 | null;
  loading: boolean;
  error?: string | null;
  onClose: () => void;
};

export const DEFAULT_PREVIEW_CENTER: [number, number] = [49, 32];
export const DEFAULT_PREVIEW_ZOOM = 6;
export const PREVIEW_MAX_ZOOM = 17;
export const PREVIEW_POINT_OPTIONS: PalitraManagerOptions = {
  minZoomForPoints: 15,
  requestDelayMs: 200,
  cacheTtlMs: 5 * 60 * 1000,
  maxCachedTiles: 100,
};

export const NOOP_CALLBACKS: PalitraManagerCallbacks = {
  onVisibilityToggle: () => undefined,
  onSearchResultsCountChanged: () => undefined,
  onSearchLoadingChanged: () => undefined,
};
