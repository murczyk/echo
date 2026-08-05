import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { StorybookConfig } from '@storybook/react-vite';
import type { Connect, Plugin, ViteDevServer } from 'vite';
import { mergeConfig } from 'vite';

const storybookDir = dirname(fileURLToPath(import.meta.url));
const webRoot = resolve(storybookDir, '..');
const mockApiRoot = resolve(webRoot, 'src/stories/fixtures/mock-api');
const MOCK_MEDIA_STATIC_DIR = {
  from: '../src/stories/fixtures/mock-api',
  to: '/api/messenger/media',
} as const;

function messengerMediaMockMiddleware(
  req: Connect.IncomingMessage,
  res: Connect.ServerResponse,
  next: Connect.NextFunction,
) {
  const pathname = (req.url ?? '').split('?')[0] ?? '';
  const match = pathname.match(/^\/api\/messenger\/media\/([^/]+)\/(wave|spectrogram)$/);
  if (!match) {
    next();
    return;
  }

  const [, mediaId, kind] = match;
  try {
    const body = readFileSync(resolve(mockApiRoot, mediaId, kind));
    res.statusCode = 200;
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Cache-Control', 'no-cache');
    res.end(body);
  } catch {
    res.statusCode = 404;
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.end('Not found');
  }
}

function installMessengerMediaMockMiddleware(server: ViteDevServer) {
  // Post-hook + unshift: run before Storybook staticDirs/sirv so Content-Type is image/png.
  server.middlewares.stack.unshift({
    route: '',
    handle: messengerMediaMockMiddleware,
  });
}

function messengerMediaMockPlugin(): Plugin {
  return {
    name: 'storybook-messenger-media-mock',
    configureServer(server) {
      return () => installMessengerMediaMockMiddleware(server);
    },
    // `vite preview` / some Storybook preview paths also need the mock.
    configurePreviewServer(server) {
      return () => installMessengerMediaMockMiddleware(server);
    },
  };
}

const config: StorybookConfig = {
  stories: ['../src/**/*.stories.@(js|jsx|mjs|ts|tsx)'],
  addons: [],
  framework: '@storybook/react-vite',
  // Emit fixtures into storybook-static so built Storybook can load wave/spectrogram.
  staticDirs: [MOCK_MEDIA_STATIC_DIR],
  async viteFinal(config) {
    return mergeConfig(config, {
      plugins: [messengerMediaMockPlugin()],
      resolve: {
        alias: {
          react: resolve(webRoot, 'node_modules/react'),
          'react-dom': resolve(webRoot, 'node_modules/react-dom'),
        },
        dedupe: ['react', 'react-dom'],
      },
      optimizeDeps: {
        include: ['react', 'react-dom', '@mui/material', '@mui/icons-material'],
        // Pre-bundling caches the linked player, so local rebuilds of its
        // dist/ never reach the browser until the Vite cache is cleared.
        exclude: ['@echoua/echo-audio-player', '@echoua/echo-audio-player/register'],
      },
    });
  },
};

export default config;
