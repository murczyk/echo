// Prints the symbol-set/entity pairs the app's milsymbol cannot draw, so the
// catalog can keep them out of the picker. Input: JSON [[set, entity], ...] on stdin.
import { createRequire } from "node:module";

const require = createRequire(new URL("../../wdintel-web/package.json", import.meta.url));
const loaded = require("milsymbol");
const ms = loaded.default ?? loaded;
let input = "";
for await (const chunk of process.stdin) input += chunk;
const undrawable = JSON.parse(input).filter(([set, entity]) =>
  !new ms.Symbol(`1001${set}0000${entity}0000`).isValid());
process.stdout.write(JSON.stringify(undrawable));
