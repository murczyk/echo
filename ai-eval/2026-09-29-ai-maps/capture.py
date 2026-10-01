#!/usr/bin/env python3
"""Capture #3064 supplied examples privately and independently audit their core fields."""
import argparse
import csv
from datetime import datetime
import hashlib
import io
import json
from pathlib import Path
import re
import subprocess

DIRECTORY = Path(__file__).resolve().parent
ROOT = DIRECTORY.parents[1]
DELIVERY_SIDC = '10062000001209020000'
ASSAULT_SIDC = '10061000001203000000'


def field(block, label):
    found = re.search(rf'^{label}\s*:?\s*(.+)$', block, re.M)
    return found[1].strip() if found else None


def normalized(value):
    digits = re.sub(r'\D', '', value)
    return digits if len(digits) == 7 else 'INVALID'


def record(name, date, time, x, y, sidc=DELIVERY_SIDC):
    timestamp = datetime.strptime(date, '%d.%m.%Y').strftime('%Y-%m-%d') if date else None
    if timestamp:
        timestamp += 'T' + (datetime.strptime(time, '%H:%M').strftime('%H:%M:00') if time else '00:00:00')
    return dict(sidc=sidc, name=name, observationDatetime=timestamp, platformType='CAPDOC',
                originalX=x.strip(), originalY=y.strip(), x=normalized(x), y=normalized(y), sources=[])


def flight_records(text):
    result = []
    for block in re.split(r'(?=^\[\d{2}\.\d{2}\.\d{4} )', text, flags=re.M):
        if 'Подразделение:' not in block:
            continue
        unit = field(block, 'Подразделение')
        unit = re.sub(r'^\d+\s+дшд\s+', '', unit)
        regiment, subdivision = re.fullmatch(r'(.+?\b(?:дшп|мсп|пдп))\s+(.+)', unit).groups()
        coordinate = field(block, 'Координаты цели')
        x, y = coordinate.split(',', 1)
        row = record(f'{subdivision} {regiment}', field(block, 'Дата'), field(block, 'Время'), x, y)
        values = re.findall(r'^[^:\n\[\]]+:\s*(.+)$', block, re.M)
        row['_sourceCommentTokens'] = sorted(set(token for token in re.findall(r'[\w]+', ' '.join(values), re.U) if len(token) >= 3))
        result.append(row)
    return result


def header_records(text, name):
    result = []
    for block in re.split(r'(?=^\[\d{2}\.\d{2}\.\d{4} )', text, flags=re.M):
        header = re.match(r'\[(\d{2}\.\d{2}\.\d{4}) ', block)
        if not header:
            continue
        x, y = re.search(r'^(\d{7})\s*,\s*(\d{7})\s*$', block, re.M).groups()
        result.append(record(name, header[1], field(block, 'Время'), x, y))
    return result


def plain_records(text):
    result = []
    for block in re.split(r'(?=^\d+ МСП )', text, flags=re.M):
        if not block.strip():
            continue
        regiment, subdivision = re.match(r'^(\d+ МСП) (.+)', block).groups()
        x = re.search(r'^[XХ][ -]*(\d+)', block, re.M)[1]
        y = re.search(r'^[YУ][ -]*(\d+)', block, re.M)[1]
        result.append(record(f'{subdivision} {regiment}', field(block, 'Дата'), field(block, 'Время'), x, y))
    return result


def table_records(text):
    lines = [line.strip() for line in text.splitlines() if line.strip()]
    starts = []
    for index, line in enumerate(lines):
        if re.fullmatch(r'[\w/" ]+\s+(?:пдп|орб)', line) and 'групп' not in line.lower():
            starts.append((index, lines[index - 1], line, index + 1))
        elif re.fullmatch(r'.+\(\d+\)', line) and re.fullmatch(r'\d+[A-Za-zА-Яа-я]?', lines[index - 1]):
            starts.append((index - 1, lines[index - 1], '', index))
    result = []
    for index, (start, code, unit, callsign_index) in enumerate(starts):
        end = starts[index + 1][0] if index + 1 < len(starts) else len(lines)
        block = '\n'.join(lines[callsign_index + 1:end])
        pairs = re.findall(r'(?<!\d)(\d{6,8})\s*[,;]\s*(\d{6,8})(?!\d)', block)
        x, y = pairs[-1]
        callsign = re.sub(r'\s*\(\d+\)\s*$', '', lines[callsign_index]).strip().upper()
        name = f'{code} {callsign} {unit}'.replace(chr(34), '').strip()
        row = record(name, '28.09.2026', '06:00', x, y, ASSAULT_SIDC)
        row['_sourcePositions'] = pairs
        result.append(row)
    return result


def coordinate_expectations(records):
    result = subprocess.run(['node', '--experimental-strip-types', str(DIRECTORY / 'verify-coordinates.ts')],
                            input=json.dumps(records), text=True, capture_output=True, check=True, cwd=ROOT)
    for row, point in zip(records, json.loads(result.stdout)):
        row.update(point or {'latitude': None, 'longitude': None})


def immutable(path, content):
    if path.exists() and path.read_bytes() != content:
        raise ValueError(f'Refusing to replace immutable artifact {path.name}')
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(content)


