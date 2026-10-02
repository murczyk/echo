import { createRequire } from 'node:module';
import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, normalize, resolve, sep } from 'node:path';
import { chromium } from 'playwright';

const evaluationDir = resolve(
  process.env.LEGACY_OFFICE_EVAL_DIR ?? '/tmp/legacy-office-evaluation',
);
const docFixture = resolve(
  evaluationDir,
  'JSDoc-821695a884e0c0bb8592a635d9524bb3e116cd67/samples/feature-showcase.doc',
);
const fixtureBuilder = resolve(
  evaluationDir,
  'JSDoc-821695a884e0c0bb8592a635d9524bb3e116cd67/test/make-fixture.js',
);
const independentFixtureDir = resolve(
  new URL('../tests/fixtures/legacy-office', import.meta.url).pathname,
);

if (
  !existsSync(resolve(evaluationDir, 'package/dist/xlsx.full.min.js')) ||
  !existsSync(docFixture) ||
  !existsSync(fixtureBuilder) ||
  !existsSync(resolve(independentFixtureDir, '3dFormulas.xls')) ||
  !existsSync(resolve(independentFixtureDir, 'DateFormats.xls')) ||
  !existsSync(resolve(independentFixtureDir, 'SimpleWithDataFormat.xls'))
) {
  throw new Error(
    `Missing historical evaluation artifacts in ${evaluationDir}. Set LEGACY_OFFICE_EVAL_DIR to a directory containing package/dist/xlsx.full.min.js, package/xlsx.mjs, JSDoc-821695a884e0c0bb8592a635d9524bb3e116cd67/src/docToText.js, JSDoc-821695a884e0c0bb8592a635d9524bb3e116cd67/samples/feature-showcase.doc, and JSDoc-821695a884e0c0bb8592a635d9524bb3e116cd67/test/make-fixture.js.`,
  );
}

const server = createServer((request, response) => {
  const csp = "default-src 'none'; script-src 'self'; connect-src 'none'; worker-src 'self' blob:";
  const requestedPath = normalize(new URL(request.url ?? '/', 'http://localhost').pathname);
  if (requestedPath === '/') {
    response.writeHead(200, { 'Content-Type': 'text/html', 'Content-Security-Policy': csp }).end();
    return;
  }
  const filePath = resolve(evaluationDir, `.${requestedPath}`);
  if (
    !filePath.startsWith(`${evaluationDir}${sep}`) ||
    !existsSync(filePath) ||
    !statSync(filePath).isFile()
  ) {
    response.writeHead(404).end();
    return;
  }

  response.writeHead(200, {
    'Content-Type': extname(filePath) === '.js' ? 'text/javascript' : 'application/octet-stream',
    'Content-Security-Policy': csp,
  });
  createReadStream(filePath).pipe(response);
});

await new Promise((resolveServer) => server.listen(0, '127.0.0.1', resolveServer));
const address = server.address();
if (address == null || typeof address === 'string')
  throw new Error('Local evaluation server did not start');
const baseUrl = `http://127.0.0.1:${address.port}`;
const docFixtureBytes = Array.from(readFileSync(docFixture));
const independentFixtures = Object.fromEntries(
  ['3dFormulas.xls', 'DateFormats.xls', 'SimpleWithDataFormat.xls'].map((name) => [
    name,
    Array.from(readFileSync(resolve(independentFixtureDir, name))),
  ]),
);
const require = createRequire(import.meta.url);
const knownAnswerDoc = Array.from(require(fixtureBuilder).buildDoc());
const parseDoc = require(
  resolve(evaluationDir, 'JSDoc-821695a884e0c0bb8592a635d9524bb3e116cd67/src/docToText.js'),
);
const SheetJS = await import(resolve(evaluationDir, 'package/xlsx.mjs'));

function probeSheetJsDifat(count) {
  const input = new Uint8Array(readFileSync(resolve(independentFixtureDir, '3dFormulas.xls')));
  const view = new DataView(input.buffer);
  view.setInt32(68, 0, true);
  view.setInt32(72, count, true);
  view.setInt32(512 + 127 * 4, 0, true);
  const started = performance.now();
  try {
    SheetJS.read(input, { type: 'array' });
    return { count, accepted: true, milliseconds: performance.now() - started };
  } catch (error) {
    return {
      count,
      accepted: false,
      milliseconds: performance.now() - started,
      error: String(error),
    };
  }
}

