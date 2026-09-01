import ComputerIcon from '@mui/icons-material/Computer';
import NotificationsIcon from '@mui/icons-material/Notifications';
import PhoneAndroidIcon from '@mui/icons-material/PhoneAndroid';
import SettingsIcon from '@mui/icons-material/Settings';
import VolumeOffIcon from '@mui/icons-material/VolumeOff';
import VolumeUpIcon from '@mui/icons-material/VolumeUp';
import {
  Button,
  Dialog,
  DialogContent,
  DialogTitle,
  DialogActions,
  Tab,
  Tabs,
  Typography,
  useMediaQuery,
  useTheme,
} from '@mui/material';
import type { ReactNode } from 'react';
import { useEffect, useState } from 'react';

import { PowerAlert } from '../../components/PowerAlert';
import { PowerButton } from '../../components/PowerButton';

export enum DutyNotificationsHelpTopic {
  Feed = 'feed',
  Chrome = 'chrome',
  System = 'system',
  Phone = 'phone',
  Troubleshooting = 'troubleshooting',
}

type Props = {
  initialTopic: DutyNotificationsHelpTopic;
  lastSuccessfulPoll: Date | null;
  onClose: () => void;
  onTestSound: () => Promise<void>;
  open: boolean;
};

function Section({
  children,
  icon,
  title,
}: {
  children: ReactNode;
  icon: ReactNode;
  title: string;
}) {
  return (
    <section className="rounded-xl border border-[var(--color-divider)] bg-black/[.02] p-4 dark:bg-white/[.02]">
      <header className="flex items-center gap-3">
        <span className="text-[var(--color-primary)]">{icon}</span>
        <Typography component="h3" variant="h6">
          {title}
        </Typography>
      </header>
      <div className="mt-4">{children}</div>
    </section>
  );
}

function Row({ children }: { children: ReactNode }) {
  return <div className="rounded-md bg-black/[.03] p-3 dark:bg-white/[.03]">{children}</div>;
}

function SchematicSetting({ label, enabled = true }: { label: string; enabled?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <Typography>{label}</Typography>
      <span
        aria-hidden="true"
        className={`flex h-5 w-9 items-center rounded-echo-pill p-0.5 ${enabled ? 'justify-end bg-echo-primary' : 'justify-start bg-echo-disabled'}`}
      >
        <span
          className={`h-4 w-4 rounded-echo-pill ${enabled ? 'bg-echo-on-primary' : 'bg-echo-surface-raised'}`}
        />
      </span>
    </div>
  );
}

function FeedAndSound({ onTestSound }: Pick<Props, 'onTestSound'>) {
  return (
    <div className="grid gap-4">
      <Section icon={<NotificationsIcon />} title="Сповіщення цієї стрічки">
        <Row>
          <Typography variant="caption" color="text.secondary">
            Приклад
          </Typography>
          <SchematicSetting label="Звуковий сигнал" />
          <SchematicSetting label="Системний банер" />
          <Typography className="mt-2" color="text.secondary" variant="body2">
            Оберіть стрічку і виконайте перевірку в її панелі.
          </Typography>
        </Row>
      </Section>
      <Section icon={<VolumeUpIcon />} title="Звук сайту">
        <div className="grid gap-3 lg:grid-cols-3">
          <Row>
            <Typography fontWeight={600}>Звук сайту увімкнено</Typography>
            <div className="mt-3 flex gap-3 border-l-[3px] border-[var(--color-primary)] bg-[color-mix(in_srgb,var(--color-primary)_7%,transparent)] p-3">
              <VolumeUpIcon color="primary" />
              <div>
                <Typography fontWeight={600}>Звук дозволено</Typography>
                <Typography color="text.secondary" variant="body2">
                  Сайт може відтворювати сигнал
                </Typography>
              </div>
            </div>
            <PowerAlert
              autoHideDuration={null}
              className="mt-3"
              dismissible={false}
              icon={<VolumeOffIcon fontSize="small" />}
              severity="warning"
            >
              Якщо бачите «Звук вимкнено», натисніть і увімкніть його.
            </PowerAlert>
          </Row>
          <Row>
            <Typography fontWeight={600}>Гучність і пристрій</Typography>
            <Typography className="mt-3" color="text.secondary" variant="body2">
              Медіагучність
            </Typography>
            <div aria-hidden="true" className="my-2 h-2 rounded bg-[var(--color-divider)]">
              <div className="h-2 w-3/4 rounded bg-[var(--color-primary)]" />
            </div>
            <Typography color="text.secondary" variant="body2">
              Вивід звуку
            </Typography>
          </Row>
          <Row>
            <div className="flex items-center gap-2">
              <VolumeUpIcon color="primary" />
              <Typography fontWeight={600}>Тестовий сигнал ЕХО</Typography>
            </div>
            <Typography className="mt-3" color="text.secondary" variant="body2">
              Запустіть короткий тестовий сигнал
            </Typography>
            <PowerButton
              className="mt-3"
              onClick={onTestSound}
              startIcon={<VolumeUpIcon />}
              variant="outlined"
            >
              Перевірити звук
            </PowerButton>
          </Row>
        </div>
      </Section>
    </div>
  );
}

