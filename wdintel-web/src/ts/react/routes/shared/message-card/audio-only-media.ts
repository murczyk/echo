export function isAmbiguousAudioOnlyMedia(
  fileName: string,
  contentType: string | null | undefined,
  media: HTMLVideoElement,
): boolean {
  const mime = (contentType ?? '').split(';', 1)[0].trim().toLowerCase();
  return (
    (!mime || mime === 'application/octet-stream') &&
    /\.(mpeg|mpg|webm)$/i.test(fileName) &&
    media.readyState > 0 &&
    media.error === null &&
    Number.isFinite(media.duration) &&
    media.duration > 0 &&
    media.videoWidth === 0 &&
    media.videoHeight === 0
  );
}

export function hasMpegAudioSignature(prefix: Uint8Array): boolean {
  if (
    prefix.length >= 10 &&
    prefix[0] === 0x49 &&
    prefix[1] === 0x44 &&
    prefix[2] === 0x33 &&
    prefix[3] >= 2 &&
    prefix[3] <= 4 &&
    prefix[4] < 0xff &&
    prefix.subarray(6, 10).every((byte) => byte < 0x80)
  )
    return true;
  if (prefix.length < 4) return false;
  const version = (prefix[1] >> 3) & 3;
  const layer = (prefix[1] >> 1) & 3;
  const bitrate = prefix[2] >> 4;
  const sampleRate = (prefix[2] >> 2) & 3;
  return (
    prefix[0] === 0xff &&
    (prefix[1] & 0xe0) === 0xe0 &&
    version !== 1 &&
    layer !== 0 &&
    bitrate > 0 &&
    bitrate < 15 &&
    sampleRate !== 3
  );
}
