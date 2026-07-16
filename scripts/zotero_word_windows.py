# -*- coding: utf-8 -*-
import argparse
import configparser
import json
import os
import re
import shutil
import sqlite3
import subprocess
import sys
import time
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
import zipfile
from pathlib import Path
from typing import Any, Dict, List, Optional


ADDON_ID = "codex-word-bridge@local.codex"
BASE_URL = "http://127.0.0.1:23119"
DEFAULT_STYLE = "APA Style 7th edition"


if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")


def skill_root() -> Path:
    return Path(__file__).resolve().parents[1]


def locate_profile() -> Path:
    support = Path(os.environ["APPDATA"]) / "Zotero" / "Zotero"
    parser = configparser.ConfigParser()
    parser.read(str(support / "profiles.ini"), encoding="utf-8")
    fallback = None
    for section in parser.sections():
        if not section.startswith("Profile"):
            continue
        raw = parser.get(section, "Path", fallback="")
        if not raw:
            continue
        profile = support / raw if parser.getboolean(section, "IsRelative", fallback=True) else Path(raw)
        if parser.getboolean(section, "Default", fallback=False):
            return profile
        fallback = fallback or profile
    if fallback:
        return fallback
    raise RuntimeError("Could not locate Zotero profile")


def zotero_data_dir(profile: Path) -> Path:
    prefs = (profile / "prefs.js").read_text(encoding="utf-8", errors="ignore")
    use_data_dir = 'user_pref("extensions.zotero.useDataDir", true)' in prefs
    match = re.search(r'user_pref\("extensions\.zotero\.dataDir",\s*"((?:[^"\\]|\\.)*)"\);', prefs)
    if use_data_dir and match:
        return Path(bytes(match.group(1), "utf-8").decode("unicode_escape"))
    return profile


def http_json(path: str, method: str = "GET", payload: Optional[Dict[str, Any]] = None, timeout: float = 10) -> Dict[str, Any]:
    data = None
    headers = {"Accept": "application/json"}
    if payload is not None:
        data = json.dumps(payload).encode("utf-8")
        headers["Content-Type"] = "application/json"
    request = urllib.request.Request(BASE_URL + path, data=data, headers=headers, method=method)
    with urllib.request.urlopen(request, timeout=timeout) as response:
        raw = response.read().decode("utf-8")
    return json.loads(raw) if raw else {}


def quote_params(params: Dict[str, Any]) -> str:
    return urllib.parse.urlencode({key: value for key, value in params.items() if value is not None and value != ""})


def render_bridge(text: str) -> str:
    text = text.replace('const WORD_AGENT = "MacWord16";', 'const WORD_AGENT = "WinWord";')
    text = text.replace("const WORD_DOCUMENT_ID = __CODEX_WORD_DOCUMENT_ID__;", "const WORD_DOCUMENT_ID = null;")
    text = text.replace("const TEMPLATE_VERSION = 2;", "const TEMPLATE_VERSION = 1;")
    text = text.replace(
        'return getWindowURL(win).includes("quickFormat.xhtml");',
        'const url = getWindowURL(win);\n    return url.includes("quickFormat.xhtml") || url.includes("citationDialog.xhtml");',
    )
    return text


def install_bridge(register: bool) -> Dict[str, Any]:
    profile = locate_profile()
    source = skill_root() / "assets" / "zotero-codex-word-bridge"
    target = profile / "extensions" / ("%s.xpi" % ADDON_ID)
    target.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(str(target), "w", zipfile.ZIP_DEFLATED) as zf:
        for path in sorted(source.rglob("*")):
            if path.is_dir():
                continue
            rel = path.relative_to(source).as_posix()
            if rel in ("chrome/content/scripts/bridge.js", "server_integration_bridge.js"):
                zf.writestr(rel, render_bridge(path.read_text(encoding="utf-8")))
            elif rel == "manifest.json":
                manifest = json.loads(path.read_text(encoding="utf-8"))
                manifest["applications"]["zotero"]["strict_max_version"] = "9.*"
                zf.writestr(rel, json.dumps(manifest, ensure_ascii=False, indent=2))
            else:
                zf.write(str(path), rel)
    result = {"profile": str(profile), "addon": str(target), "bytes": target.stat().st_size}
    if register:
        result["registration"] = register_extension(profile, target)
    return result


