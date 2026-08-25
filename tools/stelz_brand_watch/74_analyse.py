#!/usr/bin/env python3
"""Run the Stëlz detection over an archive — TikTok or Instagram feed posts.

Same cascade as the stories analyser (64), same module (_local_detect), so the
three surfaces cannot drift into three different opinions about what counts as
a sighting.

    ./firebase/functions/venv/bin/python \\
        tools/stelz_brand_watch/74_analyse.py --event lowlands-2026 \\
                                              --archive tiktok --max-dim 0
        ... --archive ig-posts   # or stories, or discovery
        ... --limit 5            # try a few first
        ... --covers-only        # skip video frames (cheap, and says so)
        ... --redo               # re-judge everything

Resumable per item id. Cost is printed as an estimate before the run and as an
actual after it.

ON COVER-ONLY VERDICTS: an item whose video could not be downloaded is judged
on its cover and the verdict records `cover_only: true`. That is not the same
claim as "we watched the clip and saw nothing", and the UI has to be able to
tell the difference — a thumbnail is a chosen frame, and nobody chooses the one
where they are drinking.
"""
from __future__ import annotations

import argparse
import importlib.util
import json
import threading
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
_spec = importlib.util.spec_from_file_location(
    "_local_detect", Path(__file__).with_name("_local_detect.py"))
D = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(D)
_espec = importlib.util.spec_from_file_location(
    "_events", Path(__file__).with_name("_events.py"))
E = importlib.util.module_from_spec(_espec)
_espec.loader.exec_module(E)

# Which field holds the id, per surface. "discovery" is everyone at the event
# who is NOT on the roster, found by hashtag (73). Same cascade, separate
# archive: paid delivery and organic pickup are different claims and must not
# share a total.
ID_FIELD = {
    "tiktok": "video_id",
    "ig-posts": "item_id",
    "stories": "story_id",
    "discovery": "video_id",
}


def load_verdicts(path: Path) -> dict[str, dict]:
    if not path.exists():
        return {}
    out: dict[str, dict] = {}
    for line in path.read_text().splitlines():
        if line.strip():
            try:
                v = json.loads(line)
                out[v.get("item_id") or v.get("story_id")] = v
            except Exception:
                continue
    return out


def write_verdicts(path: Path, rows: dict[str, dict]) -> None:
    tmp = path.with_suffix(".jsonl.tmp")
    with tmp.open("w") as f:
        for k in sorted(rows):
            f.write(json.dumps(rows[k]) + "\n")
    tmp.replace(path)


def content_identity(e: dict, kind: str) -> tuple | None:
    """What makes a row in one archive the SAME clip or slide as a row in
    another. Mirrors 72_campaign_fixture.content_key — the fixture merges what
    this failed to match, but by then Gemini has been paid twice. Identity
    lives in archive FIELDS; the id text differs per archive (discovery
    prefixes Instagram ids with "ig") and is no identity at all."""
    if kind == "stories":
        return None  # only one archive holds stories
    handle = (e.get("handle") or "").lower()
    if kind == "ig-posts" or e.get("platform") == "instagram":
        sc = e.get("short_code")
        return ("ig", handle, sc, e.get("slot")) if sc else None
    vid = e.get("video_id")
    return ("tt", handle, str(vid)) if vid else None


def reuse_sibling_verdicts(ev: dict, archive: str, id_field: str,
                           todo: list[dict], verdicts: dict[str, dict],
                           max_dim: int) -> int:
    """Copy verdicts for todo items whose content a SIBLING archive already
    judged at this resolution. The copies land in `verdicts` under this
    archive's own item id, marked `copied_from`, so a borrowed opinion stays
    distinguishable from an original one. Returns how many were copied."""
    wanted: dict[tuple, list[dict]] = {}
    for e in todo:
        k = content_identity(e, archive)
        if k:
            wanted.setdefault(k, []).append(e)

    copied = 0
    for kind in ID_FIELD:
        if kind == archive or kind == "stories" or not wanted:
            continue
        sp = E.paths(ev, kind)
        if not sp.index.exists():
            continue
        sverd = load_verdicts(sp.dir / "verdicts.jsonl")
        if not sverd:
            continue
        sid = ID_FIELD[kind]
        for line in sp.index.read_text().splitlines():
            if not line.strip():
                continue
            try:
                se = json.loads(line)
            except Exception:
                continue
            k = content_identity(se, kind)
            if k not in wanted:
                continue
            sv = sverd.get(str(se.get(sid) or ""))
            # Only a verdict reached at THIS run's resolution transfers: rows
            # without max_dim predate the guard and stay where they are.
            if not sv or sv.get("max_dim") != max_dim:
                continue
            for e in wanted.pop(k):
                v = dict(sv)
                v["item_id"] = e[id_field]
                v["copied_from"] = kind
                verdicts[e[id_field]] = v
                copied += 1
    return copied


