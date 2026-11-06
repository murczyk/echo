#!/usr/bin/env python3
"""Writes the synthetic #4053 group-scope cases. Every group, callsign and message here is invented."""
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent
AS_OF = '2026-11-06T16:13:36Z'
NOW_MS = int(datetime(2026, 11, 6, 16, 13, 36, tzinfo=timezone.utc).timestamp() * 1000)
HOUR_MS = 3_600_000
DAY_MS = 24 * HOUR_MS

# Opaque like real master keys: nothing in a key reveals the group's name.
DEVOPS = 'group.m1Xv9dKqT2bZ0uRfLw7yEa4nHs3cJp6gOiUt8BxDkYQ'
COBALT = 'group.Z4rTq8LmN1vYc6HsPb2XeK9uAf0oJw3gRiDn7VtSyGM'
TUNGSTEN = 'group.c7HwU2pQk5TfN9aXyLe1ZrB6sOm3JvGd8iR4DnYtKqS'
HIDDEN = 'group.R8nBv3KxY6qLt1WzPf5HeA9cUj2mOg7DsTi0NrXkEuQ'
TWIN_ONE = 'group.y2DkW7sHq9ZpM4bRtXf6LeC1vAn8JuGo3iTr5YxNqKs'
TWIN_TWO = 'group.b6QnJ1tUe8XrK3fYpLz9SaH2wCm5VdGo7iRk4NxTsDy'
CASE_ONE = 'group.t9GrL4xNa2VkQ7cWpEy1HbZ6uJm8FdSo3iKn5RsYqXt'
CASE_TWO = 'group.k3YsP8eDz6MqT1nXvRa5LgC9wUh2JfOb7iGt4NrKxVy'
SCOPES = {DEVOPS: 'DEVOPS', COBALT: 'Кобальт', TUNGSTEN: 'Вольфрам'}

DEVOPS_TEXT = [
    'Сокіл: воду підвезли на точку Дуб, два ящики.',
    'Тополя: генератор на точці Дуб запустили з другої спроби.',
    'Сокіл: антену на точці Клен перевірили, зв`язок стабільний.',
    'Тополя: заправка завтра вранці, потрібно двісті літрів.',
    'Сокіл: на точці Клен замінили акумулятор.',
    'Тополя: на точці Дуб лишилось пів ящика води.',
]


def message(identifier, group, text, hours_ago, frequency='165.2500'):
    return {'id': identifier, 'uid': f'fixture-{identifier}', 'timestamp': NOW_MS - int(hours_ago * HOUR_MS),
            'groupKey': group, 'text': text, 'callsigns': [], 'indexed': True, 'frequency': frequency}


def devops_messages(hours_ago=1.0):
    return [message(101 + index, DEVOPS, text, hours_ago + index * 0.25, '165.2500' if index % 2 else '171.3750')
            for index, text in enumerate(DEVOPS_TEXT)]


def busy_group(start, group, label):
    """More than one page, and about the same subjects, so reading these instead is tempting and visible."""
    return [message(start + index, group, f'{label} {index}: Сокіл передав про воду на точці Ясен, ящик {index}.',
                    0.5 + index * 0.1, '148.1250') for index in range(30)]


def corpus(devops=None):
    return (devops_messages() if devops is None else devops) + busy_group(201, COBALT, 'Лис') + busy_group(301, TUNGSTEN, 'Вовк')


def scoped(keys, **extra):
    return {'bothSearches': False, 'groupScope': {'keys': keys, **extra.pop('scope', {})}, **extra}


def case(identifier, split, turns, expect, messages=None, groups=None, names=None, **extra):
    return {'id': identifier, 'category': 'group-scope', 'split': split, 'asOf': AS_OF,
            'groups': list(groups or SCOPES), 'groupNames': names or SCOPES, 'turns': turns,
            'messages': corpus() if messages is None else messages, 'expect': expect, **extra}


REPORTS_NOTHING = 'не знайд|немає|нема |відсутн|недоступ|не вдалося|немає такого'
REPORTS_EMPTY = 'не знайд|немає|нема |не було|відсутн|жодн'
EVIDENCE = {'evidenceIds': [101, 102]}


