import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
PYTHON_ROOT = ROOT / 'echo-ai-agent/template/python'
sys.path.insert(0, str(PYTHON_ROOT))

from echomap import Record, current_map, emit_patch, emit_records, parse, recipes, sidc, state  # noqa: E402

REPORT = """[25.09.2026 0:54] БПС 3 дшб: Детали полета
Подразделение: 104 дшд 328 дшп 3 дшб
Дата: 24.09.2026
Время: 18:03
Координаты цели: 5272881, 6679505
Комментарий:
328/24
Е5, выполнено
[25.09.2026 0:54] БПС 3 дшб: Детали полета
Подразделение: 104 дшд 328 дшп 3 дшб
Дата: 24.09.2026
Время: 18:15
Координаты цели: 5272881, 6679505
Комментарий:
328/24
"""


def with_inputs(inputs):
    directory = tempfile.TemporaryDirectory()
    Path(directory.name, 'inputs.json').write_text(json.dumps(inputs, ensure_ascii=False), encoding='utf-8')
    state.load(directory.name)
    return directory


class ParseTest(unittest.TestCase):
    def test_reports_split_into_fields_with_multiline_comments(self):
        blocks = parse.split(REPORT, r'Детали полета')
        self.assertEqual(len(blocks), 2)
        fields = parse.kv(blocks[0])
        self.assertEqual(fields.first('подразделение'), '104 дшд 328 дшп 3 дшб')
        self.assertEqual(fields.first('Комментарий'), '328/24\nЕ5, выполнено')
        self.assertEqual(parse.pair(fields.first('Координаты цели')), ('5272881', '6679505'))
        self.assertEqual(parse.dt(fields.first('Дата'), fields.first('Время')), '2026-09-24T18:03:00')
        self.assertEqual(parse.dt('24.09.26'), '2026-09-24T00:00:00')
        self.assertIsNone(parse.dt('', '18:03'))

    def test_pairs_keep_malformed_components_unrepaired(self):
        self.assertEqual(parse.pair('X 52-15227 Y 65 48669'), ('52-15227', '65 48669'))
        self.assertEqual(parse.pairs('5215227/6548669; 521522, 6548669'),
                         [('5215227', '6548669'), ('521522', '6548669')])
        self.assertEqual(parse.pairs('5215227 6548669 5214301 6549102'),
                         [('5215227', '6548669'), ('5214301', '6549102')])
        self.assertEqual(parse.pair('-5215227, 6548669'), ('-5215227', '6548669'))
        self.assertEqual(parse.pair('-5215227 6548669'), ('-5215227', '6548669'))
        self.assertEqual(parse.pair('Координаты цели: 5272881, 6679505'), ('5272881', '6679505'))


