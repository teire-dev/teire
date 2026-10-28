#!/usr/bin/env python3
"""Teire's resolver service (plan S14.1, D92-D93): runs dependabot-core's updater for the worker.

The worker sends a job built by `@teire/engine/resolver` with the repository and commit it scanned.
This service downloads that commit, runs `dependabot update` on the gVisor daemon with pinned,
attested images, and returns the run's events (stdout JSON Lines) for the worker to read. It runs
one job at a time: until per-job firewall rules exist, two jobs' proxies could reach each other's
fake API (plan, Isolation item 8).

Standard library only (no packages to install on a production host). Listens on the Coolify
network's gateway address; every request needs the shared secret.

  POST /jobs       {"job": {...}, "repo": "owner/name", "commit": "<sha>", "token"?: str, "timeoutSec"?: int,
                    "overlay"?: [{"path": str, "content": str}]}
                   -> 202 {"id"}
  GET  /jobs/<id>  -> {"state": queued|running|done|failed|timeout, ...result}
  GET  /health     -> {"ok": true, "queued": n, "cli": "..."}
"""

import hashlib
import hmac
import json
import os
import queue
import re
import shutil
import signal
import subprocess
import tarfile
import threading
import time
import urllib.request
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

SECRET = os.environ["TEIRE_RESOLVER_SECRET"].encode()
BIND = os.environ.get("TEIRE_RESOLVER_BIND", "10.0.1.1:8787")
WORK = Path(os.environ.get("TEIRE_RESOLVER_WORK", "/var/lib/teire-resolver/jobs"))
IMAGES = json.loads(Path(os.environ.get("TEIRE_RESOLVER_IMAGES", "/etc/teire-resolver/images.json")).read_text())
DOCKER_HOST = "unix:///run/docker-resolver.sock"
FAKE_API_HOST = "192.168.240.1"
FAKE_API_PORT = "47000"
MAX_TARBALL = 512 * 1024 * 1024
MAX_EVENTS = 128 * 1024 * 1024
CLI_TIMEOUT = 1200  # the CLI's own --timeout (plan: 20 minutes)
GRACE = 300  # then the process group is killed
KEEP_RESULTS = 2 * 3600

REPO = re.compile(r"^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$")
SHA = re.compile(r"^[0-9a-f]{40}$")

jobs: dict[str, dict] = {}
pending: "queue.Queue[str]" = queue.Queue()
lock = threading.Lock()


def log(message: str) -> None:
    print(time.strftime("%Y-%m-%dT%H:%M:%S"), message, flush=True)


def resolver_docker(*args: str) -> str:
    return subprocess.run(
        ["docker", "-H", DOCKER_HOST, *args], capture_output=True, text=True, timeout=120
    ).stdout


def clean_daemon() -> None:
    """Every container and network a job left on the resolver daemon (only jobs run there)."""
    ids = resolver_docker("ps", "-aq").split()
    if ids:
        resolver_docker("rm", "-f", *ids)
    resolver_docker("network", "prune", "-f")


def download(repo: str, commit: str, token: str | None, dest: Path) -> str:
    """The commit's tarball, its sha256 (the job is bound to it, D102), extracted into dest."""
    request = urllib.request.Request(f"https://api.github.com/repos/{repo}/tarball/{commit}")
    request.add_header("User-Agent", "teire-resolver")
    if token:
        request.add_header("Authorization", f"token {token}")
    tarball = dest.parent / "repo.tar.gz"
    digest = hashlib.sha256()
    size = 0
    with urllib.request.urlopen(request, timeout=120) as response, open(tarball, "wb") as out:
        while chunk := response.read(1 << 20):
            size += len(chunk)
            if size > MAX_TARBALL:
                raise ValueError("repository tarball is larger than 512 MB")
            digest.update(chunk)
            out.write(chunk)
    dest.mkdir()
    with tarfile.open(tarball) as archive:
        members = []
        for member in archive.getmembers():
            parts = member.name.split("/", 1)
            if len(parts) < 2 or not parts[1]:
                continue
            member.name = parts[1]
            members.append(member)
        # The "data" filter refuses absolute paths, ".." and links that leave the folder.
        archive.extractall(dest, members=members, filter="data")
    tarball.unlink()
    return digest.hexdigest()


PULL_FAILED = re.compile(r"pull|manifest unknown|not found|attestation|denied|unauthorized", re.I)


