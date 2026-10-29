"""Teire's Python helper (plan S03, research context/09-build-research/generic/python.md).

One process per call, JSON on stdout, never executes the code it reads:
  inventory <dir>                                   manifests and lockfiles → dependency instances
  unpack-wheel <wheel> <dest> <sha256>              hash-checked, path-checked wheel extraction
  surface-diff <old_dir> <new_dir>                  griffe breaking changes (allow_inspection=False)
  docs <target_dir> <query>                         signatures, docstrings and README sections for a question
  resolve-refs <repo> <project_root> <names.json> <site_dir>...
                                                    jedi references to package symbols (safe mode)

Runs as `python -I teire_py.py …` with packaging 26.3, griffe 2.4.1 and jedi 0.20.1.
"""

from __future__ import annotations

import ast
import hashlib
import json
import os
import re
import stat
import sys
import tomllib
import zipfile
from pathlib import Path

from packaging.markers import InvalidMarker, Marker
from packaging.requirements import InvalidRequirement, Requirement
from packaging.utils import canonicalize_name

SKIP_DIRS = {".git", ".venv", "venv", "env", "node_modules", "__pycache__", ".tox", ".nox", "build", "dist", "site-packages", ".mypy_cache", ".pytest_cache"}
MAX_FILE_BYTES = 20 * 1024 * 1024
MAX_WHEEL_BYTES = 512 * 1024 * 1024
MAX_WHEEL_FILES = 50_000

# Markers are evaluated for the Linux CPython the sandbox runs for each project (the version the
# repo asks for, picked by the worker and passed to `inventory`; 3.12 when it names none), not for
# this machine.
MARKER_ENV = {
    "implementation_name": "cpython",
    "implementation_version": "3.12.0",
    "os_name": "posix",
    "platform_machine": "x86_64",
    "platform_python_implementation": "CPython",
    "platform_release": "",
    "platform_system": "Linux",
    "platform_version": "",
    "python_full_version": "3.12.0",
    "python_version": "3.12",
    "sys_platform": "linux",
    "extra": "",
}


def out(value: object) -> None:
    json.dump(value, sys.stdout)
    sys.stdout.write("\n")


def read_text(path: Path) -> str | None:
    try:
        if path.stat().st_size > MAX_FILE_BYTES:
            return None
        return path.read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError):
        return None


def read_toml(path: Path) -> dict | None:
    text = read_text(path)
    if text is None:
        return None
    try:
        return tomllib.loads(text)
    except tomllib.TOMLDecodeError:
        return None


def set_marker_python(version: str) -> None:
    MARKER_ENV["python_version"] = version
    MARKER_ENV["python_full_version"] = f"{version}.0"
    MARKER_ENV["implementation_version"] = f"{version}.0"


def marker_false(marker: str | None) -> bool:
    if not marker:
        return False
    try:
        return not Marker(marker).evaluate(MARKER_ENV)
    except (InvalidMarker, Exception):
        return False


# --- inventory -------------------------------------------------------------------------------


class Declared:
    def __init__(self, name: str, spec: str, scope: str, manifest: str, source: str = "registry", marker: str | None = None):
        self.name = canonicalize_name(name)
        self.spec = spec
        self.scope = scope
        self.manifest = manifest
        self.source = source
        self.marker = marker


def parse_requirement(line: str, scope: str, manifest: str) -> Declared | None:
    try:
        req = Requirement(line)
    except InvalidRequirement:
        return None
    source = "registry"
    if req.url:
        source = "git" if req.url.startswith("git+") else "path" if req.url.startswith("file:") else "url"
    return Declared(req.name, str(req.specifier) or (req.url or ""), scope, manifest, source, str(req.marker) if req.marker else None)


