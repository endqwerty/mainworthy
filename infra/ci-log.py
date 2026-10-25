#!/usr/bin/env python3
"""Publish only Terraform summaries and redacted error headers to public CI logs."""
import ipaddress
import json
import os
import re
import sys
from pathlib import Path


def identifiers():
    values = set()
    for name, value in os.environ.items():
        if name.startswith(("TF_VAR_", "GCP_")) or name == "STATE_BUCKET":
            if value and value != "null":
                values.add(value)
    provider = os.environ.get("GCP_WORKLOAD_IDENTITY_PROVIDER", "")
    number = re.match(r"projects/(\d+)/", provider)
    if number:
        values.add(number[1])
    for name in ("GCP_INFRA_DEPLOY_ACCOUNT", "GCP_INFRA_PLAN_ACCOUNT"):
        account = re.fullmatch(r"[^@]+@([a-z][a-z0-9-]*)\.iam\.gserviceaccount\.com", os.environ.get(name, ""))
        if account:
            values.add(account[1])
    project = os.environ.get("TF_VAR_production_project", "")
    if project:
        for account in ("app", "jobs"):
            email = f"mainworthy-{account}@{project}.iam.gserviceaccount.com"
            values.update((email, email.removesuffix(".gserviceaccount.com")))
    return sorted(values, key=len, reverse=True)


def redact_address(match):
    candidate = match[0]
    for suffix in ("", ".", ":"):
        if suffix and not candidate.endswith(suffix):
            continue
        address = candidate[:-1] if suffix else candidate
        try:
            ipaddress.ip_address(address)
        except ValueError:
            continue
        return "***" + suffix
    return candidate


def redact(line, values):
    for value in values:
        line = line.replace(value, "***")
    # These are assigned by Google and cannot all be computed before Terraform runs.
    line = re.sub(r"(?:https?|gs)://[^\s\"'<>]+", "***", line)
    line = re.sub(r"[\w.+%-]+@[\w.-]+", "***", line)
    line = re.sub(r"[\w.-]+\.run\.app\b", "***", line)
    line = re.sub(r"(?<![\w:.])[0-9a-fA-F:.]+(?:%[\w.-]+)?(?![\w:.])", redact_address, line)
    # An IPv4 address beside a port or after a colon, which the pass above leaves whole.
    line = re.sub(r"(?<![\w.])(?:\d{1,3}\.){3}\d{1,3}(?!\w|\.\d)", redact_address, line)
    line = re.sub(r"\b[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}\b", "***", line, flags=re.IGNORECASE)
    line = re.sub(r"\b\d{6,}\b", "***", line)
    return line


ACTIONS = {
    ("create",): "create", ("update",): "update", ("delete",): "destroy", ("read",): "read",
    ("delete", "create"): "replace", ("create", "delete"): "replace", ("forget",): "forget",
    ("forget", "create"): "forget and create", ("create", "forget"): "create and forget",
}


def changed(before, after, unknown):
    if not isinstance(before, dict) or not isinstance(after, dict):
        return []
    names = {name for name in before.keys() | after.keys() if before.get(name) != after.get(name)}
    if isinstance(unknown, dict):
        names |= {name for name, value in unknown.items() if value}
    return sorted(names)


def plan_changes(path, values):
    for resource in json.loads(Path(path).read_text()).get("resource_changes", []):
        change = resource.get("change", {})
        actions = tuple(change.get("actions", []))
        verb = ACTIONS.get(actions)
        if actions == ("no-op",):
            if "importing" not in change:
                continue
            verb = "import"
        elif verb is None:
            verb = f"change ({', '.join(actions)})"
        elif "importing" in change:
            verb = f"import and {verb}"
        names = changed(change.get("before"), change.get("after"), change.get("after_unknown")) if "update" in verb else []
        line = f"{verb} {resource.get('address', '?')}" + (f" ({', '.join(names)})" if names else "")
        print(redact(line, values))


values = identifiers()
if sys.argv[1] == "changes":
    plan_changes(sys.argv[2], values)
elif sys.argv[1] == "mask":
    for value in values:
        escaped = value.replace("%", "%25").replace("\r", "%0D").replace("\n", "%0A")
        print(f"::add-mask::{escaped}")
else:
    failed = sys.argv[2] != "0"
    for line in Path(sys.argv[1]).read_text(errors="replace").splitlines():
        if re.fullmatch(r"Plan: (?:\d+ to import, )?\d+ to add, \d+ to change, \d+ to destroy(?:, \d+ to forget)?\.?", line):
            print(line)
        elif re.fullmatch(r"Apply complete! Resources: (?:\d+ imported, )?\d+ added, \d+ changed, \d+ destroyed\.?", line):
            print(line)
        elif line.startswith("No changes."):
            print("No changes.")
        elif failed and line.startswith("Error:"):
            print(redact(line, values))
