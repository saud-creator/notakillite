"""Prints the UDID of the simulator to test on, creating it when the runner does not have it yet.

Usage:
  pick-simulator.py --os 18 --prefer "iPad Pro 13-inch (M4),iPad Pro 11-inch (M4)" --create "iPad Pro 13-inch (M4)"
  pick-simulator.py --os 27 --prefer "iPhone 15 Pro" --create com.apple.CoreSimulator.SimDeviceType.iPhone-15-Pro

--os       iOS version to test on: "18" takes the newest installed 18.x runtime, "18.6" exactly that one.
--prefer   device names in order of preference (comma separated). A name matches itself and its
           memory variants, such as "iPad Pro 13-inch (M4) (16GB)", but "iPhone 15 Pro" never matches
           "iPhone 15 Pro Max".
--create   device type (name or identifier) to create on that runtime when none of the preferred
           devices exists yet.

Never falls back to another iOS version or another device: if the runner cannot provide what was
asked for, it stops with a plain explanation and the list of what is available.
Diagnostics go to stderr; stdout is only the UDID.
"""
import argparse
import json
import subprocess
import sys


def simctl(*args):
    return subprocess.check_output(["xcrun", "simctl", *args], text=True)


def version_key(version):
    return tuple(int(part) if part.isdigit() else 0 for part in version.split("."))


def note(message):
    print(message, file=sys.stderr)


def fail(message):
    print(f"::error::{message}", file=sys.stderr)
    sys.exit(1)


def matches(name, wanted):
    return name == wanted or name.startswith(wanted + " (")


parser = argparse.ArgumentParser()
parser.add_argument("--os", required=True)
parser.add_argument("--prefer", required=True)
parser.add_argument("--create")
args = parser.parse_args()
preferred = [p.strip() for p in args.prefer.split(",") if p.strip()]

runtimes = [r for r in json.loads(simctl("list", "runtimes", "-j"))["runtimes"]
            if r.get("isAvailable", True) and (r.get("platform") == "iOS" or ".iOS-" in r["identifier"])]
installed = ", ".join(sorted((r["version"] for r in runtimes), key=version_key)) or "none"
wanted = [r for r in runtimes if r["version"] == args.os or r["version"].startswith(args.os + ".")]
if not wanted:
    fail(f"This runner has no iOS {args.os} simulator runtime (installed: {installed}). "
         f"Not testing on another version.")
runtime = max(wanted, key=lambda r: version_key(r["version"]))
note(f"iOS runtimes on this runner: {installed}; using {runtime['name']} ({runtime.get('buildversion', '?')})")

devices = json.loads(simctl("list", "devices", "available", "-j"))["devices"].get(runtime["identifier"], [])
for wanted_name in preferred:
    for device in devices:
        if matches(device["name"], wanted_name):
            note(f"Using the existing {device['name']} on {runtime['name']} ({device['udid']})")
            print(f"::notice::Testing on {device['name']} · {runtime['name']}", file=sys.stderr)
            print(device["udid"])
            sys.exit(0)

if not args.create:
    names = ", ".join(sorted(d["name"] for d in devices)) or "none"
    fail(f"No {' or '.join(preferred)} simulator on {runtime['name']} (devices there: {names}).")

types = runtime.get("supportedDeviceTypes")
if types is None:  # very old Xcode: let simctl decide
    types = json.loads(simctl("list", "devicetypes", "-j"))["devicetypes"]
chosen = next((t for t in types if t["identifier"] == args.create), None) \
    or next((t for t in types if t["name"] == args.create), None) \
    or next((t for t in types if matches(t["name"], args.create)), None)
if chosen is None:
    family = "iPhone" if "iPhone" in args.create else "iPad"
    offered = ", ".join(t["name"] for t in types if t.get("productFamily", family) == family) or "none"
    fail(f"{runtime['name']} on this runner cannot run a '{args.create}' simulator. "
         f"{family} models it supports: {offered}.")

name = chosen["name"]
try:
    udid = simctl("create", name, chosen["identifier"], runtime["identifier"]).strip()
except subprocess.CalledProcessError as error:
    fail(f"Creating a {name} simulator on {runtime['name']} failed (exit {error.returncode}).")
note(f"Created {name} ({chosen['identifier']}) on {runtime['name']}: {udid}")
print(f"::notice::Testing on {name} · {runtime['name']} (created for this run)", file=sys.stderr)
print(udid)