def requirements_file(path: Path, root: Path, scope: str, seen: set[Path], out_list: list[Declared], constraints: list[Declared]) -> None:
    """pip requirements syntax: `-r`/`-c` includes inside the repo, `--hash` continuations, `-e`, URLs."""
    if path in seen or not path.is_file():
        return
    seen.add(path)
    text = read_text(path) or ""
    rel = str(path.relative_to(root))
    logical: list[str] = []
    buf = ""
    for raw in text.splitlines():
        line = raw.split(" #", 1)[0].rstrip() if not raw.lstrip().startswith("#") else ""
        if line.endswith("\\"):
            buf += line[:-1] + " "
            continue
        logical.append(buf + line)
        buf = ""
    for line in logical:
        line = line.strip()
        if not line:
            continue
        if line.startswith(("-r ", "--requirement ", "-c ", "--constraint ")):
            target = line.split(None, 1)[1].strip()
            if re.match(r"^[a-z]+://", target):
                continue  # remote include: recorded nowhere, never followed
            include = (path.parent / target).resolve()
            try:
                include.relative_to(root.resolve())
            except ValueError:
                continue  # outside the repo: never followed
            constraint = line.startswith(("-c", "--constraint"))
            requirements_file(include, root, scope, seen, constraints if constraint else out_list, constraints)
            continue
        if line.startswith(("-e ", "--editable ")):
            target = line.split(None, 1)[1]
            name = re.search(r"#egg=([A-Za-z0-9_.\-]+)", target)
            if name:
                out_list.append(Declared(name.group(1), target, scope, rel, "git" if target.startswith("git+") else "path"))
            continue
        if line.startswith("-"):
            continue  # index options and flags
        line = re.sub(r"\s--hash[= ]\S+", "", line).strip()
        if line.startswith((".", "/")) or re.match(r"^[a-z]+://", line):
            continue
        dep = parse_requirement(line, scope, rel)
        if dep:
            out_list.append(dep)


def pep621(doc: dict, manifest: str) -> list[Declared]:
    deps: list[Declared] = []
    project = doc.get("project") or {}
    for line in project.get("dependencies") or []:
        d = parse_requirement(line, "prod", manifest)
        if d:
            deps.append(d)
    for lines in (project.get("optional-dependencies") or {}).values():
        for line in lines:
            d = parse_requirement(line, "optional", manifest)
            if d:
                deps.append(d)
    for lines in (doc.get("dependency-groups") or {}).values():
        for line in lines:
            if isinstance(line, str):
                d = parse_requirement(line, "dev", manifest)
                if d:
                    deps.append(d)
    return deps


def poetry_deps(doc: dict, manifest: str) -> list[Declared]:
    poetry = (doc.get("tool") or {}).get("poetry") or {}
    deps: list[Declared] = []

    def add(table: dict, scope: str) -> None:
        for name, spec in (table or {}).items():
            if name.lower() == "python":
                continue
            if isinstance(spec, dict):
                source = "git" if "git" in spec else "path" if "path" in spec else "url" if "url" in spec else "registry"
                deps.append(Declared(name, str(spec.get("version", "")), scope, manifest, source, spec.get("markers")))
            else:
                deps.append(Declared(name, str(spec), scope, manifest))

    add(poetry.get("dependencies"), "prod")
    add(poetry.get("dev-dependencies"), "dev")
    for group, table in (poetry.get("group") or {}).items():
        add((table or {}).get("dependencies"), "prod" if group == "main" else "dev")
    return deps


def pipfile_deps(doc: dict, manifest: str) -> list[Declared]:
    deps: list[Declared] = []
    for section, scope in (("packages", "prod"), ("dev-packages", "dev")):
        for name, spec in (doc.get(section) or {}).items():
            if isinstance(spec, dict):
                source = "git" if "git" in spec else "path" if "path" in spec else "registry"
                deps.append(Declared(name, str(spec.get("version", "")), scope, manifest, source, spec.get("markers")))
            else:
                deps.append(Declared(name, "" if spec == "*" else str(spec), scope, manifest))
    return deps


def uv_dev_only(packages: list[dict]) -> set[str]:
    """Locked packages reachable only through dependency groups (`dev-dependencies`), never from the
    project's own dependencies or extras: what pytest pulls in is dev, not production."""
    graph = {canonicalize_name(p["name"]): [canonicalize_name(d["name"]) for d in p.get("dependencies", []) if d.get("name")] for p in packages}
    roots = [p for p in packages if {"editable", "virtual"} & set((p.get("source") or {}).keys())]

    def reach(start: list[str]) -> set[str]:
        seen: set[str] = set()
        stack = list(start)
        while stack:
            name = stack.pop()
            if name in seen:
                continue
            seen.add(name)
            stack += graph.get(name, [])
        return seen

    prod_start = [canonicalize_name(d["name"]) for r in roots for d in r.get("dependencies", []) if d.get("name")]
    prod_start += [canonicalize_name(d["name"]) for r in roots for deps in (r.get("optional-dependencies") or {}).values() for d in deps if d.get("name")]
    dev_start = [canonicalize_name(d["name"]) for r in roots for deps in (r.get("dev-dependencies") or {}).values() for d in deps if d.get("name")]
    return reach(dev_start) - reach(prod_start)


