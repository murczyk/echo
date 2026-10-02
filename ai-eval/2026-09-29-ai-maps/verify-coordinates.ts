import { tdSk42ToWgs84 } from "../../wdintel-web/src/ts/utils.ts";

let input = "";
for await (const chunk of process.stdin) input += chunk;
const records = JSON.parse(input);
process.stdout.write(JSON.stringify(records.map((record: { x: string; y: string }) => {
  if (!/^\d{7}$/.test(record.x) || !/^\d{7}$/.test(record.y)) return null;
  const point = tdSk42ToWgs84({ x: Number(record.x), y: Number(record.y) });
  return point ? { latitude: point.x, longitude: point.y } : null;
})));
