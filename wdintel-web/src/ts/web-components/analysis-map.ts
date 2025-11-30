import * as L from 'leaflet';

import "leaflet.markercluster/dist/MarkerCluster.css"
import "leaflet.markercluster/dist/leaflet.markercluster.js"
import { loadKmzData } from '../maps/maps'
import { KMZLayer, kmzLayerFactory } from '../maps/leaflet-kmz'
import { MapPointDetailed } from '../maps/types';
import { messagesCountText } from '../maps/language-utils';
import { TimeswitchControl, PalitrasControl, FeaturesControl, FeatureToggleState, createLayerSwitchControl, createExitControl2, createTimeswitchControl, createAttributionControl, createPalitrasControl, createFeaturesControl, FeatureName } from '../maps/controls';

type NetworkUnit = { frequencies: string[]; name: string }
type Message = [number, { freq: string; coords: number[], text: string, date: number, time: number, unit: string }]
type Coords = { lat: number; lng: number }
type Geometry = { 
  center: Coords; 
  perimeter_linear_ring: Coords[] 
}
type Palitra = {
  id: number;
  name: string;
  color_hex: string;
  geometry: Geometry | null;
  source_file_name?: string;
}
type PalitraPoint = {
  coords: Coords;
  label: string | null;
}
type PalitraDetails = {
  palitra: Palitra;
  points: PalitraPoint[];
}

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



function getTileLayers() {
  const openStreetMap = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 17,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
  });

  const googleHybrid = L.tileLayer('https://{s}.google.com/vt/lyrs=s,h&x={x}&y={y}&z={z}&hl=uk', {
    maxZoom: 17,
    subdomains: ['mt0', 'mt1', 'mt2', 'mt3']
  });
  return { openStreetMap, googleHybrid }
}

const liTemplate = (message_: Message, networkUnitName_: string | undefined, selectedUnits: string[]) => {

  const unitName = networkUnitName_ ?? message_[1].unit ?? 'Не визначено'
  const unitBlock = `
            <div>
              <span style="font-weight: 700; line-height: 22px;">Підрозділ:</span> 
              <span class="pointer" style="color: #0d6efd" id="map-message-id-${message_[0]}", data-unitname="${unitName}">
                ${unitName}
                <i class="bi bi-${selectedUnits.includes(unitName) ? "dash" : "plus"}-square" > </i>
              </span>
            </div>
            `

  return `
          <li>
            ${message_[1].freq ? `<p style="line-height: 22px;"><span style="font-weight: 700;">Частота:</span> ${message_[1].freq}</p>` : ''}
            ${message_[1].coords ? `<p style="line-height: 16px;"><span style="font-weight: 700;">Координати:</span> ${message_[1].coords}</p>` : ''}
            ${message_[1].coords ? '<span style="font-weight: 700; line-height: 22px;">Повідомлення:</span><br>' : ''}
            ${message_[1].text.replace('\n', '<br>')}
            ${unitBlock}
            <div class="divider"></div>
          </li>
    `;
}
function getPointPopupTemplate(sortedMessages: Message[], networkUnits: NetworkUnit[], selectedUnits: string[]) {
  const b =
    sortedMessages.map((message) => {
      const networkUnitName = networkUnits.find(unit => unit.frequencies.includes(message[1].freq))?.name
      return liTemplate(message, networkUnitName, selectedUnits)
    }).join('')
  return `
    <div class="messages-popup" >
      <p class="title" > ${messagesCountText(sortedMessages.length)} </p>
        <ul>
            ${b}
  </ul>
    </div>
      `;
}


class AnalysisMap extends HTMLElement {
  static observedAttributes = ["points", "daterange", "messages", "visibility", "network-units", "selected-units", "palitras", "visible-palitra-ids", "palitras-enabled", "kmz-enabled", "pelengs-enabled"]

  private _map: L.Map | null = null;
  private _daterange: { startDate: number, endDate: number } = { startDate: new Date().getDate(), endDate: new Date().getDate() };
  private _switchTimeControl: TimeswitchControl | null = null;
  private _points: MapPointDetailed[] = []
  private _messages: Message[] = [];
  private _networkUnits: NetworkUnit[] = [];

  private _markersGroup: L.MarkerClusterGroup | null = null;
  private _clickedPoint: DataCircleMarker | null = null;
  private _boundedAlready = false;
  private _initialized = false;
  private _kmzLayer: KMZLayer | null = null;
  private _kmzLoading: Promise<void> | null = null;
  private _selectedUnits: string[] = []
  
