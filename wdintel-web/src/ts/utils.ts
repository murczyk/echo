import proj4 from 'proj4';

// https://github.com/AlexZeDiKoN/Bimpsoft/blob/e4118066a734a3af05adfa3eaa0e8f12759e26dc/src/utils/svg/mapObjects.js
const systems: [string, string][] = [
  // СК-42
  [
    'EPSG:4284',
    '+proj=longlat +ellps=krass +towgs84=23.92,-141.27,-80.9,-0,0.35,0.82,-0.12 +no_defs',
  ],
  [
    'EPSG:28402',
    `+proj=tmerc +lat_0=0 +lon_0=9 +k=1 +x_0=2500000 +y_0=0 +ellps=krass +towgs84=23.92,-141.27,-80.9,-0,0.35,0.82,-0.12 +units=m +no_defs`,
  ],
  [
    'EPSG:28403',
    `+proj=tmerc +lat_0=0 +lon_0=15 +k=1 +x_0=3500000 +y_0=0 +ellps=krass +towgs84=23.92,-141.27,-80.9,-0,0.35,0.82,-0.12 +units=m +no_defs`,
  ],
  [
    'EPSG:28404',
    `+proj=tmerc +lat_0=0 +lon_0=21 +k=1 +x_0=4500000 +y_0=0 +ellps=krass +towgs84=23.92,-141.27,-80.9,-0,0.35,0.82,-0.12 +units=m +no_defs`,
  ],
  [
    'EPSG:28405',
    `+proj=tmerc +lat_0=0 +lon_0=27 +k=1 +x_0=5500000 +y_0=0 +ellps=krass +towgs84=23.92,-141.27,-80.9,-0,0.35,0.82,-0.12 +units=m +no_defs`,
  ],
  [
    'EPSG:28406',
    `+proj=tmerc +lat_0=0 +lon_0=33 +k=1 +x_0=6500000 +y_0=0 +ellps=krass +towgs84=23.92,-141.27,-80.9,-0,0.35,0.82,-0.12 +units=m +no_defs`,
  ],
  [
    'EPSG:28407',
    `+proj=tmerc +lat_0=0 +lon_0=39 +k=1 +x_0=7500000 +y_0=0 +ellps=krass +towgs84=23.92,-141.27,-80.9,-0,0.35,0.82,-0.12 +units=m +no_defs`,
  ],
  [
    'EPSG:28408',
    `+proj=tmerc +lat_0=0 +lon_0=45 +k=1 +x_0=8500000 +y_0=0 +ellps=krass +towgs84=23.92,-141.27,-80.9,-0,0.35,0.82,-0.12 +units=m +no_defs`,
  ],
  // УСК-2000 https://epsg.io/5561
  ['EPSG:5561', '+proj=longlat +ellps=krass +towgs84=25,-141,-78.5,-0,0.35,0.736,0 +no_defs'],
  [
    'EPSG:5562',
    `+proj=tmerc +lat_0=0 +lon_0=21 +k=1 +x_0=4500000 +y_0=0 +ellps=krass +towgs84=25,-141,-78.5,-0,0.35,0.736,0 +units=m +no_defs`,
  ],
  [
    'EPSG:5563',
    `+proj=tmerc +lat_0=0 +lon_0=27 +k=1 +x_0=5500000 +y_0=0 +ellps=krass +towgs84=25,-141,-78.5,-0,0.35,0.736,0 +units=m +no_defs`,
  ],
  [
    'EPSG:5564',
    `+proj=tmerc +lat_0=0 +lon_0=33 +k=1 +x_0=6500000 +y_0=0 +ellps=krass +towgs84=25,-141,-78.5,-0,0.35,0.736,0 +units=m +no_defs`,
  ],
  [
    'EPSG:5565',
    `+proj=tmerc +lat_0=0 +lon_0=39 +k=1 +x_0=7500000 +y_0=0 +ellps=krass +towgs84=25,-141,-78.5,-0,0.35,0.736,0 +units=m +no_defs`,
  ],
];

proj4.defs(systems);

type GridPoint = { x: number; y: number };
type UtmPoint = { zone: number; band: string; easting: number; northing: number };

function sk42EpsgForEasting(easting: number): string | null {
  const zone = Math.trunc(easting / 1000000);
  return zone >= 2 && zone <= 8 ? `EPSG:2840${zone}` : null;
}

