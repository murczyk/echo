const fs = require("fs");
const path = require("path");
const { exec } = require("child_process");
const os = require("os");

const execAsync = (cmd) =>
  new Promise((resolve, reject) => {
    exec(cmd, (err, stdout, stderr) => {
      if (err) return reject(stderr || err.message);
      resolve(stdout.trim());
    });
  });

const CONFIG_PATH = path.join(__dirname, "../data/config.json");
const config = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
const { signalName = "swapp-signal" } = config;

const killDaemonAndUnregister = async () => {
  console.log(`🛑 Зупиняємо контейнер ${signalName}...`);
  try {
    await execAsync(`docker stop ${signalName}`);
    console.log(`✅ Контейнер ${signalName} зупинено.`);
  } catch (err) {
    console.warn(`⚠️ Не вдалося зупинити контейнер: ${err}`);
  }

  console.log(`🧹 Видаляємо контейнер ${signalName}...`);
  try {
    await execAsync(`docker rm ${signalName}`);
    console.log(`✅ Контейнер ${signalName} видалено.`);
  } catch (err) {
    console.warn(`⚠️ Не вдалося видалити контейнер: ${err}`);
  }

  const volumePath =
    os.platform() === "win32"
      ? `/host_mnt/${os.homedir().slice(0, 1).toLowerCase()}${os
          .homedir()
          .slice(2)
          .replace(/\\/g, "/")}/.local/share/signal-api`
      : `${os.homedir().replace(/\\/g, "/")}/.local/share/signal-api`;

  const fs = require("fs");

  // Remove the entire signal-api directory to clear persistent data
  try {
    fs.rmSync(volumePath, { recursive: true, force: true });
    console.log(`🧨 Каталог ${volumePath} успішно видалено.`);
  } catch (err) {
    console.error(`❌ Не вдалося видалити каталог ${volumePath}: ${err}`);
  }
};

killDaemonAndUnregister();
