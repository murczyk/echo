import L from 'leaflet';
import * as _ from './leaflet-utils'

interface KMZLayerOptions extends L.LayerOptions {
  interactive: boolean;
  ballon: boolean;
  bindPopup: boolean;
  bindTooltip: boolean;
  preferCanvas: boolean;
  permanentTooltip: boolean;
}


export class KMZLayer extends L.FeatureGroup {
  options: KMZLayerOptions = {
    interactive: true,
    ballon: true,
    bindPopup: true,
    bindTooltip: true,
    preferCanvas: false,
    permanentTooltip: false
  };
  defaultStrokeWidth = 2;

  constructor(kmzUrl: string | null, options?: Partial<KMZLayerOptions>) {
    super();
    L.Util.setOptions(this, options);
    this.options = {
      interactive: true,
      ballon: true,
      bindPopup: true,
      bindTooltip: true,
      preferCanvas: false,
      permanentTooltip: false,
      ...options
    };

    if (L.Browser.mobile) this.options.bindTooltip = false;

    if (kmzUrl) this.load(kmzUrl);
  }

  add(kmzUrl: string): void {
    this.load(kmzUrl);
  }
  load(kmzUrl: string): void {
    _.loadFile(kmzUrl)
      .then((data) => this.parse(data, { name: _.getFileName(kmzUrl), icons: {} }));
  }

  parse(data: string, props: any): Promise<void> {
    return _.isZipped(data) ? this._parseKMZ(data, props) : this._parseKML(data, props);
  }

  private async _parseKMZ(data: string, props: any): Promise<void> {
    const kmzFiles = await _.unzip(data);
    const kmlDoc = _.getKmlDoc(kmzFiles);
    const images = _.getImageFiles(Object.keys(kmzFiles));

    const kmlString = kmzFiles[kmlDoc];
    props.icons = images.reduce((obj: Record<string, string>, item: string) => {
      obj[item] = kmzFiles[item];
      return obj;
    }, {});

    await this._parseKML(kmlString, props);
  }

  private _parseKML(data: string, props: any): Promise<void> {
    const xml = _.toXML(data);
    const geojson = _.toGeoJSON(xml, props);

    const layer = this._geometryToLayer(geojson, xml);
    this.addLayer(layer);
    this.fire('load', { layer: layer });
    return Promise.resolve();
  }

  private _geometryToLayer(data: GeoJSON.FeatureCollection<GeoJSON.Geometry | null, GeoJSON.GeoJsonProperties>, _: XMLDocument): L.Layer {
    const emptyIcon = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg'/%3E";
    const markersLayer = L.featureGroup();
    const MIN_ZOOM_TO_SHOW_FULLSCREEN = 11;
    const MIN_ZOOM_TO_SHOW = 10;

    const geoJsonLayer = L.geoJson(data, {
      pointToLayer: (feature, latlng) => {
        let marker: L.Layer;
        marker = L.marker(latlng, {
          icon: L.icon({
            iconUrl: feature.properties.icon || emptyIcon,
            iconSize: [17, 17],
            iconAnchor: [9, 9],
          }),
          interactive: this.options.interactive,
        });
        if (feature.properties.icon) {
          markersLayer.addLayer(marker);
          return L.marker(latlng, {
            icon: L.icon({
              iconUrl: emptyIcon,
              iconSize: [17, 17],
              iconAnchor: [9, 9],
            }),
            interactive: this.options.interactive,
          });

        } else {
          return marker;
        }
      },
      style: (feature) => {
        const styles: { stroke?: boolean; color?: string; fill?: boolean; fillColor?: string; opacity?: number; fillOpacity?: number; weight?: number } = {};
        if (feature) {
          const prop = feature.properties;
          if (prop.stroke) {
            styles.stroke = true;
            styles.color = prop.stroke;
          }
          if (prop.fill) {
            styles.fill = true;
            styles.fillColor = prop.fill;
          } else {
            styles.fill = true;
            styles.fillColor = prop.stroke;
          }
          if (prop["stroke-opacity"]) {
            styles.opacity = prop["stroke-opacity"];
          }
          if (prop["fill-opacity"]) {
            styles.fillOpacity = prop["fill-opacity"];
          }
          if (prop["stroke-width"]) {
            this.defaultStrokeWidth = prop["stroke-width"]
            styles.weight = Math.floor(this.defaultStrokeWidth / 2);
          }
        }
        styles.opacity = 0.3

        return styles
      },
      onEachFeature: (feature, layer) => {
        if (!this.options.ballon) return;

        let prop = feature.properties;
        let name = prop.name || "";
        let desc = prop.description || "";

        if (name || desc) {
          if (this.options.bindPopup) {
            layer.bindPopup('<div>' + '<b>' + name + '</b>' + '<br>' + desc + '</div>');
          }
          if (this.options.bindTooltip) {
            layer.bindTooltip('<b>' + name + '</b>', {
              permanent: this.options.permanentTooltip,
              direction: 'center',
              opacity: 0
            });
          }
        }

      },

      interactive: this.options.interactive,
    });

    const onZoomChange = () => {
      let currentZoom = this._map.getZoom();
      let newStrokeWidth;
      const mapContainer = this._map.getContainer();

      const zoomTrashold = this._map.getSize().x > 250 ? MIN_ZOOM_TO_SHOW_FULLSCREEN : MIN_ZOOM_TO_SHOW
      if (currentZoom >= zoomTrashold) {
        newStrokeWidth = this.defaultStrokeWidth;
        if (!this._map.hasLayer(markersLayer)) {
          this._map.addLayer(markersLayer);
        }
      } else {

        newStrokeWidth = Math.floor(this.defaultStrokeWidth / 2)
        if (this._map.hasLayer(markersLayer)) {
          this._map.removeLayer(markersLayer)
        }
      }
      geoJsonLayer.setStyle({ weight: newStrokeWidth })
      geoJsonLayer.eachLayer(layer => {
        if (mapContainer.classList.contains("expanded")) {
        }
        if (currentZoom >= zoomTrashold) {
          layer.getTooltip()?.setOpacity(0.9)
        } else {
          layer.getTooltip()?.setOpacity(0);
        }
      });
    }
    this._map.on('zoomend', onZoomChange);
    return geoJsonLayer;
  }
}

export const kmzLayerFactory = (url: string | null, options?: Partial<KMZLayerOptions>) => {
  return new KMZLayer(url, options);
}
