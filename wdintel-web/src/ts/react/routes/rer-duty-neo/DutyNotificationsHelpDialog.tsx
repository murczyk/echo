import CloseIcon from '@mui/icons-material/Close';
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
  IconButton,
  Slider,
  Switch,
  Tab,
  Tabs,
  Typography,
} from '@mui/material';
import type { ReactNode } from 'react';
import { useEffect, useState } from 'react';

export enum DutyNotificationsHelpTopic {
  Feed = 'feed',
  Chrome = 'chrome',
  System = 'system',
  Phone = 'phone',
  Troubleshooting = 'troubleshooting',
}

type Props = {
  initialTopic: DutyNotificationsHelpTopic;
  onClose: () => void;
  open: boolean;
};

function Badge({ number }: { number: number }) {
  return (
    <span className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-[var(--color-primary)] text-sm font-bold text-[var(--color-on-primary)]">
      {number}
    </span>
  );
}

function Section({
  children,
  icon,
  number,
  title,
}: {
  children: ReactNode;
  icon: ReactNode;
  number: number;
  title: string;
}) {
  return (
    <section className="rounded-xl border border-[var(--color-divider)] bg-black/[.02] p-4 dark:bg-white/[.02]">
      <header className="flex items-center gap-3">
        <Badge number={number} />
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

function StaticSwitch({ label, on = true }: { label: string; on?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <Typography>{label}</Typography>
      <Switch checked={on} disabled sx={{ '&.Mui-disabled': { opacity: 1 } }} tabIndex={-1} />
    </div>
  );
}

function FeedAndSound() {
  return (
    <div className="grid gap-4">
      <Section icon={<NotificationsIcon />} number={1} title="Сповіщення цієї стрічки">
        <Row>
          <StaticSwitch label="Звукове сповіщення" />
          <StaticSwitch label="Браузерне сповіщення" />
          <Typography className="mt-2" color="text.secondary" variant="body2">
            Увімкніть потрібний канал і виконайте перевірку в панелі стрічки.
          </Typography>
        </Row>
      </Section>
      <Section icon={<VolumeUpIcon />} number={2} title="Перевірка звуку">
        <div className="grid gap-3 lg:grid-cols-3">
          <Row>
            <Typography fontWeight={600}>Звук вкладки увімкнено</Typography>
            <div className="mt-3 flex gap-3 border-l-[3px] border-[var(--color-primary)] bg-[color-mix(in_srgb,var(--color-primary)_7%,transparent)] p-3">
              <VolumeUpIcon color="primary" />
              <div>
                <Typography fontWeight={600}>Звук активний</Typography>
                <Typography color="text.secondary" variant="body2">
                  Вкладка відтворює звук
                </Typography>
              </div>
            </div>
            <div className="mt-3 flex items-center gap-2 text-[var(--color-error)]">
              <VolumeOffIcon fontSize="small" />
              <Typography variant="body2">Звук вимкнено — увімкніть його</Typography>
            </div>
          </Row>
          <Row>
            <Typography fontWeight={600}>Гучність і пристрій</Typography>
            <Typography className="mt-3" color="text.secondary" variant="body2">
              Медіагучність
            </Typography>
            <Slider disabled sx={{ '&.Mui-disabled': { opacity: 1 } }} tabIndex={-1} value={72} />
            <Typography color="text.secondary" variant="body2">
              Вивід звуку
            </Typography>
            <div className="mt-1 flex h-10 items-center rounded-md border border-[var(--color-divider)] px-3">
              <Typography variant="body2">Поточний пристрій</Typography>
            </div>
          </Row>
          <Row>
            <div className="flex items-center gap-2">
              <VolumeUpIcon color="primary" />
              <Typography fontWeight={600}>ЕХО</Typography>
            </div>
            <Typography className="mt-3" color="text.secondary" variant="body2">
              Запустіть короткий тестовий сигнал
            </Typography>
            <Button
              className="mt-6"
              disabled
              fullWidth
              startIcon={<VolumeUpIcon />}
              sx={{ '&.Mui-disabled': { opacity: 1 } }}
              variant="contained"
            >
              Перевірити звук
            </Button>
          </Row>
        </div>
      </Section>
    </div>
  );
}

function ChromePermission() {
  return (
    <Section icon={<SettingsIcon />} number={3} title="Дозвіл у Chrome">
      <div className="grid gap-3 md:grid-cols-2">
        <Row>
          <Typography fontWeight={600}>Відомості про сайт</Typography>
          <Typography className="mt-2" color="text.secondary" variant="body2">
            Ліворуч від адресного рядка відкрийте «Відомості про сайт».
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
      <Section icon={<ComputerIcon />} number={4} title="Windows">
        <div className="grid gap-3 md:grid-cols-2">
          <Row>
            <Typography fontWeight={600}>Параметри → Система → Сповіщення</Typography>
            <Typography className="mt-2" color="text.secondary" variant="body2">
              У «Сповіщеннях від програм та інших відправників» відкрийте Google Chrome.
            </Typography>
          </Row>
          <Row>
            <StaticSwitch label="Сповіщення" />
            <StaticSwitch label="Показувати банери" />
            <StaticSwitch label="Відтворювати звук" />
          </Row>
        </div>
        <Typography className="mt-3" color="text.secondary" variant="body2">
          «Не турбувати» — окремий режим Windows; він може відкласти або приховати банер.
        </Typography>
      </Section>
      <Section icon={<ComputerIcon />} number={5} title="macOS">
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
            <StaticSwitch label="Дозволити сповіщення" />
            <StaticSwitch label="Стиль попереджень: Банери" />
            <StaticSwitch label="Відтворювати звук для сповіщень" />
          </Row>
        </div>
        <Typography className="mt-3" color="text.secondary" variant="body2">
          «Зосередження» налаштовується окремо й може заглушити сповіщення.
        </Typography>
      </Section>
    </div>
  );
}

function PhoneLimitations() {
  return (
    <Section icon={<PhoneAndroidIcon />} number={6} title="Обмеження на телефоні">
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
            Коли телефон заблоковано або браузер закрито, фонової доставки та звуку немає.
          </Typography>
        </Row>
      </div>
    </Section>
  );
}

function Troubleshooting() {
  return (
    <Section icon={<SettingsIcon />} number={7} title="Як знайти причину">
      <div className="grid gap-2 md:grid-cols-2">
        {[
          'Перемикач каналу увімкнено?',
          'Браузерний статус — «Дозволено»?',
          'Перевірка звуку працює?',
          'Перевірка браузерного сповіщення працює?',
          'Системні сповіщення та звук увімкнені?',
          'Сторінку «Оперативний» відкрито?',
        ].map((text) => (
          <Row key={text}>
            <Typography>{text}</Typography>
          </Row>
        ))}
      </div>
    </Section>
  );
}

export function DutyNotificationsHelpDialog({ initialTopic, onClose, open }: Props) {
  const [topic, setTopic] = useState(initialTopic);

  useEffect(() => {
    if (open) {
      setTopic(initialTopic);
    }
  }, [initialTopic, open]);

  return (
    <Dialog fullWidth maxWidth="lg" onClose={onClose} open={open} scroll="paper">
      <DialogTitle className="flex items-center justify-between">
        <span>Налаштування сповіщень</span>
        <IconButton aria-label="Закрити довідку" onClick={onClose}>
          <CloseIcon />
        </IconButton>
      </DialogTitle>
      <DialogContent dividers>
        <Tabs
          aria-label="Розділи довідки про сповіщення"
          className="mb-5"
          onChange={(_, nextTopic: DutyNotificationsHelpTopic) => setTopic(nextTopic)}
          value={topic}
          variant="scrollable"
        >
          <Tab label="Ця стрічка" value={DutyNotificationsHelpTopic.Feed} />
          <Tab label="Chrome" value={DutyNotificationsHelpTopic.Chrome} />
          <Tab label="Система" value={DutyNotificationsHelpTopic.System} />
          <Tab label="Телефон" value={DutyNotificationsHelpTopic.Phone} />
          <Tab label="Діагностика" value={DutyNotificationsHelpTopic.Troubleshooting} />
        </Tabs>
        {topic === DutyNotificationsHelpTopic.Feed ? <FeedAndSound /> : null}
        {topic === DutyNotificationsHelpTopic.Chrome ? <ChromePermission /> : null}
        {topic === DutyNotificationsHelpTopic.System ? <SystemNotifications /> : null}
        {topic === DutyNotificationsHelpTopic.Phone ? <PhoneLimitations /> : null}
        {topic === DutyNotificationsHelpTopic.Troubleshooting ? <Troubleshooting /> : null}
      </DialogContent>
    </Dialog>
  );
}