  private _palitras: PalitraDetails[] = [];
  private _visiblePalitraIds: number[] = [];
  private _palitrasControl: PalitrasControl | null = null;
  private _palitrasLayerGroup: L.LayerGroup | null = null;
  private _palitrasPointsClusters: Map<number, L.MarkerClusterGroup> = new Map();
  private _minZoomForPoints = 13; // Мінімальний зум для показу точок палітр
  private _palitrasEnabled = true;
  private _kmzEnabled = true;
  private _pelengsEnabled = true;
  private _featuresControl: FeaturesControl | null = null;

  constructor() {
    super();
  }

  connectedCallback() { }

  disconnectedCallback() { }

  attributeChangedCallback(name: string, oldValue: any, newValue: string) {
    if (name === 'visibility') {
      if (!this._initialized && newValue === 'true') {
        // We have to make sure that map container has completely re-rendered before initializing the map.
        setTimeout(() => {
          this.render();
          this._initializeMap();
          //this._replacePointsOnMap();
          this._initialized = true;
        }, 0)
      }
    }
    if (name === 'points') {
      this._points = JSON.parse(newValue);
      if (this._map) {
        this._replacePointsOnMap(this._points);
      }
    }
    if (name === 'daterange') {
      this._daterange = JSON.parse(newValue);
      if (this._switchTimeControl && this._daterange) {
        this._switchTimeControl.updateDates(this._daterange);
      }
    }
    if (name === 'messages') {
      const parsed = JSON.parse(newValue);
      this._messages = parsed['messages']
      this._networkUnits = parsed['networkUnits']
      if (this._clickedPoint && this._messages.length > 0) {

        const unitClickedCallback = (element: Element) => {
          const event = new CustomEvent('message-unit-clicked', {
            detail: {
              networkUnitName: element.getAttribute("data-unitname")
            },
            bubbles: true,
            composed: true
          });
          this.dispatchEvent(event);
          this._clickedPoint?.closePopup();
          this._clickedPoint = null;
        }
        const sortedMessages = [...this._messages].sort((message1, message2) => {
          const datetime1 = new Date(`${message1[1].date}T${message1[1].time} `);
          const datetime2 = new Date(`${message2[1].date}T${message2[1].time} `);
          return datetime2.getTime() - datetime1.getTime();
        });

        const popupContent = getPointPopupTemplate(sortedMessages, this._networkUnits, this._selectedUnits)
        this._clickedPoint.bindPopup(popupContent)
        this._clickedPoint.openPopup()

        //this._markersGroup.refreshClusters(this._clickedPoint)

        const a = document.querySelectorAll('[id^="map-message-id-"]')
        const handlersMap = new Map<string, () => void>();
        a.forEach(x => {
          const handleClick = () => unitClickedCallback(x)
          x.addEventListener('click', handleClick)
          handlersMap.set(x.id, handleClick)
        })

        this._clickedPoint.once('popupclose', () => {
          a.forEach(x => {
            const handler = handlersMap.get(x.id)
            if (handler) {
              x.removeEventListener('click', handler)
              handlersMap.delete(x.id)
            }
          })
        })
      }
    }
    if (name === 'selected-units') {
      this._selectedUnits = JSON.parse(newValue)
    }
    if (name === 'palitras') {
      this._palitras = JSON.parse(newValue);
      if (this._palitrasControl) {
        this._palitrasControl.updatePalitras(this._palitras, this._visiblePalitraIds);
      }
      this._updatePalitrasOnMap();
    }
    if (name === 'visible-palitra-ids') {
      this._visiblePalitraIds = JSON.parse(newValue);
      if (this._palitrasControl) {
        this._palitrasControl.updatePalitras(this._palitras, this._visiblePalitraIds);
      }
      this._updatePalitrasOnMap();
    }
    if (name === 'palitras-enabled') {
      this._palitrasEnabled = JSON.parse(newValue);
      this._updateFeaturesControl();
      this._updatePalitrasOnMap();
    }
    if (name === 'kmz-enabled') {
      this._kmzEnabled = JSON.parse(newValue);
      this._updateFeaturesControl();
      this._applyKmzVisibility();
    }
    if (name === 'pelengs-enabled') {
      this._pelengsEnabled = JSON.parse(newValue);
      this._updateFeaturesControl();
    }
  }


  private render() {
    this.innerHTML = `
    <div id="analysis-map"> </div>
      `;
  }


