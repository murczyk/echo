import { Box, type BoxProps } from '@mui/material';
import {
  useEffect,
  useRef,
  type FocusEventHandler,
  type FormEvent,
  type FormEventHandler,
  type KeyboardEventHandler,
  type PointerEventHandler,
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
   * When true, Cmd/Ctrl+Enter submits after the user has interacted with this form,
   * including when focus temporarily moves to the page body after a file paste.
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
    onFocusCapture,
    onPointerDownCapture,
    ...rest
  } = props;
  const formRef = useRef<HTMLFormElement>(null);
  const ownsGlobalShortcutRef = useRef(false);

  useEffect(() => {
    if (!globalSubmitShortcut) {
      ownsGlobalShortcutRef.current = false;
      return;
    }
    const updateOwnership = (event: Event) => {
      const form = formRef.current;
      ownsGlobalShortcutRef.current = Boolean(
        form && event.target instanceof Node && form.contains(event.target),
      );
    };
    const handleGlobalSubmit = (event: globalThis.KeyboardEvent) => {
      if (event.defaultPrevented || event.key !== 'Enter') return;
      if (!(event.metaKey || event.ctrlKey) || event.shiftKey || event.altKey) return;
      const form = formRef.current;
      if (!form) return;
      if (!form.contains(document.activeElement) && !ownsGlobalShortcutRef.current) return;
      if (!resolveCanSubmit(canSubmit)) return;
      event.preventDefault();
      form.requestSubmit();
    };
    document.addEventListener('pointerdown', updateOwnership, true);
    document.addEventListener('focusin', updateOwnership, true);
    window.addEventListener('keydown', handleGlobalSubmit);
    return () => {
      document.removeEventListener('pointerdown', updateOwnership, true);
      document.removeEventListener('focusin', updateOwnership, true);
      window.removeEventListener('keydown', handleGlobalSubmit);
    };
  }, [globalSubmitShortcut, canSubmit]);
  const handleFocusCapture: FocusEventHandler<HTMLFormElement> = (event) => {
    ownsGlobalShortcutRef.current = true;
    onFocusCapture?.(event);
  };
  const handlePointerDownCapture: PointerEventHandler<HTMLFormElement> = (event) => {
    ownsGlobalShortcutRef.current = true;
    onPointerDownCapture?.(event);
  };
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
      onFocusCapture={handleFocusCapture}
      onPointerDownCapture={handlePointerDownCapture}
    />
  );
}
