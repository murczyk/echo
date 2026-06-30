import { Box, Popover, Stack, Typography } from "@mui/material";
import type { VideoPreviewSource } from "./message-card-video-utils";
import { formatVideoTime } from "./message-card-video-utils";
import { formatSizeBytes } from "./message-card-image-utils";

export function MessageCardVideoPreviewInfoPopover({
  open,
  anchorEl,
  onClose,
  video,
  duration,
}: {
  open: boolean;
  anchorEl: HTMLButtonElement | null;
  onClose: () => void;
  video: VideoPreviewSource;
  duration: number;
}) {
  const videoId = video.id?.trim() ?? "";
  const showVideoId = videoId !== "";
  const contentType = video.mimeType?.trim() || "—";
  const normalizedFileSize =
    video.sizeBytes != null ? formatSizeBytes(video.sizeBytes) : "—";
  const url = typeof video.source === "string" ? video.source : "Local File";

  return (
    <Popover
      open={open}
      anchorEl={anchorEl}
      onClose={onClose}
      anchorOrigin={{ vertical: "top", horizontal: "center" }}
      transformOrigin={{ vertical: "bottom", horizontal: "center" }}
      slotProps={{
        paper: {
          sx: {
            p: 1.5,
            minWidth: 280,
            maxWidth: 360,
            backgroundColor: "#111821",
            color: "#f4f7fb",
          },
        },
      }}
    >
      <Stack spacing={1}>
        <Box>
          <Typography
            variant="caption"
            className="text-white/75"
          >
            URL
          </Typography>
          <Typography variant="body2" sx={{ wordBreak: "break-word" }}>
            {url}
          </Typography>
        </Box>
        <Box>
          <Typography
            variant="caption"
            className="text-white/75"
          >
            Файл
          </Typography>
          <Typography variant="body2" sx={{ wordBreak: "break-word" }}>
            {video.name}
          </Typography>
        </Box>
        <Box>
          <Typography
            variant="caption"
            className="text-white/75"
          >
            Тип
          </Typography>
          <Typography variant="body2">{contentType}</Typography>
        </Box>
        <Box>
          <Typography
            variant="caption"
            className="text-white/75"
          >
            Розмір файлу
          </Typography>
          <Typography variant="body2">{normalizedFileSize}</Typography>
        </Box>
        <Box>
          <Typography
            variant="caption"
            className="text-white/75"
          >
            Тривалість
          </Typography>
          <Typography variant="body2">{formatVideoTime(duration)}</Typography>
        </Box>
        {showVideoId ? (
          <Box>
            <Typography
              variant="caption"
              className="text-white/75"
            >
              ID
            </Typography>
            <Typography variant="body2" sx={{ wordBreak: "break-word" }}>
              {videoId}
            </Typography>
          </Box>
        ) : null}
      </Stack>
    </Popover>
  );
}
