from __future__ import annotations

import importlib.util
import inspect
import sys
import tempfile
import unittest
from collections.abc import Callable
from pathlib import Path
from types import SimpleNamespace


REPO_ROOT = Path(__file__).resolve().parents[2]
PLUGIN_DIR = REPO_ROOT / "hermes-plugins" / "prolong"


def load_plugin_module():
    init_path = PLUGIN_DIR / "__init__.py"
    if not init_path.is_file():
        raise AssertionError(f"Hermes PRO-LONG plugin is missing: {init_path}")
    spec = importlib.util.spec_from_file_location(
        "test_hermes_prolong_plugin",
        init_path,
        submodule_search_locations=[str(PLUGIN_DIR)],
    )
    if spec is None or spec.loader is None:
        raise AssertionError(f"Could not load plugin module from {init_path}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


class FakeContext:
    def __init__(self) -> None:
        self.sections: list[dict] = []
        self.hooks: dict[str, Callable[..., object]] = {}
        self.unload_callbacks: list[Callable[..., object]] = []
        self.state = SimpleNamespace(
            data_dir=Path("/test/hermes-home/plugin-data/prolong")
        )

    def register_system_prompt_section(self, section_id, content, **kwargs):
        self.sections.append({"id": section_id, "content": content, **kwargs})

    def register_hook(self, hook_name, callback):
        self.hooks[hook_name] = callback

    def on_unload(self, callback):
        self.unload_callbacks.append(callback)


class PluginRegistrationTests(unittest.TestCase):
    def test_registers_one_cache_safe_prompt_section(self) -> None:
        module = load_plugin_module()
        context = FakeContext()

        module.register(context)

        self.assertEqual(len(context.sections), 1)
        section = context.sections[0]
        self.assertEqual(section["id"], "prolong.programmatic-memory")
        self.assertEqual(section["position"], "after_memory")
        self.assertLessEqual(section["max_chars"], 4000)
        self.assertTrue(callable(section["content"]))
        with tempfile.TemporaryDirectory() as home:
            projection_root = Path(home) / "plugin-data" / "hashed-prolong" / "sessions"
            rendered = module.build_prompt(
                {"session_id": "session-safe_1"},
                projection_root=projection_root,
            )
        self.assertIn("PRO-LONG programmatic memory", rendered)
        self.assertIn("session-safe_1", rendered)
        self.assertIn("trajectory.jsonl", rendered)

    def test_unregistered_path_resolution_requires_the_plugin_namespace(self) -> None:
        module = load_plugin_module()

        with self.assertRaisesRegex(ValueError, "projection_root"):
            module.trajectory_path("session-safe_1")

    def test_prompt_uses_the_registered_controller_path(self) -> None:
        module = load_plugin_module()
        expected = Path(
            "/profile/plugin-data/hashed-prolong/sessions/root/trajectory.jsonl"
        )
        controller = SimpleNamespace(projection_path=lambda session_id: expected)

        rendered = module.build_prompt(
            {"session_id": "tip"},
            controller=controller,
        )

        self.assertIn(str(expected), rendered)

    def test_prompt_fails_open_when_session_id_is_missing(self) -> None:
        module = load_plugin_module()

        class UnexpectedController:
            def projection_path(self, session_id: str) -> Path:
                raise AssertionError("missing session ID must not reach the controller")

        rendered = module.build_prompt({}, controller=UnexpectedController())

        self.assertIn("unavailable", rendered.casefold())
        self.assertNotIn("trajectory.jsonl", rendered)

    def test_registers_forward_compatible_synchronization_hooks(self) -> None:
        module = load_plugin_module()
        context = FakeContext()

        module.register(context)

        expected = {
            "on_session_start",
            "pre_llm_call",
            "pre_tool_call",
            "post_llm_call",
            "on_session_end",
            "on_session_finalize",
            "on_session_reset",
        }
        self.assertEqual(set(context.hooks), expected)
        for callback in context.hooks.values():
            self.assertEqual(
                getattr(callback, "__self__", None).__class__.__name__,
                "ProlongController",
            )
            parameters = inspect.signature(callback).parameters.values()
            self.assertTrue(
                any(
                    parameter.kind is inspect.Parameter.VAR_KEYWORD
                    for parameter in parameters
                )
            )
        self.assertEqual(len(context.unload_callbacks), 1)


if __name__ == "__main__":
    unittest.main()
