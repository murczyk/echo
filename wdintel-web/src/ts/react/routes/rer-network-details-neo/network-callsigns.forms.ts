import {
  NetworkCallsignSourceId,
  type NetworkCallsignDrawerForm,
  type NetworkCallsignMarkerMode,
  type NetworkCallsignRowView,
} from './network-callsigns.types';
import { normalizeCallsignDisplay } from './network-callsigns.utils';

export function getNetworkCallsignMarkerMode(
  networkCallsign: Pick<NetworkCallsignDrawerForm, 'mainRadioStation' | 'commandControl'>,
): NetworkCallsignMarkerMode {
  if (networkCallsign.mainRadioStation) return 'mainRadioStation';
  if (networkCallsign.commandControl) return 'commandControl';
  return 'none';
}

export function getNetworkCallsignMarkerState(markerMode: NetworkCallsignMarkerMode) {
  if (markerMode === 'mainRadioStation') {
    return { mainRadioStation: true, commandControl: false };
  }

  if (markerMode === 'commandControl') {
    return { mainRadioStation: false, commandControl: true };
  }

  return { mainRadioStation: false, commandControl: false };
}

export function hasNetworkCallsignMarker(
  networkCallsign: Pick<NetworkCallsignDrawerForm, 'mainRadioStation' | 'commandControl'>,
): boolean {
  return networkCallsign.mainRadioStation || networkCallsign.commandControl;
}

export function createDefaultNetworkCallsignDrawerForm(
  networkId: number,
  unitId: number | null,
): NetworkCallsignDrawerForm {
  return {
    id: null,
    networkId,
    callsign: '',
    position: '',
    comment: '',
    sourceId: null,
    radioFreq: '',
    unitId,
    unitDeveloping: false,
    developing: true,
    mainRadioStation: false,
    commandControl: false,
  };
}

export function isNetworkCallsignSourceRequired(
  form: Pick<NetworkCallsignDrawerForm, 'developing'>,
): boolean {
  return !form.developing;
}

export function createNetworkCallsignDrawerForm(
  networkId: number,
  networkCallsign: NetworkCallsignRowView,
): NetworkCallsignDrawerForm {
  return {
    id: networkCallsign.id,
    networkId,
    callsign: networkCallsign.callsign,
    position: networkCallsign.position,
    comment: networkCallsign.comment,
    sourceId: networkCallsign.sourceId,
    radioFreq: networkCallsign.radioFreq ?? '',
    unitId: networkCallsign.unitId,
    unitDeveloping: networkCallsign.unitDeveloping,
    developing: networkCallsign.developing,
    // Ensure markers are exclusive in the drawer form: prefer `commandControl` when
    // both flags are present on an existing record, otherwise use the canonical mode.
    ...(() => {
      const mode =
        networkCallsign.mainRadioStation && networkCallsign.commandControl
          ? 'commandControl'
          : getNetworkCallsignMarkerMode(networkCallsign);
      const state = getNetworkCallsignMarkerState(mode);
      return { mainRadioStation: state.mainRadioStation, commandControl: state.commandControl };
    })(),
  };
}

export function getNetworkCallsignDrawerSaveError(
  form: NetworkCallsignDrawerForm | null,
): string | null {
  if (!form) return null;

  const callsign = normalizeCallsignDisplay(form.callsign);
  if (callsign === '') return 'Позивний є обовʼязковим';
  if (isNetworkCallsignSourceRequired(form) && form.sourceId === null)
    return 'Джерело є обовʼязковим';
  if (form.sourceId === NetworkCallsignSourceId.RO && form.radioFreq.trim() === '') {
    return 'Для джерела "РО" частота є обовʼязковою';
  }

  return null;
}
