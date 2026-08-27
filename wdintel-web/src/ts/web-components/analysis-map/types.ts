import * as L from 'leaflet';
import type { ContentNode } from '../../../Bindings';

export type NetworkUnit = { frequencies: string[]; name: string };

export type Message = [
  number,
  {
    message_uid?: string | null;
    freq?: string | null;
    coords?: string | null;
    text: string;
    date?: string | null;
    time?: string | null;
    unit?: string | null;
    network_ids?: number[] | null;
    text_marked?: ContentNode[] | null;
  },
];

export type CoordinateMenuTarget = {
  lat: number;
  lng: number;
  mgrsCoords?: string | null;
};

export class DataCircleMarker extends L.CircleMarker {
  data: {
    messageId: number;
    freq?: string | null;
    battleLineDistance?: number | null;
  };

  constructor(
    latLng: L.LatLngExpression,
    data: {
      messageId: number;
      freq?: string | null;
      battleLineDistance?: number | null;
    },
    options: L.CircleMarkerOptions,
  ) {
    super(latLng, options);
    this.setData(data);
  }

  getData() {
    return this.data;
  }

  setData(data: { messageId: number; freq?: string | null; battleLineDistance?: number | null }) {
    this.data = data;
  }
}