class PositionFormatTest(unittest.TestCase):
    def test_decimal_degrees_are_read_as_written(self):
        self.assertEqual(parse.pair('Тестова точка 01,47.54821,35.38674')[0], '47.54821')
        self.assertEqual(parse.pair('47.54821, 35.38674'), ('47.54821', '35.38674'))
        self.assertEqual(parse.pair('47,54821 35,38674'), ('47,54821', '35,38674'))
        self.assertEqual(parse.pair('55.75123; 37.61712'), ('55.75123', '37.61712'))
        self.assertEqual(parse.pair('47.55, 35.38'), ('47.55', '35.38'))

    def test_dates_times_and_stray_decimals_are_not_degrees(self):
        self.assertEqual(parse.pairs('Дата: 24.09.2026 Час: 18.03'), [])
        self.assertEqual(parse.pairs('12.345 67.890'), [])
        self.assertEqual(parse.pair('24.09.2026 5272881, 6679505'), ('5272881', '6679505'))

    def test_mgrs_is_read_in_every_written_form(self):
        for text in ['36T XT 79584 68848', '36TXT7958468848', '36txt7958468848', '36Т ХТ 79584 68848',
                     '36т хт 79584 68848', '36T  XT  79584  68848', '36T XT 7 6', '36T XT 795 688']:
            self.assertEqual(parse.pair(f'Ціль: {text}, 18:03'), (text, ''))
        self.assertEqual(parse.mgrs('36T XT 79584 68848 і 36T YT 08049 72644'), ['36T XT 79584 68848', '36T YT 08049 72644'])

    def test_mgrs_stops_before_a_following_field(self):
        for text in ['36TXT7958468848', '36T XT 79584 68848', '36T XT 7958 6884']:
            self.assertEqual(parse.pair(f'{text} 18:03'), (text, ''))
            self.assertEqual(parse.mgrs(f'{text} 24.09.2026'), [text])
        self.assertEqual(parse.mgrs('36T XT 79584 18:03'), ['36T XT 79584'])

    def test_a_malformed_mgrs_keeps_every_digit_so_echo_can_reject_it(self):
        for text in ['36T XT 7958 68848', '36T XT 795846 88481', '36TXT795846 88481']:
            self.assertEqual(parse.mgrs(f'Ціль: {text}'), [text])
            self.assertEqual(parse.pair(text), (text, ''))

    def test_unit_designations_are_not_mgrs(self):
        for text in ['1 мср 120 мсп', '25 мср 120 мсп', '2 дшб 328 дшп', '36 ОМБр 12', '104 дшд', '1 МСР 120']:
            self.assertEqual(parse.mgrs(text), [], text)

    def test_positions_keep_their_order_across_formats(self):
        text = '36T XT 79584 68848; 5272881 6679505; 47.54821, 35.38674'
        self.assertEqual(parse.pairs(text), [
            ('36T XT 79584 68848', ''), ('5272881', '6679505'), ('47.54821', '35.38674'),
        ])

    def test_a_malformed_mgrs_tail_never_leaves_a_shorter_reference(self):
        for text in ['36T XT 7958 6884abc', '36T XT 79 68abc']:
            self.assertEqual(parse.mgrs(text), [], text)
            self.assertEqual(parse.pair(text), ('', ''), text)
        self.assertEqual(parse.mgrs('36TXT7958468848 5км'), ['36TXT7958468848'])

    def test_mgrs_survives_sentence_punctuation_and_low_precision(self):
        self.assertEqual(parse.pair('Ціль: 36T XT 79584 68848.'), ('36T XT 79584 68848', ''))
        self.assertEqual(parse.pair('36TXT76'), ('36TXT76', ''))
        self.assertEqual(parse.mgrs('36TXT7958468848.5'), [])

    def test_a_following_field_never_shortens_a_reference(self):
        self.assertEqual(parse.pair('36T XT 7958 6884 5км'), ('36T XT 7958 6884', ''))
        self.assertEqual(parse.pair('36T XT 79584 68848 5км'), ('36T XT 79584 68848', ''))

    def test_malformed_degrees_are_not_cleaned_into_a_point(self):
        for text in ['47.54821,35.38674abc', '47.54821,35.38674.123', '47.54821x,35.38674']:
            self.assertEqual(parse.pair(text), ('', ''), text)
        self.assertEqual(parse.pair('Ціль 47.54821, 35.38674.'), ('47.54821', '35.38674'))

    def test_a_whole_position_allows_nothing_else(self):
        self.assertEqual(parse.whole(' 36T XT 79584 68848 '), ('36T XT 79584 68848', ''))
        self.assertEqual(parse.whole('50,4501 30,5234'), ('50,4501', '30,5234'))
        for text in ['47.54821, 35.38674abc', '36T XT 7958 6884abc', '5272881, 6679505', '']:
            self.assertIsNone(parse.whole(text), text)

    def test_a_record_leaves_the_format_to_echo(self):
        for x, y in [('47.54821', '35.38674'), ('36TXT7958468848', ''), ('5272881', '6679505')]:
            item = Record('Точка', x, y).to_input()
            self.assertEqual((item['coordinateSystem'], item['x'], item['y']), ('', x, y))
        self.assertEqual(Record('Точка', '36TXT7958468848').to_input()['y'], '')


