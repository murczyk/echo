const fs = require("fs");
const path = require("path");
const { exec, spawn } = require("child_process");
const os = require("os");

const CONFIG_PATH = path.join(__dirname, "../data/config.json");
const config = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
const { signalPort, signalMode, signalName = "swapp-signal" } = config;

const imageName = "bbernhard/signal-cli-rest-api";
let weStartedContainer = false; // only stop it on shutdown if we started it in this run
let logsProcess = null;

const execAsync = (cmd) =>
  new Promise((resolve, reject) => {
    exec(cmd, (err, stdout, stderr) => {
      if (err) return reject(new Error(stderr || err.message));
      resolve(stdout.trim());
    });
  });

const info = (msg) => console.log(`\u001b[36m[i]\u001b[0m ${msg}`);
const ok = (msg) => console.log(`\u001b[32m[✓]\u001b[0m ${msg}`);
const warn = (msg) => console.log(`\u001b[33m[!]\u001b[0m ${msg}`);
const err = (msg) => console.error(`\u001b[31m[x]\u001b[0m ${msg}`);

const ensureDockerRunning = async () => {
  info("Checking Docker CLI availability...");
  try {
    const version = await execAsync("docker --version");
    ok(`Docker found: ${version}`);
  } catch (e) {
    err(
      "Docker is not installed or not on PATH (try `docker -v` in your terminal).\nInstall Docker Desktop: https://www.docker.com/products/docker-desktop"
    );
    process.exitCode = 1;
    throw e;
  }

  try {
    await execAsync("docker info");
    ok("Docker daemon is running.");
  } catch (e) {
    err(
      "Docker is installed but the daemon is not running. Start Docker Desktop and re-run."
    );
    process.exitCode = 1;
    throw e;
  }
};

const containerExists = async (name) => {
  try {
    const out = await execAsync(
      `docker ps -a --filter "name=^/${name}$" --format "{{.Names}}"`
    );
    return out === name;
  } catch {
    return false;
  }
};

const containerRunning = async (name) => {
  try {
    const out = await execAsync(
      `docker inspect -f "{{.State.Running}}" ${name}`
    );
    return out === "true";
  } catch {
    return false;
  }
};

const ensureImage = async (image) => {
  try {
    await execAsync(`docker image inspect ${image}`);
    ok(`${image} image present.`);
  } catch {
    info(`Pulling ${image}...`);
    await execAsync(`docker pull ${image}`);
    ok(`${image} pulled.`);
  }
};

const computeVolumePath = () => {
  const home = os.homedir().replace(/\\/g, "/");
  if (os.platform() === "win32") {
    // Convert C:\Users\name -> /host_mnt/c/Users/name
    return `/host_mnt/${home.slice(0, 1).toLowerCase()}${home
      .slice(2)
      .replace(/\\/g, "/")}/.local/share/signal-api`;
  }
  return `${home}/.local/share/signal-api`;
};

const startContainer = async () => {
  const exists = await containerExists(signalName);
  const running = exists ? await containerRunning(signalName) : false;

  if (running) {
    ok(`${signalName} already running.`);
    return false; // we didn't start it
  }

  if (!exists) {
    await ensureImage(imageName);
  }

  const volumePath = computeVolumePath();
  info(
    `Ensuring port ${signalPort} is available and starting ${signalName}...`
  );

  const runCmd = [
    "run",
    "-d",
    "--name",
    signalName,
    "--restart=always",
    "-p",
    `${signalPort}:8080`,
    "-v",
    `${volumePath}:/home/.local/share/signal-cli`,
    "-e",
    `MODE=${signalMode}`,
    imageName,
  ];

  try {
    const out = await execAsync(`docker ${runCmd.join(" ")}`);
    ok(`Started ${signalName}: ${out}`);
    return true; // we started it
  } catch (e) {
    // If container exists but not running, try to start instead of run
    if (await containerExists(signalName)) {
      info(`Attempting to start existing container ${signalName}...`);
      const out = await execAsync(`docker start ${signalName}`);
      ok(`Started ${signalName}: ${out}`);
      return true;
    }
    throw e;
  }
};

const attachLogs = () => {
  info(`Attaching logs for ${signalName}... (Ctrl+C to stop)`);
  // Use --since to avoid replaying ancient logs on long-lived volumes
  logsProcess = spawn("docker", ["logs", "-f", "--since", "10s", signalName], {
    stdio: ["ignore", "pipe", "pipe"],
  });

  const prefix = (line, isErr = false) => {
    const tag = isErr ? "signal:stderr" : "signal:stdout";
    return `[${tag}] ${line}`;
  };

  const pipe = (readable, isErr = false) => {
    let buf = "";
    readable.on("data", (chunk) => {
      buf += chunk.toString();
      let idx;
      while ((idx = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, idx);
        console.log(prefix(line, isErr));
        buf = buf.slice(idx + 1);
      }
    });
    readable.on("end", () => {
      if (buf.length) console.log(prefix(buf, isErr));
    });
  };

  pipe(logsProcess.stdout, false);
  pipe(logsProcess.stderr, true);

  logsProcess.on("close", (code) => {
    warn(`docker logs exited with code ${code}`);
  });
};

const stopContainerIfWeStarted = async () => {
  info(`Stopping ${signalName} (regardless of who started it)...`);
  try {
    info(`Stopping ${signalName}...`);
    await execAsync(`docker stop ${signalName}`);
    ok(`${signalName} stopped.`);
  } catch (e) {
    warn(`Failed to stop ${signalName}: ${e.message}`);
  }
};

const setupShutdownHooks = () => {
  const graceful = async (signal) => {
    info(`Received ${signal}, shutting down...`);
    if (logsProcess && !logsProcess.killed) {
      logsProcess.kill("SIGINT");
    }
    await stopContainerIfWeStarted();
    process.exit(0);
  };

  // PM2 sends SIGINT on stop/restart by default
  ["SIGINT", "SIGTERM", "SIGQUIT"].forEach((s) =>
    process.on(s, () => graceful(s))
  );

  // Fallback on normal exit (e.g., unhandled rejection path may still exit(1))
  process.on("exit", async () => {
    if (logsProcess && !logsProcess.killed) logsProcess.kill("SIGINT");
    await stopContainerIfWeStarted();
  });

  process.on("uncaughtException", async (e) => {
    err(`Uncaught exception: ${e.stack || e.message}`);
    await stopContainerIfWeStarted();
    process.exit(1);
  });

  process.on("unhandledRejection", async (e) => {
    err(`Unhandled rejection: ${e && e.stack ? e.stack : e}`);
    await stopContainerIfWeStarted();
    process.exit(1);
  });
};

const run = async () => {
  try {
    await ensureDockerRunning();

    const exists = await containerExists(signalName);
    const running = exists ? await containerRunning(signalName) : false;

    weStartedContainer = await startContainer();

    // If it was already running and started by someone else, we still want logs
    if (!weStartedContainer && running) {
      info(`${signalName} is already running; attaching logs only.`);
    }

    setupShutdownHooks();
    attachLogs();
  } catch (e) {
    err(e.message || String(e));
    process.exit(1);
  }
};

run();
