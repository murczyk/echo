export type Coords = { lat: number; lng: number };

export type Geometry = {
  center?: Coords | null;
  perimeter_linear_ring?: Coords[] | null;
  line_strings?: Coords[][] | null;
};

export type Palitra = {
  id: number;
  api_palitra_id?: number;
  name: string;
  folder?: string | null;
  color_hex: string;
  geometry: Geometry | null;
  source_file_name?: string;
};

export type PalitraPoint = {
  coords: Coords;
  label: string | null;
  color?: string | null;
};

export type PalitraDetails = {
  palitra: Palitra;
  points: PalitraPoint[];
};

export interface PalitraManagerCallbacks {
  onVisibilityToggle: (palitraId: number) => void;
  onSearchResultsCountChanged: (count: number | null) => void;
  onSearchLoadingChanged: (isLoading: boolean) => void;
  onOverlayContextMenu?: (target: Coords, latlng: Coords) => void;
  /** When result set is huge, we cap rendered markers */
  onSearchResultsTruncated?: (rendered: number, total: number) => void;
}

export interface PalitraManagerOptions {
  minZoomForPoints: number;
  requestDelayMs: number;
  cacheTtlMs: number;
  maxCachedTiles: number;
  /** Buffer ratio for viewport filtering. Only points inside viewport + buffer are rendered. Default 0.15. */
  pointsViewportBufferRatio?: number;
}