def locked_versions(root: Path, project_dir: Path) -> tuple[str | None, str | None, str | None, dict[str, str], set[str]]:
    """(manager, lockfile, lockfile version, name → version, dev-only names) from the nearest lock,
    walking up for uv workspaces."""
    for directory in [project_dir, *project_dir.parents]:
        if directory != root and root not in directory.parents:
            break
        uv = directory / "uv.lock"
        if uv.is_file():
            doc = read_toml(uv) or {}
            # Project and workspace members (`editable`/`virtual` sources) are the repo's own code.
            versions = {
                canonicalize_name(p["name"]): p.get("version", "")
                for p in doc.get("package", [])
                if p.get("version") and not ({"editable", "virtual"} & set((p.get("source") or {}).keys()))
            }
            return "uv", str(uv.relative_to(root)), f"{doc.get('version', '?')}.{doc.get('revision', 0)}", versions, uv_dev_only(doc.get("package", []))
        if directory != project_dir:
            continue
        poetry = directory / "poetry.lock"
        if poetry.is_file():
            doc = read_toml(poetry) or {}
            versions = {canonicalize_name(p["name"]): p.get("version", "") for p in doc.get("package", [])}
            # Poetry 2 locks list each package's groups; older locks carry none (scope stays prod).
            dev = {canonicalize_name(p["name"]) for p in doc.get("package", []) if p.get("groups") and "main" not in p["groups"]}
            return "poetry", str(poetry.relative_to(root)), str((doc.get("metadata") or {}).get("lock-version", "")), versions, dev
        pipfile = directory / "Pipfile.lock"
        if pipfile.is_file():
            try:
                doc = json.loads(read_text(pipfile) or "{}")
            except json.JSONDecodeError:
                doc = {}
            versions: dict[str, str] = {}
            dev = {canonicalize_name(n) for n in (doc.get("develop") or {})} - {canonicalize_name(n) for n in (doc.get("default") or {})}
            for section in ("default", "develop"):
                for name, entry in (doc.get(section) or {}).items():
                    version = str(entry.get("version", "")).lstrip("=")
                    if version:
                        versions[canonicalize_name(name)] = version
            return "pipenv", str(pipfile.relative_to(root)), str(((doc.get("_meta") or {}).get("pipfile-spec", ""))), versions, dev
        for lock in sorted(directory.glob("pylock*.toml")):
            doc = read_toml(lock) or {}
            versions = {canonicalize_name(p["name"]): p.get("version", "") for p in doc.get("packages", []) if p.get("version")}
            return "pylock", str(lock.relative_to(root)), str(doc.get("lock-version", "")), versions, set()
    return None, None, None, {}, set()


def pinned(spec: str) -> str | None:
    m = re.fullmatch(r"===?\s*([A-Za-z0-9_.!+\-]+)", spec.strip())
    return m.group(1) if m else None


