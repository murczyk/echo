import { readFileSync } from "node:fs";
import { join } from "node:path";

// Resolves the flat echo_map_set_symbol arguments into one SIDC patch, using
// the APP-6(D) catalog shipped with the echomap library.

interface CatalogAlias {
  label: string;
  terms: string[];
  symbolSet: string;
  entity: string;
  modifier1: string;
  modifier2: string;
  hq: string;
}

interface Catalog {
  aliases: CatalogAlias[];
  symbolSets: Array<{ code: string; entities: Array<{ code: string; name: string }> }>;
}

export interface SymbolRequest {
  sidc?: string;
  type?: string;
  identity?: string;
  status?: string;
  echelon?: string;
}

export type SymbolPatch =
  | { sidc: string }
  | { components: Record<string, string>; typeLabel?: string };

const IDENTITIES: Record<string, string> = {
  pending: "0", unknown: "1", невідомий: "1", невідомі: "1",
  "assumed friend": "2", friend: "3", friendly: "3", дружній: "3", дружні: "3", свої: "3", наші: "3",
  neutral: "4", нейтральний: "4", нейтральні: "4",
  suspect: "5", підозрілий: "5", підозрілі: "5",
  hostile: "6", enemy: "6", ворожий: "6", ворожі: "6", противник: "6", ворог: "6",
};
const STATUSES: Record<string, string> = {
  present: "0", наявний: "0", planned: "1", anticipated: "1", запланований: "1", заплановані: "1", ймовірний: "1",
  damaged: "3", пошкоджений: "3", пошкоджені: "3", destroyed: "4", знищений: "4", знищені: "4", знищено: "4",
};
const ECHELONS: Record<string, string> = {
  team: "11", crew: "11", група: "11", екіпаж: "11", розрахунок: "11", squad: "12", відділення: "12",
  section: "13", секція: "13", platoon: "14", взвод: "14", company: "15", battery: "15", рота: "15", батарея: "15",
  battalion: "16", батальйон: "16", дивізіон: "16", regiment: "17", полк: "17", brigade: "18", бригада: "18",
  division: "21", дивізія: "21", corps: "22", корпус: "22", army: "23", армія: "23",
};

function normalize(text: string): string {
  return ` ${(text ?? "").toLowerCase().replace(/[’ʼ]/g, "'").match(/[\p{L}\p{N}'-]+/gu)?.join(" ") ?? ""} `;
}

function code(value: string | undefined, names: Record<string, string>, width: number, label: string): string | undefined {
  if (value === undefined || value === null || String(value).trim() === "") return undefined;
  const text = String(value).trim().toLowerCase();
  if (/^\d+$/.test(text) && text.length <= width) return text.padStart(width, "0");
  const known = names[text];
  if (known) return known;
  throw new Error(`Невідоме значення «${value}» для ${label}. Допустимі: ${[...new Set(Object.keys(names))].slice(0, 12).join(", ")}.`);
}

export class SidcResolver {
  private catalog: Catalog | null = null;
  private readonly path: string;

  constructor(path: string) {
    this.path = path;
  }

  static fromPythonRoot(root: string): SidcResolver {
    return new SidcResolver(join(root, "echomap", "app6d-catalog.json"));
  }

  private load(): Catalog {
    this.catalog ??= JSON.parse(readFileSync(this.path, "utf8")) as Catalog;
    return this.catalog;
  }

  /** The Ukrainian alias whose longest term starts a word in `text`. */
  matchType(text: string): CatalogAlias | null {
    const haystack = normalize(text);
    let best: { score: [number, number]; alias: CatalogAlias } | null = null;
    for (const alias of this.load().aliases) {
      for (const term of alias.terms) {
        const needle = normalize(term).trimEnd();
        const position = haystack.indexOf(needle);
        if (!needle.trim() || position < 0) continue;
        const score: [number, number] = [needle.length, -position];
        if (!best || score[0] > best.score[0] || (score[0] === best.score[0] && score[1] > best.score[1])) {
          best = { score, alias };
        }
      }
    }
    if (best) return best.alias;
    const english = haystack.trim();
    for (const set of this.load().symbolSets) {
      const entity = set.entities.find((item) => normalize(item.name).trim() === english);
      if (entity) return { label: entity.name, terms: [], symbolSet: set.code, entity: entity.code, modifier1: "00", modifier2: "00", hq: "0" };
    }
    return null;
  }

  resolve(request: SymbolRequest): SymbolPatch {
    const sidc = request.sidc?.trim();
    if (sidc) {
      if (!/^\d{20}$/.test(sidc)) throw new Error("SIDC має містити рівно 20 цифр, наприклад 10031000001211000000.");
      return { sidc };
    }
    const components: Record<string, string> = {};
    let typeLabel: string | undefined;
    if (request.type?.trim()) {
      const alias = this.matchType(request.type);
      if (!alias) throw new Error(`Не знайдено тип позначки для «${request.type}». Спробуйте простіше слово (танк, БпЛА, піхота, РЕБ) або передайте повний SIDC.`);
      Object.assign(components, { symbolSet: alias.symbolSet, mainIcon: alias.entity, modifier1: alias.modifier1, modifier2: alias.modifier2 });
      if (alias.hq !== "0") components.headquartersOrTaskForce = alias.hq;
      typeLabel = alias.label;
    }
    const identity = code(request.identity, IDENTITIES, 1, "приналежності");
    const status = code(request.status, STATUSES, 1, "стану");
    const echelon = code(request.echelon, ECHELONS, 2, "ешелону");
    if (identity) components.identity = identity;
    if (status) components.status = status;
    if (echelon) components.echelon = echelon;
    if (!Object.keys(components).length) {
      throw new Error("Вкажіть sidc або хоча б одне з: type, identity, status, echelon.");
    }
    return { components, typeLabel };
  }
}
