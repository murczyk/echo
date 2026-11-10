import { Tooltip, useMediaQuery } from '@mui/material';
import { useTheme } from '@mui/material/styles';
import { useEffect, useRef, useState, type ReactNode } from 'react';

import { copyTextToClipboard } from '../../../../copy-to-clipboard';
import { useOptionalPowerSnackbar } from '../../../components/PowerSnackbar';

const FEEDBACK_MS = 1500;
const TITLES = {
  idle: 'копіювати',
  copied: 'Скопійовано',
  failed: 'Не вдалося скопіювати',
};

// A value that is copied to the clipboard when clicked. The tooltip says whether it worked, for a moment. On a phone
// (below `sm`, like the rest of the page) a snackbar says so too, as when a message is copied elsewhere in echo: a touch
// screen has no hover, so the snackbar is what tells a reader that the tap copied something.
export function CopyValue({
  text,
  className,
  children,
  ...dataAttributes
}: {
  text: string;
  className?: string;
  children: ReactNode;
  [dataAttribute: `data-${string}`]: string | boolean | undefined;
}) {
  const [status, setStatus] = useState<keyof typeof TITLES>('idle');
  const timerRef = useRef<number | null>(null);
  const { notify: snackbar } = useOptionalPowerSnackbar();
  const phone = useMediaQuery(useTheme().breakpoints.down('sm'));
  const notify: typeof snackbar = (notification) => (phone ? snackbar(notification) : 0);
  useEffect(
    () => () => {
      if (timerRef.current != null) window.clearTimeout(timerRef.current);
    },
    [],
  );

  const show = (next: 'copied' | 'failed') => {
    setStatus(next);
    if (timerRef.current != null) window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => setStatus('idle'), FEEDBACK_MS);
  };

  return (
    <Tooltip title={TITLES[status]} open={status === 'idle' ? undefined : true}>
      <button
        type="button"
        className={`cursor-pointer text-start ${className ?? ''}`}
        onClick={(event) => {
          // Copying a value in a table row must not select the row.
          event.stopPropagation();
          copyTextToClipboard(text).then(
            () => {
              show('copied');
              notify({ severity: 'success', message: 'Скопійовано.' });
            },
            () => {
              show('failed');
              notify({ severity: 'error', message: 'Не вдалося скопіювати.' });
            },
          );
        }}
        {...dataAttributes}
      >
        {children}
      </button>
    </Tooltip>
  );
}
