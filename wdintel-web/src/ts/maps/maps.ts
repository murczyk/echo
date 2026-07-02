import { L } from './leaflet-markercluster';
import 'leaflet/dist/leaflet.css';
import { getNavigationApi } from '../browser/navigation-api'
import { kmzLayerFactory } from './leaflet-kmz'
import '../web-components/range-date-selector'
import './maps.css'
import type { MapPointShort } from './types'

export function initializeMap(containerId: string | HTMLElement, initialPoint: { lat: number, lng: number } | null) {
	const initial: [number, number] = initialPoint ? [initialPoint.lat, initialPoint.lng] : [49, 32]
	const map = L.map(containerId, { zoomControl: false, attributionControl: false }).setView(initial, 14);
	L.tileLayer('https://{s}.google.com/vt/lyrs=s,h&x={x}&y={y}&z={z}&hl=uk', {
		maxZoom: 17,
		subdomains: ['mt0', 'mt1', 'mt2', 'mt3']
	}).addTo(map);
	return map;
}

export function addPointsToLayer(points: MapPointShort[]) {
	const markers = L.markerClusterGroup({
		maxClusterRadius: 30,
		zoomToBoundsOnClick: false,
		spiderfyOnMaxZoom: false,
		iconCreateFunction: function(cluster) {
			const childCount = cluster.getChildCount();
			return L.divIcon({
				html: '<div class="marker-cluster" style="background-color: #f25769; border-radius: 50%; ; display: flex; align-items: center; justify-content: center;">' +
					'<span style="color: white; font-weight: bold;">' + childCount + '</span>' +
					'</div>',
				className: '',
				iconSize: new L.Point(20, 20)
			});
		}
	});
	const bounds = L.latLngBounds(points);

	const circles: L.CircleMarker[] = [];
	points.forEach(point => {
		const circle = L.circleMarker([point.lat, point.lng], {
			color: '#f25769',
			fillColor: '#f25769',
			fillOpacity: 0.5,
			radius: 5
		})

		if (point.body) {
			circle.bindPopup(point.body)
		}

		circle.on('click', () => {
			if (!circle.isPopupOpen()) {
				circle.openPopup()
			}

		})
		circle.on('popupopen', function() {
			circle.setStyle({
				color: '#0d6efd',
				fillColor: '#0d6efd',
			});
		});

		circle.on('popupclose', function() {
			circle.setStyle({
				color: '#f25769',
				fillColor: '#f25769',
			});
		});

		markers.addLayer(circle)
		circles.push(circle)
	});
	return {
		bounds,
		markersGroup: markers
	};
}

export function createFullScreenControl(toggleMapSize: () => void) {
	return L.Control.extend({
		onAdd: function(_: L.Map) {
			let container = L.DomUtil.create('div', 'leaflet-custom-control');
			let button = L.DomUtil.create('a', '', container);
			const setExpanded = (isExpanded: boolean) => {
				const title = isExpanded ? 'Згорнути мапу' : 'Розгорнути мапу';
				button.setAttribute('aria-label', title);
				button.title = title;
				button.innerHTML = isExpanded
					? '<i class="bi bi-fullscreen-exit" style="font-size: 12px;"></i>'
					: '<i class="bi bi-arrows-fullscreen" style="font-size: 12px;"></i>';
			};
			button.href = '#';
			setExpanded(false);
			(this as L.Control & { setExpanded?: (isExpanded: boolean) => void }).setExpanded = setExpanded;
			L.DomEvent.on(button, 'click', L.DomEvent.stopPropagation)
				.on(button, 'click', L.DomEvent.preventDefault)
				.on(button, 'click', toggleMapSize, this);
			return container;
		},
	});
}

export function createExitControl(closeMap: () => void) {
	return L.Control.extend({
		onAdd: function(_: L.Map) {
			let container = L.DomUtil.create('div', 'leaflet-custom-control');
			let button = L.DomUtil.create('a', '', container);
			button.href = '#';
			button.setAttribute('aria-label', 'Закрити мапу');
			button.title = 'Закрити мапу';
			button.innerHTML = '<i class="bi bi-x-lg" style="font-size: 12px;"></i>';
			L.DomEvent.on(button, 'click', L.DomEvent.stopPropagation)
				.on(button, 'click', L.DomEvent.preventDefault)
				.on(button, 'click', () => {
					clearSmallMapFullscreenBodyLock();
					closeMap();
				}, this);
			return container;
		},
	});
}

export function clearSmallMapFullscreenBodyLock() {
	document.body.classList.remove('small-map-fullscreen-open');
}

