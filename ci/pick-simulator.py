"""Prints the UDID of an available iPad simulator, preferring iPad Pro (M4) on iPadOS 18.

Usage: pick-simulator.py [iOS version prefix, default 18]
"""
import json, subprocess, sys

version = sys.argv[1] if len(sys.argv) > 1 else "18"
devices = json.loads(subprocess.check_output(["xcrun", "simctl", "list", "devices", "available", "-j"]))["devices"]
runtimes = sorted((r for r in devices if ".iOS-" in r), reverse=True)  # newest first
wanted = [r for r in runtimes if f".iOS-{version.replace('.', '-')}" in r]
if not wanted:
    sys.exit(f"No iOS {version} simulator runtime on this runner (found {runtimes}). Refusing to test on another version.")
for preference in ("iPad Pro 13-inch (M4)", "iPad Pro 11-inch (M4)", "iPad Pro", "iPad"):
    for runtime in wanted:
        for device in devices[runtime]:
            if device["name"].startswith(preference):
                print(device["udid"])
                print(f"Using {device['name']} on {runtime.split('.')[-1]}", file=sys.stderr)
                sys.exit(0)
sys.exit(f"No iPad simulator; runtimes: {runtimes}")
