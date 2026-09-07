import GpsFixedOutlinedIcon from '@mui/icons-material/GpsFixedOutlined';

export function MessageCardRawCoordinates({ coordinates }: { coordinates: string }) {
  return (
    <div
      data-message-card-raw-coordinates="true"
      className="flex min-w-0 items-start gap-1.5 text-[var(--color-text-muted)]"
    >
      <GpsFixedOutlinedIcon aria-hidden className="mt-0.5 shrink-0 text-[var(--color-action)]" />
      <div className="min-w-0 wrap-break-word whitespace-pre-wrap">
        <span className="font-semibold text-[var(--color-text)]">Координати: </span>
        <span>{coordinates}</span>
      </div>
    </div>
  );
}
