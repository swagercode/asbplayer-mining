import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import install


class InstallTests(unittest.TestCase):
    def test_codex_discovery_preserves_custom_paths_and_repairs_moved_app(self):
        bundled = '/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex'
        custom = '/custom/codex'
        cli = '/opt/bin/codex'
        for available, configured, expected in (
                ({bundled, custom, cli}, custom, custom),
                ({bundled, cli}, '/Applications/ChatGPT.app/Contents/Resources/codex', bundled),
                ({cli}, None, cli)):
            with self.subTest(configured=configured, expected=expected), \
                    patch.object(Path, 'is_file', lambda path: str(path) in available), \
                    patch.object(install.shutil, 'which', return_value=cli):
                self.assertEqual(install.find_codex(configured), expected)
        with patch.object(Path, 'is_file', return_value=False), \
                patch.object(install.shutil, 'which', return_value=None):
            with self.assertRaises(ValueError):
                install.find_codex()

    def test_chrome_id_uses_manifest_key(self):
        with tempfile.TemporaryDirectory() as directory:
            manifest = Path(directory) / 'manifest.json'
            # SHA-256("abc") begins ba7816bf8f01cfea414140de5dae2223.
            manifest.write_text(json.dumps({'key': 'YWJj'}))
            self.assertEqual(install.chrome_extension_id(manifest), 'lkhibglpipabmpokebebeanofnkocccd')
            for key in [None, '', 'not base64!']:
                manifest.write_text(json.dumps({'key': key}))
                with self.assertRaises(ValueError):
                    install.chrome_extension_id(manifest)

    def test_chrome_install_preserves_firefox_registration(self):
        with tempfile.TemporaryDirectory() as directory:
            home = Path(directory)
            support = home / 'Library/Application Support'
            firefox = support / f'Mozilla/NativeMessagingHosts/{install.HOST_NAME}.json'
            firefox.parent.mkdir(parents=True)
            firefox.write_text('existing Firefox registration')
            manifest = home / 'manifest.json'
            manifest.write_text(json.dumps({'key': 'YWJj'}))
            with patch.object(install.shutil, 'which', return_value=__file__):
                install.install('chrome', manifest, home)
            self.assertEqual(firefox.read_text(), 'existing Firefox registration')
            chrome = json.loads((support / f'Google/Chrome/NativeMessagingHosts/{install.HOST_NAME}.json').read_text())
            self.assertEqual(chrome['allowed_origins'], ['chrome-extension://lkhibglpipabmpokebebeanofnkocccd/'])
            self.assertNotIn('allowed_extensions', chrome)
            self.assertTrue(Path(chrome['path']).is_file())
            self.assertEqual(Path(chrome['path']).stat().st_mode & 0o777, 0o700)

    def test_firefox_manifest_remains_extension_scoped(self):
        manifest = install.host_manifest(Path('/tmp/launch'), 'firefox')
        self.assertEqual(manifest['allowed_extensions'], [install.FIREFOX_ID])
        self.assertNotIn('allowed_origins', manifest)
        with self.assertRaises(ValueError):
            install.host_manifest(Path('/tmp/launch'), 'chrome', '*')


if __name__ == '__main__':
    unittest.main()
