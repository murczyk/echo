export type ImporterIcon = {
  icon: string;
  name: string;
  titleMain: string;
  titleExtras: string[];
};

export const genericIcon: ImporterIcon = {
  icon: '00_Загально.png',
  name: 'Загально',
  titleMain: '',
  titleExtras: [],
};

export const knownIcons: ImporterIcon[] = [
  genericIcon,
  { icon: 'Арта САУ.png', name: 'Арта САУ', titleMain: 'САУ', titleExtras: [] },
  { icon: 'Блокпост.png', name: 'Блокпост', titleMain: 'Блокпост', titleExtras: [] },
  { icon: 'БПЛА.png', name: 'БПЛА', titleMain: 'БПЛА', titleExtras: [] },
  {
    icon: 'БПЛА_дружній.png',
    name: 'БПЛА_дружній.png',
    titleMain: 'БПЛА (дружній)',
    titleExtras: ['Точка старту'],
  },
  { icon: 'БТР.png', name: 'БТР', titleMain: 'БТР', titleExtras: [] },
  { icon: 'ВАТ.png', name: 'ВАТ', titleMain: 'ВАТ', titleExtras: [] },
  {
    icon: 'Важка артилерія РОВ.png',
    name: 'Артилерія',
    titleMain: 'Артилерія',
    titleExtras: ['Артилерія на вогневих позиціях'],
  },
  {
    icon: 'Вогнева позиція 2.png',
    name: 'Вогнева позиція 2',
    titleMain: 'Вогнева позиція',
    titleExtras: [],
  },
  {
    icon: 'Вогнева позиція.png',
    name: 'Вогнева позиція',
    titleMain: 'Вогнева позиція',
    titleExtras: [],
  },
  { icon: 'Гелікоптер.png', name: 'Гелікоптер', titleMain: 'Гелікоптер', titleExtras: [] },
  { icon: 'ІФО.png', name: 'ІФО', titleMain: 'ІФО', titleExtras: ['Блокпост'] },
  { icon: 'ІФО окоп.png', name: 'ІФО окоп', titleMain: 'ІФО', titleExtras: ['Блокпост'] },
  { icon: 'ІФО 2.png', name: 'ІФО 2', titleMain: 'ІФО', titleExtras: ['Блокпост'] },
  {
    icon: 'Інженерний підрозділ.png',
    name: 'Інженерний підрозділ',
    titleMain: 'Інженерний підрозділ',
    titleExtras: [],
  },
  { icon: 'Інша ББМ.png', name: 'Інша ББМ', titleMain: 'ББМ', titleExtras: [] },
  { icon: 'Логістика, БК.png', name: 'Логістика, БК', titleMain: 'БК', titleExtras: [] },
  {
    icon: 'Медичний підрозділ.png',
    name: 'Медичний підрозділ',
    titleMain: 'Медичний підрозділ',
    titleExtras: [],
  },
  {
    icon: 'Медичний_підрозділ_дружній.png',
    name: 'Медичний_підрозділ_дружній.png',
    titleMain: 'Медичний підрозділ (дружній)',
    titleExtras: ['Медпункт', 'Стабпункт'],
  },
  { icon: 'ОіВТ.png', name: 'ОіВТ', titleMain: 'ОіВТ', titleExtras: ['Колона ОіВТ'] },
  { icon: 'Міни.png', name: 'Міни', titleMain: 'Міни', titleExtras: [] },
  { icon: 'Міномет РОВ.png', name: 'Міномет РОВ', titleMain: 'Міномет', titleExtras: [] },
  {
    icon: 'Міст пантон.png',
    name: 'Міст пантон',
    titleMain: 'Міст',
    titleExtras: ['Поромна переправа'],
  },
  { icon: 'Піхота.png', name: 'Піхота (о/с)', titleMain: 'Піхота (о/с)', titleExtras: [] },
  {
    icon: 'Підрозділ звязку.png',
    name: 'Підрозділ звязку',
    titleMain: 'Підрозділ звʼязку',
    titleExtras: [],
  },
  { icon: 'ПММ.png', name: 'ПММ', titleMain: 'ПММ', titleExtras: [] },
  { icon: 'ППО.png', name: 'ППО', titleMain: 'ППО', titleExtras: [] },
  { icon: 'Паром.png', name: 'Паром', titleMain: 'Паром', titleExtras: [] },
  { icon: 'РЕБ.png', name: 'РЕБ', titleMain: 'РЕБ', titleExtras: [] },
  { icon: 'РЕР.png', name: 'РЕР', titleMain: 'РЕР', titleExtras: [] },
  { icon: 'РСЗО.png', name: 'РСЗВ', titleMain: 'РСЗВ', titleExtras: [] },
  { icon: 'Радар.png', name: 'Радар', titleMain: 'Радар', titleExtras: [] },
  { icon: 'Рембаза.png', name: 'Рембаза', titleMain: 'Рембаза', titleExtras: [] },
  { icon: 'Танк.png', name: 'Танк', titleMain: 'Танк', titleExtras: [] },
  {
    icon: 'Цивільна автівка.png',
    name: 'Цивільна автівка',
    titleMain: 'Цивільне авто',
    titleExtras: [],
  },
  { icon: 'Штаб.png', name: 'Штаб', titleMain: 'Штаб', titleExtras: [] },
  { icon: '10061500002203000000.png', name: 'РЛС', titleMain: 'РЛС', titleExtras: [] },
  { icon: '10061500002001000000.png', name: 'Антена', titleMain: 'Антена', titleExtras: [] },
  { icon: '10061500001103000000.png', name: 'АГС', titleMain: 'АГС', titleExtras: [] },
  { icon: '10061500001601000000.png', name: 'ЛАТ', titleMain: 'ЛАТ', titleExtras: [] },
  { icon: '10063000001405020000.png', name: 'Човен', titleMain: 'Човен', titleExtras: [] },
  { icon: '10062000001120000000.png', name: 'Склад', titleMain: 'Склад', titleExtras: [] },
  {
    icon: '10061000001110010000.png',
    name: 'Радіо сигнал',
    titleMain: 'Радіо сигнал',
    titleExtras: [],
  },
  {
    icon: '10061000001110040000.png',
    name: 'Супутниковий звʼязок',
    titleMain: 'Супутниковий звʼязок',
    titleExtras: [],
  },
  { icon: 'point-green.png', name: 'Орієнтир', titleMain: 'Орієнтир', titleExtras: [] },
  { icon: 'point-red.png', name: 'Орієнтир', titleMain: 'Орієнтир', titleExtras: [] },
  { icon: 'point-blue.png', name: 'Орієнтир', titleMain: 'Орієнтир', titleExtras: [] },
  { icon: 'cross-green.png', name: 'Ціль', titleMain: 'Ціль', titleExtras: [] },
  { icon: 'cross-red.png', name: 'Ціль', titleMain: 'Ціль', titleExtras: [] },
  { icon: 'cross-blue.png', name: 'Ціль', titleMain: 'Ціль', titleExtras: [] },
  {
    icon: 'interest_point_yellow.svg',
    name: 'Орієнтир(точка інтересу)',
    titleMain: 'Орієнтир(точка інтересу)',
    titleExtras: [],
  },
  {
    icon: 'interest_point_red.svg',
    name: 'Орієнтир(точка інтересу)',
    titleMain: 'Орієнтир(точка інтересу)',
    titleExtras: [],
  },
];