def cmd_inventory(root_arg: str, pythons_json: str = "{}") -> None:
    root = Path(root_arg).resolve()
    # {"<project root>": "3.11"}: the Python each project runs on in the sandbox.
    pythons = json.loads(pythons_json) if pythons_json else {}
    projects: list[dict] = []
    roots: set[Path] = set()
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if d not in SKIP_DIRS and not d.startswith(".")]
        names = set(filenames)
        if names & {"pyproject.toml", "Pipfile"} or any(re.fullmatch(r"requirements.*\.(txt|in)", f) for f in names):
            roots.add(Path(dirpath))
    for project_dir in sorted(roots):
        rel = str(project_dir.relative_to(root)) or "."
        set_marker_python(str(pythons.get(rel, "3.12")))
        declared: list[Declared] = []
        constraints: list[Declared] = []
        hint = None
        pyproject = project_dir / "pyproject.toml"
        doc = read_toml(pyproject) if pyproject.is_file() else None
        manifest = str(pyproject.relative_to(root)) if doc is not None else None
        if doc is not None:
            declared += pep621(doc, manifest)
            declared += poetry_deps(doc, manifest)
        pipfile = project_dir / "Pipfile"
        if pipfile.is_file():
            pdoc = read_toml(pipfile) or {}
            declared += pipfile_deps(pdoc, str(pipfile.relative_to(root)))
            manifest = manifest or str(pipfile.relative_to(root))
        req_files = sorted(p for p in project_dir.iterdir() if re.fullmatch(r"requirements.*\.(txt|in)", p.name))
        compiled = {p.with_suffix(".txt") for p in req_files if p.suffix == ".in"}
        seen: set[Path] = set()
        for req in req_files:
            text = read_text(req) or ""
            if "autogenerated by pip-compile" in text:
                hint = "pip-tools"
            elif "autogenerated by uv" in text:
                hint = hint or "uv-pip"
            scope = "dev" if re.search(r"dev|test|lint", req.name) else "prod"
            target: list[Declared] = []
            requirements_file(req, root, scope, seen, target, constraints)
            # A compiled .txt pins what its .in declares: the .in is the manifest, the .txt the lock.
            if req in compiled:
                continue
            declared += target
            manifest = manifest or str(req.relative_to(root))
        manager, lockfile, lock_version, versions, dev_only = locked_versions(root, project_dir)
        if not manager and compiled:
            manager, lockfile = "pip-tools", str(sorted(compiled)[0].relative_to(root))
            lock_doc: list[Declared] = []
            requirements_file(sorted(compiled)[0], root, "prod", set(), lock_doc, [])
            versions = {d.name: pinned(d.spec) or "" for d in lock_doc if pinned(d.spec)}
        if not manager and req_files:
            manager = hint or "pip"
        if not declared and not versions:
            continue
        instances: list[dict] = []
        direct_names: set[str] = set()
        for d in declared:
            direct_names.add(d.name)
            version = versions.get(d.name) or (pinned(d.spec) if not lockfile else None)
            if d.source != "registry":
                version = None
            entry = {
                "ecosystem": "pypi",
                "name": d.name,
                "version": version,
                "declaredRange": d.spec,
                "direct": True,
                "scope": d.scope,
                "workspace": rel,
                "manifestPath": d.manifest,
                "source": d.source,
                "resolvedBy": "lockfile" if versions.get(d.name) else "unresolved",
            }
            if lockfile:
                entry["lockfilePath"] = lockfile
            if version and not versions.get(d.name):
                entry["resolvedBy"] = "lockfile"  # an exact == pin in a requirements file is the lock
            if version is None:
                entry["unresolvedReason"] = "not a registry dependency" if d.source != "registry" else ("not in the lockfile" if lockfile else "no lockfile")
            if marker_false(d.marker):
                entry["environment"] = {"markers": d.marker}
                entry["unresolvedReason"] = f"marker false on Linux CPython {MARKER_ENV['python_version']}: {d.marker}"
            instances.append(entry)
        for name, version in sorted(versions.items()):
            if name in direct_names or not version:
                continue
            instances.append({
                "ecosystem": "pypi",
                "name": name,
                "version": version,
                "direct": False,
                "scope": "dev" if name in dev_only else "prod",
                "workspace": rel,
                "manifestPath": lockfile,
                "lockfilePath": lockfile,
                "source": "registry",
                "resolvedBy": "lockfile",
            })
        projects.append({
            "root": rel,
            "manager": manager or "unknown",
            "lockfile": lockfile,
            "lockfileVersion": lock_version,
            "manifest": manifest,
            "instances": instances,
        })
    out({"projects": projects})


# --- wheels ----------------------------------------------------------------------------------


def cmd_unpack_wheel(wheel: str, dest: str, sha256: str) -> None:
    """A wheel is a zip; nothing in it runs. Refuse links, absolute paths and `..`; cap size and count."""
    data = Path(wheel).read_bytes()
    digest = hashlib.sha256(data).hexdigest()
    if sha256 and digest != sha256:
        out({"ok": False, "error": "sha256 mismatch"})
        return
    target = Path(dest).resolve()
    target.mkdir(parents=True, exist_ok=True)
    total = 0
    skipped = 0
    with zipfile.ZipFile(wheel) as zf:
        infos = zf.infolist()
        if len(infos) > MAX_WHEEL_FILES:
            out({"ok": False, "error": "too many files"})
            return
        for info in infos:
            mode = (info.external_attr >> 16) & 0o170000
            name = info.filename
            if mode == stat.S_IFLNK or name.startswith("/") or ".." in Path(name).parts or info.is_dir():
                skipped += 0 if info.is_dir() else 1
                continue
            path = (target / name).resolve()
            if target not in path.parents:
                skipped += 1
                continue
            total += info.file_size
            if total > MAX_WHEEL_BYTES:
                out({"ok": False, "error": "too large"})
                return
            path.parent.mkdir(parents=True, exist_ok=True)
            with zf.open(info) as src, open(path, "wb") as dst:
                dst.write(src.read())
    tops = top_level(target)
    out({"ok": True, "sha256": digest, "bytes": total, "skipped": skipped, "topLevel": tops})