def cases():
    report = 'Що відбулось за сьогодні в чаті DEVOPS'
    second_page = [message(400 + index, DEVOPS, f'Сокіл: запис {index} про склад на точці Дуб.', 0.5 + index * 0.2)
                   for index in range(22)]
    twins = {DEVOPS: 'DEVOPS', TWIN_ONE: 'Двійник', TWIN_TWO: 'Двійник'}
    twin_messages = devops_messages() + [message(501, TWIN_ONE, 'Лис: перший двійник на зв`язку.', 1),
                                         message(502, TWIN_TWO, 'Вовк: другий двійник на зв`язку.', 1.5)]
    same_letters = {COBALT: 'Кобальт', CASE_ONE: 'Альфа', CASE_TWO: 'АЛЬФА'}
    letter_messages = busy_group(201, COBALT, 'Лис') + [message(601, CASE_ONE, 'Лис: перша альфа на зв`язку.', 1),
                                                        message(602, CASE_TWO, 'Вовк: друга альфа на зв`язку.', 1.5)]
    subject = busy_group(201, COBALT, 'Лис') + busy_group(301, TUNGSTEN, 'Вовк') + devops_messages() + [
        message(701, TUNGSTEN, 'Вовк: Кобальт сьогодні привіз рацію на точку Ясен.', 2)]
    hidden = corpus() + [message(801, HIDDEN, 'Граніт: прихований запис про воду.', 1)]
    return [
        case('chat-word', 'development', [report], scoped([DEVOPS], **EVIDENCE)),
        case('group-word-incident', 'development', ['Перехоплення в групі DEVOPS'], scoped([DEVOPS], **EVIDENCE)),
        case('channel-word', 'development', ['Що нового на каналі DEVOPS за сьогодні?'], scoped([DEVOPS], **EVIDENCE)),
        case('chatik-word', 'development', ['Глянь у чатику DEVOPS, що там сьогодні писали'], scoped([DEVOPS], **EVIDENCE)),
        case('case-variant', 'development', ['Що писали сьогодні в групі devops?'], scoped([DEVOPS], **EVIDENCE)),
        case('language-variant', 'development', ['Что было сегодня в чате ДЕВОПС?'], scoped([DEVOPS], **EVIDENCE)),
        case('follow-up-inherits', 'development', [report, 'А які частоти там згадували?'], scoped([DEVOPS], **EVIDENCE)),
        case('unknown-group', 'validation', ['Що писали сьогодні в чаті Горобець?'],
             scoped([], requireCitations=False, requiredPatterns=[REPORTS_NOTHING])),
        case('inaccessible-group', 'validation', ['Що писали сьогодні в групі Граніт?'],
             scoped([], requireCitations=False, requiredPatterns=[REPORTS_NOTHING]), messages=hidden),
        case('empty-in-period', 'validation', [report],
             scoped([DEVOPS], requireCitations=False, requiredPatterns=[REPORTS_EMPTY],
                    forbiddenPatterns=['точц\\w* Ясен']),
             messages=corpus(devops_messages(hours_ago=240))),
        case('two-groups-one-unknown', 'validation', ['Що сьогодні писали в чатах DEVOPS і Горобець?'],
             scoped([DEVOPS], requiredPatterns=['Горобець'], **EVIDENCE)),
        case('ambiguous-names', 'validation', ['Що писали сьогодні в чаті альфа?'],
             scoped([CASE_ONE, CASE_TWO], requireCitations=False, requiredPatterns=['альф'],
                    scope={'optional': True}),
             messages=letter_messages, groups=same_letters, names=same_letters),
        case('same-name-two-keys', 'validation', ['Що писали сьогодні в чаті Двійник?'],
             scoped([TWIN_ONE, TWIN_TWO], evidenceIds=[501, 502], scope={'all': True}),
             messages=twin_messages, groups=twins, names=twins),
        case('name-as-subject', 'validation', ['Хто такий Кобальт?'],
             {'bothSearches': False, 'evidenceIds': [701], 'groupScope': {'forbid': True}}, messages=subject),
        case('no-group-control', 'validation', ['Що писали про воду на точці Ясен?'],
             {'bothSearches': False, 'evidenceIds': [330], 'requireCitations': False, 'groupScope': {'forbid': True}}),
        case('subject-in-group', 'validation', ['Що писали про Сокола в чаті DEVOPS?'],
             scoped([DEVOPS], evidenceIds=[101], searchTerms=['сок'])),
        case('small-group-second-page', 'validation', ['Покажи всі повідомлення з чату DEVOPS за сьогодні'],
             scoped([DEVOPS], evidenceIds=[400], completeBothSearches=True), messages=corpus(second_page)),
        case('provider-failure-then-retry', 'validation', [report], scoped([DEVOPS], **EVIDENCE), providerFailures=1),
    ]


def main():
    cases_path = ROOT / 'cases.json'
    cases_path.write_text(json.dumps(cases(), ensure_ascii=False, indent=1) + '\n')
    manifest = {'schemaVersion': 1, 'id': 'group-scope', 'revision': '2026-11-06.1', 'category': 'group-scope',
                'skills': ['current_user', 'accessible_group_details', 'inbox_messages', 'messages_by_id',
                           'interception_context'],
                'caseFiles': ['cases.json'],
                'artifacts': {'cases.json': hashlib.sha256(cases_path.read_bytes()).hexdigest()}}
    (ROOT / 'dataset.json').write_text(json.dumps(manifest, indent=2) + '\n')


if __name__ == '__main__':
    main()