function probeFormulaCaches() {
  const sheet = SheetJS.utils.aoa_to_sheet([
    ['number', 'string', 'boolean', 'error', 'missing', 'empty'],
  ]);
  sheet.A2 = { t: 'n', v: 42, f: '1+1' };
  sheet.B2 = { t: 's', v: 'cached', f: '"x"' };
  sheet.C2 = { t: 'b', v: true, f: 'TRUE()' };
  sheet.D2 = { t: 'e', v: 7, f: '1/0' };
  sheet.E2 = { t: 'n', f: '9+9' };
  sheet['!ref'] = 'A1:F2';
  const workbook = SheetJS.utils.book_new();
  SheetJS.utils.book_append_sheet(workbook, sheet, 'FormulaCaches');
  const parsed = SheetJS.read(SheetJS.write(workbook, { type: 'array', bookType: 'xls' }), {
    type: 'array',
    cellFormula: true,
  }).Sheets.FormulaCaches;
  return Object.fromEntries(
    ['A2', 'B2', 'C2', 'D2', 'E2', 'F2'].map((address) => [address, parsed[address] ?? null]),
  );
}

const sheetJsDifatProbe = {
  acceptedMalformed: probeSheetJsDifat(5_000),
  deepChain: probeSheetJsDifat(10_000),
};
const formulaCacheProbe = probeFormulaCaches();

function rejectInvalidDifat(input) {
  if (input.byteLength < 512) throw new Error('CFB header is truncated');
  const view = new DataView(input.buffer, input.byteOffset, input.byteLength);
  const sectorSize = 1 << view.getUint16(30, true);
  if (sectorSize !== 512 && sectorSize !== 4096) throw new Error('CFB sector size is unsupported');

  const sectorCount = Math.floor((input.byteLength - 512) / sectorSize);
  const difatCount = view.getUint32(72, true);
  if (difatCount > sectorCount) throw new Error('CFB DIFAT count exceeds container sectors');

  const endOfChain = 0xfffffffe;
  const freeSector = 0xffffffff;
  let sector = view.getUint32(68, true);
  const visited = new Set();
  for (let index = 0; index < difatCount; index += 1) {
    if (sector >= sectorCount || visited.has(sector)) throw new Error('CFB DIFAT chain is invalid');
    visited.add(sector);
    sector = view.getUint32((sector + 2) * sectorSize - 4, true);
  }
  if (sector !== endOfChain && sector !== freeSector)
    throw new Error('CFB DIFAT chain is longer than declared');
}

const difatProbe = new Uint8Array(knownAnswerDoc);
const difatProbeView = new DataView(difatProbe.buffer);
difatProbeView.setUint32(68, 0, true);
difatProbeView.setUint32(72, 5_000, true);
difatProbeView.setUint32(512 + 127 * 4, 0, true);
const beforeDifatProbe = process.memoryUsage().arrayBuffers;
const difatProbeStarted = performance.now();
const difatProbeOutput = parseDoc(difatProbe);
const difatProbeResult = {
  inputBytes: difatProbe.byteLength,
  milliseconds: performance.now() - difatProbeStarted,
  arrayBufferBytes: process.memoryUsage().arrayBuffers - beforeDifatProbe,
  accepted: difatProbeOutput === 'Hello, “World”\n1Tab\tEnd\nUnicode: éπ\n',
  preflightRejected: false,
};
try {
  rejectInvalidDifat(difatProbe);
} catch {
  difatProbeResult.preflightRejected = true;
}