def top_level(directory: Path) -> list[str]:
    """Import names a wheel provides: packages (with __init__.py, or namespace dirs holding one) and modules."""
    names: list[str] = []
    for entry in sorted(directory.iterdir()):
        if entry.name.endswith((".dist-info", ".data")) or entry.name.startswith(("_", ".")) and entry.name != "__init__.py":
            continue
        if entry.is_dir():
            if (entry / "__init__.py").exists() or (entry / "__init__.pyi").exists():
                names.append(entry.name)
            else:
                for child in sorted(entry.iterdir()):
                    if child.is_dir() and ((child / "__init__.py").exists() or (child / "__init__.pyi").exists()):
                        names.append(f"{entry.name}.{child.name}")
        elif entry.suffix in (".py", ".pyi") and entry.stem != "__init__":
            names.append(entry.stem)
    return names


# --- surface diff ----------------------------------------------------------------------------

KIND_MAP = {"class": "class", "function": "function", "attribute": "property", "module": "module", "alias": "variable", "type alias": "type", "type_alias": "type"}


def safe(read, default=None):
    """An alias to something outside the wheel (stdlib, another package) cannot be resolved offline;
    reading through it raises instead of returning, so every read through an object is guarded."""
    try:
        return read()
    except Exception:
        return default


def cmd_surface_diff(old_dir: str, new_dir: str) -> None:
    import griffe

    old_tops = top_level(Path(old_dir))
    new_tops = set(top_level(Path(new_dir)))
    breakages = []
    notes = []
    counts = {}
    # Modules griffe could not read, or stopped comparing part-way: never reported as "no changes".
    partial: list[str] = []
    for name in old_tops:
        if name not in new_tops:
            breakages.append({"kind": "MODULE_REMOVED", "path": name, "canonical": name, "old": None, "new": None, "line": None, "memberKind": "module"})
            continue
        try:
            old = griffe.load(name, search_paths=[old_dir], allow_inspection=False, try_relative_path=False, resolve_aliases=False)
            new = griffe.load(name, search_paths=[new_dir], allow_inspection=False, try_relative_path=False, resolve_aliases=False)
        except Exception as error:  # a package griffe cannot read is reported, never "no changes"
            notes.append(f"{name}: {type(error).__name__}: {error}")
            partial.append(name)
            continue
        counts[name] = {"old": sum(1 for _ in iter_objects(old)), "new": sum(1 for _ in iter_objects(new))}
        found = griffe.find_breaking_changes(old, new)
        while True:
            try:
                b = next(found)
            except StopIteration:
                break
            except Exception as error:  # the generator is spent: what came before stands, the rest is unknown
                notes.append(f"{name}: comparison stopped: {type(error).__name__}: {error}")
                partial.append(name)
                break
            obj = b.obj
            # jedi resolves a name to its final definition, so the join key follows re-exports to
            # the end (`openai.ChatCompletion` → `openai.api_resources.chat_completion.ChatCompletion`);
            # an alias leaving the wheel (stdlib, another package) keeps its first hop.
            canonical = obj.path
            if safe(lambda: obj.is_alias, False):
                canonical = safe(lambda: obj.final_target.path) or safe(lambda: obj.target_path) or obj.path
            kind = safe(lambda: obj.kind)
            breakages.append({
                "kind": b.kind.name,
                "path": obj.path,
                "canonical": canonical,
                "old": None if b.old_value is None else safe(lambda: str(b.old_value)[:600]),
                "new": None if b.new_value is None else safe(lambda: str(b.new_value)[:600]),
                "line": safe(lambda: obj.lineno),
                "memberKind": KIND_MAP.get(getattr(kind, "value", str(kind)), "unknown"),
            })
    out({"breakages": breakages, "notes": notes, "counts": counts, "modules": old_tops, "partial": partial})


