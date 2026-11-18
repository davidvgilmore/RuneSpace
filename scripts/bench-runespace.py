#!/usr/bin/env python3
"""Measure visible frame pacing from Metal drawable timestamps or an Instruments trace.

    python3 scripts/bench-runespace.py samples ~/.config/herdr-app/data/runespace-metal-benchmark.json
    python3 scripts/bench-runespace.py instruments --process Herdr --seconds 10
    python3 scripts/bench-runespace.py embedded

The Instruments command samples one existing process. Move/orbit during the
capture, or describe the result as idle. The samples command expects the
renderer's walk/orbit/combined phases, with warm-up excluded from each phase.
"""

import argparse
import json
import math
import os
import statistics
import subprocess
import tempfile
import time
import uuid
from datetime import datetime
import xml.etree.ElementTree as ET
from pathlib import Path


def summarize_phase(timestamps, target):
    if not timestamps or any(not isinstance(t, (int, float)) or not math.isfinite(t) or t <= 0 for t in timestamps):
        raise ValueError("Presentation timestamps must be positive finite seconds")
    # Handlers on different command queues may be delivered out of order.
    ordered = sorted(timestamps)
    if len(ordered) < 2 or len(set(ordered)) != len(ordered):
        raise ValueError("Each phase needs distinct, successfully presented drawables")
    gaps = sorted((b - a) * 1000 for a, b in zip(ordered, ordered[1:]))
    period = 1000 / target
    duration = ordered[-1] - ordered[0]
    # A 60 Hz phase normally has 16.67 ms gaps. Count estimated missing
    # display intervals after rounding jitter to the nearest refresh.
    missed = sum(max(0, math.floor(gap / period + 0.5) - 1) for gap in gaps)
    summary = {
        "presented_frames": len(ordered),
        "seconds": round(duration, 3),
        "presented_fps": round(len(gaps) / duration, 2),
        "p50_ms": round(statistics.median(gaps), 2),
        "p95_ms": round(gaps[math.ceil(len(gaps) * .95) - 1], 2),
        "p99_ms": round(gaps[math.ceil(len(gaps) * .99) - 1], 2),
        "max_ms": round(gaps[-1], 2),
        "estimated_missed_refreshes": missed,
        "estimated_missed_percent": round(100 * missed / (missed + len(gaps)), 2),
    }
    return summary


def samples(source, target):
    doc = json.loads(Path(source).read_text())
    if doc.get("clock") != "MTLDrawable.presentedTime":
        raise ValueError("Expected MTLDrawable.presentedTime (seconds) from presented handlers")
    phases = {}
    for phase, scenario in [("walk", "walking"), ("orbit", "orbiting"), ("walk_orbit", "walkingAndOrbiting")]:
        summary = summarize_phase(doc["phases"][phase], target)
        visibility = doc.get("scenarios", {}).get(scenario, {})
        summary["minimum_visible_agents"] = visibility.get("minimumVisibleAgents")
        summary["all_agents_in_viewport"] = visibility.get("allAgentsInViewport")
        phases[phase] = summary
    return {
        "clock": doc["clock"],
        "device": doc.get("device"),
        "roster": doc.get("roster"),
        "width": doc.get("width"),
        "height": doc.get("height"),
        "walk_distance": doc.get("walkDistance"),
        "orbit_radians": doc.get("orbitRadians"),
        "target_hz": target,
        "phases": phases,
    }


def parse_trace(path, bounds=None):
    tree = ET.parse(path)
    records = {node.attrib["id"]: node for node in tree.iter() if "id" in node.attrib}
    layers = {}
    for table in tree.findall(".//node"):
        columns = [e.text for e in table.findall("schema/col/mnemonic")]
        for row in table.findall("row"):
            fields = {name: records[cell.attrib["ref"]] if "ref" in cell.attrib else cell
                      for name, cell in zip(columns, row)}
            if fields["name"].text != "Frame Interval" or fields["metric-variant"].text != "0":
                continue
            if bounds:
                start = int(fields["start"].text) / 1e9
                end = start + int(fields["duration"].text) / 1e9
                if start < bounds[0] or end > bounds[1]:
                    continue
            process = fields["process"].get("fmt")
            layer = fields["layer-name"].get("fmt")
            layer_id = fields["layer-id"].text
            samples = layers.setdefault((process, layer, layer_id), [])
            samples.append((int(fields["number-of-frames"].text), float(fields["value-in-ms"].text)))
    if not layers and not bounds:
        raise ValueError("Instruments recorded no displayed Metal frames")
    output = []
    for (process, layer, identifier), groups in layers.items():
        count = sum(n for n, _ in groups)
        if not count:
            continue
        mean = sum(n * ms for n, ms in groups) / count
        output.append(dict(process=process, layer=layer, layer_id=identifier,
                           frames=count, mean_display_interval_ms=round(mean, 2),
                           presented_fps=round(1000 / mean, 2)))
    return output