class SidcTest(unittest.TestCase):
    def test_aliases_choose_symbol_and_spoken_identity(self):
        self.assertEqual(sidc.find('ворожий танк'), '10061500001202000000')
        self.assertEqual(sidc.find('FPV дрон', identity='friend'), '10030100001103000000')
        self.assertEqual(sidc.find('БПС 3 дшб', identity='3', echelon='взвод'), '10031000141219000000')
        self.assertEqual(sidc.find('щось незрозуміле'), '')

    def test_set_and_retype_preserve_other_components(self):
        code = '10061000141211020000'
        self.assertEqual(sidc.set(code, identity='дружній'), '10031000141211020000')
        self.assertEqual(sidc.set(code, status='знищений', echelon='рота'), '10061040151211020000')
        self.assertEqual(sidc.retype(code, 'РСЗО'), '10061500141116000000')
        with self.assertRaises(ValueError):
            sidc.set(code, identity='союзник')

    def test_describe_and_search_use_the_generated_catalog(self):
        self.assertIn('Ворожий', sidc.describe('10061000141211020000'))
        self.assertIn('Піхотний підрозділ', sidc.describe('10061000141211020000'))
        self.assertIn('Пошта', sidc.describe('10062000001209020000'))
        self.assertEqual(sidc.find('пошта', identity='hostile'), '10062000001209020000')
        self.assertEqual(sidc.find('ворожий мотоцикл'), '10061500001413000000')
        self.assertEqual(sidc.search('мотоцикл')[0][:2], ('15', '141300'))
        self.assertEqual(sidc.find('Довільний текст'), '')
        self.assertIn('Взвод', sidc.describe('10061000141211020000'))
        self.assertTrue(any(entity == '120200' for _, entity, _ in sidc.search('tank')))

    def test_catalog_copies_are_identical(self):
        web = ROOT / 'wdintel-web/static/data/app6d-catalog.json'
        self.assertEqual(web.read_bytes(), sidc.CATALOG_FILE.read_bytes())


class RecordsAndPatchTest(unittest.TestCase):
    def test_records_reference_sources_and_split_long_comments(self):
        directory = with_inputs({'prompt': REPORT})
        self.addCleanup(directory.cleanup)
        source = {'messageId': 7, 'messageIdentifier': 'abc'}
        emit_records([Record(name='3 дшб', x='1', y='2', comments=['я' * 4500], source=source, sources=[source])])
        record = state.result()['records'][0]
        self.assertEqual([len(cell) for cell in record['comments']], [2000, 2000, 500])
        self.assertEqual(record['sources'], [source])
        with self.assertRaises(ValueError):
            emit_records([Record(name='bad', x='1', y='2', sidc='123')])
        aliased = Record(name='Точка', x='1', y='2', coordinateSystem='sk42', observationDatetime='2026-09-24T07:00:00')
        self.assertEqual((aliased.crs, aliased.when), ('sk42', '2026-09-24T07:00:00'))
        with self.assertRaisesRegex(TypeError, 'use name, x, y'):
            Record(name='Точка', x='1', y='2', colour='red')
        self.assertIsNone(current_map())

    def test_patch_groups_symbol_changes_and_keeps_other_edits_separate(self):
        records = [
            {'id': f'id-{index}', 'name': f'Точка {index}', 'sidc': '10061000001211020000',
             'coordinateSystem': 'msk2000', 'originalX': '5215227', 'originalY': '6548669', 'comments': []}
            for index in range(4)
        ]
        directory = with_inputs({'map': {'id': 'm', 'title': 'Мапа', 'records': records},
                                 'selectedPointIds': ['id-0', 'id-1']})
        self.addCleanup(directory.cleanup)
        edited = current_map()
        for record in edited.selected():
            record.sidc = sidc.set(record.sidc, identity='friend')
        edited.where(name='Точка 2')[0].name = 'Перейменована'
        edited.remove(edited.records[3])
        edited.title = 'Нова'
        emit_patch(edited, summary='Оновлено')
        operations = state.result()['operations']
        self.assertEqual([operation['op'] for operation in operations], ['setTitle', 'remove', 'setSidc', 'update'])
        self.assertEqual(operations[2]['selector']['ids'], ['id-0', 'id-1'])
        self.assertEqual(operations[3]['fields'], {'name': 'Перейменована'})
        self.assertEqual(state.result()['summary'], 'Оновлено')