  private async _initializeMap() {
    const mapContainer = this.querySelector<HTMLDivElement>('#analysis-map')
    if (mapContainer) {
      const tileLayers = getTileLayers();

      // Start with a single base layer to avoid loading two full tile stacks at once
      const map = L.map(mapContainer, { zoomControl: false, attributionControl: false }).setView([47.42135, 35.62197], 8);
      tileLayers.googleHybrid.addTo(map);

      const result = this._initializeControls(map, tileLayers)
      this._map = result.map;
      this._switchTimeControl = result.switchTimeControl;

     //TODO: remove
      if (!window.location.hostname.includes('echo-soledarnist')) {

        await this._loadKmzLayer();
     }
     
     // Initialize palitras layer group
     this._palitrasLayerGroup = L.layerGroup();
     this._palitrasLayerGroup.addTo(this._map);
     
     // Listen for zoom changes to show/hide points
     this._map.on('zoomend', () => {
       this._updatePalitraPointsOnMap();
     });
     
     // Try to update palitras if we already have data
     if (this._palitras.length > 0) {
       this._updatePalitrasOnMap();
     }
    }
  }

  private _initializeControls(map: L.Map, tileLayers: { openStreetMap: L.TileLayer, googleHybrid: L.TileLayer }) {
    const exitCallback = () => {
      const event = new CustomEvent('exit', {
        detail: {
        },
        bubbles: true,
        composed: true
      });
      this.dispatchEvent(event);
    }

    const palitraToggleCallback = (palitraId: number) => {
      const event = new CustomEvent('palitra-visibility-toggled', {
        detail: { palitraId },
        bubbles: true,
        composed: true
      });
      this.dispatchEvent(event);
    }

    const featureToggleCallback = (feature: FeatureName, enabled: boolean) => {
      const event = new CustomEvent('feature-toggle', {
        detail: { feature, enabled },
        bubbles: true,
        composed: true
      });
      this.dispatchEvent(event);
    }

    const switchTimeControl = createTimeswitchControl(this._daterange);
    map.addControl(switchTimeControl)

    map.addControl(createExitControl2(exitCallback));
    map.addControl(createLayerSwitchControl(tileLayers));
    map.addControl(createAttributionControl());
    
    const palitrasControl = createPalitrasControl(this._palitras, this._visiblePalitraIds, palitraToggleCallback);
    this._palitrasControl = palitrasControl;
    map.addControl(palitrasControl);

    const featuresControl = createFeaturesControl(this._getFeatureToggleState(), featureToggleCallback);
    this._featuresControl = featuresControl;
    map.addControl(featuresControl);
    
    return { map, switchTimeControl };
  }

  private _replacePointsOnMap(points: MapPointDetailed[]) {
    if (this._markersGroup) {
      this._markersGroup.off();
      this._markersGroup.eachLayer(l => l.off())
      this._map?.removeLayer(this._markersGroup)
    }
    const { bounds, markersGroup } = this._addPointsMarkersGroup(points);
    this._markersGroup = markersGroup;

    this._map?.addLayer(this._markersGroup)

    if (bounds.isValid() && !this._boundedAlready) {
      this._map?.fitBounds(bounds);
      this._boundedAlready = true;
    }

  }

  private _addPointsMarkersGroup(points: MapPointDetailed[]) {
    const markers = L.markerClusterGroup({
      maxClusterRadius: points.length > 100 ? 30 : 10,
      zoomToBoundsOnClick: false,
      spiderfyOnMaxZoom: false,
      iconCreateFunction: function(cluster) {
        const colors = cluster.isPopupOpen() ? "background-color: #fff;color:black;" : "background-color: #ED1C23; border: 1px solid #000;color: white;"
        const childCount = cluster.getChildCount();
        return L.divIcon({
          html: `<div style="${colors} border-radius: 50%; width: 17px; height: 17px; display: flex; align-items: center; justify-content: center; text-align: center;  font-size: 10px; line-height: 17px;">
                ${childCount}
            </div>`,
          className: '',
        });
      }
    });
    let bounds = L.latLngBounds(points);


    points.forEach(point => {
      const circle = new DataCircleMarker([point.lat, point.lng], { messageId: point.message_id }, {
        color: '#000',
        fillColor: '#ED1C23',
        fillOpacity: 1,
        radius: 4,
        weight: 1
      })

      circle.on('click', () => {
        this._emitLoadMessagesDescriptions([point.message_id])
        this._clickedPoint = circle;
      })
      circle.on('popupopen', () => {
        circle.setStyle({ fillColor: '#fff', color: "#000" })
      })
      circle.on('popupclose', () => {
        circle.setStyle({ fillColor: '#ED1C23', color: '#000' })
      })

      markers.addLayer(circle)
    });

    markers.on('clusterclick', (leafletEvent) => {
      const allChildMarkers = leafletEvent.layer.getAllChildMarkers();
      const messageIds = allChildMarkers.map(dataCircle => dataCircle.data.messageId)
      console.log(leafletEvent, 'leafletEvent')
      this._clickedPoint = leafletEvent.propagatedFrom
      this._emitLoadMessagesDescriptions(messageIds)
    });
    return {
      bounds,
      markersGroup: markers
    };
  }

