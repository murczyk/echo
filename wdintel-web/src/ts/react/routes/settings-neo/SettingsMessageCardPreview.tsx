import DescriptionOutlinedIcon from '@mui/icons-material/DescriptionOutlined';
import ImageOutlinedIcon from '@mui/icons-material/ImageOutlined';
import MapOutlinedIcon from '@mui/icons-material/MapOutlined';
import { Collapse, useMediaQuery } from '@mui/material';
import {
  MessageAttachmentPreviewMode,
  type MessageTextPreviewLineLimit,
} from '../../services/api/user-settings';
import type { TagsLayoutVariant } from '../rer-duty-neo/utils';
import './SettingsMessageCardPreview.css';

const PREVIEW_TAG_WIDTHS = [72, 88, 64, 56, 80, 48, 72, 64];

function PreviewLines({ widths }: { widths: number[] }) {
  return (
    <div className="settings-message-card-preview__lines" aria-hidden="true">
      {widths.map((width, index) => (
        <div
          key={index}
          className="settings-message-card-preview__line"
          style={{ width: `${width}%` }}
        />
      ))}
    </div>
  );
}

export function SettingsMessageCardPreview({
  tagsLayout,
  mediaSummaryEnabled,
  attachmentPreviewMode,
  aiPositionHighlightsEnabled,
  messageTextPreviewLines,
}: {
  tagsLayout: TagsLayoutVariant;
  mediaSummaryEnabled: boolean;
  attachmentPreviewMode: MessageAttachmentPreviewMode;
  aiPositionHighlightsEnabled: boolean;
  messageTextPreviewLines: MessageTextPreviewLineLimit;
}) {
  const reducedMotion = useMediaQuery('(prefers-reduced-motion: reduce)');
  const duration = reducedMotion ? 0 : 250;
  const attachmentsExpanded = attachmentPreviewMode !== MessageAttachmentPreviewMode.Collapsed;
  return (
    <section
      aria-label="Попередній перегляд картки повідомлення"
      className={
        attachmentPreviewMode === MessageAttachmentPreviewMode.Large
          ? 'message-card-previews-large'
          : undefined
      }
    >
      <div
        data-message-card-mock="true"
        data-message-card-tags-mock="true"
        aria-hidden="true"
        className="message-card-root settings-message-card-preview bg-black/2! dark:bg-white/2!"
      >
        <div className="message-card-header-row">
          <div data-message-card-header-left="true" className="w-full">
            <PreviewLines widths={[40, 28]} />
          </div>
        </div>
        <div className="message-card-divider" aria-hidden="true" />
        <div className="message-card-content-layout">
          <div className="message-card-main">
            <div data-message-text-preview-limit={messageTextPreviewLines ?? 'off'}>
              <PreviewLines widths={[96, 88, 72]} />
              <Collapse in={messageTextPreviewLines !== 20} timeout={duration} unmountOnExit>
                <PreviewLines widths={[92, 80]} />
              </Collapse>
              <Collapse in={messageTextPreviewLines === null} timeout={duration} unmountOnExit>
                <PreviewLines widths={[86, 62]} />
              </Collapse>
              <Collapse in={aiPositionHighlightsEnabled} timeout={duration} unmountOnExit>
                <div data-ai-position-preview className="settings-message-card-preview__position">
                  <div className="h-2 w-1/2 rounded-sm bg-echo-primary/55" />
                </div>
              </Collapse>
              <Collapse in={messageTextPreviewLines !== null} timeout={duration} unmountOnExit>
                <div className="h-2 w-20 rounded-sm bg-echo-primary/55" />
              </Collapse>
            </div>
            <div className="message-card-attachments-region">
              <Collapse in={!attachmentsExpanded} timeout={duration} unmountOnExit>
                <div className="message-card-attachment-counters" aria-hidden="true">
                  <span className="message-card-attachment-counter">
                    <span className="h-1.5 w-9.5 rounded-sm bg-echo-primary/60" />
                  </span>
                  <span className="message-card-attachment-counter">
                    <span className="h-1.5 w-9.5 rounded-sm bg-echo-primary/60" />
                  </span>
                </div>
              </Collapse>
              <Collapse in={attachmentsExpanded} timeout={duration} unmountOnExit>
                <div
                  className="message-card-gallery"
                  data-attachment-preview-mock={attachmentPreviewMode}
                >
                  {[ImageOutlinedIcon, MapOutlinedIcon].map((Icon, index) => (
                    <div className="message-card-thumbnail-shell" key={index}>
                      <div
                        className="message-card-thumbnail-control settings-message-card-preview__tile"
                        data-picture-thumb-layout="multi"
                      >
                        <Icon />
                      </div>
                    </div>
                  ))}
                </div>
              </Collapse>
              <Collapse
                in={mediaSummaryEnabled && attachmentsExpanded}
                timeout={duration}
                unmountOnExit
              >
                <div
                  data-media-summary-mock="true"
                  className="settings-message-card-preview__summary"
                >
                  <DescriptionOutlinedIcon className="settings-message-card-preview__icon" />
                  <div className="min-w-0 flex-1">
                    <PreviewLines widths={[90, 65]} />
                  </div>
                </div>
              </Collapse>
            </div>
          </div>
          <div className="message-card-details-region">
            <PreviewLines widths={[68, 88]} />
            <div className="message-card-divider" aria-hidden="true" />
            <Collapse in={tagsLayout !== 'hidden'} timeout={duration} unmountOnExit>
              <div data-tags-mock="true">
                <div className="settings-message-card-preview__tags">
                  {PREVIEW_TAG_WIDTHS.slice(0, 3).map((width, index) => (
                    <div
                      key={index}
                      data-preview-tag
                      className="h-3.5 rounded-sm bg-echo-primary/35"
                      style={{ width }}
                    />
                  ))}
                  <Collapse
                    in={tagsLayout === 'compact'}
                    orientation="horizontal"
                    timeout={duration}
                    unmountOnExit
                  >
                    <div className="h-3.5 w-10 rounded-sm border border-echo-primary/30 bg-echo-primary/10" />
                  </Collapse>
                </div>
                <Collapse in={tagsLayout === 'full'} timeout={duration} unmountOnExit>
                  <div className="settings-message-card-preview__tags pt-echo-sm">
                    {PREVIEW_TAG_WIDTHS.slice(3).map((width, index) => (
                      <div
                        key={index}
                        data-preview-tag
                        className="h-3.5 rounded-sm bg-echo-primary/35"
                        style={{ width }}
                      />
                    ))}
                  </div>
                </Collapse>
              </div>
            </Collapse>
          </div>
        </div>
        <div className="message-card-timestamp-footer">
          <div className="h-2.25 w-6.5 rounded-sm bg-echo-text-muted/25" />
        </div>
      </div>
    </section>
  );
}
