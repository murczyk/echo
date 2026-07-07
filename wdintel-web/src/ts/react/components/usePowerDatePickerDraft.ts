import { useEffect, useLayoutEffect, useRef, useState } from 'react';

type UsePowerDatePickerDraftParams<TValue> = {
  value: TValue;
  allowEmpty: boolean;
  manualInputDebounceMs: number;
  selectedSections: unknown;
  onChange: (nextValue: TValue) => void;
  onAccept?: (nextValue: TValue) => void;
  onOpen?: () => void;
  onClose?: () => void;
  isValidValue: (value: TValue) => boolean;
};

type UsePowerDatePickerDraftResult<TValue> = {
  open: boolean;
  draftValue: TValue;
  handleOpen: () => void;
  handleClose: () => void;
  handleAccept: () => void;
  handleSelectedSectionsChange: (nextSelectedSections: unknown) => void;
  handleChange: (value: TValue, context: { validationError: unknown }) => void;
};

export function usePowerDatePickerDraft<TValue>({
  value,
  allowEmpty,
  manualInputDebounceMs,
  selectedSections,
  onChange,
  onAccept,
  onOpen,
  onClose,
  isValidValue,
}: UsePowerDatePickerDraftParams<TValue>): UsePowerDatePickerDraftResult<TValue> {
  const [open, setOpen] = useState(false);
  const [draftValue, setDraftValue] = useState(value);
  const debounceTimerRef = useRef<number | null>(null);
  const pendingValueRef = useRef<TValue | null>(null);
  const acceptingRef = useRef(false);
  const selectedSectionsRef = useRef<unknown>(selectedSections ?? null);

  useEffect(() => {
    selectedSectionsRef.current = selectedSections ?? null;
  }, [selectedSections]);

  useEffect(
    () => () => {
      if (debounceTimerRef.current != null) {
        window.clearTimeout(debounceTimerRef.current);
        debounceTimerRef.current = null;
      }
      pendingValueRef.current = null;
    },
    [],
  );

  useLayoutEffect(() => {
    if (value != null) return;
    clearPendingChange();
  }, [value]);

  const syncDraftFromControlledValueIfIdle = () => {
    if (open) return;
    if (selectedSectionsRef.current != null) return;
    if (debounceTimerRef.current != null) return;

    setDraftValue(value);
  };

  useEffect(() => {
    syncDraftFromControlledValueIfIdle();
  }, [open, value]);

  const clearPendingChange = () => {
    if (debounceTimerRef.current != null) {
      window.clearTimeout(debounceTimerRef.current);
      debounceTimerRef.current = null;
    }
    pendingValueRef.current = null;
  };

  const flushPendingChange = () => {
    if (debounceTimerRef.current == null || pendingValueRef.current == null) return;

    window.clearTimeout(debounceTimerRef.current);
    debounceTimerRef.current = null;
    const pendingValue = pendingValueRef.current;
    pendingValueRef.current = null;
    onChange(pendingValue);
  };

  const scheduleManualChange = (nextValue: TValue) => {
    clearPendingChange();
    pendingValueRef.current = nextValue;
    debounceTimerRef.current = window.setTimeout(() => {
      const pendingValue = pendingValueRef.current;
      debounceTimerRef.current = null;
      pendingValueRef.current = null;
      if (pendingValue != null) {
        onChange(pendingValue);
      }
    }, manualInputDebounceMs);
  };

  const handleOpen = () => {
    const pendingValue = pendingValueRef.current;
    flushPendingChange();
    setDraftValue(pendingValue ?? value);
    setOpen(true);
    onOpen?.();
  };

  const handleClose = () => {
    setOpen(false);
    if (!acceptingRef.current) {
      clearPendingChange();
      setDraftValue(value);
    }
    acceptingRef.current = false;
    onClose?.();
  };

  const handleAccept = () => {
    acceptingRef.current = true;
    clearPendingChange();
    const nextValue = draftValue;
    setOpen(false);
    if (nextValue == null) {
      if (allowEmpty) onChange(nextValue);
      return;
    }
    if (!isValidValue(nextValue)) return;
    onChange(nextValue);
    onAccept?.(nextValue);
  };

  const handleSelectedSectionsChange = (nextSelectedSections: unknown) => {
    const previousSelectedSections = selectedSectionsRef.current;
    selectedSectionsRef.current = nextSelectedSections;
    if (
      previousSelectedSections != null &&
      nextSelectedSections == null &&
      !open &&
      debounceTimerRef.current == null
    ) {
      setDraftValue(value);
    }
  };

  const handleChange = (nextValue: TValue, context: { validationError: unknown }) => {
    if (context.validationError != null) return;
    if (nextValue == null) {
      clearPendingChange();
      setDraftValue(nextValue);
      if (allowEmpty) onChange(nextValue);
      return;
    }
    if (!isValidValue(nextValue)) return;
    if (selectedSectionsRef.current != null) {
      setDraftValue(nextValue);
      scheduleManualChange(nextValue);
      return;
    }
    if (open) {
      setDraftValue(nextValue);
      return;
    }
    setDraftValue(nextValue);
    onChange(nextValue);
  };

  return {
    open,
    draftValue,
    handleOpen,
    handleClose,
    handleAccept,
    handleSelectedSectionsChange,
    handleChange,
  };
}
