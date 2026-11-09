import CloseIcon from '@mui/icons-material/Close';
import { Dialog, Typography } from '@mui/material';
import { useId, type ReactNode } from 'react';
import { PowerIconButton } from '../../../components/PowerIconButton';

export function DeviceMobileSheet({
  open,
  title,
  onClose,
  children,
}: {
  open: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const titleId = useId();
  return (
    <Dialog fullScreen open={open} onClose={onClose} aria-labelledby={titleId}>
      <header className="flex shrink-0 items-center justify-between gap-echo-sm border-b border-echo-border p-echo-md">
        <Typography component="h2" variant="h6" id={titleId} className="m-0!">
          {title}
        </Typography>
        <PowerIconButton
          className="!size-echo-control-lg"
          aria-label={`Закрити: ${title}`}
          onClick={onClose}
        >
          <CloseIcon />
        </PowerIconButton>
      </header>
      <div className="min-h-0 flex-1 overflow-auto">{children}</div>
    </Dialog>
  );
}
