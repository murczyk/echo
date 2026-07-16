import { Box, type BoxProps } from '@mui/material';
import {
  useEffect,
  useRef,
  type FormEvent,
  type FormEventHandler,
  type KeyboardEventHandler,
} from 'react';

import {
  getFormKeyboardSubmitHandler,
  preventFormSubmitFromKeyboard,
} from '../utils/formKeyboardSubmit';

type PowerFormProps = Omit<BoxProps<'form'>, 'component' | 'onSubmit' | 'onKeyDown'> & {
  onSubmit: FormEventHandler<HTMLFormElement>;
  canSubmit?: boolean | (() => boolean);
  keyboardSubmit?: boolean;
  /**
   * When true, Cmd/Ctrl+Enter submits the form from anywhere on the page while it is
   * mounted, even when focus is outside any field (e.g. right after pasting an
   * attachment). In-field key handling is unchanged; this only adds a global fallback.
   */
  globalSubmitShortcut?: boolean;
  onKeyDown?: KeyboardEventHandler<HTMLFormElement>;
};

function resolveCanSubmit(canSubmit: boolean | (() => boolean)): boolean {
  return typeof canSubmit === 'function' ? canSubmit() : canSubmit;
}

export function PowerForm(props: PowerFormProps) {
  const {
    canSubmit = true,
    keyboardSubmit = true,
    globalSubmitShortcut = false,
    onSubmit,
    onKeyDown,
    ...rest
  } = props;
  const formRef = useRef<HTMLFormElement>(null);

  useEffect(() => {
    if (!globalSubmitShortcut) return;
    const handleGlobalSubmit = (event: globalThis.KeyboardEvent) => {
      if (event.defaultPrevented || event.key !== 'Enter') return;
      if (!(event.metaKey || event.ctrlKey) || event.shiftKey || event.altKey) return;
      if (!resolveCanSubmit(canSubmit)) return;
      event.preventDefault();
      formRef.current?.requestSubmit();
    };
    window.addEventListener('keydown', handleGlobalSubmit);
    return () => window.removeEventListener('keydown', handleGlobalSubmit);
  }, [globalSubmitShortcut, canSubmit]);
  const handleSubmit: FormEventHandler<HTMLFormElement> = (event: FormEvent<HTMLFormElement>) => {
    if (!resolveCanSubmit(canSubmit)) {
      event.preventDefault();
      return;
    }

    onSubmit(event);
  };
  const handleKeyDown: KeyboardEventHandler<HTMLFormElement> | undefined = keyboardSubmit
    ? (event) => {
        onKeyDown?.(event);
        if (event.defaultPrevented) return;
        getFormKeyboardSubmitHandler(canSubmit)(event);
      }
    : (event) => {
        onKeyDown?.(event);
        if (event.defaultPrevented) return;
        preventFormSubmitFromKeyboard(event);
      };

  return (
    <Box
      {...rest}
      ref={formRef}
      component="form"
      onSubmit={handleSubmit}
      onKeyDown={handleKeyDown}
    />
  );
}