def iter_objects(obj, depth=0):
    yield obj
    if depth > 8:
        return
    try:
        members = obj.members.values()
    except Exception:
        return
    for m in members:
        if getattr(m, "is_alias", False):
            continue
        yield from iter_objects(m, depth + 1)


# --- references (jedi) ------------------------------------------------------------------------


def calls_by_position(tree: ast.AST) -> dict[tuple[int, int], ast.Call]:
    """(line, column of the called name) → the Call node, for keyword and argument checks."""
    index: dict[tuple[int, int], ast.Call] = {}
    for node in ast.walk(tree):
        if isinstance(node, ast.Call):
            func = node.func
            if isinstance(func, ast.Attribute):
                end = func.end_col_offset or 0
                index[(func.end_lineno or func.lineno, end - len(func.attr))] = node
            elif isinstance(func, ast.Name):
                index[(func.lineno, func.col_offset)] = node
    return index


def cmd_resolve_refs(repo: str, project_root: str, names_file: str, *site_dirs: str) -> None:
    import jedi

    spec = json.loads(Path(names_file).read_text())
    names = set(spec["names"])
    prefixes = tuple(spec["packages"])
    root = Path(repo).resolve()
    base = (root / project_root).resolve() if project_root != "." else root
    project = jedi.Project(str(base), added_sys_path=list(site_dirs), load_unsafe_extensions=False, smart_sys_path=False)
    word = re.compile(r"\b(" + "|".join(re.escape(n) for n in sorted(names)) + r")\b") if names else None
    imports = re.compile(r"^\s*(from|import)\s+(" + "|".join(re.escape(p) for p in prefixes) + r")\b", re.M) if prefixes else None
    hits = []
    unresolved = 0
    unresolved_at: list[str] = []
    scanned = 0
    skipped = 0
    for dirpath, dirnames, filenames in os.walk(base):
        dirnames[:] = [d for d in dirnames if d not in SKIP_DIRS and not d.startswith(".")]
        for filename in filenames:
            if not filename.endswith((".py", ".pyi")):
                continue
            path = Path(dirpath) / filename
            text = read_text(path)
            if text is None:
                skipped += 1
                continue
            scanned += 1
            if not ((word and word.search(text)) or (imports and imports.search(text))):
                continue
            try:
                tree = ast.parse(text)
            except SyntaxError:
                skipped += 1
                continue
            calls = calls_by_position(tree)
            script = jedi.Script(text, path=str(path), project=project)
            rel = str(path.relative_to(root))
            lines = text.splitlines()
            for name in script.get_names(all_scopes=True, references=True, definitions=True):
                if name.name not in names:
                    continue
                # Of the definitions, only imports matter: `from pkg import Removed` fails at import time.
                if name.is_definition() and not re.match(r"^\s*(from|import)\b", lines[name.line - 1] if name.line - 1 < len(lines) else ""):
                    continue
                try:
                    defs = script.goto(name.line, name.column, follow_imports=True)
                except Exception:
                    defs = []
                full = sorted({d.full_name for d in defs if d.full_name})
                if not full:
                    # A local name (a parameter, a variable) is the repo's own; only a name with no
                    # definition at all, in a file that imports the package, could be the package's.
                    if defs or not (imports and imports.search(text)):
                        continue
                    unresolved += 1
                    if len(unresolved_at) < 20:
                        unresolved_at.append(f"{path.relative_to(root)}:{name.line} {name.name}")
                    continue
                if not any(f == p or f.startswith(p + ".") for f in full for p in prefixes):
                    continue  # resolves to the repo's own code or another library
                call = calls.get((name.line, name.column))
                hit = {
                    "file": rel,
                    "line": name.line,
                    "column": name.column + 1,
                    "name": name.name,
                    "fullNames": full,
                    "snippet": (lines[name.line - 1] if name.line - 1 < len(lines) else "").strip()[:200],
                    "kind": "import" if name.is_definition() or re.match(r"^\s*(from|import)\b", lines[name.line - 1]) else "call" if call else "property",
                }
                if call is not None:
                    hit["argCount"] = len(call.args)
                    hit["kwargs"] = [k.arg for k in call.keywords if k.arg]
                hits.append(hit)
    out({"hits": hits, "unresolved": unresolved, "unresolvedAt": unresolved_at, "filesScanned": scanned, "filesSkipped": skipped})


