const fs = require("fs");
const path = require("path");
const { exec } = require("child_process");

const os = require("os");

const CONFIG_PATH = path.join(__dirname, "../data/config.json");
const config = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
const { signalPort, signalMode, signalName = "swapp-signal" } = config;

const execAsync = (cmd) =>
  new Promise((resolve, reject) => {
    exec(cmd, (err, stdout, stderr) => {
      if (err) return reject(stderr || err.message);
      resolve(stdout.trim());
    });
  });

const run = async () => {
  console.log("🐳 Перевіряємо чи встановлено Docker...");

  try {
    const version = await execAsync("docker --version");
    console.log(`👌 Docker встановлено, версія ${version}`);
  } catch (err) {
    console.error(
      "❌ Docker не встановлено або немає доступу (перевірте в терміналі команду docker -v)"
    );
    console.log(
      "👉 Якщо Docker не встановлено його потрібно завантажити та встановити: https://www.docker.com/products/docker-desktop"
    );
    return;
  }

  try {
    await execAsync("docker info");
    console.log("🟢 Docker встановлено та запущено.");
  } catch (err) {
    console.error("❌ Docker встановлено але Docker Desktop не відкрито.");
    console.log("👉 Відкрийте Docker Desktop та спробуйте ще раз.");
    return;
  }

  const imageName = "bbernhard/signal-cli-rest-api";

  try {
    const container = await execAsync(
      `docker ps -a --filter "name=${signalName}" --format "{{.Names}}"`
    );
    if (container === signalName) {
      try {
        const isRunning = await execAsync(
          `docker inspect -f "{{.State.Running}}" ${signalName}`
        );
        if (isRunning === "true") {
          console.log(`✅ ${signalName} додано та запущено.`);
          // startLogListener();
        } else {
          console.log(`⏩ Запускаємо ${signalName}...`);
          await execAsync(`docker start ${signalName}`);
          console.log(`✅ ${signalName} запущено.`);
          // startLogListener();
        }
        return;
      } catch (err) {
        console.log(
          `⚠️ Не вдалося отримати доступ до перевірки стану ${signalName}. Відкрийте у режимі адміністратора та спробуйте ще раз.`
        );
        return;
      }
    }
  } catch {}

  try {
    await execAsync(`docker image inspect ${imageName}`);
    console.log(`👍 ${imageName} завантажено.`);
  } catch {
    console.log(`📦 Завантажуємо ${imageName}...`);
    await execAsync(`docker pull ${imageName}`);
    console.log(`🙌 ${imageName} успішно завантажено.`);
  }

  console.log(
    `💅 Резервуємо порт ${signalPort}. Переконайтеся що інші процеси не використовують цей порт.`
  );
  const volumePath =
    os.platform() === "win32"
      ? `/host_mnt/${os.homedir().slice(0, 1).toLowerCase()}${os
          .homedir()
          .slice(2)
          .replace(/\\/g, "/")}/.local/share/signal-api`
      : `${os.homedir().replace(/\\/g, "/")}/.local/share/signal-api`;

  const runCommand = `docker run -d --name ${signalName} --restart=always -p ${signalPort}:8080 -v ${volumePath}:/home/.local/share/signal-cli -e MODE=${signalMode} ${imageName}`;

  console.log("🚀 Запускаємо signal-cli-rest-api...");
  try {
    const result = await execAsync(runCommand);
    console.log(`✅ Запуск успішний: ${result}`);
    // startLogListener();
  } catch (err) {
    console.error("❌ Помилка запуску:", err);
  }
};

run();
