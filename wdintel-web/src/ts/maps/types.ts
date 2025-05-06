export type MapPointShort = {
  lat: number;
  lng: number;
  body: string;
  id: number;
}

export type MapPointDetailed = Omit<MapPointShort, 'body'> & {
  mgrs_coords: string;
  sk42_coords: string;
  freq: string;
  message_id: number;
}


export type MapPoint = MapPointShort | MapPointDetailed
