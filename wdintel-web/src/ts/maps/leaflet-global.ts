import L from 'leaflet';
import type * as Leaflet from 'leaflet';

const patchedLeaflet = L as typeof Leaflet;

(globalThis as typeof globalThis & { L?: typeof Leaflet }).L = patchedLeaflet;

export { patchedLeaflet as L };
