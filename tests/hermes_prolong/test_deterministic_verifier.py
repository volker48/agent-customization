from __future__ import annotations

import importlib.util
import os
import unittest
import unittest.mock
from pathlib import Path


VERIFIER = Path(__file__).resolve().parents[2] / "scripts" / "verify-hermes-prolong.py"


class DeterministicVerifierTests(unittest.TestCase):
    def test_model_free_environment_removes_runtime_import_overrides(self) -> None:
        spec = importlib.util.spec_from_file_location("prolong_deterministic", VERIFIER)
        assert spec is not None and spec.loader is not None
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        with unittest.mock.patch.dict(
            os.environ,
            {
                "HERMES_SOURCE": "/ambient/hermes",
                "PYTHONPATH": "/ambient/python",
                "PYTHONHOME": "/ambient/home",
                "PATH": "/usr/bin",
            },
            clear=True,
        ):
            env = module.sanitized_environment()

        self.assertEqual(env, {"PATH": "/usr/bin"})


if __name__ == "__main__":
    unittest.main()