function ChromePermission() {
  return (
    <Section icon={<SettingsIcon />} title="Дозвіл у Chrome">
      <div className="grid gap-3 md:grid-cols-2">
        <Row>
          <Typography fontWeight={600}>Відомості про сайт</Typography>
          <Typography className="mt-2" color="text.secondary" variant="body2">
            Ліворуч від рядка адреси відкрийте «Відомості про сайт».
          </Typography>
        </Row>
        <Row>
          <Typography fontWeight={600}>Сповіщення</Typography>
          <Typography className="mt-2" color="text.secondary" variant="body2">
            Увімкніть «Сповіщення» для ЕХО.
          </Typography>
        </Row>
      </div>
      <Typography className="mt-3" color="text.secondary" variant="body2">
        Якщо пункту немає: Налаштування → Конфіденційність і безпека → Налаштування сайтів →
        Сповіщення.
      </Typography>
    </Section>
  );
}

function SystemNotifications() {
  return (
    <div className="grid gap-4">
      <Section icon={<ComputerIcon />} title="Windows">
        <div className="grid gap-3 md:grid-cols-2">
          <Row>
            <Typography fontWeight={600}>Параметри → Система → Сповіщення</Typography>
            <Typography className="mt-2" color="text.secondary" variant="body2">
              У «Сповіщеннях від програм та інших відправників» відкрийте Google Chrome.
            </Typography>
          </Row>
          <Row>
            <Typography className="mb-2" color="text.secondary" variant="caption">
              Приклад
            </Typography>
            <SchematicSetting label="Сповіщення" />
            <SchematicSetting label="Показувати банери" />
          </Row>
        </div>
        <Typography className="mt-3" color="text.secondary" variant="body2">
          «Не турбувати» — окремий режим Windows; він може відкласти або приховати банер.
        </Typography>
      </Section>
      <Section icon={<ComputerIcon />} title="macOS">
        <div className="grid gap-3 md:grid-cols-2">
          <Row>
            <Typography fontWeight={600}>
              Системні параметри → Сповіщення → Google Chrome
            </Typography>
            <Typography className="mt-2" color="text.secondary" variant="body2">
              Відкрийте налаштування сповіщень Google Chrome.
            </Typography>
          </Row>
          <Row>
            <Typography className="mb-2" color="text.secondary" variant="caption">
              Приклад
            </Typography>
            <SchematicSetting label="Дозволити сповіщення" />
            <SchematicSetting label="Стиль попереджень: Банери" />
          </Row>
        </div>
        <Typography className="mt-3" color="text.secondary" variant="body2">
          «Зосередження» налаштовується окремо й може заглушити сповіщення.
        </Typography>
      </Section>
      <Typography color="text.secondary" variant="body2">
        Системний параметр звуку не керує сигналом ЕХО: сигнал відтворюється окремо відкритою
        сторінкою.
      </Typography>
    </div>
  );
}

function PhoneLimitations() {
  return (
    <Section icon={<PhoneAndroidIcon />} title="Обмеження на телефоні">
      <div className="grid gap-3 md:grid-cols-2">
        <Row>
          <Typography fontWeight={600}>Активна сторінка</Typography>
          <Typography className="mt-2" color="text.secondary" variant="body2">
            Телефон розблоковано, а «Оперативний» відкрито — звук може відтворюватися.
          </Typography>
        </Row>
        <Row>
          <Typography fontWeight={600}>Неактивна сторінка</Typography>
          <Typography className="mt-2" color="text.secondary" variant="body2">
            Коли телефон заблоковано, сторінку закрито або браузер її призупинив, підтримка
            звукового сигналу та системного банера обмежена.
          </Typography>
        </Row>
      </div>
    </Section>
  );
}