def mirror_of(ref: str) -> str | None:
    """`ghcr.io/dependabot/<name>@sha256:…` in Teire's mirror, if one is configured."""
    mirror = IMAGES.get("mirror")
    if not mirror or "@" not in ref:
        return None
    repo, digest = ref.split("@", 1)
    return f"{mirror}/{repo.rsplit('/', 1)[1]}@{digest}"


def cli(folder: Path, job_file: Path, repo_dir: Path, timeout: int, env: dict, updater: str, proxy: str):
    """One `dependabot update` run in its own process group; (state, exit code)."""
    command = [
        "dependabot", "update", "-f", str(job_file), "--local", str(repo_dir),
        "--timeout", f"{timeout}s", "--updater-image", updater, "--proxy-image", proxy,
    ]
    with open(folder / "stdout", "wb") as out, open(folder / "stderr", "wb") as err:
        process = subprocess.Popen(command, stdout=out, stderr=err, env=env, cwd=folder, start_new_session=True)
        try:
            return "done", process.wait(timeout=timeout + GRACE)
        except subprocess.TimeoutExpired:
            os.killpg(process.pid, signal.SIGKILL)
            process.wait()
            return "timeout", None


def run(job_id: str) -> None:
    with lock:
        spec = jobs[job_id]
        spec["state"] = "running"
    started = time.monotonic()
    folder = WORK / job_id
    folder.mkdir(parents=True)
    result: dict = {}
    try:
        repo_dir = folder / "repo"
        result["tarballSha256"] = download(spec["repo"], spec["commit"], spec.get("token"), repo_dir)
        # Teire's pre-steps (D104): files written over the checkout before the updater reads it.
        for item in spec.get("overlay") or []:
            target = repo_dir / item["path"]
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(item["content"])
        job_file = folder / "job.yaml"
        job_file.write_text(json.dumps(spec["job"]))  # JSON is YAML
        manager = spec["job"]["job"]["package-manager"]
        timeout = min(int(spec.get("timeoutSec") or CLI_TIMEOUT), CLI_TIMEOUT)
        env = {
            "PATH": "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
            "HOME": "/root",
            "DOCKER_HOST": DOCKER_HOST,
            "FAKE_API_HOST": FAKE_API_HOST,
            "FAKE_API_PORT": FAKE_API_PORT,
        }
        if spec.get("token"):
            # A per-run token for one repository with contents:read (D106): release notes, Go metadata.
            env["LOCAL_GITHUB_ACCESS_TOKEN"] = spec["token"]
        updater, proxy = IMAGES["updaters"][manager], IMAGES["proxy"]
        state, result["exitCode"] = cli(folder, job_file, repo_dir, timeout, env, updater, proxy)
        stderr = (folder / "stderr").read_bytes()[-20000:].decode("utf-8", "replace")
        # Upstream images unreachable or deleted (the run never started): the same digests from
        # Teire's mirror, whose attestations the CLI verifies the same way (R-P27).
        if (
            state == "done"
            and result["exitCode"] != 0
            and not (folder / "stdout").stat().st_size
            and PULL_FAILED.search(stderr)
            and mirror_of(updater)
        ):
            log(f"job {job_id}: upstream images failed; retrying from the mirror")
            clean_daemon()
            state, result["exitCode"] = cli(
                folder, job_file, repo_dir, timeout, env, mirror_of(updater), mirror_of(proxy)
            )
            result["mirror"] = True
        result["events"] = (folder / "stdout").read_bytes()[:MAX_EVENTS].decode("utf-8", "replace")
        result["stderrTail"] = (folder / "stderr").read_bytes()[-20000:].decode("utf-8", "replace")
    except Exception as error:  # noqa: BLE001 - every failure becomes the job's named state
        state = "failed"
        result["error"] = f"{type(error).__name__}: {error}"[:2000]
    finally:
        clean_daemon()
        shutil.rmtree(folder, ignore_errors=True)
    result["ms"] = int((time.monotonic() - started) * 1000)
    with lock:
        spec.pop("token", None)
        spec.pop("job", None)
        spec.pop("overlay", None)
        spec.update(result, state=state, finishedAt=time.time())
    log(f"job {job_id} {spec['repo']}@{spec['commit'][:7]} {state} exit={result.get('exitCode')} {result['ms']}ms")


