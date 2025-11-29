import * as L from 'leaflet';

import "leaflet.markercluster/dist/MarkerCluster.css"
import "leaflet.markercluster/dist/leaflet.markercluster.js"
import {loadKmzData} from '../maps/maps'
import {KMZLayer, kmzLayerFactory} from '../maps/leaflet-kmz'
import {MapPointDetailed} from '../maps/types';
import {messagesCountText} from '../maps/language-utils';
import {
    createAttributionControl,
    createExitControl2,
    createLayerSwitchControl,
    createTimeswitchControl,
    TimeswitchControl
} from '../maps/controls';

type NetworkUnit = { frequencies: string[]; name: string }
type Message = [number, {
    message_uid: string;
    freq: string;
    coords: number[],
    text: string,
    date: number,
    time: number,
    unit: string
}]

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
    return {openStreetMap, googleHybrid}
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
            ${message_[1].message_uid ?`<p style="line-height: 22px;"><span style="font-weight: 700;">Посилання: </span><a href="${updateStateUrl(window.location.href, message_[1].message_uid)}">${message_[1].message_uid}</a></p>`: ''}
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
    static observedAttributes = ["points", "daterange", "messages", "visibility", "network-units", "selected-units"]

    private _map: L.Map | null = null;
    private _daterange: { startDate: number, endDate: number } = {
        startDate: new Date().getDate(),
        endDate: new Date().getDate()
    };
    private _switchTimeControl: TimeswitchControl | null = null;
    private _points: MapPointDetailed[] = []
    private _messages: Message[] = [];
    private _networkUnits: NetworkUnit[] = [];

    private _markersGroup: L.MarkerClusterGroup | null = null;
    private _clickedPoint: DataCircleMarker | null = null;
    private _boundedAlready = false;
    private _initialized = false;
    private _kmzLayer: KMZLayer | null = null;
    private _selectedUnits: string[] = []

    constructor() {
        super();
    }

    connectedCallback() {
    }

    disconnectedCallback() {
    }

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

            const map = L.map(mapContainer, {
                zoomControl: false,
                attributionControl: false,
                layers: Object.values(tileLayers)
            }).setView([47.42135, 35.62197], 8);

            const result = this._initializeControls(map, tileLayers)
            this._map = result.map;
            this._switchTimeControl = result.switchTimeControl;

            //TODO: remove
            if (!window.location.hostname.includes('echo-soledarnist')) {

                const kmzData = await loadKmzData();
                this._kmzLayer = kmzLayerFactory(null, {bindTooltip: true, bindPopup: false, permanentTooltip: true})
                this._kmzLayer.addTo(this._map);
                this._kmzLayer.parse(kmzData, {})
            }
        }
    }

    private _initializeControls(map: L.Map, tileLayers: { openStreetMap: L.TileLayer, googleHybrid: L.TileLayer }) {
        const exitCallback = () => {
            const event = new CustomEvent('exit', {
                detail: {},
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
        return {map, switchTimeControl};
    }

    private _replacePointsOnMap(points: MapPointDetailed[]) {
        if (this._markersGroup) {
            this._markersGroup.off();
            this._markersGroup.eachLayer(l => l.off())
            this._map?.removeLayer(this._markersGroup)
        }
        const {bounds, markersGroup} = this._addPointsMarkersGroup(points);
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
            iconCreateFunction: function (cluster) {
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
            const circle = new DataCircleMarker([point.lat, point.lng], {messageId: point.message_id}, {
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
                circle.setStyle({fillColor: '#fff', color: "#000"})
            })
            circle.on('popupclose', () => {
                circle.setStyle({fillColor: '#ED1C23', color: '#000'})
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
}

function updateStateUrl(currentUrl: string, messageUid: string): string {
    try {
        const url = new URL(currentUrl);
        const stateParam = url.searchParams.get('state');
        let stateObject;
        if (stateParam) {
            const decodedState = decodeURIComponent(stateParam);
            stateObject = JSON.parse(decodedState);
        } else {
            stateObject = {};
        }
        stateObject.search = messageUid;
        const updatedState = JSON.stringify(stateObject);
        url.searchParams.set('state', updatedState);
        return url.href;
    } catch (error) {
        console.error("Error updating URL state:", error);
        return currentUrl;
    }
}

customElements.define('analysis-map', AnalysisMap)