def capture(source, case_revision):
    content = source.read_bytes()
    text = content.decode('utf-8')
    headers = list(re.finditer(r'^(?:данні (?:входу|виходу) [1-6](?: [^\n]*)?|Данні (?:входу|виходу) \(приклад штурмові групи\)):\s*\n', text, re.I | re.M))
    assert len(headers) == 14
    blocks = [text[header.end():headers[index + 1].start() if index + 1 < len(headers) else len(text)].strip()
              for index, header in enumerate(headers)]
    provided = []
    for block in blocks[1::2]:
        provided.append(list(csv.DictReader(io.StringIO(block[block.index('"sidc"'):])) ) if '"sidc"' in block else [])
    inputs = blocks[::2]
    records = [flight_records(inputs[0]), header_records(inputs[1], provided[1][0]['name']),
               plain_records(inputs[2]), flight_records(inputs[3]), flight_records(inputs[4]),
               flight_records(inputs[5]), table_records(inputs[6])]
    assert [len(rows) for rows in records] == [25, 10, 3, 22, 19, 19, 107]
    corrections = []
    comment_corrections = []
    for case_index, (rows, output) in enumerate(zip(records, provided), 1):
        if not output:
            assert case_index == 5
            continue
        assert len(rows) == len(output)
        for index, (row, supplied) in enumerate(zip(rows, output), 1):
            for key, csv_key in [('sidc', 'sidc'), ('name', 'name'), ('observationDatetime', 'observation_datetime'), ('x', 'x'), ('y', 'y')]:
                if str(row[key]).strip() != supplied[csv_key].strip():
                    corrections.append({'case': case_index, 'row': index, 'field': key, 'supplied': supplied[csv_key], 'source': row[key]})
            values = [fragment.split(':', 1)[-1] for fragment in supplied.get('comment 1', '').split(' | ')]
            tokens = set(token for token in re.findall(r'[\w]+', ' '.join(values), re.U) if len(token) >= 3)
            if case_index == 7:
                positions = row.pop('_sourcePositions')
                supplied_coordinates = {token for token in tokens if re.fullmatch(r'\d{6,8}', token)}
                source_coordinates = {component for pair in positions for component in pair}
                if supplied_coordinates - source_coordinates:
                    comment_corrections.append({'case': case_index, 'row': index,
                                                'supplied': sorted(supplied_coordinates - source_coordinates),
                                                'source': sorted(source_coordinates - supplied_coordinates)})
                tokens -= supplied_coordinates
                tokens.update(component for pair in positions[:-1] for component in pair)
            row['commentTokens'] = sorted(tokens)
            row.pop('_sourceCommentTokens', None)
    for row in records[4]:
        row['commentTokens'] = row.pop('_sourceCommentTokens')
    if corrections:
        raise ValueError('Supplied expectations differ from independent extraction: ' + json.dumps(corrections, ensure_ascii=False))
    assert sum(row['x'] == 'INVALID' or row['y'] == 'INVALID' for row in records[4]) == 2
    common = ('Побудуй головну мапу точок із усіх подій нижче та опублікуй її. Збережи окремі події з однаковими координатами і порядок. '
              'Потрібні CSV та KMZ за шаблоном sidc,name,observation_datetime,platform_type,x,y,comment 1,... . '
              'Платформа CAPDOC, система для X/Y — MSK-2000 (як СК-42 в Echo). Неповні координати не доповнюй: INVALID, рядок залишається в CSV. '
              'Назви підрозділів від меншого до більшого до рівня полків. Дату/час події бери перед датою публікації; '
              'лише дата — T00:00:00, без дати — порожньо. У коментарях збережи всі наявні поля тікета та їх значення без подвійних лапок. ')
    cases = []
    for index, (input_text, rows) in enumerate(zip(inputs, records), 1):
        override = f"Для всіх записів name має бути {provided[1][0]['name']}. " if index == 2 else ''
        table = 'Для таблиці обирай реальне положення, потім змінене, потім попереднє; решту положень і колонок збережи в коментарі. Ім’я лише через пробіли, без лапок і ком: код групи (число безпосередньо перед підрозділом, не порядковий номер рядка), позивний без кількості людей, підрозділ. У коментарях збережи також код групи та заголовок розділу (тип груп), усі колонки й невибрані положення. Рік 2026. ' if index == 7 else ''
        sidc = ASSAULT_SIDC if index == 7 else DELIVERY_SIDC
        coordinate_expectations(rows)
        cases.append(dict(id=f'supplied-{index}', category='map-documents', split='validation', asOf='2026-09-29T12:00:00Z',
                          groups=[], messages=[], turns=[common + override + table + f'SIDC {sidc}.\n\n' + input_text],
                          provenance={'sourceSha256': hashlib.sha256(content).hexdigest(), 'sourceCase': index}, expect={'records': rows}))
    audit = {'sourceSha256': hashlib.sha256(content).hexdigest(), 'method': 'Independent source extraction of event order, dates, units and position priority; WGS-84 checked with the existing frontend СК-42 converter.',
             'suppliedCsvRows': [len(rows) for rows in provided], 'verifiedRows': [len(rows) for rows in records], 'corrections': corrections,
             'invalidRows': [index + 1 for index, row in enumerate(records[4]) if row['latitude'] is None],
             'commentCorrections': comment_corrections}
    immutable(DIRECTORY / 'raw/map-data-v1.txt', content)
    immutable(DIRECTORY / f'raw/cases-{case_revision}.json', (json.dumps(cases, ensure_ascii=False, indent=2) + '\n').encode())
    immutable(DIRECTORY / f'raw/audit-{case_revision}.json', (json.dumps(audit, ensure_ascii=False, indent=2) + '\n').encode())
    print('Verified source rows:', ', '.join(str(len(rows)) for rows in records), '; case 5: 17 valid, 2 invalid.')


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('source', type=Path)
    parser.add_argument("--case-revision", default="v4", type=lambda value: value if re.fullmatch(r"v[1-9][0-9]*", value) else parser.error("Expected v<number>"))
    args = parser.parse_args()
    capture(args.source, args.case_revision)
