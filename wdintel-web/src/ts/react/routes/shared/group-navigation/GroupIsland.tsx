import type { ComponentProps } from 'react';

import { GroupIdentity } from './GroupIdentity';

type Props = {
  group: ComponentProps<typeof GroupIdentity>['group'];
  className?: string;
};

export function GroupIsland({ group, className }: Props) {
  return (
    <div className={`group-navigation-island${className ? ` ${className}` : ''}`} data-group-island>
      <GroupIdentity group={group} />
    </div>
  );
}
