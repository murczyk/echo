import { spawn, spawnSync } from 'node:child_process';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

import { chromium } from 'playwright';

import { validateLegacyOfficeNginx } from './validate-legacy-office-nginx.mjs';
import { verifyLegacyOfficeWorkerAssets } from './verify-legacy-office-worker-assets.mjs';

const dist = resolve('dist');
const fixtures = resolve('tests/fixtures/legacy-office');

function run(name, args) {
  if (spawnSync(name, args, { stdio: 'inherit' }).status !== 0) throw new Error(`${name} failed`);
}

async function port() {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address == null || typeof address === 'string')
        return reject(new Error('No localhost port'));
      server.close((error) => (error == null ? resolvePort(address.port) : reject(error)));
    });
  });
}

async function wait(url, nginx) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (nginx.exitCode != null) throw new Error('Temporary nginx stopped');
    try {
      if ((await fetch(url)).ok) return;
    } catch {}
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
  }
  throw new Error('Temporary nginx did not start');
}

function pageSource(docWorker, xlsWorker) {
  return [
    `const paths=${JSON.stringify({ doc: `/assets/${docWorker}`, xls: `/assets/${xlsWorker}` })};`,
    "const fixture={doc:'/fixtures/structured-document.doc',xls:'/fixtures/formatted-workbook.xls'};",
    "async function parse(kind,buffer){const worker=new Worker(paths[kind],{type:'module'});const started=performance.now();try{return await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('deadline')),5000);worker.addEventListener('message',event=>{clearTimeout(timer);resolve({response:event.data,milliseconds:performance.now()-started})},{once:true});worker.addEventListener('error',()=>reject(new Error('worker error')),{once:true});worker.postMessage({requestId:kind,request:{buffer}},[buffer]);});}finally{worker.terminate();}}",
    'async function data(path){return (await (await fetch(path)).arrayBuffer());}',
    "async function probe(){const worker=new Worker('/probe.worker.js',{type:'module'});try{return await new Promise((resolve,reject)=>{worker.addEventListener('message',event=>resolve(event.data),{once:true});worker.addEventListener('error',()=>reject(new Error('probe error')),{once:true});worker.postMessage('probe');});}finally{worker.terminate();}}",
    "window.runLegacyOfficeQualification=async()=>{const headers=await Promise.all(Object.values(paths).map(async path=>{const response=await fetch(path);if(!response.ok)throw new Error('worker fetch '+path+' '+response.status);return [path,response.headers.get('content-security-policy')]}));return {headers,doc:await parse('doc',await data(fixture.doc)),xls:await parse('xls',await data(fixture.xls)),hostile:await parse('xls',new TextEncoder().encode('not a CFB container').buffer),recovered:await parse('xls',await data(fixture.xls)),probe:await probe()}};",
  ].join('\n');
}

const probeSource =
  "self.addEventListener('message',async()=>{const result={fetchBlocked:false,socketBlocked:false,nestedWorkerBlocked:false};try{await fetch('/probe-http')}catch{result.fetchBlocked=true}try{const socket=new WebSocket('ws://'+location.host+'/probe-websocket');await new Promise(resolve=>{socket.addEventListener('error',resolve,{once:true});socket.addEventListener('open',()=>{socket.close();resolve()},{once:true})});result.socketBlocked=true}catch{result.socketBlocked=true}try{const nested=new Worker('/probe.child.js');await new Promise(resolve=>{nested.addEventListener('error',()=>{result.nestedWorkerBlocked=true;resolve()},{once:true});nested.addEventListener('message',resolve,{once:true});setTimeout(resolve,250)});nested.terminate()}catch{result.nestedWorkerBlocked=true}self.postMessage(result)});";