def flight_report(index, author, unit, coords='5272881, 6679505'):
    return (f"[25.09.2026 {index % 10}:54] {author}: Детали полета\n"
            f"Подразделение: {unit}\nПозывной: pilot{index}\nДата: 24.09.2026\n"
            f"Время: {7 + index % 12:02d}:{index % 60:02d}\nТип БЧ: [\"Провизия\"]\n"
            + (f"Координаты цели: {coords}\n" if coords else "")
            + "Комментарий:\n328/24\nвыполнено\n")


class RecipeTest(unittest.TestCase):
    def test_unit_names_run_from_the_smallest_unit_to_the_regiment(self):
        self.assertEqual(recipes.unit_name('104 дшд 328 дшп 2 дшб'), '2 дшб 328 дшп')
        self.assertEqual(recipes.unit_name('104 дшд 328 дшп ШР (В)'), 'ШР (В) 328 дшп')
        self.assertEqual(recipes.unit_name('59 омпбр 1 мпб 2 взвод'), '2 взвод 1 мпб 59 омпбр')
        self.assertEqual(recipes.unit_name('76 гв. дшд 104 гв. дшп 1 дшб'), '1 дшб 104 гв. дшп')
        self.assertEqual(recipes.unit_name('2 дшб 328 дшп 104 дшд'), '2 дшб 328 дшп')
        self.assertEqual(recipes.unit_name('104 дшд 328 дшп 2-й дшб'), '2-й дшб 328 дшп')
        self.assertEqual(recipes.unit_name('104 дшд, 328 дшп, 2 дшб'), '2 дшб 328 дшп')
        self.assertEqual(recipes.unit_name('328 дшп 2 мотострелковый батальон'), '2 мотострелковый батальон 328 дшп')
        self.assertEqual(recipes.unit_name('328 дшп группа БПЛА'), 'группа БПЛА 328 дшп')
        self.assertEqual(recipes.unit_name('2 мотострелковый батальон 328 дшп'), '2 мотострелковый батальон 328 дшп')
        self.assertEqual(recipes.unit_name('104 десантно-штурмовая дивизия 328 дшп 2 дшб'), '2 дшб 328 дшп')
        self.assertEqual(recipes.unit_name('49 армия 328 дшп 3 дшб'), '3 дшб 328 дшп')

    def test_flight_reports_keep_every_report_in_order(self):
        units = ['104 дшд 328 дшп 3 дшб', '104 дшд 328 дшп 2 дшб', '104 дшд 328 дшп ШР (В)']
        authors = ['БПС 3 дшб', 'Vladislav', 'Fok$']
        reports = [flight_report(i, authors[i % 3], units[i % 3],
                                 None if i == 7 else ('5272881 , 6679505' if i % 5 == 0 else f'{5272881 + i}, {6679505 - i}'))
                   for i in range(25)]
        directory = with_inputs({'prompt': 'нанеси на мапу\n' + '\n'.join(reports)})
        self.addCleanup(directory.cleanup)
        self.assertEqual(recipes.detect(), {'flight_reports': 25})
        stats = recipes.run()
        records = state.result()['records']
        self.assertEqual((stats['sourceCount'], stats['emittedCount']), (25, 25))
        self.assertEqual(stats['skipped'], [{'index': 8, 'reason': 'немає координат цілі'}])
        self.assertEqual([record['name'] for record in records[:3]], ['3 дшб 328 дшп', '2 дшб 328 дшп', 'ШР (В) 328 дшп'])
        self.assertEqual(records[1]['observationDatetime'], '2026-09-24T08:01:00')
        self.assertEqual((records[0]['x'], records[0]['y']), ('5272881', '6679505'))
        self.assertEqual((records[1]['x'], records[1]['y']), ('5272882', '6679504'))
        self.assertNotIn('Vladislav', records[1]['name'])
        self.assertIn('Комментарий:\n328/24', records[0]['comments'][0])

    def test_instructions_naming_the_format_are_not_reports_and_header_dates_fill_gaps(self):
        report = flight_report(1, 'Vladislav', '104 дшд 328 дшп 2 дшб').replace('Дата: 24.09.2026\n', '')
        directory = with_inputs({'prompt': 'Нанеси на мапу звіти «Детали полета»:\n' + report})
        self.addCleanup(directory.cleanup)
        self.assertEqual(recipes.detect(), {'flight_reports': 1})
        recipes.run()
        records = state.result()['records']
        self.assertEqual(len(records), 1)
        self.assertEqual(records[0]['observationDatetime'], '2026-09-25T08:01:00')

    def test_reports_keep_comments_naming_the_format_and_malformed_coordinates(self):
        first = flight_report(1, 'Vladislav', '104 дшд 328 дшп 2 дшб', '5272881, abc').replace(
            'выполнено\n', 'Детали полета уточнены\nвыполнено\n')
        second = flight_report(2, 'Vladislav', '104 дшд', '527, 6679505')
        directory = with_inputs({'prompt': first + second})
        self.addCleanup(directory.cleanup)
        recipes.run()
        records = state.result()['records']
        self.assertEqual(len(records), 2)
        self.assertIn('Детали полета уточнены', records[0]['comments'][0])
        self.assertEqual((records[0]['x'], records[0]['y']), ('5272881', 'abc'))
        self.assertEqual((records[1]['x'], records[1]['y']), ('527', '6679505'))
        self.assertEqual(records[1]['name'], 'Політ')
        self.assertEqual(recipes._target_coordinates('5272881abc, 6679505'), ('5272881abc', '6679505'))
        block = 'Детали полета\nПодразделение: 2 дшб\nДата: 24.09.2026\nКоординаты цели: 5272881, 6681122\nРайон применения Каменское\n'
        record, problem = recipes._flight_record(block, None)
        self.assertEqual((record.x, record.y, problem), ('5272881', '6681122', None))
        self.assertEqual(recipes._target_coordinates('5272881abc 6679505'), ('5272881abc', '6679505'))
        self.assertEqual(recipes._target_coordinates('5272881abc 6679505 (цель)'), ('5272881abc', '6679505'))
        self.assertEqual(recipes._target_coordinates('52-15227 65 48669'), ('52-15227', '65 48669'))
        headed = '[25.09.2026 0:54] Vladislav:\nДетали полета\nПодразделение: 104 дшд 328 дшп 2 дшб\nВремя: 18:03\nКоординаты цели: 5272881, 6679505\n'
        directory = with_inputs({'prompt': headed + headed})
        self.addCleanup(directory.cleanup)
        recipes.run()
        headed_records = state.result()['records']
        self.assertEqual([record['observationDatetime'] for record in headed_records], ['2026-09-25T18:03:00'] * 2)
        self.assertNotIn('Vladislav', headed_records[0]['comments'][0].split('Детали полета')[1])
        commented = flight_report(4, 'Vladislav', '104 дшд 328 дшп 2 дшб').replace('выполнено\n', 'Детали полета\nуточнено пізніше\n')
        only_coordinates = 'Детали полета\nПодразделение: 104 дшд 328 дшп 3 дшб\nКоординаты: 5272881, 6679505\n'
        directory = with_inputs({'prompt': commented + only_coordinates})
        self.addCleanup(directory.cleanup)
        recipes.run()
        records = state.result()['records']
        self.assertEqual(len(records), 2)
        self.assertIn('уточнено пізніше', records[0]['comments'][0])
        self.assertEqual(records[1]['name'], '3 дшб 328 дшп')

    def test_supplied_sidcs_win_and_a_requested_symbol_fills_the_rest(self):
        own = flight_report(1, 'Vladislav', '104 дшд 328 дшп 2 дшб').replace('Комментарий:', 'SIDC: 10031000001211000000\nКомментарий:')
        other = flight_report(2, 'Vladislav', '104 дшд 328 дшп 3 дшб')
        directory = with_inputs({'prompt': own + other})
        self.addCleanup(directory.cleanup)
        recipes.run(symbol='дружній БпЛА')
        self.assertEqual([record['sidc'] for record in state.result()['records']],
                         ['10031000001211000000', '10030100001103000000'])

    def test_comments_cannot_override_fields_and_posting_dates_carry_over(self):
        quoted = flight_report(1, 'Vladislav', '104 дшд 328 дшп 2 дшб').replace(
            'выполнено\n', 'Координаты цели: 1111111, 2222222\nДата: 01.01.2020\n')
        undated = 'Детали полета\nПодразделение: 104 дшд 328 дшп 3 дшб\nВремя: 19:30\nКоординаты цели: 5272881, 6679505\n'
        directory = with_inputs({'prompt': quoted + undated})
        self.addCleanup(directory.cleanup)
        recipes.run()
        records = state.result()['records']
        self.assertEqual((records[0]['x'], records[0]['y']), ('5272881', '6679505'))
        self.assertEqual(records[0]['observationDatetime'], '2026-09-24T08:01:00')
        self.assertEqual(records[1]['observationDatetime'], '2026-09-25T19:30:00')

    def test_incomplete_reports_stay_and_scripts_can_customize_recipe_records(self):
        incomplete = '[25.09.2026 1:00] Vladislav: Детали полета\nПодразделение: 104 дшд 328 дшп 2 дшб\nПозывной: pilot9\nРезультат полета: Не выполнено\n'
        wrapped = flight_report(2, 'Vladislav', '104 дшд 328 дшп 3 дшб', '(5272881, 6679505)')
        directory = with_inputs({'prompt': flight_report(1, 'Vladislav', '104 дшд 328 дшп 2 дшб') + incomplete + wrapped})
        self.addCleanup(directory.cleanup)
        parsed = recipes.records()
        self.assertEqual(len(parsed), 3)
        self.assertEqual((parsed[1].x, parsed[1].y), ('', ''))
        self.assertEqual((parsed[2].x, parsed[2].y), ('5272881', '6679505'))
        emit_records([record for record in parsed if '3 дшб' in record.name])
        self.assertEqual(len(state.result()['records']), 1)

    def test_reports_accept_every_coordinate_format(self):
        report = 'Детали полета\nПодразделение: 328 дшп\nДата: 24.09.2026\nКоординаты цели: {}\n'
        for written, expected in [
            ('36T XT 79584 68848', ('36T XT 79584 68848', '')),
            ('47.54821, 35.38674', ('47.54821', '35.38674')),
            ('50,4501 30,5234', ('50,4501', '30,5234')),
            ('5272881, 6679505', ('5272881', '6679505')),
        ]:
            directory = with_inputs({'prompt': report.format(written), 'messages': []})
            self.addCleanup(directory.cleanup)
            recipes.run()
            result = state.result()
            self.assertEqual((result['records'][0]['x'], result['records'][0]['y']), expected, written)
            self.assertEqual(result['stats']['skipped'], [], written)

    def test_stray_characters_never_become_a_clean_point(self):
        report = 'Детали полета\nПодразделение: 328 дшп\nДата: 24.09.2026\nКоординаты цели: {}\n'
        for written, expected in [
            ('47.54821, 35.38674abc', ('47.54821', '35.38674abc')),
            ('36T XT 7958 6884abc', ('36T', '7958')),
        ]:
            directory = with_inputs({'prompt': report.format(written), 'messages': []})
            self.addCleanup(directory.cleanup)
            record = recipes.records()[0]
            self.assertEqual((record.x, record.y), expected, written)

    def test_header_units_name_reports_without_a_unit_field(self):
        named = '[25.09.2026 1:00] 2 дшб 328 дшп: Детали полета\nДата: 24.09.2026\nКоординаты цели: 5272881, 6679505\n'
        poster = '[25.09.2026 1:00] Vladislav: Детали полета\nДата: 24.09.2026\nКоординаты цели: 5272881, 6679505\n'
        self.assertEqual(recipes._flight_record(named, None)[0].name, '2 дшб 328 дшп')
        self.assertEqual(recipes._flight_record(poster, None)[0].name, 'Політ')
        self.assertEqual(recipes._header_unit('[25.09.2026 0:54] БПС 3 дшб: Детали полета\n'), '3 дшб')

    def test_message_dates_use_kyiv_time(self):
        self.assertEqual(recipes._kyiv_date('2026-09-24T22:54:00.000Z'), '25.09.2026')
        self.assertEqual(recipes._kyiv_date('2026-12-24T22:30:00Z'), '25.12.2026')
        self.assertEqual(recipes._kyiv_date('2026-12-24T21:30:00Z'), '24.12.2026')

    def test_unknown_text_has_no_recipe(self):
        directory = with_inputs({'prompt': 'просто текст'})
        self.addCleanup(directory.cleanup)
        self.assertEqual(recipes.detect(), {})
        with self.assertRaises(LookupError):
            recipes.run()


