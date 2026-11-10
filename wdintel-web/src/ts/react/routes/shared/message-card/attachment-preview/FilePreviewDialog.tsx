import CloseIcon from '@mui/icons-material/Close';
import {
  Dialog,
  DialogContent,
  DialogTitle,
  IconButton,
  useMediaQuery,
  useTheme,
} from '@mui/material';
import { useId, type ReactNode } from 'react';

export function FilePreviewDialog({
  open,
  title,
  onClose,
  children,
  actions,
  header,
  fullScreen = false,
}: {
  open: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
  actions?: ReactNode;
  header?: ReactNode;
  fullScreen?: boolean;
}) {
  const titleId = useId();
  const theme = useTheme();
  const narrow = useMediaQuery(theme.breakpoints.down('sm'));
  if (!open) return null;
  return (
    <Dialog
      open
      onClose={onClose}
      fullScreen={fullScreen || narrow}
      fullWidth
      maxWidth="xl"
      aria-labelledby={header ? undefined : titleId}
      aria-label={header ? title : undefined}
    >
      {header ?? (
        <DialogTitle id={titleId} className="flex flex-wrap items-center gap-echo-sm">
          <span className="min-w-0 flex-1 break-all">{title}</span>
          <IconButton aria-label="Закрити перегляд" onClick={onClose}>
            <CloseIcon />
          </IconButton>
          {actions && (
            <div className="flex w-full flex-wrap items-center justify-end gap-echo-sm">
              {actions}
            </div>
          )}
        </DialogTitle>
      )}
      <DialogContent className="flex min-h-0 min-w-0 flex-col" sx={{ height: '80dvh', p: 0 }}>
        {children}
      </DialogContent>
    </Dialog>
  );
}
