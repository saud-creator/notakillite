"""Prints the UDID of an available simulator: pick-simulator.py <iPhone|iPad> [iOS version prefix]."""
import json, subprocess, sys

kind = sys.argv[1]
version = sys.argv[2] if len(sys.argv) > 2 else ""
devices = json.loads(subprocess.check_output(["xcrun", "simctl", "list", "devices", "available", "-j"]))["devices"]
runtimes = sorted((r for r in devices if ".iOS-" in r), reverse=True)  # newest first
for runtime in runtimes:
    if version and f".iOS-{version.replace('.', '-')}" not in runtime:
        continue
    for device in devices[runtime]:
        if device["name"].startswith(kind):
            print(device["udid"])
            sys.exit(0)
sys.exit(f"No {kind} simulator for iOS {version or 'any'}; runtimes: {runtimes}")
