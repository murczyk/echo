import * as L from 'leaflet';
import type { AiAgentMapDocument } from '../../../../Bindings';
import type { BaseLayerId } from '../../../maps/base-layers';
import { MessageCardMapPreview } from '../shared/message-card/MessageCardMapPreview';

export default function MapCanvas({
  document,
  baseLayerId,
  onSelect,
}: {
  document: AiAgentMapDocument;
  baseLayerId: BaseLayerId;
  onSelect: (index: number) => void;
}) {
  return (
    <MessageCardMapPreview
      baseLayerId={baseLayerId}
      dataAttributes={{ 'data-testid': 'ai-map-canvas' }}
      onMapReady={(map) => {
        const markers = document.records.flatMap((record, index) => {
          if (record.latitude == null || record.longitude == null) return [];
          const icon = L.icon({
            iconUrl: `/img/google_earth_icons/${record.sidc}.png`,
            iconSize: [32, 32],
            iconAnchor: [16, 16],
          });
          return [
            L.marker([record.latitude, record.longitude], {
              icon,
              title: record.name,
              alt: record.name,
              keyboard: true,
            })
              .on('add', function () {
                const element = this.getElement();
                element?.addEventListener(
                  'error',
                  () => {
                    if (element instanceof HTMLImageElement)
                      element.src = '/img/google_earth_icons/10061000001211020000.png';
                  },
                  { once: true },
                );
              })
              .on('click', () => onSelect(index))
              .on('keydown', (event) => {
                const keyboard = event.originalEvent;
                if (keyboard.key === 'Enter' || keyboard.key === ' ') {
                  keyboard.preventDefault();
                  keyboard.stopPropagation();
                  onSelect(index);
                }
              }),
          ];
        });
        const group = L.featureGroup(markers).addTo(map);
        if (markers.length)
          map.fitBounds(group.getBounds(), { padding: [24, 24], maxZoom: 14, animate: false });
        else map.setView([48, 31], 6);
        return () => group.remove();
      }}
    />
  );
}