function sk42EpsgForLongitude(longitude: number): string | null {
  const zone = Math.floor((longitude + 3) / 6);
  return zone >= 2 && zone <= 8 ? `EPSG:2840${zone}` : null;
}

function usk2000EpsgForEasting(easting: number): string | null {
  const zone = Math.trunc(easting / 1000000);
  return zone >= 4 && zone <= 7 ? `EPSG:${5558 + zone}` : null;
}

function usk2000EpsgForLongitude(longitude: number): string | null {
  const zone = Math.floor((longitude + 3) / 6);
  return zone >= 4 && zone <= 7 ? `EPSG:${5558 + zone}` : null;
}

export function td_sk42_to_wgs84(p: GridPoint): GridPoint | null {
  const epsg = sk42EpsgForEasting(p.y);
  if (!epsg) return null;
  const res = proj4(epsg).inverse({ x: p.y, y: p.x });
  if (!Number.isFinite(res?.x) || !Number.isFinite(res?.y)) return null;
  return { x: res.y, y: res.x };
}

export function td_wgs84_to_sk42(p: GridPoint): GridPoint | null {
  const epsg = sk42EpsgForLongitude(p.x);
  if (!epsg) return null;
  const res = proj4(epsg).forward(p);
  if (!Number.isFinite(res?.x) || !Number.isFinite(res?.y)) return null;
  return res;
}

export function td_usk2000_to_wgs84(p: GridPoint): GridPoint | null {
  const epsg = usk2000EpsgForEasting(p.y);
  if (!epsg) return null;
  const res = proj4(epsg).inverse({ x: p.y, y: p.x });
  if (!Number.isFinite(res?.x) || !Number.isFinite(res?.y)) return null;
  return { x: res.y, y: res.x };
}

export function td_wgs84_to_usk2000(p: GridPoint): GridPoint | null {
  const epsg = usk2000EpsgForLongitude(p.x);
  if (!epsg) return null;
  const res = proj4(epsg).forward(p);
  if (!Number.isFinite(res?.x) || !Number.isFinite(res?.y)) return null;
  return res;
}

const UTM_LATITUDE_BANDS = 'CDEFGHJKLMNPQRSTUVWX';

function isSouthernUtmBand(band: string): boolean {
  return UTM_LATITUDE_BANDS.indexOf(band.toUpperCase()) < UTM_LATITUDE_BANDS.indexOf('N');
}

export function utmToWgs84(p: UtmPoint) {
  const zone = Math.trunc(p.zone);
  if (!Number.isInteger(zone) || zone < 1 || zone > 60) {
    return null;
  }

  const band = String(p.band ?? '')
    .trim()
    .toUpperCase();
  if (!UTM_LATITUDE_BANDS.includes(band)) {
    return null;
  }

  const proj = proj4(
    `+proj=utm +zone=${zone}${isSouthernUtmBand(band) ? ' +south' : ''} +datum=WGS84 +units=m +no_defs`,
  );
  const res = proj.inverse({ x: p.easting, y: p.northing });
  if (!Number.isFinite(res?.x) || !Number.isFinite(res?.y)) {
    return null;
  }
  return { lat: res.y, lng: res.x };
}

function latitudeToUtmBand(latitude: number): string | null {
  if (!Number.isFinite(latitude) || latitude < -80 || latitude > 84) return null;
  if (latitude === 84) return 'X';
  const index = Math.floor((latitude + 80) / 8);
  return UTM_LATITUDE_BANDS[index] ?? null;
}

export function wgs84ToUtm(coords: { lat: number; lng: number }): UtmPoint | null {
  const band = latitudeToUtmBand(coords.lat);
  if (!band || !Number.isFinite(coords.lng) || coords.lng < -180 || coords.lng > 180) return null;
  const zone = Math.min(60, Math.floor((coords.lng + 180) / 6) + 1);
  const proj = proj4(
    `+proj=utm +zone=${zone}${coords.lat < 0 ? ' +south' : ''} +datum=WGS84 +units=m +no_defs`,
  );
  const res = proj.forward({ x: coords.lng, y: coords.lat });
  if (!Number.isFinite(res?.x) || !Number.isFinite(res?.y)) return null;
  return { zone, band, easting: res.x, northing: res.y };
}
