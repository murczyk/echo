"""Local integration reads the server database named by the checkout config."""
import unittest

from local import database_name, psql_command


class LocalDatabase(unittest.TestCase):
    def test_reads_pg_dbname(self):
        self.assertEqual(database_name('pg_host = "localhost"\npg_dbname = "wd_connection_status_stable"\n'),
                         'wd_connection_status_stable')

    def test_rejects_missing_or_unusual_names(self):
        with self.assertRaises(ValueError):
            database_name('pg_host = "localhost"\n')
        with self.assertRaises(ValueError):
            database_name('pg_dbname = "wd;drop"\n')

    def test_replaces_fixture_database(self):
        command = psql_command({'fixturePsql': ['sudo', '-n', '-u', 'postgres', 'psql', '-d', 'wd']}, 'wd_connection_status_stable')
        self.assertEqual(command, ['sudo', '-n', '-u', 'postgres', 'psql', '-d', 'wd_connection_status_stable', '-XAtq', '-v', 'ON_ERROR_STOP=1'])


if __name__ == '__main__':
    unittest.main()