run('npm', ['run', 'build']);
const { assets, docWorker, xlsWorker } = await verifyLegacyOfficeWorkerAssets();
const { csp: workerCsp } = await validateLegacyOfficeNginx(assets);
let directory = await mkdtemp(resolve(tmpdir(), 'echo-legacy-office-qualification-'));
let listenPort = await port();
let baseUrl = `http://127.0.0.1:${listenPort}`;
let config = resolve(directory, 'nginx.conf');
await writeFile(
  resolve(directory, 'qualification.html'),
  '<script src="/qualification.js"></script>',
);
await writeFile(resolve(directory, 'qualification.js'), pageSource(docWorker, xlsWorker));
await writeFile(resolve(directory, 'probe.worker.js'), probeSource);
await writeFile(resolve(directory, 'probe.child.js'), 'self.postMessage("unexpected");');
await writeFile(
  config,
  [
    `pid ${directory}/nginx.pid;`,
    `error_log ${directory}/error.log;`,
    'events {}',
    'http {',
    `access_log ${directory}/access.log;`,
    'server {',
    `listen 127.0.0.1:${listenPort};`,
    `root ${directory};`,
    `location = /assets/${docWorker} {`,
    `alias ${resolve(dist, 'assets', docWorker)};`,
    `add_header Content-Security-Policy "${workerCsp}" always;`,
    'default_type application/javascript;',
    '}',
    `location = /assets/${xlsWorker} {`,
    `alias ${resolve(dist, 'assets', xlsWorker)};`,
    `add_header Content-Security-Policy "${workerCsp}" always;`,
    'default_type application/javascript;',
    '}',
    'location = /probe.worker.js {',
    `add_header Content-Security-Policy "${workerCsp}" always;`,
    'default_type application/javascript;',
    '}',
    'location = /probe.child.js {',
    `add_header Content-Security-Policy "${workerCsp}" always;`,
    'default_type application/javascript;',
    '}',
    'location = /qualification.html {',
    "add_header Content-Security-Policy \"default-src 'none'; connect-src 'self'; script-src 'self'; worker-src 'self'\" always;",
    '}',
    `location /fixtures/ { alias ${fixtures}/; }`,
    'location = /probe-http { return 204; }',
    'location = /probe-websocket { return 204; }',
    '}',
    '}',
  ].join('\n'),
);
const nginxArgs = () => [
  '-g',
  `daemon off; error_log ${resolve(directory, 'bootstrap-error.log')};`,
  '-p',
  directory,
  '-c',
  config,
];
const stopNginx = (nginx) => {
  spawnSync('nginx', [...nginxArgs(), '-s', 'stop'], { stdio: 'ignore' });
  if (nginx.exitCode == null) nginx.kill();
};
let nginx;
let nginxStderr = '';
for (let attempt = 0; attempt < 3; attempt += 1) {
  nginxStderr = '';
  nginx = spawn('nginx', nginxArgs(), { stdio: ['ignore', 'inherit', 'pipe'] });
  nginx.stderr.on('data', (chunk) => {
    nginxStderr += String(chunk);
  });
  try {
    await wait(`${baseUrl}/qualification.html`, nginx);
    break;
  } catch (error) {
    const errorLog = await readFile(resolve(directory, 'error.log'), 'utf8').catch(() => '');
    const diagnostics = `${nginxStderr}\n${errorLog}`;
    stopNginx(nginx);
    if (!/address already in use|bind\(\).*failed/i.test(diagnostics) || attempt === 2) {
      console.error(
        `Temporary nginx startup failed. stderr:\n${nginxStderr || '(none)'}\nerror log:\n${errorLog || '(none)'}`,
      );
      await rm(directory, { force: true, recursive: true });
      throw error;
    }
    const previousDirectory = directory;
    const previousPort = listenPort;
    directory = await mkdtemp(resolve(tmpdir(), 'echo-legacy-office-qualification-'));
    listenPort = await port();
    baseUrl = `http://127.0.0.1:${listenPort}`;
    config = resolve(directory, 'nginx.conf');
    await cp(previousDirectory, directory, { recursive: true });
    await writeFile(
      config,
      (await readFile(config, 'utf8'))
        .replaceAll(previousDirectory, directory)
        .replace(`listen 127.0.0.1:${previousPort};`, `listen 127.0.0.1:${listenPort};`),
    );
    await rm(previousDirectory, { force: true, recursive: true });
  }
}
try {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    const violations = [];
    page.on('console', (message) => {
      if (message.type() === 'error' && /Content Security Policy/i.test(message.text()))
        violations.push(message.text());
    });
    await page.goto(`${baseUrl}/qualification.html`);
    let result;
    try {
      result = await page.evaluate(() => window.runLegacyOfficeQualification());
    } catch (error) {
      throw new Error(
        `${error instanceof Error ? error.message : String(error)}; console: ${violations.join(' | ')}`,
      );
    }
    const valid =
      result.headers.every(([, header]) => header === workerCsp) &&
      result.doc.response.ok &&
      result.xls.response.ok &&
      !result.hostile.response.ok &&
      result.hostile.response.error === 'LEGACY_OFFICE_INVALID_CFB' &&
      result.recovered.response.ok &&
      result.probe.fetchBlocked &&
      result.probe.socketBlocked &&
      result.probe.nestedWorkerBlocked;
    if (!valid)
      throw new Error(`Unexpected production qualification result: ${JSON.stringify(result)}`);
    if (
      /probe-(?:http|websocket|child)/.test(
        await readFile(resolve(directory, 'access.log'), 'utf8'),
      )
    )
      throw new Error('A CSP-blocked request reached a probe endpoint');
    console.log(
      JSON.stringify({
        docWorker,
        xlsWorker,
        cspViolations: violations.length,
        timings: { doc: result.doc.milliseconds, xls: result.xls.milliseconds },
      }),
    );
  } finally {
    await browser.close();
  }
} catch (error) {
  const errorLog = await readFile(resolve(directory, 'error.log'), 'utf8').catch(() => '');
  console.error(
    `Temporary nginx qualification failed. stderr:\n${nginxStderr || '(none)'}\nerror log:\n${errorLog || '(none)'}`,
  );
  throw error;
} finally {
  stopNginx(nginx);
  await rm(directory, { force: true, recursive: true });
}
