"""#3064 map grading against independently captured records and parsed downloads."""
import base64
import csv
import io
import re
import xml.etree.ElementTree as ET
import zipfile


def grade_maps(case, events, failed=False):
    answers = [event['text'] for event in events if event.get('type') == 'eval_answer']
    answer = answers[-1] if answers else ''
    documents = {event['document']['id']: event['document'] for event in events
                 if event.get('type') == 'map_artifact'}
    main = next((document for document in reversed(list(documents.values())) if document['isMain']), None)
    exports = {event['id']: event for event in events if event.get('type') == 'eval_map_export'}
    failures = []
    expect = case['expect']
    records = main['records'] if main else []
    expected = expect['records']
    if failed or not answer.strip():
        failures.append('execution')
    if not main or len(records) != len(expected):
        failures.append('record_completeness')
    for actual, target in zip(records, expected):
        if any(actual.get(key) != target.get(key) for key in ('sidc', 'name', 'observationDatetime', 'platformType', 'x', 'y')):
            failures.append('record_metadata_or_order')
        if any(re.sub(r'\D', '', actual.get(key, '')) != re.sub(r'\D', '', target.get(key, '')) for key in ('originalX', 'originalY')):
            failures.append('original_coordinates')
        if target.get('latitude') is None:
            if actual.get('latitude') is not None or actual.get('longitude') is not None or not actual.get('warnings'):
                failures.append('invalid_geometry_or_warning')
        elif any(actual.get(key) is None or abs(actual[key] - target[key]) > 0.00002 for key in ('latitude', 'longitude')):
            failures.append('projection')
        comments = ' '.join(actual.get('comments', []))
        if '"' in comments or any(token.lower() not in comments.lower() for token in target.get('commentTokens', [])):
            failures.append('comments')
        if actual.get('sources', []) != target.get('sources', []):
            failures.append('source_citations')
    valid = sum(record.get('latitude') is not None for record in expected)
    if main and (main['totalCount'], main['validCount'], main['invalidCount']) != (len(expected), valid, len(expected) - valid):
        failures.append('counts')
    if main and any(record.get('warnings') for record in records) and not main.get('warnings'):
        failures.append('warnings')
    references = re.findall(r'\]\(echo-map:([^\s)]+)\)', answer)
    if not references or any(identifier not in documents for identifier in references):
        failures.append('map_references')
    if expect.get('submaps') and len([document for document in documents.values() if not document['isMain']]) < expect['submaps']:
        failures.append('submaps')
    for document_id, document in documents.items():
        export = exports.get(document_id)
        if not export:
            failures.append('missing_download')
            continue
        try:
            parsed = list(csv.reader(io.StringIO(export['csv'])))
            if parsed[0][:6] != ['sidc', 'name', 'observation_datetime', 'platform_type', 'x', 'y'] or len(parsed) != document['totalCount'] + 1:
                failures.append('csv_structure')
            for cells, record in zip(parsed[1:], document['records']):
                if cells[:6] != [record['sidc'], record['name'], record.get('observationDatetime') or '', record['platformType'], record['x'], record['y']] or len(cells) != len(parsed[0]):
                    failures.append('csv_records')
                if cells[6:6 + len(record['comments'])] != record['comments'] or any('"' in cell for cell in cells[6:]):
                    failures.append('csv_comments')
            if not document['validCount']:
                if export.get('kmz') is not None:
                    failures.append('empty_kmz')
                continue
            with zipfile.ZipFile(io.BytesIO(base64.b64decode(export['kmz']))) as archive:
                root = ET.fromstring(archive.read('doc.kml'))
                ns = {'k': 'http://www.opengis.net/kml/2.2'}
                placemarks = root.findall('.//k:Placemark', ns)
                valid_records = [record for record in document['records'] if record['latitude'] is not None]
                if len(placemarks) != len(valid_records):
                    failures.append('kmz_geometry_count')
                for placemark, record in zip(placemarks, valid_records):
                    lon, lat, _alt = map(float, placemark.findtext('k:Point/k:coordinates', namespaces=ns).split(','))
                    metadata = {item.attrib['name']: item.findtext('k:value', namespaces=ns) or '' for item in placemark.findall('k:ExtendedData/k:Data', ns)}
                    if abs(lon - record['longitude']) > 1e-9 or abs(lat - record['latitude']) > 1e-9 or placemark.findtext('k:name', namespaces=ns) != record['name']:
                        failures.append('kmz_coordinates')
                    if metadata.get('sidc') != record['sidc'] or metadata.get('app6d') != record['sidc'] or metadata.get('platform_type') != record['platformType']:
                        failures.append('kmz_metadata')
                    if metadata.get('observation_datetime', '') != (record.get('observationDatetime') or '') or metadata.get('original_x') != record['originalX'] or metadata.get('original_y') != record['originalY']:
                        failures.append('kmz_metadata')
                    if any(metadata.get(f'comment {index + 1}') != comment for index, comment in enumerate(record['comments'])):
                        failures.append('kmz_comments')
                    icon_name = f"{record['sidc']}.png"
                    if icon_name not in archive.namelist() or placemark.findtext('k:styleUrl', namespaces=ns) != f"#map-{record['sidc']}":
                        failures.append('kmz_style')
                    elif not archive.read(icon_name).startswith(b'\x89PNG\r\n\x1a\n'):
                        failures.append('kmz_icon')
        except (ValueError, KeyError, TypeError, ET.ParseError, zipfile.BadZipFile):
            failures.append('download_parse')
    batches = [event for event in events if event.get('type') == 'eval_retrieval' and event.get('path') == '/api/ai-agent/maps/prepare']
    if not batches or any(not 1 <= len(event['body'].get('records', [])) <= 16 for event in batches):
        failures.append('batching')
    return {'passed': not failures, 'failures': sorted(set(failures)), 'retrievedIds': [], 'citedIds': [],
            'recordCount': len(records), 'validCount': valid, 'mapCount': len(documents),
            'toolErrors': sum(event.get('type') == 'tool_end' and event.get('is_error', False) for event in events), 'answer': answer}