const knownIconNames = new Set(knownIcons.map((item) => item.icon));

const knownRenames = new Map<string, string>([
  ['Fort_MGRS-Mapper.png', 'ІФО.png'],
  ['Underground-Facility_MGRS-Mapper.png', 'ІФО 2.png'],
  ['icon-1_2.png', 'Арта САУ.png'],
  ['icon-2_2.png', '00_Загально.png'],
  ['icon-4_2.png', 'Цивільна автівка.png'],
  ['icon-5_2.png', 'Радар.png'],
  ['Інша ББМ_0.png', 'Інша ББМ.png'],
  ['Інша ББМ_3.png', 'Інша ББМ.png'],
  ['Інша ББМ_4.png', 'Інша ББМ.png'],
  ['Особовий склад, піхота.png', 'Піхота.png'],
  ['Особовий склад, піхота_0.png', 'Піхота.png'],
  ['Особовий склад, піхота_1.png', 'Піхота.png'],
  ['Особовий склад, піхота_3.png', 'Піхота.png'],
  ['вогнева позиція (2).png', 'Вогнева позиція 2.png'],
  ['мост_пантон.png', 'Міст пантон.png'],
  ['міни.png', 'Міни.png'],
  ['окопи.png', 'ІФО окоп.png'],
  ['підрозділ звязку.png', 'Підрозділ звязку.png'],
  ['Механізовані, ОіВТ.png', 'ОіВТ.png'],
]);

