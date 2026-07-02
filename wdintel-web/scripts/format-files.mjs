import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');

const sourcePatterns = [
  'package.json',
  '.prettierrc.json',
  '*config*.{js,ts,mjs,cjs}',
  'tsconfig*.json',
  'scripts/**/*.{js,jsx,ts,tsx,html,css,json,mjs,cjs}',
  'tests/**/*.{js,jsx,ts,tsx,html,css,json,mjs,cjs}',
  'src/**/*.{js,jsx,ts,tsx,html,css,json,mjs,cjs}',
];

const repoRootStagedPattern = `wdintel-web/{${sourcePatterns.join(',')}}`;

const commands = {
  all: ['prettier', ['--write', ...sourcePatterns]],
  staged: ['pretty-quick', ['--staged', '--pattern', repoRootStagedPattern]],
};

const mode = process.argv[2];

if (!Object.hasOwn(commands, mode)) {
  console.error('Usage: node scripts/format-files.mjs <all|staged>');
  process.exit(1);
}

const [command, args] = commands[mode];

const child = spawn(command, args, {
  cwd: projectRoot,
  stdio: 'inherit',
  shell: process.platform === 'win32',
});

child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }

  process.exit(code ?? 1);
});

child.on('error', (error) => {
  console.error(`[format-files] failed to run ${command}:`, error);
  process.exit(1);
});
