import * as L from 'leaflet';

export function getTileLayers() {
  const openStreetMap = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 17,
    attribution:
      '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  });

  const googleHybrid = L.tileLayer('https://{s}.google.com/vt/lyrs=s,h&x={x}&y={y}&z={z}&hl=uk', {
    maxZoom: 17,
    subdomains: ['mt0', 'mt1', 'mt2', 'mt3'],
  });

  return { openStreetMap, googleHybrid };
}