class RunEntryTest(unittest.TestCase):
    def test_entry_runs_a_script_and_writes_the_result(self):
        with tempfile.TemporaryDirectory() as work:
            Path(work, 'inputs.json').write_text(json.dumps({'prompt': REPORT}, ensure_ascii=False), encoding='utf-8')
            Path(work, 'script.py').write_text(
                'from echomap import inputs, parse, Record, emit_records\n'
                'for block in parse.split(inputs.prompt(), "Детали полета"):\n'
                '    f = parse.kv(block)\n'
                '    x, y = parse.pair(f.first("Координаты цели"))\n'
                '    emit_records([Record(name=f.first("Подразделение"), x=x, y=y, comments=[block])])\n'
                'print("done")\n', encoding='utf-8')
            completed = subprocess.run(
                [sys.executable, '-I', '-B', str(PYTHON_ROOT / 'echomap/run.py'), work],
                capture_output=True, text=True, timeout=60, env={'PATH': '/usr/bin:/bin'})
            self.assertEqual(completed.returncode, 0, completed.stderr)
            self.assertEqual(completed.stdout.strip(), 'done')
            result = json.loads(Path(work, 'result.json').read_text(encoding='utf-8'))
            self.assertEqual(len(result['records']), 2)
            self.assertIn('Е5, выполнено', result['records'][0]['comments'][0])

    def test_entry_reports_script_errors_without_a_result(self):
        with tempfile.TemporaryDirectory() as work:
            Path(work, 'script.py').write_text('raise ValueError("broken")\n', encoding='utf-8')
            completed = subprocess.run(
                [sys.executable, '-I', '-B', str(PYTHON_ROOT / 'echomap/run.py'), work],
                capture_output=True, text=True, timeout=60, env={'PATH': '/usr/bin:/bin'})
            self.assertEqual(completed.returncode, 1)
            self.assertIn('ValueError: broken', completed.stderr)
            self.assertFalse(Path(work, 'result.json').exists())


if __name__ == '__main__':
    unittest.main()
