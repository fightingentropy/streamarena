#!/usr/bin/env python3
"""Probe one signed media resource without printing its URL or authorization.

Examples:
  python3 scripts/check-hls-delivery-cache.py --url-file /private/segment.txt
  python3 scripts/check-hls-delivery-cache.py --url-file /private/probes.json \
    --json-path segments.0.url --origin https://live.example.com

An edge HIT proves cache reuse for this resource, not successful video playback
or faster cold startup. Every sample is a fresh network GET, not a browser hit.
"""

import argparse
import hashlib
import json
import pathlib
import subprocess
import sys
import tempfile
import urllib.parse

MAX_BYTES = 16 * 1024 * 1024


def checked_url(value, origin_only=False):
    if not isinstance(value, str) or any(ord(c) < 33 for c in value):
        raise ValueError("invalid URL")
    parsed = urllib.parse.urlsplit(value)
    if (parsed.scheme != "https" or not parsed.hostname or parsed.username
            or parsed.password or parsed.fragment):
        raise ValueError("HTTPS URL required")
    if origin_only and (parsed.path not in ("", "/") or parsed.query):
        raise ValueError("origin cannot contain a path or query")
    return parsed


def read_resource(path, json_path):
    value = pathlib.Path(path).read_text().strip()
    if json_path:
        value = json.loads(value)
        for component in json_path.split("."):
            value = value[int(component)] if isinstance(value, list) else value[component]
    return checked_url(value)


def response_headers(path):
    headers = {}
    for line in path.read_text(errors="replace").splitlines():
        # Reset for a later response, including after an HTTP CONNECT preamble.
        if line.startswith("HTTP/"):
            headers = {}
        elif ":" in line:
            key, value = line.split(":", 1)
            headers[key.lower()] = value.strip()
    return headers


def sample(url, origin, number):
    with tempfile.TemporaryDirectory(prefix="hls-cache-probe-") as temp:
        body = pathlib.Path(temp) / "body"
        headers_file = pathlib.Path(temp) / "headers"
        body.touch(mode=0o600)
        headers_file.touch(mode=0o600)
        # Keep the bearer URL out of argv/process listings as well as output.
        config = "url = " + json.dumps(url) + "\n"
        try:
            result = subprocess.run(
                ["curl", "--silent", "--show-error", "--proto", "=https",
                 "--request", "GET", "--max-time", "20", "--connect-timeout", "10",
                 "--max-filesize", str(MAX_BYTES), "--dump-header", str(headers_file),
                 "--output", str(body), "--write-out", "%{json}", "--config", "-"],
                input=config, text=True, capture_output=True, timeout=22, check=False,
            )
            curl_exit = result.returncode
            metrics = json.loads(result.stdout or "{}")
        except subprocess.TimeoutExpired:
            curl_exit, metrics = 28, {}
        headers = response_headers(headers_file)
        size = body.stat().st_size
        status = int(metrics.get("http_code", 0))
        complete = curl_exit == 0 and status == 200 and 0 < size <= MAX_BYTES
        digest = hashlib.sha256(body.read_bytes()).hexdigest() if complete else None
        # Only fixed, non-sensitive cache classifications leave this process.
        cache_values = {"HIT", "MISS", "DYNAMIC", "BYPASS", "EXPIRED", "REVALIDATED",
                        "UPDATING", "STALE", "NONE", "UNKNOWN"}
        cache = {}
        for key in ("cf-cache-status", "x-upstream-cache"):
            value = headers.get(key, "absent").upper()
            cache[key] = value if value in cache_values else "absent"
        return {"origin": origin, "sample": number, "status": status,
                "curl_exit": curl_exit, "complete": complete, "bytes": size,
                "ttfb_ms": round(float(metrics.get("time_starttransfer", 0)) * 1000, 3),
                "total_ms": round(float(metrics.get("time_total", 0)) * 1000, 3),
                "cache": cache, "sha256": digest}


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--url-file", required=True, help="Private file containing one signed HTTPS resource URL")
    parser.add_argument("--json-path", help="Optional dotted JSON path, e.g. segments.0.url")
    parser.add_argument("--origin", action="append", default=[], help="Explicit HTTPS origin override; repeat to compare")
    parser.add_argument("--samples", type=int, choices=range(1, 4), default=3)
    args = parser.parse_args()
    try:
        resource = read_resource(args.url_file, args.json_path)
        origins = [checked_url(value, origin_only=True) for value in args.origin] or [resource]
        if len(origins) > 4:
            raise ValueError("at most four origins")
        rows = []
        for parsed in origins:
            origin = urllib.parse.urlunsplit((parsed.scheme, parsed.netloc, "", "", ""))
            url = urllib.parse.urlunsplit(resource._replace(scheme=parsed.scheme, netloc=parsed.netloc))
            for number in range(1, args.samples + 1):
                row = sample(url, origin, number)
                rows.append(row)
                print(json.dumps(row), flush=True)
        complete = all(row["complete"] for row in rows)
        equal = complete and len({row["sha256"] for row in rows}) == 1
        print(json.dumps({"all_complete": complete, "byte_identical": equal,
                          "edge_hit_samples": sum(row["complete"] and "HIT" in row["cache"].values() for row in rows),
                          "playback_verified": False,
                          "limitation": "Resource cache reuse only; not first-frame or cold-provider performance."}))
        return 0 if equal else 1
    except (ValueError, KeyError, IndexError, TypeError, OSError):
        # Exception messages can contain signed URLs; never print them.
        print(json.dumps({"error": "probe_input_or_execution_failed", "signed_urls_printed": False}))
        return 2


if __name__ == "__main__":
    sys.exit(main())
