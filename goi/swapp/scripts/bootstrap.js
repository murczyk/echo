const { createHash } = require("crypto");
const { existsSync, mkdirSync, readFileSync, writeFileSync } = require("fs");
const { join, dirname, delimiter } = require("path");
const { spawn } = require("child_process");

if (process.platform === "win32") {
  try {
    // Flip current console to UTF-8 in-place. Using spawnSync ensures it runs
    // in the same console and actually persists for this process.
    const { spawnSync } = require("child_process");
    const r = spawnSync("cmd.exe", ["/c", "chcp", "65001"], {
      stdio: "inherit",
    });
    // Optional: if chcp failed for any reason, just continue; better to run than to crash.
  } catch {}
}

const ROOT = join(__dirname, "..");
const STAMP_DIR = join(ROOT, ".bootstrap");
const STAMP_FILE = join(STAMP_DIR, "deps.stamp");
const APP_NAME = "SWapp";

console.log(`Каталог з ${APP_NAME} ${ROOT}`);

const nodeBin = process.execPath;
const nodeDir = dirname(nodeBin);

// Resolve npm-cli.js relative to the current Node
const npmCli = join(nodeDir, "node_modules", "npm", "bin", "npm-cli.js");

console.log(`Шлях до Node.js ${nodeBin}`);
console.log(`Шлях до NPM ${npmCli}`);

const log = (msg) => console.log(msg);
const error = (msg) => console.error(msg);

const startHeartbeat = (label, intervalMs = 10000) => {
  const started = Date.now();
  const id = setInterval(() => {
    const s = Math.floor((Date.now() - started) / 1000);
    log(`${label} ... виконується вже ${s} секунд`);
  }, intervalMs);
  return () => clearInterval(id);
};

const prettyMs = (ms) => {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} секунд`;
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m} хв ${r} сек`;
};

const buildEnv = () => {
  // Start from current process env but drop any inherited npm_config_* keys
  const baseEntries = Object.entries(process.env || {}).filter(
    ([k]) => !/^npm_config_/i.test(k),
  );
  const base = Object.fromEntries(baseEntries);
  return {
    ...base,
    // Ensure our bundled Node is first in PATH
    PATH: `${nodeDir}${delimiter}${base.PATH || ""}`,
    // Tell npm which node and npm to use (safe in npm >=10)
    npm_node_execpath: nodeBin,
    npm_execpath: npmCli,
    // Do NOT set deprecated scripts-prepend-node-path here
    PORT: base.PORT || "4002",
  };
};

const run = (cmd, args, opts = {}) =>
  new Promise((resolve, reject) => {
    const env = buildEnv();
    const started = Date.now();
    log(`Виконуємо $ ${cmd} ${args.join(" ")}`);
    const child = spawn(cmd, args, {
      cwd: opts.cwd || ROOT,
      stdio: "inherit",
      env,
    });
    child.on("close", (code) => {
      const dur = prettyMs(Date.now() - started);
      if (code === 0) {
        log(`Завершено за ${dur}`);
        resolve(0);
      } else {
        log(`Помилка ${code} після ${dur}`);
        reject(new Error(`${cmd} ${args.join(" ")} exited ${code}`));
      }
    });
  });

const runForeground = (cmd, args, opts = {}) =>
  new Promise((resolve, reject) => {
    const env = buildEnv();
    // Hand off the terminal to the child process (Next.js)
    const child = spawn(cmd, args, {
      cwd: opts.cwd || ROOT,
      stdio: "inherit",
      env,
    });
    child.on("exit", (code) => {
      if (code === 0) return resolve(0);
      return reject(new Error(`${cmd} ${args.join(" ")} exited ${code}`));
    });
  });

const depsHash = () => {
  const h = createHash("sha256");
  const pkg = join(ROOT, "package.json");

  if (existsSync(pkg)) h.update(readFileSync(pkg));

  return h.digest("hex");
};

const readStamp = () => {
  try {
    return readFileSync(STAMP_FILE, "utf8");
  } catch {
    return null;
  }
};
const writeStamp = (val) => {
  if (!existsSync(STAMP_DIR)) mkdirSync(STAMP_DIR, { recursive: true });
  writeFileSync(STAMP_FILE, val, "utf8");
};

