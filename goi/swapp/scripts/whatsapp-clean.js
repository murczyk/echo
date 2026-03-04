const fs = require("fs");
const path = require("path");
const baseDir = path.join(__dirname, "..");
const targetDirs = [".wwebjs_auth", ".wwebjs_cache"];

targetDirs.forEach((dirName) => {
  const dirPath = path.join(baseDir, dirName);
  try {
    fs.rmSync(dirPath, { recursive: true, force: true });
    console.log(`✅ Каталог ${dirPath} успішно видалено.`);
  } catch (err) {
    console.error(`❌ Не вдалося видалити каталог ${dirPath}: ${err.message}`);
  }
});