const browser = await chromium.launch({ headless: true });
try {
  const requests = [];
  const page = await browser.newPage();
  page.on('request', (request) => requests.push(request.url()));
  await page.goto(baseUrl);
  const result = await page.evaluate(
    async ({ baseUrl, docFixtureBytes, knownAnswerDoc, independentFixtures }) => {
      function runWorker(source, input, timeoutMs = 2_000) {
        return new Promise((resolveResult) => {
          const worker = new Worker(
            URL.createObjectURL(new Blob([source], { type: 'text/javascript' })),
          );
          const timeout = setTimeout(() => {
            worker.terminate();
            resolveResult({ timeout: true });
          }, timeoutMs);
          worker.addEventListener('message', ({ data }) => {
            clearTimeout(timeout);
            worker.terminate();
            resolveResult(data);
          });
          worker.addEventListener('error', (event) => {
            clearTimeout(timeout);
            worker.terminate();
            resolveResult({ error: event.message });
          });
          const buffer = Uint8Array.from(input).buffer;
          worker.postMessage(buffer, [buffer]);
        });
      }

      const xls = await runWorker(
        `importScripts('${baseUrl}/package/dist/xlsx.full.min.js');
       self.onmessage=async()=>{try{
         const first=XLSX.utils.aoa_to_sheet([['Назва','Код','Дата','Сума','Формула','Немає результату','Порожньо'],['Київ','00123',45929,1234.5,3,null,null]]);
         first.C2={t:'n',v:45929,z:'yyyy-mm-dd'};first.D2={t:'n',v:1234.5,z:'#,##0.00'};first.E2={t:'n',v:99,f:'1+2'};first.F2={t:'n',f:'9+9'};first['!merges']=[XLSX.utils.decode_range('A1:B1')];
         const second=XLSX.utils.aoa_to_sheet([['Змішані','true'],['Latin / Кирилиця',true]]);
         const workbook=XLSX.utils.book_new();XLSX.utils.book_append_sheet(workbook,first,'Дані');XLSX.utils.book_append_sheet(workbook,second,'Mixed');
         const bytes=XLSX.write(workbook,{type:'array',bookType:'xls'});const started=performance.now();const parsed=XLSX.read(bytes,{type:'array',cellFormula:true,cellNF:true});
         const fetchBlocked=await fetch('${baseUrl}/network-probe').then(()=>false).catch(()=>true);const socketBlocked=await new Promise(resolve=>{const socket=new WebSocket('ws://127.0.0.1:9');socket.onopen=()=>{socket.close();resolve(false)};socket.onerror=()=>resolve(true)});
         const formatConfusion=XLSX.read(new TextEncoder().encode('a,b\\n1,2'),{type:'array'}).Sheets.Sheet1.A1.v;
         const sheet=parsed.Sheets['Дані'];self.postMessage({ok:true,milliseconds:performance.now()-started,sheets:parsed.SheetNames,leadingZero:sheet.B2.w,date:sheet.C2.w,number:sheet.D2.w,boolean:parsed.Sheets.Mixed.B2.v,cachedFormula:sheet.E2.v,missingCachedFormula:sheet.F2?.v??null,blank:sheet.G2?.v??null,mergeCount:sheet['!merges'].length,mixed:parsed.Sheets.Mixed.A2.v,fetchBlocked,socketBlocked,formatConfusion});
       }catch(error){self.postMessage({ok:false,error:String(error)})}}`,
        [],
      );
      const doc = await runWorker(
        `importScripts('${baseUrl}/JSDoc-821695a884e0c0bb8592a635d9524bb3e116cd67/src/docToText.js','${baseUrl}/JSDoc-821695a884e0c0bb8592a635d9524bb3e116cd67/src/textToDoc.js');
       self.onmessage=event=>{try{const known=docToText(event.data);const sample=docToText.model(Uint8Array.from(${JSON.stringify(docFixtureBytes)}));const ukrainian='Ґґ Єє Іі Її / Latin <img src=x onerror=alert(1)>';const ukrainianModel=docToText.model(textToDoc(ukrainian));self.postMessage({ok:known==='Hello, “World”\\n1Tab\\tEnd\\nUnicode: éπ\\n',known,paragraphs:sample?.body?.length??0,lists:sample?.body?.filter(paragraph=>paragraph.list).length??0,tableCells:sample?.body?.filter(paragraph=>paragraph.kind==='cell'||paragraph.kind==='rowEnd').length??0,ukrainian:ukrainianModel.body[0].runs.map(run=>run.text).join('')})}catch(error){self.postMessage({ok:false,error:String(error)})}}`,
        knownAnswerDoc,
      );
      const readIndependentXls = `importScripts('${baseUrl}/package/dist/xlsx.full.min.js');self.onmessage=event=>{try{const workbook=XLSX.read(event.data,{type:'array',cellFormula:true,cellNF:true,cellDates:true});const cells={};for(const name of workbook.SheetNames){const sheet=workbook.Sheets[name];for(const address of ['A1','A5','A7','B1','B4']){if(sheet[address])cells[name+'!'+address]={v:sheet[address].v instanceof Date?sheet[address].v.toISOString():sheet[address].v,w:sheet[address].w??null,f:sheet[address].f??null,t:sheet[address].t}}}self.postMessage({ok:true,sheets:workbook.SheetNames,cells})}catch(error){self.postMessage({ok:false,error:String(error)})}}`;
      const independent = {};
      for (const [name, bytes] of Object.entries(independentFixtures))
        independent[name] = await runWorker(readIndependentXls, bytes);
      const timeout = await runWorker('self.onmessage=()=>{while(true){}}', [], 25);
      return { xls, doc, independent, timeout };
    },
    { baseUrl, docFixtureBytes, knownAnswerDoc, independentFixtures },
  );
  const renderedElements = await page.evaluate((text) => {
    const rendered = document.createElement('pre');
    rendered.textContent = text;
    return rendered.children.length;
  }, result.doc.ukrainian);
  result.doc.renderedElements = renderedElements;

  const expectedRequests = new Set([
    `${baseUrl}/`,
    `${baseUrl}/package/dist/xlsx.full.min.js`,
    `${baseUrl}/JSDoc-821695a884e0c0bb8592a635d9524bb3e116cd67/src/docToText.js`,
    `${baseUrl}/JSDoc-821695a884e0c0bb8592a635d9524bb3e116cd67/src/textToDoc.js`,
  ]);
  const assertions = {
    xls:
      result.xls.ok &&
      JSON.stringify(result.xls.sheets) === JSON.stringify(['Дані', 'Mixed']) &&
      result.xls.leadingZero === '00123' &&
      result.xls.date === '2025-09-29' &&
      result.xls.number === '1,234.50' &&
      result.xls.boolean === true &&
      result.xls.cachedFormula === 99 &&
      result.xls.missingCachedFormula === null &&
      result.xls.blank === null &&
      result.xls.mergeCount === 1 &&
      result.xls.mixed === 'Latin / Кирилиця' &&
      result.xls.fetchBlocked === true &&
      result.xls.socketBlocked === true,
    doc:
      result.doc.ok &&
      result.doc.paragraphs === 33 &&
      result.doc.lists === 5 &&
      result.doc.tableCells === 15 &&
      result.doc.ukrainian === 'Ґґ Єє Іі Її / Latin <img src=x onerror=alert(1)>' &&
      result.doc.renderedElements === 0,
    timeout: result.timeout.timeout === true,
    independent:
      result.independent['3dFormulas.xls']?.ok === true &&
      JSON.stringify(result.independent['3dFormulas.xls'].sheets) ===
        JSON.stringify(['Sheet1', 'S2', 'Sh3']) &&
      result.independent['3dFormulas.xls'].cells['Sheet1!A5']?.v === 'S2-A1' &&
      result.independent['3dFormulas.xls'].cells['Sheet1!A5']?.f === 'S2!A1' &&
      result.independent['3dFormulas.xls'].cells['Sheet1!A7']?.v === 165 &&
      result.independent['DateFormats.xls']?.cells['Sheet1!B4']?.w === 'Friday, August 10, 2007' &&
      result.independent['SimpleWithDataFormat.xls']?.cells['Sheet1!A1']?.w === '1.3',
    formulaCaches:
      formulaCacheProbe.A2?.v === 42 &&
      formulaCacheProbe.B2?.v === 'cached' &&
      formulaCacheProbe.C2?.v === true &&
      formulaCacheProbe.D2?.w === '#DIV/0!' &&
      formulaCacheProbe.E2 === null &&
      formulaCacheProbe.F2 === null,
    network: requests
      .filter((url) => url.startsWith('http'))
      .every((url) => expectedRequests.has(url)),
  };
  console.log(
    JSON.stringify(
      { result, assertions, requests, difatProbeResult, sheetJsDifatProbe, formulaCacheProbe },
      null,
    ),
  );
  if (!Object.values(assertions).every(Boolean)) process.exitCode = 1;
} finally {
  await browser.close();
  await new Promise((resolveServer) => server.close(resolveServer));
}