const ensureDeps = async () => {
  log("Перевіряємо залежності ...");
  const current = depsHash();
  const stamped = readStamp();
  const nodeModulesMissing = !existsSync(join(ROOT, "node_modules"));
  if (nodeModulesMissing || current !== stamped) {
    if (!existsSync(npmCli)) {
      throw new Error(
        `Не виявлено npm-cli.js за шляхом: ${npmCli}. Перевірте наявність папки .runtime\\та те що node має доступний npm.`,
      );
    }
    const lockPath = join(ROOT, "package-lock.json");
    const useCi = existsSync(lockPath);
    const installCommand = useCi ? "ci" : "install";
    if (nodeModulesMissing) {
      log(
        `node_modules папка не виявлена, встановлюємо залежності (npm ${installCommand}) ...`,
      );
    } else {
      log(
        `Виявлено зміни, встановлюємо залежності (npm ${installCommand}) ...`,
      );
    }
    log(
      "Це одноразова дія (може зайняти до 2 хвилин в залежності від швидкості інтернету)",
    );

    const stopBeat = startHeartbeat("Встановлення залежностей", 15000);
    const started = Date.now();
    await run(nodeBin, [
      npmCli,
      installCommand,
      "--no-audit",
      "--no-fund",
      "--no-progress",
      "--loglevel",
      "error",
    ]);
    stopBeat();
    log(`Зеленості встановлено за ${prettyMs(Date.now() - started)}`);
    const finalHash = depsHash();
    writeStamp(finalHash);
  } else {
    log("Залежності актуальні, продовжуємо ...");
  }
};

const openInBrowser = (url, delayMs = 5000) => {
  try {
    setTimeout(() => {
      try {
        if (process.platform === "win32") {
          // Use 'start' via cmd. Empty title argument "" is required.
          spawn("cmd", ["/c", "start", "", url], {
            detached: true,
            stdio: "ignore",
          }).unref();
        } else if (process.platform === "darwin") {
          spawn("open", [url], { detached: true, stdio: "ignore" }).unref();
        } else {
          spawn("xdg-open", [url], { detached: true, stdio: "ignore" }).unref();
        }
      } catch {}
    }, delayMs);
  } catch {}
};

const startApp = async () => {
  const pkgJson = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
  const port = process.env.PORT || "4002";
  log(
    "На деяких компʼютерах 'Windows Security Alert' може заптати дозвіл для Node.js до приватних та публічних мереж.",
  );
  log(
    "Потрібно надати цей дозвіл якщо ви плануєте виступати як сервер для інших компʼютерів у вашій локальній мережі.",
  );
  log(
    `Якщо ви випадково не надали дозволу, це можна змінити в 'Windows Defender Firewall' дозволивши: ${nodeBin}`,
  );
  log(
    `Альтернативно, можна додати нове правило: Inbound Rules > New Rule > Program > This program: ${nodeBin} > Allow > (Private) > Name: 'SWapp local node'.`,
  );
  log(
    `${APP_NAME} буде використовувати порт ${port}. Якщо він заблокований, змініть порт або розблокуйте його в налаштуваннях Firewall.`,
  );

  if (pkgJson?.scripts?.start) {
    log(
      `Запускаємо ${APP_NAME} командою "npm start" використовуючи порт ${port} ...`,
    );
    log(`Передаємо контроль для ${APP_NAME}`);
    openInBrowser(`http://localhost:${port}`, 2000);
    await runForeground(nodeBin, [npmCli, "run", "start"]);
  } else {
    log(
      `Не виявлено "start" скрипта. Виконуємо "next start" використовуючи порт ${port} ...`,
    );
    log(`Передаємо контроль для ${APP_NAME}`);
    openInBrowser(`http://localhost:${port}`, 2000);
    await runForeground(nodeBin, [npmCli, "exec", "next", "start", "-p", port]);
  }
};

(async () => {
  log(`Запускаємо ${APP_NAME} використовуючи локальну версію Node ...`);
  await ensureDeps();
  await startApp();
})().catch((err) => {
  error(String((err && err.stack) || err));
  process.exit(1);
});
