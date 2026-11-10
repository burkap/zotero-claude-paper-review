"""Load a review profile. A profile may `extends: other.yaml` (path relative to it).

Merge rules: dict keys merge deeply; lists replace, except `checks`, which are
merged by `id` (child entries override or add; `remove_checks: [id]` drops some).
"""
import os

import yaml


def _merge(base, child):
    out = dict(base)
    for k, v in child.items():
        if isinstance(v, dict) and isinstance(out.get(k), dict):
            out[k] = _merge(out[k], v)
        else:
            out[k] = v
    return out


def load_profile(path):
    path = os.path.abspath(path)
    with open(path, encoding="utf-8") as f:
        prof = yaml.safe_load(f) or {}
    parent = prof.pop("extends", None)
    if parent:
        base = load_profile(os.path.join(os.path.dirname(path), parent))
        checks = {c["id"]: c for c in base.get("checks", [])}
        for rid in prof.pop("remove_checks", []):
            checks.pop(rid, None)
        for c in prof.get("checks", []):
            checks[c["id"]] = c
        merged = _merge(base, {k: v for k, v in prof.items() if k != "checks"})
        merged["checks"] = list(checks.values())
        return merged
    return prof