def register_extension(profile: Optional[Path] = None, xpi: Optional[Path] = None) -> Dict[str, Any]:
    profile = profile or locate_profile()
    xpi = xpi or profile / "extensions" / ("%s.xpi" % ADDON_ID)
    ext_json = profile / "extensions.json"
    backup = profile / ("extensions.json.codex-word-bridge-backup-%d" % int(time.time()))
    data = json.loads(ext_json.read_text(encoding="utf-8"))
    addons = [addon for addon in data.get("addons", []) if addon.get("id") != ADDON_ID]
    now_ms = int(time.time() * 1000)
    addons.append({
        "id": ADDON_ID,
        "syncGUID": "{codex-word-bridge-local}",
        "version": "0.2.0",
        "type": "extension",
        "loader": None,
        "manifestVersion": 2,
        "defaultLocale": {
            "name": "Codex Zotero Word Bridge",
            "description": "Local bridge for inserting real Zotero Word citations from Codex.",
            "creator": "OpenAI Codex",
        },
        "visible": True,
        "active": True,
        "userDisabled": False,
        "appDisabled": False,
        "installDate": now_ms,
        "updateDate": now_ms,
        "path": str(xpi),
        "strictCompatibility": True,
        "targetApplications": [{"id": "zotero@zotero.org", "minVersion": "7.0", "maxVersion": "9.*"}],
        "signedState": 0,
        "seen": True,
        "rootURI": "jar:file:///%s!/" % str(xpi).replace("\\", "/").replace(" ", "%20"),
        "location": "app-profile",
    })
    shutil.copy2(str(ext_json), str(backup))
    data["addons"] = addons
    ext_json.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    return {"extensions_json": str(ext_json), "backup": str(backup), "registered": ADDON_ID}