  private _emitLoadMessagesDescriptions(messageIds: number[]) {
    const event = new CustomEvent('load-messages-description', {
      detail: {
        messageIds
      },
      bubbles: true,
      composed: true
    });
    this.dispatchEvent(event);

  }

  private _updatePalitrasOnMap() {
    if (!this._palitrasLayerGroup || !this._map) {
      return;
    }

    if (!this._palitrasEnabled) {
      this._palitrasLayerGroup.clearLayers();
      this._palitrasPointsClusters.forEach((cluster) => this._map!.removeLayer(cluster));
      this._palitrasPointsClusters.clear();
      return;
    }

    // Clear existing polygons
    this._palitrasLayerGroup.clearLayers();

    // Add visible palitras
    const visiblePalitras = this._palitras.filter(pd => 
      this._visiblePalitraIds.includes(pd.palitra.id) && pd.palitra.geometry
    );


    const polygons: L.Polygon[] = [];
    
    visiblePalitras.forEach(palitraDetails => {
      const polygon = this._createPalitraPolygon(palitraDetails);
      if (polygon) {
        this._palitrasLayerGroup!.addLayer(polygon);
        polygons.push(polygon);
      } else {
        console.log('❌ Polygon creation failed');
      }
    });

    // Update points clusters
    this._updatePalitraPointsOnMap();

    // Fit map bounds to show all visible palitras
    if (polygons.length > 0) {
      const group = L.featureGroup(polygons);
      this._map!.fitBounds(group.getBounds(), { 
        padding: [50, 50],
        maxZoom: 10 
      });
    }
  }

  private _createPalitraPolygon(palitraDetails: PalitraDetails): L.Polygon | null {
    const palitra = palitraDetails.palitra;
    
    if (!palitra.geometry || !palitra.geometry.perimeter_linear_ring) {
      return null;
    }

    // Convert coordinates to Leaflet format [lat, lng]
    const latlngs: [number, number][] = palitra.geometry.perimeter_linear_ring.map(
      (coord: { lat: number; lng: number }) => [coord.lat, coord.lng] as [number, number]
    );

    if (latlngs.length < 3) {
      return null; // Need at least 3 points for a polygon
    }

    // Create polygon with styling
    const polygon = L.polygon(latlngs, {
      color: palitra.color_hex,
      fillColor: palitra.color_hex,
      fillOpacity: 0.2,
      weight: 2,
      opacity: 0.8
    });

    // Add popup with palitra info
    const pointsCount = palitra.geometry.perimeter_linear_ring.length;
    // Swap lat/lng because they're reversed in the database
    const centerLat = palitra.geometry.center.lng.toFixed(4);
    const centerLng = palitra.geometry.center.lat.toFixed(4);
    
    const popupContent = `
      <div style="padding: 8px;">
        <div style="display: flex; align-items: center; gap: 8px; margin-bottom: 8px;">
          <span style="display: inline-block; width: 16px; height: 16px; background-color: ${palitra.color_hex}; border: 1px solid #ccc; border-radius: 3px;"></span>
          <strong style="font-size: 14px;">${palitra.name}</strong>
        </div>
        <div style="font-size: 12px; color: #666;">
          <div>Центр: ${centerLat}, ${centerLng}</div>
          <div>Точок периметру: ${pointsCount}</div>
          ${palitra.source_file_name ? `<div>Файл: ${palitra.source_file_name}</div>` : ''}
        </div>
      </div>
    `;
    
    polygon.bindPopup(popupContent);

    // Add tooltip with name (always visible)
    polygon.bindTooltip(palitra.name, {
      permanent: true,
      direction: 'center',
      className: 'palitra-label'
    });

    return polygon;
  }

