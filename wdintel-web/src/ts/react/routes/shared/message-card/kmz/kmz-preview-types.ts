export type KmzPreviewCoords = { lat: number; lng: number };

export type KmzPreview = {
  points: Array<{
    coords: KmzPreviewCoords;
    label: string | null;
    color: string | null;
    opacity: number;
  }>;
  lineStrings: Array<{
    coords: KmzPreviewCoords[];
    label: string | null;
    color: string | null;
    opacity: number;
  }>;
  polygons: Array<{
    rings: KmzPreviewCoords[][];
    label: string | null;
    strokeColor: string | null;
    strokeOpacity: number;
    fillColor: string | null;
    fillOpacity: number;
    inferredFromPoints?: boolean;
  }>;
};
