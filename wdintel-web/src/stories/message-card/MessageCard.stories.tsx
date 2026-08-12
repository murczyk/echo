import type { Meta, StoryObj } from '@storybook/react-vite';
import { MessageCard } from '../../ts/react/routes/shared/message-card/MessageCard';
import {
  buildAudioAttachment,
  buildMessage,
  buildMessageCardProps,
  SAMPLE_AUDIO_SIZE_BYTES,
} from './message-card.fixtures';

const LONG_TRANSCRIPTION = [
  'Прийом, Альфа, підтвердіть готовність до виходу.',
  'Альфа на зв’язку, готові.',
  'Рух колоною, інтервал двісті, без світла.',
  'Прийняв. Контрольна точка через дванадцять хвилин.',
  'Повторити частоту резервного каналу.',
].join('\n');

const meta = {
  title: 'MessageCard/Audio',
  component: MessageCard,
  args: buildMessageCardProps(),
} satisfies Meta<typeof MessageCard>;

export default meta;
type Story = StoryObj<typeof meta>;

export const TextOnly: Story = {
  name: 'Text only',
  args: buildMessageCardProps({
    msg: buildMessage({
      text: 'Картка без медіа — базовий макет.',
      media: [],
    }),
  }),
};

export const WithWaveAndSpectrogram: Story = {
  name: 'Wave + spectrogram',
  args: buildMessageCardProps({
    msg: buildMessage({
      text: 'Аудіо з mock wave і spectrogram (fixtures з echo-audio-player).',
      media: [buildAudioAttachment({ id: 'audio-full' })],
    }),
  }),
};

export const WaveOnly: Story = {
  name: 'Wave only',
  args: buildMessageCardProps({
    msg: buildMessage({
      text: 'Spectrogram 404 — лише waveform.',
      media: [buildAudioAttachment({ id: 'audio-wave-only', fileName: 'wave-only.wav' })],
    }),
  }),
};

export const SpectrumOnly: Story = {
  name: 'Spectrogram only',
  args: buildMessageCardProps({
    msg: buildMessage({
      text: 'Wave 404 — лише spectrogram.',
      media: [buildAudioAttachment({ id: 'audio-spectrum-only', fileName: 'spectrum-only.wav' })],
    }),
  }),
};

export const WithoutDerivedImages: Story = {
  name: 'Without wave/spectrogram',
  args: buildMessageCardProps({
    msg: buildMessage({
      text: 'sizeBytes понад ліміт — derived images не підвантажуються.',
      media: [
        buildAudioAttachment({
          id: 'audio-oversized',
          fileName: 'oversized.wav',
          sizeBytes: 101 * 1024 * 1024,
        }),
      ],
    }),
  }),
};

export const WithTranscription: Story = {
  name: 'With transcription',
  args: buildMessageCardProps({
    msg: buildMessage({
      text: 'Аудіо з видимою транскрипцією.',
      media: [
        buildAudioAttachment({
          id: 'audio-full',
          transcription: LONG_TRANSCRIPTION,
        }),
      ],
    }),
  }),
};

export const TranscriptionCollapsed: Story = {
  name: 'Transcription collapsed',
  parameters: {
    audioTranscriptionCollapsed: true,
  },
  args: buildMessageCardProps({
    msg: buildMessage({
      text: 'Транскрипція згорнута за замовчуванням (кнопка субтитрів).',
      media: [
        buildAudioAttachment({
          id: 'audio-full',
          transcription: LONG_TRANSCRIPTION,
        }),
      ],
    }),
  }),
};

export const MultipleAudio: Story = {
  name: 'Multiple audio',
  args: buildMessageCardProps({
    msg: buildMessage({
      text: 'Кілька аудіо-вкладень у одній картці.',
      media: [
        buildAudioAttachment({
          id: 'audio-full',
          fileName: 'sample-a.wav',
          transcription: 'Короткий запис A.',
        }),
        buildAudioAttachment({
          id: 'audio-wave-only',
          fileName: 'sample-b.wav',
          sizeBytes: SAMPLE_AUDIO_SIZE_BYTES,
        }),
        buildAudioAttachment({
          id: 'audio-spectrum-only',
          fileName: 'sample-c.wav',
        }),
      ],
    }),
  }),
};

export const CompactFeed: Story = {
  name: 'Compact feed (≥3 columns)',
  args: buildMessageCardProps({
    feedCount: 3,
    msg: buildMessage({
      text: 'Компактний макет як у стрічці з трьома колонками.',
      media: [
        buildAudioAttachment({ id: 'audio-full', transcription: 'Компакт + wave/spectrum.' }),
      ],
    }),
  }),
};

export const AnalysisMode: Story = {
  name: 'Analysis mode',
  args: buildMessageCardProps({
    displayMode: 'analysis',
    msg: buildMessage({
      text: 'Режим аналізу з аудіо-плеєром.',
      media: [buildAudioAttachment({ id: 'audio-full' })],
    }),
  }),
};

export const DarkTheme: Story = {
  name: 'Dark theme',
  globals: {
    theme: 'dark',
  },
  args: buildMessageCardProps({
    msg: buildMessage({
      text: 'Темна тема: картка + compact audio player.',
      media: [
        buildAudioAttachment({
          id: 'audio-full',
          transcription: 'Перевірка theme sync для custom-audio-player.',
        }),
      ],
    }),
  }),
};