export const exampleContent =
  '19.00 Качкарівка\n*В район (47.1305050, 33.7418280) сьогодні зайшла ОВТ ров. Склад та кількість не встановлено.\n*в районі (52-20714 65-51696) знаходиться машина з антенами. Тип не встановлено.';

export const operatyvkaExamples = [
  exampleContent,
  `№ 68839
село Милове, Бериславський район, Херсонська область, Україна
ОВТ (ОіВТ): 50
Особовий склад: 200
WGS84: 47.07227275466425, 33.61823252372279
SK42: 52-15579, 65-47075
MGRS: 36TWT4693813381
https://api.griselda.kyiv.ua/s/WTkUSqv8
Джерело: Світло
2022-10-11 17:15:00
-------
Станом на 11.10.2022 17:15 Милове, Херсонська область ОС (200 осіб) + ВТ (50 од. легка броня, колісна та ін.)
-------`,
  `№ 69093
село Милове, Бериславський район, Херсонська область, Україна
РСЗВ БМ-21 Град: 4
Танк: 9
ОВТ (ОіВТ): 7
Особовий склад: 300
WGS84: 47.068996067976, 33.63917305156
SK42: 52-15227, 65-48669
MGRS: 36TWT4853113030
https://api.griselda.kyiv.ua/s/xHIDCEri
Джерело: Світло
2022-10-12 21:59:00
-------
скупч.ОіВТ нп Милове, Херсонська обл.
300 од. ОС, скупч. ОіВТ
танки 9 од., БМ-21 "Град" - 4 од.
БМП/БТР - 7 од.

WGS-84: Ш=47.06899606851839, Д=33.63917305061088
MGRS: 36TWT 48531 13030
СК-42: X=5215227.19, Y=6548668.84
ширина 211 м., глибина 129 м.
отримано через Борода_інфо
-------`,
  `21.25 Шляхове
*наметове містечко – (46.8785549, 33.4183013) - більше 100 осіб о/с ров.
*ОВТ ров, більше 20од, склад не встановлено – (46.8780489, 33.4189665).`,
];

export function getIcon(icon: string): ImporterIcon {
  return knownIcons.find((item) => item.icon === icon) ?? genericIcon;
}

export function isTitleStandard(title: string): boolean {
  return knownIcons.some((item) => item.titleMain === title || item.titleExtras.includes(title));
}

export function renameIcons(icons: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];

  for (const icon of icons) {
    const renamed = knownRenames.get(icon) ?? (knownIconNames.has(icon) ? icon : genericIcon.icon);
    if (seen.has(renamed)) continue;
    seen.add(renamed);
    result.push(renamed);
  }

  return result;
}

export function replaceFilenameMacros(now: Date, input: string): string {
  const date = now.toISOString().slice(0, 10);
  const datetime = now.toISOString().slice(0, 16).replace('T', '-').replace(':', '-');
  return input.replaceAll('<DATE>', date).replaceAll('<DATETIME>', datetime);
}
