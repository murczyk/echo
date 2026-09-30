import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const nginxDirectory = resolve(scriptDirectory, '../../deploy/nginx');
const workerAssetPattern = /^(?:doc|xls)-preview\.worker-[a-z0-9_-]+\.js$/i;
const workerLocationStart = 'location ~* ^/assets/(?:doc|xls)-preview\\.worker-[a-z0-9_-]+\\.js$ {';
const requiredDirectives = [
  "default-src 'none'",
  "connect-src 'none'",
  "worker-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
];

export const productionSites = [
  'echo-190-training',
  'echo-cbr',
  'echo-donetsk2',
  'echo-kharkiv2',
  'echo-kherson2',
  'echo-kupiansk',
  'echo-pivnich',
  'echo-siversk',
  'echo-skhid',
  'echo-staging',
  'echo-volyn2',
  'echo-zaporizhzha2',
];
function extractWorkerPolicy(site, fragment) {
  const start = fragment.indexOf(workerLocationStart);
  if (start === -1) throw new Error(`${site}: missing legacy Office worker location`);
  const end = fragment.indexOf('\n    }', start);
  if (end === -1) throw new Error(`${site}: unterminated legacy Office worker location`);
  const location = fragment.slice(start, end + '\n    }'.length);
  const csp = location.match(/add_header Content-Security-Policy "([^"]+)" always;/)?.[1];
  if (csp == null) throw new Error(`${site}: worker location lacks a CSP header`);
  for (const directive of requiredDirectives)
    if (!csp.includes(directive)) throw new Error(`${site}: worker CSP lacks ${directive}`);
  return { location, csp };
}

async function checkStandaloneConfig(site, fragment) {
  const standaloneFragment = fragment
    .replace(/^\s*listen\b.*$/gm, '')
    .replace(/^\s*ssl_(?:certificate|certificate_key)\b.*$/gm, '');
  const directory = await mkdtemp(resolve(tmpdir(), 'echo-nginx-'));
  const config = resolve(directory, 'nginx.conf');
  await writeFile(
    config,
    `pid ${directory}/nginx.pid;\nerror_log ${directory}/error.log;\nevents {}\nhttp {\n${standaloneFragment}\n}\n`,
  );
  try {
    const result = spawnSync('nginx', ['-t', '-p', directory, '-c', config], {
      encoding: 'utf8',
    });
    if (result.status !== 0) throw new Error(`${site}: ${result.stderr || result.stdout}`);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
}

export async function validateLegacyOfficeNginx(workerAssets = []) {
  for (const workerAsset of workerAssets)
    if (!workerAssetPattern.test(workerAsset))
      throw new Error(`Worker location does not match emitted asset: ${workerAsset}`);
  const policies = await Promise.all(
    productionSites.map(async (site) => {
      const fragment = await readFile(resolve(nginxDirectory, site), 'utf8');
      const policy = extractWorkerPolicy(site, fragment);
      await checkStandaloneConfig(site, fragment);
      return policy;
    }),
  );
  const first = policies[0];
  if (first == null) throw new Error('No production nginx sites configured');
  if (policies.some((policy) => policy.location !== first.location || policy.csp !== first.csp))
    throw new Error('Production nginx sites do not share an identical legacy Office worker policy');
  return { csp: first.csp, location: first.location };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  await validateLegacyOfficeNginx();
  console.log(`Validated ${productionSites.length} production nginx site fragments.`);
}
