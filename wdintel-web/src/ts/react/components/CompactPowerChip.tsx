import type { ComponentProps } from 'react';
import { PowerChip } from './PowerChip';

type CompactPowerChipProps = Omit<ComponentProps<typeof PowerChip>, 'fontSize'>;

export function CompactPowerChip(props: CompactPowerChipProps) {
  return <PowerChip {...props} fontSize="0.875rem" />;
}