def analyse(entry: dict, media: Path, refs: list[bytes], covers_only: bool,
            stats: dict) -> tuple[list[dict], int]:
    results: list[dict] = []
    frames_extracted = 0

    img = entry.get("image_file")
    if img and (media / img).exists():
        results.append(D.judge_image((media / img).read_bytes(), refs, stats))

    vid = entry.get("video_file")
    if vid and not covers_only and (media / vid).exists():
        before = stats["frames_extracted"]
        results.extend(D.judge_video((media / vid).read_bytes(), refs, stats))
        frames_extracted = stats["frames_extracted"] - before

    return results, frames_extracted


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--event", default="lowlands-2026", choices=E.available(),
                    help="which event's archives (default lowlands-2026)")
    ap.add_argument("--archive", required=True, choices=sorted(ID_FIELD))
    ap.add_argument("--limit", type=int)
    ap.add_argument("--covers-only", action="store_true")
    ap.add_argument("--redo", action="store_true")
    # Re-judge only the rows a verifier change can move: the ones the second
    # look already touched, plus the one hard rejection it is now allowed to
    # re-open (verifier.REOPENABLE_GATE). That is a few dozen out of fifteen
    # hundred — re-running the whole archive would re-bill the ~97% no verifier
    # rule can reach.
    ap.add_argument("--redo-verified", action="store_true",
                    help="re-judge items the second-look pass can change its mind about")
    # Re-judge everything the archive currently CLAIMS. Used to check that a
    # finding survives a change to the detection path without re-billing the
    # ~97% of an archive that says "nothing here" — those rows are only at risk
    # from a change that makes the pass see MORE, and this flag exists for the
    # opposite case.
    ap.add_argument("--redo-found", action="store_true",
                    help="re-judge every hit and near miss")
    # What the first pass sees. The default matches the deployed function, so a
    # local number means the same thing as a deployed one. 0 sends the archived
    # bytes as-is, which finds more and costs more — see _local_detect.
    ap.add_argument("--max-dim", type=int, default=D.PROD_MAX_DIM,
                    help=f"first-pass long edge in px (default {D.PROD_MAX_DIM}, "
                         f"as production; 0 = no downscale)")
    # Frame extraction is CPU-bound and the Gemini calls are almost all waiting
    # on the network, so one item at a time leaves both idle. 288 TikToks at
    # ~30s each is two and a half hours serial; the work is embarrassingly
    # parallel and the only shared state is the verdict file, which is written
    # under a lock.
    ap.add_argument("--concurrency", type=int, default=6)
    args = ap.parse_args()

    ev = E.load(args.event)
    P = E.paths(ev, args.archive)
    id_field = ID_FIELD[args.archive]
    index, media, vpath = P.index, P.media, P.dir / "verdicts.jsonl"

    D.load_env()
    if not D.have_key():
        print("No Gemini key (GOOGLE_AI_API_KEY / GEMINI_API_KEY)")
        return 2
    if not index.exists():
        print(f"No archive at {P.label()} — harvest it first")
        return 2

    entries = [json.loads(l) for l in index.read_text().splitlines() if l.strip()]
    verdicts = load_verdicts(vpath)
    def wanted(e: dict) -> bool:
        if args.redo:
            return True
        if args.redo_found:
            v = verdicts.get(e[id_field]) or {}
            return bool(v.get("detected")) or bool(v.get("near_miss"))
        if args.redo_verified:
            v = verdicts.get(e[id_field]) or {}
            return bool(v.get("verify_verdict")) or v.get("gate") == D.REOPENABLE_GATE
        return e[id_field] not in verdicts

    todo = [e for e in entries if wanted(e)]
    if args.limit:
        todo = todo[: args.limit]

    print(f"{ev['name']} / {args.archive} — {len(entries)} archived · "
          f"{len(verdicts)} already judged · {len(todo)} to analyse")
    print("First pass at "
          + (f"{args.max_dim}px (as production)" if args.max_dim == D.PROD_MAX_DIM
             else f"{args.max_dim}px" if args.max_dim > 0
             else "the archived resolution — MORE than production sees"))

    # An archive judged at two resolutions is an archive whose totals mean
    # nothing. The three roster archives were built at the archived resolution
    # (max_dim 0); re-running at the 512px default turns 37 Instagram hits into
    # 27 and 8 TikTok hits into 5, and the drop looks exactly like "the brand
    # was less visible this week". Mixing the two inside ONE file is worse
    # still: the difference is then invisible even in principle.
    existing = {v.get("max_dim") for v in verdicts.values() if "max_dim" in v}
    if len(existing) == 1 and (settled := existing.pop()) != args.max_dim and not args.redo:
        print(f"\n  ✕ REFUSED. {len(verdicts)} verdicts in this archive were judged at "
              f"max_dim={settled}, and this run would add rows at {args.max_dim}.")
        print(f"    Pass --max-dim {settled} to extend the archive, or --redo to "
              f"re-judge all of it at {args.max_dim} (which re-bills every row).")
        return 2

    # NEVER PAY GEMINI TWICE FOR THE SAME PIXELS. The same clip enters two
    # archives by two roads — found via #stelz into discovery, and via the
    # profile scrape of its poster into tiktok/ig-posts — and each archive's
    # todo-list only knows its own verdicts. Round A2 spent $0,60 re-judging
    # six videos the discovery pass had already judged. Identity comes from the
    # archive FIELDS (handle + video_id, or handle + shortcode + slide), never
    # from id text: discovery prefixes IG ids with "ig". Only verdicts reached
    # at THIS run's resolution are copied — a copy at another max_dim would
    # smuggle in exactly the mixed-resolution archive the check above refuses.
    # Skipped under --redo*: those flags exist to form a fresh opinion.
    if not (args.redo or args.redo_found or args.redo_verified):
        copied = reuse_sibling_verdicts(ev, args.archive, id_field, todo,
                                        verdicts, args.max_dim)
        if copied:
            write_verdicts(vpath, verdicts)
            todo = [e for e in todo if e[id_field] not in verdicts]
            print(f"{copied} al beoordeeld in een ander archief — oordeel "
                  f"gekopieerd, {len(todo)} over voor Gemini")

    if not todo:
        print("Nothing to do.")
        return 0

    D.set_max_dim(args.max_dim)
    D.warm()
    refs = D.load_references()
    print(f"{len(refs)} reference images, logo first")
    est = sum(D.COST_IMAGE + (D.COST_VIDEO + 2 * D.COST_IMAGE
                              if e.get("video_file") and not args.covers_only else 0)
              for e in todo)
    print(f"Estimated Gemini spend: ~${est:.2f}\n")

    stats = D.new_stats()
    counts = {"hits": 0, "near": 0, "cover_only": 0, "done": 0}
    lock = threading.Lock()

    def work(e: dict) -> None:
        iid = e[id_field]
        try:
            results, frames = analyse(e, media, refs, args.covers_only, stats)
        except Exception as exc:
            with lock:
                counts["done"] += 1
                print(f"[{counts['done']}/{len(todo)}] @{e['handle']} → FAILED ({str(exc)[:60]})")
            return
        if not results:
            with lock:
                counts["done"] += 1
                print(f"[{counts['done']}/{len(todo)}] @{e['handle']} → no media")
            return
        v = D.verdict_record(iid, e["handle"], results,
                             frames_extracted=frames, duration_s=e.get("duration"))
        # A verdict with no description is not a verdict. The model returned
        # nothing usable — a malformed response, a safety block, a truncated
        # call — and writing it stores "no Stëlz" for an image nothing ever
        # actually read, which is indistinguishable on screen from a real
        # negative. Leaving it out keeps the item in the todo list so the next
        # run retries it, exactly as detect_image refuses to cache a failed call
        # ("Never cache a failed call ... not evidence the brand is absent").
        if not v["detected"] and not (v.get("context") or "").strip():
            with lock:
                counts["done"] += 1
                print(f"[{counts['done']}/{len(todo)}] @{e['handle']} → LEEG antwoord, "
                      f"niet opgeslagen (blijft ongeanalyseerd)")
            return
        # A clip we never obtained is judged on a thumbnail. Say so in the row
        # rather than letting it read like a full viewing.
        v["cover_only"] = bool(e.get("video_unavailable")) or (
            args.covers_only and bool(e.get("video_file") or e.get("video_unavailable")))
        with lock:
            counts["done"] += 1
            if v["cover_only"]:
                counts["cover_only"] += 1
            verdicts[iid] = v
            # Under the lock and after every item: a crash keeps everything it
            # already paid Gemini for.
            write_verdicts(vpath, verdicts)
            head = f"[{counts['done']}/{len(todo)}] @{e['handle']}"
            if v["detected"]:
                counts["hits"] += 1
                print(f"{head} → STËLZ {int((v['confidence'] or 0) * 100)}% "
                      f"({v.get('size_in_frame') or '?'}, {v.get('judged_from')})")
            elif v["near_miss"]:
                counts["near"] += 1
                print(f"{head} → bijna ({(v.get('near_miss_reason') or '?')[:50]})")
            else:
                print(f"{head} → no")

    with ThreadPoolExecutor(max_workers=max(1, args.concurrency)) as ex:
        for fut in as_completed([ex.submit(work, e) for e in todo]):
            fut.result()
    hits, near, cover_only = counts["hits"], counts["near"], counts["cover_only"]

    print(f"\n{hits} of {len(todo)} contained Stëlz · {near} near miss"
          f"{'' if near == 1 else 'es'}")
    if cover_only:
        print(f"{cover_only} judged on the cover alone (video unavailable) — "
              f"weaker evidence, marked as such")
    print(f"Gemini: {stats['image_calls']} image · {stats['video_calls']} screen · "
          f"{stats['verify_calls']} verify  =  ~${D.spend(stats):.2f}")
    if stats["frames_extracted"]:
        print(f"Frames: {stats['frames_extracted']} sampled · {stats['frames_flagged']} flagged "
              f"· {stats['frames_analysed']} given a full look")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
