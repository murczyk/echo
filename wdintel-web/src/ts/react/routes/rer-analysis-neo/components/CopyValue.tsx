import { Tooltip } from '@mui/material';
import { useEffect, useRef, useState, type ReactNode } from 'react';

import { copyTextToClipboard } from '../../../../copy-to-clipboard';

const FEEDBACK_MS = 1500;
const TITLES = {
  idle: 'копіювати',
  copied: 'Скопійовано',
  failed: 'Не вдалося скопіювати',
};

// A value that is copied to the clipboard when clicked. The tooltip says whether it worked, for a moment.
export function CopyValue({
  text,
  className,
  children,
}: {
  text: string;
  className?: string;
  children: ReactNode;
}) {
  const [status, setStatus] = useState<keyof typeof TITLES>('idle');
  const timerRef = useRef<number | null>(null);
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
            () => show('copied'),
            () => show('failed'),
          );
        }}
      >
        {children}
      </button>
    </Tooltip>
  );
}
