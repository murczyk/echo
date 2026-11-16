import { createContext } from 'react';

/** Duty-only user choices that hide parts of the message card. */
export type DutyMessageCardVisibility = {
  /** Hides the header's identity block; actions and the important badge stay. */
  hideHeader: boolean;
  hideFrequency: boolean;
  hideUnit: boolean;
};

export const DEFAULT_DUTY_MESSAGE_CARD_VISIBILITY: DutyMessageCardVisibility = {
  hideHeader: false,
  hideFrequency: false,
  hideUnit: false,
};

export const DutyMessageCardVisibilityContext = createContext<DutyMessageCardVisibility>(
  DEFAULT_DUTY_MESSAGE_CARD_VISIBILITY,
);
