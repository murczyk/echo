import { UserUuidValue } from './UserUuidValue';
import { CopyUuidButton, formatUuidShort } from './user-display';

export function UserIdentity({ id }: { id: string }) {
  return (
    <div className="flex min-w-0 items-center gap-2 text-echo-sm text-muted-foreground md:col-span-2">
      <span>UUID:</span>
      <UserUuidValue uuid={id} shortValue={formatUuidShort(id)} />
      <CopyUuidButton uuid={id} />
    </div>
  );
}
