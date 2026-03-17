import * as L from 'leaflet';

export type NetworkUnit = { frequencies: string[]; name: string };

export type Message = [
  number,
  {
    message_uid?: string;
    freq?: string;
    coords?: number[];
    text: string;
    date?: string;
    time?: string;
    unit?: string | null;
    network_ids?: number[] | null;
  },
];

export type CoordinateMenuTarget = {
  lat: number;
  lng: number;
  mgrsCoords?: string | null;
};

export class DataCircleMarker extends L.CircleMarker {
  data: { messageId: number };

  constructor(latLng: L.LatLngExpression, data: { messageId: number }, options: L.CircleMarkerOptions) {
    super(latLng, options);
    this.setData(data);
  }

  getData() {
    return this.data;
  }

  setData(data: { messageId: number }) {
    this.data = data;
  }
}
