import { Button, Stack, Tab, Tabs } from '@mui/material';
import { useState } from 'react';

import type { AttachmentSettings, DeviceDocumentSettings } from '../../../../Bindings';
import { PageHeader } from '../../components/PageHeader';
import { PowerAlert } from '../../components/PowerAlert';
import { AttachmentDocumentDialog } from '../shared/message-card/attachment-preview/DocumentContentDialog';
import { DeviceDocumentsTable } from './DeviceDocumentsTable';
import { DocumentSettingsCard } from './DocumentSettingsCard';
import { DocumentsToolbar } from './DocumentsToolbar';
import { MessageDocumentsTable } from './MessageDocumentsTable';
import { QueueCounts } from './QueueCounts';
import { useDeviceDocuments, useMessageDocuments } from './useDocumentsAdmin';

type DocumentsTab = 'messages' | 'devices' | 'settings';

const TAB_LABELS: Record<DocumentsTab, string> = {
  messages: 'Вкладення повідомлень',
  devices: 'Файли пристроїв',
  settings: 'Налаштування',
};

function tabProps(tab: DocumentsTab) {
  return {
    value: tab,
    label: TAB_LABELS[tab],
    id: `admin-documents-tab-${tab}`,
    'aria-controls': `admin-documents-panel-${tab}`,
  };
}

export function AdminDocumentsPage() {
  const [tab, setTab] = useState<DocumentsTab>('messages');
  const [preview, setPreview] = useState<string | null>(null);
  const messages = useMessageDocuments();
  const devices = useDeviceDocuments();
  const devicesAvailable = devices.page?.available ?? false;

  return (
    <Stack spacing={2}>
      <PageHeader
        title="Документи"
        titleActions={
          <Tabs
            value={tab}
            onChange={(_, value: DocumentsTab) => setTab(value)}
            aria-label="Розділи документів"
          >
            <Tab {...tabProps('messages')} />
            <Tab {...tabProps('devices')} />
            <Tab {...tabProps('settings')} />
          </Tabs>
        }
        titleActionsGap={2}
      />

      <div
        role="tabpanel"
        id="admin-documents-panel-messages"
        aria-labelledby="admin-documents-tab-messages"
        hidden={tab !== 'messages'}
      >
        {tab === 'messages' && (
          <Stack spacing={2}>
            <QueueCounts counts={messages.page?.counts ?? []} />
            <DocumentsToolbar
              query={messages.query}
              onQueryChange={messages.setQuery}
              onSearch={() => void messages.load()}
            />
            <MessageDocumentsTable
              documents={messages.page?.documents ?? []}
              onPreview={setPreview}
              onRetry={(mediaId) => void messages.retry(mediaId)}
            />
            {messages.loadMore && (
              <div>
                <Button onClick={() => void messages.loadMore?.()}>Наступні документи</Button>
              </div>
            )}
          </Stack>
        )}
      </div>

      <div
        role="tabpanel"
        id="admin-documents-panel-devices"
        aria-labelledby="admin-documents-tab-devices"
        hidden={tab !== 'devices'}
      >
        {tab === 'devices' && (
          <Stack spacing={2}>
            {devices.error && <PowerAlert severity="error">{devices.error}</PowerAlert>}
            {devices.page && !devicesAvailable && (
              <PowerAlert severity="info">Файловий реєстр не підключено</PowerAlert>
            )}
            {devicesAvailable && (
              <>
                <QueueCounts counts={devices.page?.counts ?? []} />
                <DocumentsToolbar
                  query={devices.query}
                  onQueryChange={devices.setQuery}
                  onSearch={() => void devices.load()}
                />
                <DeviceDocumentsTable
                  documents={devices.page?.documents ?? []}
                  busy={devices.busy}
                  onRetry={(document) => void devices.retry(document)}
                />
              </>
            )}
          </Stack>
        )}
      </div>

      <div
        role="tabpanel"
        id="admin-documents-panel-settings"
        aria-labelledby="admin-documents-tab-settings"
        hidden={tab !== 'settings'}
      >
        {tab === 'settings' && (
          <Stack spacing={2} sx={{ maxWidth: 560 }}>
            {messages.settings && (
              <DocumentSettingsCard<AttachmentSettings>
                title="Вкладення повідомлень"
                enabledLabel="Індексація вкладень"
                positionsLabel="Пошук позицій у документах та OCR"
                note={
                  messages.settings.backfillComplete
                    ? 'Історію вкладень додано до черги'
                    : 'Історія додається до черги від нових до старих'
                }
                settings={messages.settings}
                engines={messages.page?.engines ?? []}
                saving={messages.busy}
                onChange={messages.setSettings}
                onSave={() => void messages.save()}
              />
            )}
            {devices.settings && devicesAvailable && (
              <DocumentSettingsCard<DeviceDocumentSettings>
                title="Файли пристроїв"
                enabledLabel="Індексація файлів пристроїв"
                positionsLabel="Пошук позицій"
                note={`${
                  devices.page?.backfillComplete
                    ? 'Історію додано до черги'
                    : 'Історія додається до черги'
                } · Додано: ${devices.page?.discovered ?? 0}`}
                settings={devices.settings}
                engines={devices.page?.engines ?? []}
                saving={devices.busy}
                onChange={devices.setSettings}
                onSave={() => void devices.save()}
              />
            )}
          </Stack>
        )}
      </div>

      {preview && <AttachmentDocumentDialog mediaId={preview} onClose={() => setPreview(null)} />}
    </Stack>
  );
}
