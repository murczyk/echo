import WhatsAppIcon from '@mui/icons-material/WhatsApp';
import type { SvgIconProps } from '@mui/material';

import { EchoIcon } from './EchoIcon';
import { SignalIcon } from './SignalIcon';

type DatasourceKindIconProps = Omit<SvgIconProps, 'children'> & {
  kind: string | null | undefined;
};

const KIND_ICON_TITLE: Record<string, string> = {
  signal: 'Signal',
  whatsapp: 'WhatsApp',
  echo_operator: 'ЕХО',
};

export function DatasourceKindIcon({ kind, titleAccess, ...props }: DatasourceKindIconProps) {
  const normalizedKind = kind?.toLowerCase();
  const iconTitle = normalizedKind ? KIND_ICON_TITLE[normalizedKind] : null;

  if (!iconTitle) return null;

  const resolvedTitleAccess = titleAccess ?? iconTitle;

  if (normalizedKind === 'signal') {
    return (
      <span title={resolvedTitleAccess} style={{ display: 'inline-flex' }}>
        <SignalIcon {...props} titleAccess={resolvedTitleAccess} />
      </span>
    );
  }

  if (normalizedKind === 'whatsapp') {
    return (
      <span title={resolvedTitleAccess} style={{ display: 'inline-flex' }}>
        <WhatsAppIcon {...props} titleAccess={resolvedTitleAccess} />
      </span>
    );
  }

  if (normalizedKind === 'echo_operator') {
    return (
      <span title={resolvedTitleAccess} style={{ display: 'inline-flex' }}>
        <EchoIcon {...props} titleAccess={resolvedTitleAccess} />
      </span>
    );
  }

  return null;
}
