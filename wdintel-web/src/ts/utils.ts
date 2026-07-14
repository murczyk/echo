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

export function td_usk2000_to_wgs84(p) {
  let proj = proj4('EPSG:5564');
  if (p.y >= 7200000) {
    // if (p.y >= 7274000) {
    proj = proj4('EPSG:5565');
  }
  let swapped = { x: p.y, y: p.x };
  // console.log("swapped", swapped);
  let res = proj.inverse(swapped);
  let res_swapped = { x: res.y, y: res.x };
  return res_swapped;
}

export function td_wgs84_to_usk2000(p) {
  let proj = proj4('EPSG:5564');
  let res = proj.forward(p);
  // if (res.x >= 6700000) {
  if (res.x >= 6726000) {
    proj = proj4('EPSG:5565');
    res = proj.forward(p);
  }
  return res;
}

const UTM_LATITUDE_BANDS = 'CDEFGHJKLMNPQRSTUVWX';

function isSouthernUtmBand(band: string): boolean {
  return UTM_LATITUDE_BANDS.indexOf(band.toUpperCase()) < UTM_LATITUDE_BANDS.indexOf('N');
}

export function utmToWgs84(p: { zone: number; band: string; easting: number; northing: number }) {
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