  private _createPalitraPointsCluster(palitraDetails: PalitraDetails): L.MarkerClusterGroup | null {
    const palitra = palitraDetails.palitra;
    const points = palitraDetails.points;

    if (!points || points.length === 0) {
      return null;
    }

    // Create cluster group with custom styling
    const clusterGroup = L.markerClusterGroup({
      maxClusterRadius: 40,
      spiderfyOnMaxZoom: true,
      showCoverageOnHover: false,
      zoomToBoundsOnClick: true,
      iconCreateFunction: (cluster) => {
        const childCount = cluster.getChildCount();
        return L.divIcon({
          html: `<div style="background-color: ${palitra.color_hex}; border: 2px solid #fff; border-radius: 50%; width: 30px; height: 30px; display: flex; align-items: center; justify-content: center; text-align: center; font-size: 12px; font-weight: bold; color: white; box-shadow: 0 2px 4px rgba(0,0,0,0.3);">
                ${childCount}
            </div>`,
          className: 'palitra-point-cluster',
          iconSize: L.point(30, 30)
        });
      }
    });

    // Add points to cluster
    points.forEach(point => {
      const marker = L.circleMarker([point.coords.lat, point.coords.lng], {
        radius: 6,
        fillColor: palitra.color_hex,
        color: '#fff',
        weight: 2,
        opacity: 1,
        fillOpacity: 0.8
      });

      // Add popup with point info
      const popupContent = `
        <div style="padding: 8px;">
          <div style="display: flex; align-items: center; gap: 8px; margin-bottom: 8px;">
            <span style="display: inline-block; width: 16px; height: 16px; background-color: ${palitra.color_hex}; border: 1px solid #ccc; border-radius: 50%;"></span>
            <strong style="font-size: 14px;">${palitra.name}</strong>
          </div>
          ${point.label ? `<div style="font-size: 13px; margin-bottom: 4px;"><strong>Мітка:</strong> ${point.label}</div>` : ''}
          <div style="font-size: 12px; color: #666;">
            <div>Координати: ${point.coords.lat.toFixed(5)}, ${point.coords.lng.toFixed(5)}</div>
          </div>
        </div>
      `;
      
      marker.bindPopup(popupContent);

      // Add tooltip with label if exists
      const tooltipLabel = point.label ?? palitra.name;
      if (tooltipLabel) {
        marker.bindTooltip(tooltipLabel, {
          permanent: true,
          direction: 'top',
          offset: [0, -10],
          className: 'palitra-point-label'
        });
      }

      clusterGroup.addLayer(marker);
    });

    return clusterGroup;
  }

  private _updatePalitraPointsOnMap() {
    if (!this._map) {
      return;
    }

    // Remove all existing point clusters from map
    this._palitrasPointsClusters.forEach((cluster) => {
      this._map!.removeLayer(cluster);
    });
    this._palitrasPointsClusters.clear();

    if (!this._palitrasEnabled) {
      return;
    }

    // Check zoom level - only show points at close zoom levels
    const currentZoom = this._map.getZoom();
    if (currentZoom < this._minZoomForPoints) {
      // Too far out, don't show points
      return;
    }

    // Add point clusters for visible palitras
    const visiblePalitras = this._palitras.filter(pd => 
      this._visiblePalitraIds.includes(pd.palitra.id)
    );

    visiblePalitras.forEach(palitraDetails => {
      const cluster = this._createPalitraPointsCluster(palitraDetails);
      if (cluster) {
        this._palitrasPointsClusters.set(palitraDetails.palitra.id, cluster);
        this._map!.addLayer(cluster);
      }
    });
  }

  private _getFeatureToggleState(): FeatureToggleState {
    return {
      palitrasEnabled: this._palitrasEnabled,
      kmzEnabled: this._kmzEnabled,
      pelengsEnabled: this._pelengsEnabled
    };
  }

  private _updateFeaturesControl() {
    if (this._featuresControl) {
      this._featuresControl.updateFeatures(this._getFeatureToggleState());
    }
  }

  private async _loadKmzLayer() {
    if (!this._map || !this._kmzEnabled) {
      return;
    }

    if (this._kmzLayer) {
      this._kmzLayer.addTo(this._map);
      return;
    }

    if (this._kmzLoading) {
      await this._kmzLoading;
      return;
    }

    this._kmzLoading = (async () => {
      try {
        const kmzData = await loadKmzData();
        this._kmzLayer = kmzLayerFactory(null, { bindTooltip: true, bindPopup: false, permanentTooltip: true });
        if (this._map && this._kmzEnabled) {
          this._kmzLayer.addTo(this._map);
          this._kmzLayer.parse(kmzData, {});
        }
      } catch (e) {
        console.error('Failed to load KMZ data', e);
      } finally {
        this._kmzLoading = null;
      }
    })();

    await this._kmzLoading;
  }

  private _applyKmzVisibility() {
    if (!this._map) {
      return;
    }

    if (!this._kmzEnabled) {
      if (this._kmzLayer) {
        this._map.removeLayer(this._kmzLayer);
      }
      return;
    }

    this._loadKmzLayer();
  }
}

customElements.define('analysis-map', AnalysisMap)
