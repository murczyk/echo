import { Box, type BoxProps } from '@mui/material';
import type { FormEvent, FormEventHandler, KeyboardEventHandler } from 'react';

import {
  getFormKeyboardSubmitHandler,
  preventFormSubmitFromKeyboard,
} from '../utils/formKeyboardSubmit';

type PowerFormProps = Omit<BoxProps<'form'>, 'component' | 'onSubmit' | 'onKeyDown'> & {
  onSubmit: FormEventHandler<HTMLFormElement>;
  canSubmit?: boolean | (() => boolean);
  keyboardSubmit?: boolean;
  onKeyDown?: KeyboardEventHandler<HTMLFormElement>;
};

function resolveCanSubmit(canSubmit: boolean | (() => boolean)): boolean {
  return typeof canSubmit === 'function' ? canSubmit() : canSubmit;
}

export function PowerForm(props: PowerFormProps) {
  const { canSubmit = true, keyboardSubmit = true, onSubmit, onKeyDown, ...rest } = props;
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

  return <Box {...rest} component="form" onSubmit={handleSubmit} onKeyDown={handleKeyDown} />;
}