def worker() -> None:
    while True:
        job_id = pending.get()
        try:
            run(job_id)
        except Exception as error:  # noqa: BLE001
            log(f"job {job_id} crashed: {error}")
        with lock:
            cutoff = time.time() - KEEP_RESULTS
            for key in [k for k, v in jobs.items() if v.get("finishedAt", time.time()) < cutoff]:
                del jobs[key]


def validate(body: dict) -> str | None:
    repo, commit, job = body.get("repo"), body.get("commit"), body.get("job")
    if not isinstance(repo, str) or not REPO.match(repo):
        return "repo must be owner/name"
    if not isinstance(commit, str) or not SHA.match(commit):
        return "commit must be a full sha"
    if not isinstance(job, dict) or not isinstance(job.get("job"), dict):
        return "job must be {job: {...}}"
    inner = job["job"]
    if inner.get("package-manager") not in IMAGES["updaters"]:
        return f"no pinned updater for {inner.get('package-manager')!r}"
    source = inner.get("source") or {}
    # The job is bound to the commit and repository it was sent for (D102).
    if source.get("repo") != repo or source.get("commit") != commit:
        return "job source must name the same repo and commit"
    overlay = body.get("overlay")
    if overlay is not None:
        if not isinstance(overlay, list) or len(overlay) > 20:
            return "overlay must be a list of at most 20 files"
        for item in overlay:
            path = item.get("path") if isinstance(item, dict) else None
            # Relative, inside the checkout, never .git: the same rule as the paths results return.
            if (
                not isinstance(path, str)
                or not isinstance(item.get("content"), str)
                or path.startswith("/")
                or "\x00" in path
                or any(part in ("", ".", "..", ".git") for part in path.split("/"))
                or len(item["content"]) > 1_000_000
            ):
                return "overlay paths must be relative, inside the checkout and outside .git"
    token = body.get("token")
    if token is not None and (not isinstance(token, str) or not re.match(r"^gh[sopu]_[A-Za-z0-9]+$", token)):
        return "token must be a GitHub token"
    return None


class Handler(BaseHTTPRequestHandler):
    server_version = "teire-resolver"

    def log_message(self, fmt: str, *args) -> None:  # requests are logged per job instead
        pass

    def reply(self, status: int, value: dict) -> None:
        data = json.dumps(value).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def authorised(self) -> bool:
        given = self.headers.get("Authorization", "").removeprefix("Bearer ").encode()
        if hmac.compare_digest(given, SECRET):
            return True
        self.reply(401, {"error": "unauthorised"})
        return False

    def do_GET(self) -> None:  # noqa: N802
        if not self.authorised():
            return
        if self.path == "/health":
            self.reply(200, {"ok": True, "queued": pending.qsize(), "cli": IMAGES.get("cli")})
            return
        match = re.fullmatch(r"/jobs/([0-9a-f-]{36})", self.path)
        with lock:
            spec = jobs.get(match.group(1)) if match else None
            value = {k: v for k, v in spec.items() if k not in ("token", "job", "overlay")} if spec else None
        self.reply(200 if value else 404, value or {"error": "no such job"})

    def do_POST(self) -> None:  # noqa: N802
        if not self.authorised():
            return
        if self.path != "/jobs":
            self.reply(404, {"error": "not found"})
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if length > 4 * 1024 * 1024:
                raise ValueError("body too large")
            body = json.loads(self.rfile.read(length))
        except (ValueError, json.JSONDecodeError) as error:
            self.reply(400, {"error": str(error)})
            return
        problem = validate(body)
        if problem:
            self.reply(400, {"error": problem})
            return
        job_id = str(uuid.uuid4())
        with lock:
            jobs[job_id] = {
                "id": job_id,
                "state": "queued",
                "repo": body["repo"],
                "commit": body["commit"],
                "job": body["job"],
                "overlay": body.get("overlay"),
                "token": body.get("token"),
                "timeoutSec": body.get("timeoutSec"),
                "queuedAt": time.time(),
            }
        pending.put(job_id)
        self.reply(202, {"id": job_id})


def main() -> None:
    WORK.mkdir(parents=True, exist_ok=True)
    for stale in WORK.iterdir():  # a restart drops unfinished jobs; the worker retries them
        shutil.rmtree(stale, ignore_errors=True)
    clean_daemon()
    threading.Thread(target=worker, daemon=True).start()
    host, port = BIND.rsplit(":", 1)
    log(f"listening on {BIND}")
    ThreadingHTTPServer((host, int(port)), Handler).serve_forever()


if __name__ == "__main__":
    main()