def capture(process, seconds):
    # xctrace requires a nonexistent .trace output and creates its own bundle.
    with tempfile.TemporaryDirectory(prefix="runespace-frame-trace-") as directory:
        trace = Path(directory) / "frames.trace"
        xml = Path(directory) / "metrics.xml"
        subprocess.run(["xctrace", "record", "--template", "Game Performance Overview",
                        "--attach", process, "--time-limit", f"{seconds}s",
                        "--no-prompt", "--output", str(trace)], check=True)
        schema = "metal-perf-overview-layer-duration-metric"
        subprocess.run(["xctrace", "export", "--input", str(trace), "--xpath",
                        f'/trace-toc/run/data/table[@schema="{schema}"]',
                        "--output", str(xml)], check=True)
        return parse_trace(xml)


def embedded(home):
    shared = home / "shared.json"
    if json.loads(shared.read_bytes()).get("runespace.mode") != "play":
        raise ValueError("Open the embedded Guild world before measuring it")
    # Capture the existing Herdr layer without changing focus or opening a diagnostic window.
    with tempfile.TemporaryDirectory(prefix="runespace-play-trace-") as directory:
        trace = Path(directory) / "frames.trace"
        xml = Path(directory) / "metrics.xml"
        toc = Path(directory) / "index.xml"
        tag = "runespace.benchmark." + uuid.uuid4().hex
        with subprocess.Popen(["/usr/bin/notifyutil","-q","-1",tag]) as ready:
            recorder = subprocess.Popen(["xctrace","record","--template","Game Performance Overview",
                "--attach","Herdr","--time-limit","32s","--notify-tracing-started",tag,
                "--no-prompt","--output",str(trace)],stdout=subprocess.DEVNULL)
            try:
                ready.wait(timeout=18)
                if recorder.poll() is not None:
                    raise ValueError("Instruments stopped before the Guild movement test")
                started = time.time()
                subprocess.run(["herdr-app","do","runespace.world-benchmark"],check=True,
                               stdout=subprocess.DEVNULL)
                if recorder.wait(timeout=60) != 0:
                    raise ValueError("Instruments could not finish recording Herdr")
            finally:
                if ready.poll() is None:
                    ready.terminate()
                if recorder.poll() is None:
                    recorder.terminate()
                    recorder.wait()
        doc = json.loads((home/"data/runespace-play-produced.json").read_bytes())
        if doc.get("id",0)/1000 < started-.1:
            raise ValueError("No result was received from this movement test")
        subprocess.run(["xctrace","export","--input",str(trace),"--toc","--output",str(toc)],
                       check=True,stdout=subprocess.DEVNULL)
        date = ET.parse(toc).findtext(".//run/info/summary/start-date")
        origin = datetime.fromisoformat(date).timestamp()
        xpath = '/trace-toc/run/data/table[@schema="metal-perf-overview-layer-duration-metric"]'
        subprocess.run(["xctrace","export","--input",str(trace),"--xpath",xpath,"--output",str(xml)],
                       check=True,stdout=subprocess.DEVNULL)
        output = {}
        for key in ("walk","orbit","walk_orbit"):
            phase = doc["phases"].get(key)
            if not phase:
                continue
            stamps = phase["sentTimes"]
            if len(stamps) < 2:
                continue
            duration = stamps[-1]-stamps[0]
            begin = phase["firstEpoch"]-origin
            # Instruments aggregates into ~one-second buckets. Exclude buckets
            # spanning a scenario boundary instead of assigning them to either.
            layers = parse_trace(xml,(begin,begin+duration))
            layer = max((row for row in layers if "GPUIView" in row["layer"]),key=lambda r:r["frames"],default=None)
            output[key] = dict(display=layer, sent_fps=round((len(stamps)-1)/duration,2),
                               sent_frames=len(stamps), elapsed_seconds=round(duration,2),
                               **{k:v for k,v in phase.items() if k not in ("sentTimes","firstEpoch")})
        return {"surface":"embedded Herdr GPUIView", "cancelled":bool(doc.get("cancelled")), "phases":output}


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    commands = parser.add_subparsers(dest="command", required=True)
    analyze = commands.add_parser("samples")
    analyze.add_argument("json_file", help="JSON with per-phase timestamps from Metal")
    analyze.add_argument("--target", type=int, default=60, choices=range(1, 241), metavar="HZ")
    instruments = commands.add_parser("instruments")
    instruments.add_argument("--process", required=True, help="Process name or PID")
    instruments.add_argument("--seconds", type=int, default=10, choices=range(2, 121), metavar="N")
    integrated = commands.add_parser("embedded", help="Measure real gameplay in the open Herdr window")
    integrated.add_argument("--app-home",type=Path,default=os.environ.get("HERDR_APP_HOME", Path.home()/".config/herdr-app"))
    args = parser.parse_args()
    try:
        if args.command == "embedded":
            result=embedded(args.app_home)
        elif args.command == "samples":
            result=samples(args.json_file,args.target)
        else:
            result=capture(args.process,args.seconds)
        print(json.dumps(result, indent=2))
    except (KeyError, ValueError, OSError, subprocess.SubprocessError) as error:
        parser.exit(1, f"Frame measurement failed: {error}\n")


if __name__ == "__main__":
    main()
