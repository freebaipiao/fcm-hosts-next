import io
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import update_fcm


class HostsTests(unittest.TestCase):
    def test_whitelist_normalization_and_deduplication(self):
        data = update_fcm.parse_hosts("""
            # comment
            8.8.8.8 MTALK.GOOGLE.COM. alias.example # comment
            8.8.8.8 mtalk.google.com
            2001:4860:4860::8888 mtalk.google.com
            1.1.1.1 alt1-mtalk.google.com
            invalid mtalk.google.com
            127.0.0.1 mtalk.google.com
        """)
        self.assertEqual(data, {
            "mtalk.google.com": {
                "A": ["8.8.8.8"], "AAAA": ["2001:4860:4860::8888"],
            },
        })

    def test_single_stack_is_valid(self):
        self.assertEqual(
            update_fcm.parse_hosts("8.8.8.8 mtalk.google.com")[update_fcm.TARGET]["AAAA"],
            [],
        )

    def test_invalid_download_preserves_existing_data(self):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "fcm-data.js"
            output.write_text("previous data", encoding="utf-8")
            with patch.object(update_fcm, "urlopen", return_value=io.BytesIO(b"bad hosts")):
                with patch.object(update_fcm, "write_data") as writer:
                    with self.assertRaises(ValueError):
                        update_fcm.main()
                    writer.assert_not_called()
            self.assertEqual(output.read_text(encoding="utf-8"), "previous data")

    def test_network_failure_does_not_write(self):
        with patch.object(update_fcm, "urlopen", side_effect=OSError("offline")):
            with patch.object(update_fcm, "write_data") as writer:
                with self.assertRaises(OSError):
                    update_fcm.main()
                writer.assert_not_called()

    def test_atomic_write_leaves_no_temporary_files(self):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "fcm-data.js"
            data = update_fcm.parse_hosts("8.8.8.8 mtalk.google.com")
            update_fcm.write_data(data, output)
            self.assertTrue(output.read_text(encoding="utf-8").startswith("export default "))
            self.assertEqual(list(Path(directory).iterdir()), [output])


if __name__ == "__main__":
    unittest.main()
