"""Isolated native-config tests; no Supervisor, Docker or business state touched."""
import hashlib
import importlib.util
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location('app_control', Path(__file__).resolve().parents[2] / 'services/app-control.py')
apps = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(apps)
apps.OWNER = os.getuid()


class AppAutostartTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='pic-app-policy-')
        self.addCleanup(self.temp.cleanup)
        self.directory = Path(self.temp.name)

    def put(self, content, name='demo.conf'):
        path = self.directory / name
        path.write_text(content)
        path.chmod(0o600)
        return path

    def change(self, name, enabled):
        app = apps.applications(self.directory)[name]
        apps.set_autostart(name, enabled, app[1], self.directory)

    def test_defaults_true_and_preserves_explicit_disabled(self):
        self.put('[program:demo]\ncommand=/safe/program\n')
        self.put('[program:other]\nautostart=false\ncommand=/safe/other\n', 'other.conf')
        found = apps.applications(self.directory)
        self.assertTrue(found['demo'][0])
        self.assertFalse(found['other'][0])
        self.assertEqual(len(found), 2)

    def test_only_selected_program_changes_no_live_process_action(self):
        path = self.put('# reviewed\n[program:demo]\ncommand=/safe/%(ENV_USER)s\nsecret=FAKE-PRIVATE\nautostart=true\nautorestart=true\n\n[program:second]\ncommand=/safe/second\nautostart=true\n')
        original = path.read_bytes()
        self.change('demo', False)
        changed = path.read_bytes()
        self.assertEqual(changed, original.replace(b'autostart=true', b'autostart=false', 1))
        self.assertEqual(path.stat().st_mode & 0o777, 0o600)
        self.assertTrue(apps.applications(self.directory)['second'][0])
        self.change('demo', True)
        self.assertEqual(path.read_bytes(), original)
        inode = path.stat().st_ino
        self.change('demo', True)
        self.assertEqual(path.stat().st_ino, inode, 'no-op does not rewrite')

    def test_missing_value_added_inside_correct_section_even_without_final_newline(self):
        path = self.put('[DEFAULT]\nautostart=true\n[program:demo]\ncommand=/safe\n[group:batch]\nprograms=demo')
        self.change('demo', False)
        self.assertIn('command=/safe\nautostart=false\n[group:', path.read_text())
        self.assertFalse(apps.applications(self.directory)['demo'][0])
        last = self.put('[program:last]\ncommand=/safe', 'last.conf')
        self.change('last', False)
        self.assertTrue(last.read_text().endswith('command=/safe\nautostart=false\n'))

    def test_crlf_and_option_case(self):
        data = b'[program:demo]\r\ncommand=/safe\r\nAUTOSTART = true ; original\r\n'
        path = self.put('')
        path.write_bytes(data)
        self.change('demo', False)
        self.assertEqual(path.read_bytes(), b'[program:demo]\r\ncommand=/safe\r\nautostart=false\r\n')

    def test_multiline_commands_are_never_mistaken_for_options_or_sections(self):
        path = self.put('[program:demo]\ncommand=/safe\n    autostart=true\n    [program:not-a-program]\n    --flag\nautostart=true\n[program:second]\ncommand=/other\nautostart=true\n')
        original = path.read_text()
        self.change('demo', False)
        self.assertEqual(path.read_text(), original.replace('\nautostart=true\n[program:second]', '\nautostart=false\n[program:second]'))
        self.assertEqual(list(apps.applications(self.directory)), ['demo', 'second'])

    def test_stale_revision_rejected_without_overwriting(self):
        path = self.put('[program:demo]\nautostart=true\n')
        revision = apps.applications(self.directory)['demo'][1]
        path.write_text('[program:demo]\nautostart=true\ncommand=changed\n')
        before = path.read_bytes()
        with self.assertRaisesRegex(apps.AppError, '其他操作者'):
            apps.set_autostart('demo', False, revision, self.directory)
        self.assertEqual(path.read_bytes(), before)

    def test_rejects_duplicate_core_invalid_and_malformed_definitions(self):
        for bad in ['[program:sshd]\n', '[program:bad name]\n', '[program:demo]\nautostart=invalid\n', '[program:demo]\nautostart=true\nautostart=false\n']:
            with self.subTest(bad=bad):
                self.put(bad)
                with self.assertRaises((ValueError, apps.configparser.Error)):
                    apps.applications(self.directory)
        self.put('[program:demo]\n')
        self.put('[program:demo]\n', 'second.conf')
        with self.assertRaisesRegex(ValueError, '重复'):
            apps.applications(self.directory)

    def test_rejects_writable_symlink_and_non_regular_config(self):
        path = self.put('[program:demo]\n')
        path.chmod(0o666)
        with self.assertRaises(ValueError):
            apps.applications(self.directory)
        path.unlink()
        target = self.put('[program:demo]\n', 'target.disabled')
        path.symlink_to(target)
        with self.assertRaises(OSError):
            apps.applications(self.directory)
        path.unlink()
        os.mkfifo(path)
        with self.assertRaises(ValueError):
            apps.applications(self.directory)

    def test_atomic_replace_failure_keeps_original_and_removes_temporary(self):
        path = self.put('[program:demo]\nautostart=true\n')
        before = path.read_bytes()
        with patch.object(apps.os, 'replace', side_effect=OSError('synthetic-failure')):
            with self.assertRaises(OSError):
                self.change('demo', False)
        self.assertEqual(path.read_bytes(), before)
        self.assertEqual([p.name for p in self.directory.iterdir()], ['demo.conf'])

    def test_invalid_arguments_never_reach_paths(self):
        for name in ['../demo', '-demo', 'demo;id', 'sshd\n']:
            with self.assertRaises(ValueError):
                apps.set_autostart(name, False, hashlib.sha256(b'').hexdigest(), self.directory)


if __name__ == '__main__':
    unittest.main()
