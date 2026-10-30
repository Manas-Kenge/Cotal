import argparse
import json
import os
from pathlib import Path
import shutil
import signal
import subprocess
import time

parser = argparse.ArgumentParser(description="Linux-only interruption checks for the feasibility controller")
parser.add_argument("--output", required=True)
args = parser.parse_args()
assert os.uname().sysname == "Linux", "This check observes real Linux /proc; it does not simulate other platforms"
root = Path(__file__).resolve().parents[2]
output = Path(args.output).resolve()
output.mkdir(parents=True, exist_ok=True)


def descendants(pid):
    found = {}
    todo = [pid]
    while todo:
        parent = todo.pop()
        try:
            children = Path(f"/proc/{parent}/task/{parent}/children").read_text().split()
        except FileNotFoundError:
            continue
        for value in children:
            child = int(value)
            try:
                found[child] = Path(f"/proc/{child}/cmdline").read_bytes().replace(b"\0", b" ").decode(errors="replace")
            except FileNotFoundError:
                continue
            todo.append(child)
    return found


def live(pid):
    try:
        return Path(f"/proc/{pid}/stat").read_text().rsplit(") ", 1)[1][0] != "Z"
    except (FileNotFoundError, ProcessLookupError):
        return False


results = []
for phase in ["compile", "candidate", "observer"]:
    directory = output / phase
    directory.mkdir(exist_ok=True)
    known = {}
    with (directory / "controller.log").open("w") as log:
        controller = subprocess.Popen(["node", "--import", "tsx", "scripts/tui-feasibility/run.mjs", "--output", str(directory)], cwd=root, stdout=log, stderr=subprocess.STDOUT)
        try:
            deadline = time.monotonic() + 90
            target = None
            while time.monotonic() < deadline and controller.poll() is None:
                current = descendants(controller.pid)
                known.update(current)
                for pid, command in current.items():
                    matches = ("bun build " in command if phase == "compile" else
                               "entry.mjs " in command and "config.json" in command and "bun build " not in command if phase == "candidate" else
                               "bin/dist/cotal.js who " in command)
                    if matches:
                        target = {"pid": pid, "command": command}
                        break
                if target:
                    break
                time.sleep(0.01)
            assert target, f"Never observed the active {phase} child"
            controller.send_signal(signal.SIGTERM)
            code = controller.wait(timeout=20)
            deadline = time.monotonic() + 10
            while any(live(pid) for pid in known) and time.monotonic() < deadline:
                time.sleep(0.05)
            alive = [pid for pid in known if live(pid)]
            result = {"phase": phase, "controllerExit": code, "target": target, "observedChildren": known, "liveChildrenAfterExit": alive}
            assert code != 0, "An interrupted proof must not pass"
            assert not alive, f"Owned children still live: {alive}"
            if (directory / "interrupted.json").exists():
                interrupted = json.loads((directory / "interrupted.json").read_text())
                scratch = Path(interrupted["scratchRetained"])
                assert scratch.name.startswith("cotal-smoke-broker-"), str(scratch)
                assert str(scratch).startswith("/tmp/"), str(scratch)
                shutil.rmtree(scratch)
            else:
                report = json.loads((directory / "report.json").read_text())
                assert report["cleanup"]["scratchRemoved"], report["cleanup"]
            result["scratchRemovedAfterControllerAndChildrenExited"] = True
            results.append(result)
        finally:
            if controller.poll() is None:
                controller.send_signal(signal.SIGTERM)
                controller.wait(timeout=20)
    (output / "interruptions.json").write_text(json.dumps(results, indent=2) + "\n")
print(json.dumps(results, indent=2))