export function toggleMapSize(map: L.Map, mapContainer: HTMLElement, bounds: L.LatLngBounds, fullScreenControl: any) {
	const isExpanded = mapContainer.classList.toggle('expanded');
	fullScreenControl?.setExpanded?.(isExpanded);
	document.body.classList.toggle('small-map-fullscreen-open', isExpanded);
	mapContainer.dispatchEvent(new CustomEvent('map-expanded-changed', { detail: { isExpanded } }));
	setTimeout(function() {
		map.invalidateSize();
		map.fitBounds(bounds);
		fullScreenControl.fire("fullscreen-toggled")
	}, 0);
}

let cachedKmzData: string | null = null;
let kmzResponseResolved = false;

export async function loadKmzData() {
	if (!kmzResponseResolved) {
		try {
			const response = await fetch('/api/delta/kml/latest');
			if (!response.ok) {
				if (response.status === 404) {
					kmzResponseResolved = true;
					console.info('[Map] /api/delta/kml/latest returned 404. KMZ layer will be skipped.');
					cachedKmzData = null;
					return null;
				}
				console.warn(`[Map] Failed to load KMZ: HTTP ${response.status}. KMZ layer will be skipped.`);
				cachedKmzData = null;
				return null;
			}
			kmzResponseResolved = true;
			cachedKmzData = await response.text();
		} catch (error) {
			console.warn('[Map] Failed to fetch KMZ data. KMZ layer will be skipped.', error);
			cachedKmzData = null;
			return null;
		}
	}
	return cachedKmzData;
}

export async function setupMap(data: { points: MapPointShort[], containerId: string }, exitCallback: () => void) {
	const kmzData = await loadKmzData();
	requestAnimationFrame(() => {
		const mapContainer = document.getElementById(`map-container-${data.containerId}`);
		if (mapContainer) {
			const map = initializeMap(`map-container-${data.containerId}`, data.points[0]);
			let isCleanedUp = false;
			const navigationApi = getNavigationApi();
			const cleanup = () => {
				if (isCleanedUp) {
					return;
				}
				isCleanedUp = true;
				clearSmallMapFullscreenBodyLock();
				removalObserver.disconnect();
				navigationApi?.removeEventListener('navigate', handleRouteChange);
				window.removeEventListener('popstate', handleRouteChange);
				window.removeEventListener('pagehide', handleRouteChange);
				map.off('unload', cleanup);
				if ((map as any)._container) {
					map.remove();
				}
			};
			const handleRouteChange = () => {
				cleanup();
			};
			const removalObserver = new MutationObserver(() => {
				if (!document.body.contains(mapContainer)) {
					cleanup();
				}
			});
			removalObserver.observe(document.body, { childList: true, subtree: true });
			navigationApi?.addEventListener('navigate', handleRouteChange);
			window.addEventListener('popstate', handleRouteChange);
			window.addEventListener('pagehide', handleRouteChange);
			map.on('unload', cleanup);

			const { bounds, markersGroup } = addPointsToLayer(data.points);
			map.addLayer(markersGroup)
			if (bounds.isValid()) {
				map.fitBounds(bounds)
			}
			const toggleSize = () => toggleMapSize(map, mapContainer, bounds, fullScreenControl);

			const FullScreenControl = createFullScreenControl(toggleSize);
			L.extend(FullScreenControl.prototype, L.Evented.prototype);
			const fullScreenControl: any = new FullScreenControl()
			map.addControl(new (createExitControl(exitCallback))({ position: 'topright' }));
			map.addControl(fullScreenControl);

			if (kmzData) {
				const kmz = kmzLayerFactory(null, { bindTooltip: true, bindPopup: false })
				kmz.addTo(map);	
				kmz.parse(kmzData, {})

				fullScreenControl.on("fullscreen-toggled", (e) => {
					const isMapOpened = map.getSize().x > 250
					kmz.eachLayer((layer: any) => {
						layer.eachLayer((l: any) => {
							if (l.feature.properties.name) {
								l.unbindTooltip();
								if (isMapOpened) {
									l.bindTooltip('<b>' + l.feature.properties.name + '</b>', {
										permanent: true,
										direction: 'center',
										opacity: 0
									});
								} else {
									l.bindTooltip('<b>' + l.feature.properties.name + '</b>', {
										permanent: false,
										direction: 'center',
										opacity: 0
									});
								}
							}
						})
					})
				})
			}
		} else {
			throw Error("Map container is not found")
		}
	});
}
