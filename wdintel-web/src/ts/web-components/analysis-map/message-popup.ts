import * as L from 'leaflet';

import { getPointPopupTemplate } from './popup-template';
import { DataCircleMarker, Message, NetworkUnit } from './types';

type OpenMessagePopupOptions = {
  map: L.Map | null;
  clickedPoint: DataCircleMarker | null;
  clickedLatLng: L.LatLng | null;
  preferClickedLatLng: boolean;
  messages: Message[];
  networkUnits: NetworkUnit[];
  selectedUnits: string[];
  findPointMarkerByMessageId: (messageId: number) => DataCircleMarker | null;
  onUnitClicked: (networkUnitName: string | null) => void;
  hasMoreMessages?: boolean;
  onLoadMoreMessages?: () => void;
  contextTitle?: string;
  battleLineDistances?: ReadonlyMap<number, number>;
  setClickedState: (clickedPoint: DataCircleMarker | null, clickedLatLng: L.LatLng | null) => void;
};

export function openMessagesPopup({
  map,
  clickedPoint,
  clickedLatLng,
  preferClickedLatLng,
  messages,
  networkUnits,
  selectedUnits,
  findPointMarkerByMessageId,
  onUnitClicked,
  hasMoreMessages = false,
  onLoadMoreMessages,
  contextTitle,
  battleLineDistances = new Map(),
  setClickedState,
}: OpenMessagePopupOptions): boolean {
  if ((!clickedPoint && !clickedLatLng) || messages.length === 0) {
    return false;
  }

  const sortedMessages = [...messages].sort((message1, message2) => {
    const datetime1 = new Date(`${message1[1].date}T${message1[1].time} `);
    const datetime2 = new Date(`${message2[1].date}T${message2[1].time} `);
    return datetime2.getTime() - datetime1.getTime();
  });
  const popupContent = getPointPopupTemplate(
    sortedMessages,
    selectedUnits,
    hasMoreMessages,
    contextTitle,
    battleLineDistances,
  );
  const clickedMessageId = sortedMessages[0]?.[0];
  const isCluster = sortedMessages.length > 1;
  const clickedPointOnMap =
    !preferClickedLatLng && clickedPoint && clickedPoint.getElement() !== null
      ? clickedPoint
      : null;
  const restoredPoint =
    clickedPointOnMap ??
    (!preferClickedLatLng && !isCluster && clickedMessageId !== undefined
      ? findPointMarkerByMessageId(clickedMessageId)
      : null);
  const canOpenOnRestoredPoint = restoredPoint ? restoredPoint.getElement() !== null : false;
  const popupOptions = { offset: L.point(1, 3) };

  if (restoredPoint && canOpenOnRestoredPoint) {
    setClickedState(restoredPoint, restoredPoint.getLatLng());
    restoredPoint.bindPopup(popupContent, popupOptions);
    restoredPoint.openPopup();
  } else if (map && clickedLatLng) {
    L.popup(popupOptions).setLatLng(clickedLatLng).setContent(popupContent).openOn(map);
    setClickedState(null, clickedLatLng);
  } else {
    return false;
  }

  bindPopupUnitClickHandlers({
    map,
    clickedPoint: restoredPoint && canOpenOnRestoredPoint ? restoredPoint : null,
    onUnitClicked,
    onLoadMoreMessages,
    setClickedState,
  });

  return true;
}

function bindPopupUnitClickHandlers({
  map,
  clickedPoint,
  onUnitClicked,
  onLoadMoreMessages,
  setClickedState,
}: {
  map: L.Map | null;
  clickedPoint: DataCircleMarker | null;
  onUnitClicked: (networkUnitName: string | null) => void;
  onLoadMoreMessages?: () => void;
  setClickedState: (clickedPoint: DataCircleMarker | null, clickedLatLng: L.LatLng | null) => void;
}): void {
  const elements = document.querySelectorAll('[id^="map-message-id-"]');
  const handlersMap = new Map<string, () => void>();
  const loadMoreButton = document.querySelector<HTMLElement>(
    '[data-map-settlement-messages-load-more]',
  );
  const handleLoadMore = () => onLoadMoreMessages?.();
  loadMoreButton?.addEventListener('click', handleLoadMore);

  elements.forEach((element) => {
    const handleClick = () => {
      onUnitClicked(element.getAttribute('data-unitname'));
      if (clickedPoint) {
        clickedPoint.closePopup();
      } else {
        map?.closePopup();
      }
      setClickedState(null, null);
    };
    element.addEventListener('click', handleClick);
    handlersMap.set(element.id, handleClick);
  });

  const clearPopupHandlers = () => {
    loadMoreButton?.removeEventListener('click', handleLoadMore);
    elements.forEach((element) => {
      const handler = handlersMap.get(element.id);
      if (handler) {
        element.removeEventListener('click', handler);
        handlersMap.delete(element.id);
      }
    });
    setClickedState(null, null);
  };

  if (clickedPoint) {
    clickedPoint.once('popupclose', clearPopupHandlers);
  } else if (map) {
    map.once('popupclose', clearPopupHandlers);
  }
}