# --- docs (the agent's lookup_docs, R21.5) --------------------------------------------------------
def _render_signature(obj) -> "str | None":
    """A function's or class's signature as the target version declares it, read statically."""
    try:
        kind = obj.kind.value
        target = obj
        if kind == "class":
            target = obj.members.get("__init__")
            if target is None or getattr(target, "is_alias", False):
                return f"class {obj.name}"
        elif kind == "attribute":
            annotation = f": {obj.annotation}" if obj.annotation is not None else ""
            value = f" = {obj.value}" if obj.value is not None else ""
            return f"{obj.name}{annotation}{value}"
        elif kind != "function":
            return None
        params = []
        star = False
        for p in target.parameters:
            pk = p.kind.value
            if pk == "keyword-only" and not star:
                params.append("*")
                star = True
            text = p.name
            if pk == "variadic positional":
                text, star = f"*{text}", True
            elif pk == "variadic keyword":
                text = f"**{text}"
            if p.annotation is not None:
                text += f": {p.annotation}"
            if p.default is not None:
                text += f" = {p.default}"
            params.append(text)
            if pk == "positional-only" and p is list(target.parameters)[-1]:
                params.append("/")
        if kind == "class":
            return f"class {obj.name}({', '.join(x for x in params if x != 'self')})"
        returns = f" -> {target.returns}" if getattr(target, "returns", None) is not None else ""
        return f"def {obj.name}({', '.join(params)}){returns}"
    except Exception:
        return None


def _readme_sections(directory: Path, tokens: list[str]) -> list[str]:
    """The README's sections that name what was asked, from the wheel's own METADATA description."""
    sections: list[str] = []
    for info in directory.glob("*.dist-info/METADATA"):
        text = info.read_text("utf-8", errors="replace")
        body = text.split("\n\n", 1)[1] if "\n\n" in text else ""
        parts = re.split(r"(?m)^(?=#{1,4} )", body)
        for part in parts:
            if any(t.split(".")[-1] in part for t in tokens):
                sections.append(part.strip()[:1500])
            if len(sections) >= 3:
                break
    return sections


def cmd_docs(target_dir: str, query: str) -> None:
    """The target version's own documentation for one question: the objects the query names, each with
    its signature and docstring (griffe, statically, never importing the package), and the README
    sections that mention them."""
    import griffe

    root = Path(target_dir)
    tokens = [t for t in re.findall(r"[A-Za-z_][A-Za-z0-9_.]*", query) if len(t) > 2]
    scored = []
    unread: list[str] = []
    for name in top_level(root):
        try:
            module = griffe.load(name, search_paths=[target_dir], allow_inspection=False, try_relative_path=False, resolve_aliases=False)
        except Exception as error:
            unread.append(f"{name}: {type(error).__name__}")
            continue
        for obj in iter_objects(module):
            path = obj.path
            last = path.rsplit(".", 1)[-1]
            score = 0
            for t in tokens:
                if path == t or path.endswith("." + t):
                    score += 3
                elif last == t.rsplit(".", 1)[-1]:
                    score += 2
            if score and not last.startswith("_"):
                scored.append((score, path, obj))
    scored.sort(key=lambda m: (-m[0], len(m[1])))
    objects = []
    seen = set()
    for _, path, obj in scored:
        if path in seen:
            continue
        seen.add(path)
        doc = obj.docstring.value if getattr(obj, "docstring", None) is not None else None
        objects.append({"path": path, "kind": obj.kind.value, "signature": _render_signature(obj), "docstring": (doc or "")[:1500] or None})
        if len(objects) >= 6:
            break
    out({"objects": objects, "readme": _readme_sections(root, tokens), "unread": unread})


def main(argv: list[str]) -> None:
    commands = {
        "inventory": cmd_inventory,
        "unpack-wheel": cmd_unpack_wheel,
        "surface-diff": cmd_surface_diff,
        "resolve-refs": cmd_resolve_refs,
        "docs": cmd_docs,
    }
    if len(argv) < 2 or argv[1] not in commands:
        sys.stderr.write(f"usage: teire_py.py {{{','.join(commands)}}} …\n")
        sys.exit(2)
    commands[argv[1]](*argv[2:])


if __name__ == "__main__":
    main(sys.argv)