def start_zotero() -> Dict[str, Any]:
    candidates = [
        Path(os.environ.get("PROGRAMFILES", r"C:\Program Files")) / "Zotero" / "zotero.exe",
        Path(os.environ.get("LOCALAPPDATA", "")) / "Programs" / "Zotero" / "zotero.exe",
    ]
    exe = next((path for path in candidates if path.exists()), None)
    if not exe:
        raise RuntimeError("Could not locate zotero.exe")
    subprocess.Popen([str(exe)], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    return {"started": str(exe)}


def wait_bridge(timeout: int = 45) -> Dict[str, Any]:
    deadline = time.time() + timeout
    last_error = None
    while time.time() < deadline:
        try:
            return http_json("/codex/zotero-word/status", timeout=3)
        except Exception as error:
            last_error = error
            time.sleep(1)
    raise RuntimeError("Bridge did not respond: %s" % last_error)


def bridge_status() -> Dict[str, Any]:
    return http_json("/codex/zotero-word/status", timeout=5)


def check() -> Dict[str, Any]:
    profile = locate_profile()
    result = {"profile": str(profile), "data_dir": str(zotero_data_dir(profile))}
    try:
        result["bridge_ping"] = http_json("/codex/zotero-word/ping", timeout=5)
        result["bridge"] = bridge_status()
    except Exception as error:
        result["bridge_error"] = str(error)
    return result


def local_name(tag: str) -> str:
    return tag.rsplit("}", 1)[-1]


def child_text(parent: ET.Element, name: str) -> Optional[str]:
    for child in parent:
        if local_name(child.tag) == name:
            return child.text
    return None


def list_styles() -> List[Dict[str, str]]:
    styles_dir = zotero_data_dir(locate_profile()) / "styles"
    rows = []
    for path in sorted(styles_dir.glob("*.csl")):
        root = ET.parse(str(path)).getroot()
        info = next((child for child in root if local_name(child.tag) == "info"), None)
        if info is None:
            continue
        title = child_text(info, "title") or path.stem
        style_id = child_text(info, "id") or path.stem
        rows.append({"file": path.name, "stem": path.stem, "title": title, "id": style_id})
    return rows


def resolve_style(style: str) -> Dict[str, Any]:
    styles = list_styles()
    norm = style.casefold()
    for row in styles:
        values = [row["id"], row["title"], row["file"], row["stem"]]
        if any(norm == value.casefold() for value in values):
            return {"requested": style, "resolved": row["id"], "match": row, "ambiguous": False}
    prefix_matches = [row for row in styles if any(value.casefold().startswith(norm) for value in (row["title"], row["file"], row["stem"]))]
    if len(prefix_matches) == 1:
        row = prefix_matches[0]
        return {"requested": style, "resolved": row["id"], "match": row, "ambiguous": False}
    if norm == "myself":
        preferred = next((row for row in prefix_matches if row["stem"] == "Myself-AuthorYear"), None)
        if preferred:
            return {"requested": style, "resolved": preferred["id"], "match": preferred, "ambiguous": True, "candidates": prefix_matches}
    if prefix_matches:
        titles = ["%s (%s)" % (row["title"], row["id"]) for row in prefix_matches]
        raise RuntimeError("Citation style is ambiguous: %s. Candidates: %s" % (style, "; ".join(titles)))
    return {"requested": style, "resolved": style, "match": None, "ambiguous": False}


def resolve_key(key: str) -> Dict[str, Any]:
    profile = locate_profile()
    db = zotero_data_dir(profile) / "zotero.sqlite"
    conn = sqlite3.connect("file:%s?mode=ro&immutable=1" % db.as_posix(), uri=True)
    try:
        rows = conn.execute("select itemID, libraryID, key from items where key = ?", (key,)).fetchall()
    finally:
        conn.close()
    if not rows:
        raise RuntimeError("Zotero item key not found: %s" % key)
    return {"profile": str(profile), "db": str(db), "itemID": rows[0][0], "libraryID": rows[0][1], "key": rows[0][2]}


def open_word(docx: Optional[str], end: bool, marker: Optional[str] = None, close_on_error: bool = False):
    import win32com.client

    word_owned = False
    try:
        word = win32com.client.GetActiveObject("Word.Application")
    except Exception:
        word = win32com.client.DispatchEx("Word.Application")
        word_owned = True
    word.Visible = True
    opened_by_script = False
    if docx:
        path = str(Path(docx).resolve())
        doc = next((doc for doc in word.Documents if Path(doc.FullName).resolve() == Path(path)), None)
        if doc is None:
            if not word_owned:
                word = win32com.client.DispatchEx("Word.Application")
                word.Visible = True
                word_owned = True
            doc = word.Documents.Open(path)
            opened_by_script = True
        doc.Activate()
        try:
            if marker:
                word.Selection.SetRange(doc.Content.Start, doc.Content.Start)
                find = word.Selection.Find
                find.ClearFormatting()
                find.Text = marker
                if not find.Execute():
                    raise RuntimeError("Marker not found in Word document: %s" % marker)
                word.Selection.Text = ""
            elif end:
                word.Selection.EndKey(Unit=6)
        except Exception:
            if close_on_error and opened_by_script:
                doc.Close(False)
            if close_on_error and word_owned:
                word.Quit(False)
            raise
    else:
        doc = word.ActiveDocument
    return word, doc, opened_by_script, word_owned


def wait_task(label: str, timeout: int = 150) -> Dict[str, Any]:
    deadline = time.time() + timeout
    last = None
    while time.time() < deadline:
        status = bridge_status()
        last = status.get("lastTask") or {}
        if last.get("label") == label and last.get("state") == "completed":
            return status
        if last.get("label") == label and last.get("state") == "failed":
            raise RuntimeError(last.get("error") or "Bridge task failed")
        time.sleep(1)
    raise RuntimeError("Timed out waiting for bridge task %s; last=%s" % (label, last))


def wait_integration_window(timeout: int = 30) -> str:
    accepted = ("integrationDocPrefs.xhtml", "quickFormat.xhtml", "citationDialog.xhtml")
    deadline = time.time() + timeout
    current_url = ""
    while time.time() < deadline:
        current_url = (bridge_status().get("currentWindowURL") or "")
        if any(part in current_url for part in accepted):
            return current_url
        time.sleep(0.25)
    raise RuntimeError("Zotero integration dialog did not load; currentWindowURL=%s" % current_url)


def select_zotero_field(doc: Any, item_key: str) -> None:
    for field in doc.Fields:
        if "ZOTERO_ITEM" in field.Code.Text and item_key in field.Code.Text:
            field.Select()
            return
    raise RuntimeError("Zotero citation field not found for item key: %s" % item_key)


def run_insert(word: Any, args: argparse.Namespace, item_id: int, style_id: str) -> Dict[str, Any]:
    word.Run("Project.Zotero.ZoteroAddEditCitation")
    dialog_url = wait_integration_window(min(args.timeout, 30))
    params = quote_params({
        "itemID": item_id,
        "style": style_id,
        "locator": args.locator,
        "label": args.label,
        "prefix": args.prefix,
        "suffix": args.suffix,
        "suppress-author": "1" if args.suppress_author else None,
    })
    started = http_json("/codex/zotero-word/inject-current-get?%s" % params, timeout=10)
    status = wait_task("inject-current", timeout=args.timeout)
    return {"dialog": dialog_url, "started": started, "status": status}


def insert(args: argparse.Namespace) -> Dict[str, Any]:
    item_keys = args.item_keys or ([args.item_key] if args.item_key else [])
    if args.item_id and item_keys:
        raise RuntimeError("Use either --item-id or --item-key/--item-keys, not both")
    item_ids = [resolve_key(key)["itemID"] for key in item_keys]
    if args.item_id:
        item_ids = [args.item_id]
    if not item_ids:
        raise RuntimeError("insert requires an item ID or at least one item key")
    style = resolve_style(args.style)
    word, doc, opened_by_script, word_owned = open_word(args.docx, bool(args.docx) and args.position == "end", args.marker, args.close)
    try:
        try:
            result = run_insert(word, args, item_ids[0], style["resolved"])
        except RuntimeError as error:
            message = str(error)
            if args.retry_preferences and "Timed out waiting for Quick Format dialog after Document Preferences" in message:
                result = run_insert(word, args, item_ids[0], style["resolved"])
                result["retried_after_document_preferences"] = True
            else:
                raise
        for index, item_id in enumerate(item_ids[1:], start=1):
            if not item_keys:
                raise RuntimeError("Grouped insertion requires Zotero item keys so the existing field can be located")
            select_zotero_field(doc, item_keys[0])
            result["append_%d" % index] = run_insert(word, args, item_id, style["resolved"])
        if args.save:
            doc.Save()
        result["style"] = style
        result["document"] = getattr(doc, "FullName", None)
        if item_keys:
            result["item_keys"] = item_keys
        return result
    finally:
        if args.close and opened_by_script:
            doc.Close(False)
        if args.close and word_owned:
            word.Quit(False)


def refresh(args: argparse.Namespace) -> Dict[str, Any]:
    word, doc, opened_by_script, word_owned = open_word(args.docx, False)
    try:
        word.Run("Project.Zotero.ZoteroRefresh")
        if args.save:
            doc.Save()
        document = getattr(doc, "FullName", None)
        return {"refreshed": True, "document": document}
    finally:
        if args.close and opened_by_script:
            doc.Close(False)
        if args.close and word_owned:
            word.Quit(False)


def print_json(payload: Dict[str, Any]) -> None:
    print(json.dumps(payload, ensure_ascii=False, indent=2, default=str))


def main() -> None:
    parser = argparse.ArgumentParser(description="Windows Word/Zotero live citation helper for Codex.")
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("check")
    sub.add_parser("bridge-status")
    sub.add_parser("start-zotero")
    sub.add_parser("styles")
    install_parser = sub.add_parser("install-bridge")
    install_parser.add_argument("--register", action="store_true")
    sub.add_parser("register-extension")
    resolve_parser = sub.add_parser("resolve-key")
    resolve_parser.add_argument("--key", required=True)
    insert_parser = sub.add_parser("insert")
    insert_parser.add_argument("--item-key")
    insert_parser.add_argument("--item-keys", nargs="+")
    insert_parser.add_argument("--item-id", type=int)
    insert_parser.add_argument("--docx")
    insert_parser.add_argument("--style", default=DEFAULT_STYLE)
    insert_parser.add_argument("--locator")
    insert_parser.add_argument("--label")
    insert_parser.add_argument("--prefix")
    insert_parser.add_argument("--suffix")
    insert_parser.add_argument("--suppress-author", action="store_true")
    insert_parser.add_argument("--position", choices=["cursor", "end"], default="end")
    insert_parser.add_argument("--marker")
    insert_parser.add_argument("--save", action="store_true")
    insert_parser.add_argument("--close", action="store_true")
    insert_parser.add_argument("--retry-preferences", action="store_true", default=True)
    insert_parser.add_argument("--no-retry-preferences", dest="retry_preferences", action="store_false")
    insert_parser.add_argument("--timeout", type=int, default=150)
    refresh_parser = sub.add_parser("refresh")
    refresh_parser.add_argument("--docx")
    refresh_parser.add_argument("--save", action="store_true")
    refresh_parser.add_argument("--close", action="store_true")
    args = parser.parse_args()
    if args.command == "check":
        print_json(check())
    elif args.command == "bridge-status":
        print_json(bridge_status())
    elif args.command == "start-zotero":
        print_json(start_zotero())
    elif args.command == "styles":
        print_json({"styles": list_styles()})
    elif args.command == "install-bridge":
        print_json(install_bridge(args.register))
    elif args.command == "register-extension":
        print_json(register_extension())
    elif args.command == "resolve-key":
        print_json(resolve_key(args.key))
    elif args.command == "insert":
        if not args.item_key and not args.item_keys and not args.item_id:
            parser.error("insert requires --item-key, --item-keys, or --item-id")
        print_json(insert(args))
    elif args.command == "refresh":
        print_json(refresh(args))


if __name__ == "__main__":
    main()
