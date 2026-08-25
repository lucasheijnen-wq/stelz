"""Every name a handler references must exist on the module after import.

Why this test exists: handlers/scan_hashtags.py called `scan_state.*` at three
sites for FOUR commits without ever importing it. The module imports cleanly
(the failure is per-call, at runtime, inside Cloud Functions), no test imported
the module, and the suite stayed green while production's hashtag step could
never report itself finished. A missing import is the cheapest bug class there
is to catch mechanically — this file makes it structurally impossible to ship
again.

HOW: `symtable` compiles each handler's source and walks every scope. A symbol
that is global AND referenced is a name Python will resolve from the module
namespace at call time — if it is neither a builtin nor an attribute of the
imported module, some call path raises NameError in production. Eval-free:
nothing in the handler is executed beyond its import.
"""
from __future__ import annotations

import builtins
import importlib
import os
import symtable
import sys
import types
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


def _stub(name: str) -> types.ModuleType:
    mod = sys.modules.get(name)
    if mod is None:
        mod = types.ModuleType(name)
        sys.modules[name] = mod
    if "." in name:
        parent, _, child = name.rpartition(".")
        setattr(_stub(parent), child, mod)
    return mod


for _n in (
    "firebase_admin", "firebase_admin.firestore", "firebase_admin.storage",
    "google.cloud", "google.cloud.firestore", "google.cloud.pubsub_v1",
):
    _stub(_n)
_stub("firebase_admin").initialize_app = lambda *a, **k: None
_stub("firebase_admin").get_app = lambda *a, **k: None
_stub("firebase_admin").credentials = types.SimpleNamespace(ApplicationDefault=lambda: None)
_fsmod = _stub("google.cloud.firestore")
for _attr, _val in (("SERVER_TIMESTAMP", "TS"), ("Increment", lambda *a, **k: None),
                    ("ArrayUnion", lambda v: v), ("ArrayRemove", lambda v: v),
                    ("DELETE_FIELD", "DEL")):
    if not hasattr(_fsmod, _attr):
        setattr(_fsmod, _attr, _val)

HANDLERS_DIR = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "handlers")

# Names a module resolves globally that are legitimately absent from `dir()`
# after a plain import: module dunders set by the import machinery.
MODULE_ATTRS = {"__file__", "__name__", "__doc__", "__package__", "__spec__",
                "__loader__", "__builtins__"}
BUILTINS = set(dir(builtins))


def referenced_globals(source: str, path: str) -> set[str]:
    """Every symbol some scope will resolve from the module's global namespace."""
    out: set[str] = set()

    def walk(table: symtable.SymbolTable) -> None:
        for sym in table.get_symbols():
            if sym.is_global() and sym.is_referenced():
                out.add(sym.get_name())
        for child in table.get_children():
            walk(child)

    walk(symtable.symtable(source, path, "exec"))
    return out


class TestHandlerImports(unittest.TestCase):
    def test_every_referenced_global_exists(self):
        checked = 0
        for fname in sorted(os.listdir(HANDLERS_DIR)):
            if not fname.endswith(".py") or fname == "__init__.py":
                continue
            modname = f"handlers.{fname[:-3]}"
            module = importlib.import_module(modname)
            with open(os.path.join(HANDLERS_DIR, fname), encoding="utf-8") as f:
                source = f.read()
            missing = sorted(
                n for n in referenced_globals(source, fname)
                if n not in BUILTINS and n not in MODULE_ATTRS
                and not hasattr(module, n))
            self.assertEqual(missing, [], (
                f"{modname} references {missing} but never binds or imports "
                f"them — a call path in production raises NameError. "
                f"(This is exactly how scan_state went missing from "
                f"scan_hashtags for four commits.)"))
            checked += 1
        # The walk must actually have covered the handlers — an empty directory
        # scan passing would be a broken test claiming safety.
        self.assertGreaterEqual(checked, 10)


if __name__ == "__main__":
    unittest.main()
