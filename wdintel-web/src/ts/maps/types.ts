export type MapPointShort = {
  lat: number;
  lng: number;
  body: string;
  id: number;
};

export type MapPointDetailed = Omit<MapPointShort, 'body'> & {
  message_uid?: string | null;
  mgrs_coords: string;
  sk42_coords: string;
  freq: string | null;
  message_id: number;
  battle_line_distance: number | null;
};

export type MapPoint = MapPointShort | MapPointDetailed;