function Troubleshooting({
  lastSuccessfulPoll,
  onSelectTopic,
}: {
  lastSuccessfulPoll: Date | null;
  onSelectTopic: (topic: DutyNotificationsHelpTopic) => void;
}) {
  const actions: Array<{ text: string; topic: DutyNotificationsHelpTopic }> = [
    { text: 'Перемикач каналу увімкнено?', topic: DutyNotificationsHelpTopic.Feed },
    { text: 'Перевірка звуку працює?', topic: DutyNotificationsHelpTopic.Feed },
    { text: 'Дозвіл Chrome надано?', topic: DutyNotificationsHelpTopic.Chrome },
    {
      text: 'Перевірка банера спрацювала, але банер не з’явився?',
      topic: DutyNotificationsHelpTopic.System,
    },
    {
      text: 'Системні сповіщення та режим фокусування налаштовані?',
      topic: DutyNotificationsHelpTopic.System,
    },
    {
      text: 'Сторінка «Оперативний» залишається відкритою?',
      topic: DutyNotificationsHelpTopic.Phone,
    },
  ];

  return (
    <Section icon={<SettingsIcon />} title="Як знайти причину">
      <div className="grid gap-2 md:grid-cols-2">
        {actions.map(({ text, topic }) => (
          <PowerButton
            className="w-full justify-start text-left"
            key={text}
            onClick={() => onSelectTopic(topic)}
            style={{ whiteSpace: 'normal' }}
            type="button"
            variant="outlined"
          >
            {text}
          </PowerButton>
        ))}
      </div>
      <div className="mt-3">
        <Row>
          <Typography fontWeight={600}>Остання успішна перевірка сервера</Typography>
          <Typography className="mt-2" color="text.secondary" variant="body2">
            {lastSuccessfulPoll ? lastSuccessfulPoll.toLocaleTimeString() : 'Ще не було'}
          </Typography>
          <Typography className="mt-2" color="text.secondary" variant="body2">
            Поки «Оперативний» працює, час має регулярно оновлюватися.
          </Typography>
        </Row>
      </div>
    </Section>
  );
}

export function DutyNotificationsHelpDialog({
  initialTopic,
  lastSuccessfulPoll,
  onClose,
  onTestSound,
  open,
}: Props) {
  const [topic, setTopic] = useState(initialTopic);
  const theme = useTheme();
  const fullScreen = useMediaQuery(theme.breakpoints.down('sm'));

  useEffect(() => {
    if (open) {
      setTopic(initialTopic);
    }
  }, [initialTopic, open]);

  return (
    <Dialog
      fullScreen={fullScreen}
      fullWidth
      maxWidth="lg"
      onClose={onClose}
      open={open}
      scroll="paper"
    >
      <DialogTitle>Налаштування та діагностика сповіщень</DialogTitle>
      <DialogContent>
        <Tabs
          aria-label="Розділи довідки про сповіщення"
          className="mb-3"
          onChange={(_, nextTopic: DutyNotificationsHelpTopic) => setTopic(nextTopic)}
          value={topic}
          variant="scrollable"
          scrollButtons="auto"
          allowScrollButtonsMobile
        >
          <Tab label="Стрічка та звук" value={DutyNotificationsHelpTopic.Feed} />
          <Tab label="Chrome" value={DutyNotificationsHelpTopic.Chrome} />
          <Tab label="Система" value={DutyNotificationsHelpTopic.System} />
          <Tab label="Телефон" value={DutyNotificationsHelpTopic.Phone} />
          <Tab label="Діагностика" value={DutyNotificationsHelpTopic.Troubleshooting} />
        </Tabs>
        {topic === DutyNotificationsHelpTopic.Feed ? (
          <FeedAndSound onTestSound={onTestSound} />
        ) : null}
        {topic === DutyNotificationsHelpTopic.Chrome ? <ChromePermission /> : null}
        {topic === DutyNotificationsHelpTopic.System ? <SystemNotifications /> : null}
        {topic === DutyNotificationsHelpTopic.Phone ? <PhoneLimitations /> : null}
        {topic === DutyNotificationsHelpTopic.Troubleshooting ? (
          <Troubleshooting lastSuccessfulPoll={lastSuccessfulPoll} onSelectTopic={setTopic} />
        ) : null}
      </DialogContent>
      <DialogActions sx={{ borderTop: 1, borderColor: 'divider' }}>
        <Button onClick={onClose}>Закрити</Button>
      </DialogActions>
    </Dialog>
  );
}
