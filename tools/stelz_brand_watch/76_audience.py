#!/usr/bin/env python3
"""Who stands around Stëlz — built from payloads that are already on disk.

WHY THIS SCRIPT COSTS NOTHING. Every harvester keeps the full Apify response in
`<archive>/raw/`, and the index it writes alongside takes only the fields the
detection pass needs. Everything the audience question wants was thrown away at
that step and kept in the raw file:

    latestComments   2.040 distinct people, 2.854 comments — never read
    taggedUsers      392 accounts tagged in a post — never read
    authorMeta       fans, hearts, video count, bio, verified — partly read
    textLanguage     722 nl / 352 en across the archive — never read
    locationName     43 places — never read

So this makes no network call. It re-reads what was already bought and answers a
different question with it.

WHAT IT WILL NOT ANSWER. Age, gender and city are not in here, because they are
not in the data. Of 1.089 bios with text, exactly ONE states an age under the
rule in web/src/lib/communities.selfReportedAge. A demographic profile built on
that is invention, and the kind a client finds out about later.

THE NUMBER THAT MATTERS IS THE OVERLAP. "28 creators with 2,8M followers
between them" says nothing about whether that is 2,8M people or the same
80.000 counted 28 times. Comments are the only per-person signal either
platform hands over for free, so the question becomes answerable: 2.040 people
commented, and 154 of them commented on more than one booked creator.

    tools/stelz_brand_watch/76_audience.py --event lowlands-2026

Writes .tmp/preview-audience.json for the dev server. Idempotent; rerun after
every harvest.
"""

from __future__ import annotations

import argparse
import collections
import importlib.util
import json
import re
from pathlib import Path

_espec = importlib.util.spec_from_file_location(
    "_events", Path(__file__).with_name("_events.py"))
E = importlib.util.module_from_spec(_espec)
_espec.loader.exec_module(E)

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / ".tmp" / "preview-audience.json"

# How many rows of each list reach the fixture. The tail of a comment ranking is
# 1.886 people who commented once, which is a fact worth counting and not worth
# shipping 1.886 rows for. The COUNTS are always complete; only the lists are
# cut, and every cut says so in the output.
TOP = 60

# The SAME rule as web/src/lib/communities.selfReportedAge, deliberately kept
# identical: only an age the person wrote down themselves, never one inferred
# from writing style, music taste or a school reference. Its only job here is to
# produce the count behind the dashboard's claim that age data does not exist —
# so if the two rules drifted apart, the dashboard would be citing a number
# measured under a rule it does not use.
AGE_IN_BIO = [
    re.compile(r"\b(1[6-9]|[2-4][0-9])\s*(?:yo|y/o|years? old|jaar)\b", re.I),
    re.compile(r"\b(?:age|leeftijd)[:\s]+(1[6-9]|[2-4][0-9])\b", re.I),
]


def self_reported_age(bio: str | None) -> int | None:
    for pattern in AGE_IN_BIO:
        m = pattern.search(bio or "")
        if m:
            n = int(m.group(1))
            if 16 <= n <= 49:
                return n
    return None


def read_raw(ev: dict, kind: str):
    """Every raw payload for one archive, as dicts. Missing archive -> empty."""
    d = E.archive_dir(ev, kind) / "raw"
    if not d.is_dir():
        return
    for f in sorted(d.iterdir()):
        if f.suffix != ".json":
            continue
        try:
            yield json.loads(f.read_text())
        except Exception:
            continue


def read_index(ev: dict, kind: str) -> list[dict]:
    p = E.archive_dir(ev, kind) / "index.jsonl"
    if not p.exists():
        return []
    return [json.loads(l) for l in p.read_text().splitlines() if l.strip()]


def hit_ids(ev: dict, kind: str) -> set[str]:
    """Ids whose verdict says Stëlz was in frame, so a person can be marked as
    having actually shown the can rather than merely having been present."""
    p = E.archive_dir(ev, kind) / "verdicts.jsonl"
    if not p.exists():
        return set()
    out = set()
    for line in p.read_text().splitlines():
        if not line.strip():
            continue
        v = json.loads(line)
        if v.get("detected") and not v.get("is_false_positive"):
            out.add(str(v.get("story_id") or v.get("item_id") or v.get("video_id")))
    return out


def commenters(ev: dict, roster: set[str]) -> tuple[list[dict], dict]:
    """Who comments, and on how many DIFFERENT booked creators.

    Self-comments are dropped: a creator replying under her own post is not
    audience. Only Instagram appears here — TikTok's payload carries a
    commentsDatasetUrl that is null on every row we hold, so its comments would
    be a separate paid scrape.
    """
    on = collections.defaultdict(set)      # commenter -> {accounts they commented on}
    times = collections.defaultdict(int)
    first, last = {}, {}
    total = 0
    posts_with = 0

    for p in read_raw(ev, "ig-posts"):
        owner = (p.get("ownerUsername") or "").lower()
        lc = p.get("latestComments") or []
        if lc:
            posts_with += 1
        for c in lc:
            u = (c.get("ownerUsername") or "").lower()
            if not u or u == owner:
                continue
            total += 1
            times[u] += 1
            if owner:
                on[u].add(owner)
            ts = c.get("timestamp")
            if ts:
                first[u] = min(first.get(u, ts), ts)
                last[u] = max(last.get(u, ts), ts)

    rows = [{
        "handle": u,
        "comments": times[u],
        "creators": sorted(on[u]),
        # How many of those are people Stëlz actually paid. A commenter who
        # reaches five booked creators is a different finding from one who
        # reaches five strangers.
        "rosterReached": len([a for a in on[u] if a in roster]),
        "firstAt": first.get(u),
        "lastAt": last.get(u),
    } for u in times]
    rows.sort(key=lambda r: (-len(r["creators"]), -r["comments"], r["handle"]))

    shared = [r for r in rows if len(r["creators"]) >= 2]
    return rows[:TOP], {
        "people": len(rows),
        "comments": total,
        "postsWithComments": posts_with,
        "shared": len(shared),
        "listed": min(TOP, len(rows)),
        # The distribution, complete, so the cut list never has to carry it:
        # {1: 1886, 2: 102, ...} is the whole overlap story in one line.
        "reachDistribution": dict(sorted(collections.Counter(
            len(r["creators"]) for r in rows).items())),
    }


def tagged(ev: dict, roster: set[str]) -> tuple[list[dict], dict]:
    """Who gets tagged in the roster's posts — the people physically there.

    Roster members tag each other heavily, and that is worth separating: reach
    that lands on another booked creator is reach the campaign already bought.
    """
    counts = collections.Counter()
    names = {}
    by = collections.defaultdict(set)
    for p in read_raw(ev, "ig-posts"):
        owner = (p.get("ownerUsername") or "").lower()
        for u in (p.get("taggedUsers") or []):
            h = (u.get("username") or "").lower()
            if not h:
                continue
            counts[h] += 1
            if u.get("full_name"):
                names[h] = u["full_name"]
            if owner:
                by[h].add(owner)
    rows = [{
        "handle": h,
        "fullName": names.get(h),
        "times": n,
        "taggedBy": sorted(by[h]),
        "onRoster": h in roster,
    } for h, n in counts.most_common()]
    return rows[:TOP], {
        "accounts": len(rows),
        "onRoster": sum(1 for r in rows if r["onRoster"]),
        "tags": sum(counts.values()),
        "listed": min(TOP, len(rows)),
    }


def accounts(ev: dict, roster: set[str]) -> tuple[list[dict], dict]:
    """Every TikTok account we hold a profile for, roster and festival-goer.

    TikTok is the only platform here that publishes a follower count at all —
    Instagram returns none, on any endpoint we use — so this section is TikTok
    and says so.
    """
    seen: dict[str, dict] = {}
    for kind, source in (("tiktok", "roster"), ("discovery", "discovery")):
        hits = hit_ids(ev, kind)
        for p in read_raw(ev, kind):
            a = p.get("authorMeta") or {}
            h = (a.get("name") or "").lower()
            if not h:
                continue
            r = seen.setdefault(h, {
                "handle": h,
                "platform": "tiktok",
                "source": source,
                "fullName": a.get("nickName"),
                "followers": a.get("fans"),
                "hearts": a.get("heart"),
                "videos": a.get("video"),
                "following": a.get("following"),
                "verified": bool(a.get("verified")),
                "bio": a.get("signature") or None,
                "posts": 0,
                "withStelz": 0,
            })
            # A roster creator also picked up by hashtag search stays roster.
            if source == "roster":
                r["source"] = "roster"
            r["posts"] += 1
            if str(p.get("id")) in hits:
                r["withStelz"] += 1

    rows = sorted(seen.values(), key=lambda r: (-(r["followers"] or 0), r["handle"]))

    def stats(pool: list[dict]) -> dict:
        fans = sorted(r["followers"] for r in pool if r["followers"])
        bios = [r["bio"] for r in pool if r["bio"]]
        return {
            "accounts": len(pool),
            "followersKnownFor": len(fans),
            # MEDIAN, not mean. One account with 1,2M followers among 337
            # festival-goers drags a mean to a number describing nobody there.
            "medianFollowers": fans[len(fans) // 2] if fans else None,
            "totalFollowers": sum(fans),
            "verified": sum(1 for r in pool if r["verified"]),
            "withStelz": sum(1 for r in pool if r["withStelz"] > 0),
            # The dashboard says "no age, no gender, no city" and gives a count
            # to back it. That count has to be measured over the accounts the
            # dashboard is actually showing, not over some wider bio corpus —
            # a true number under the wrong denominator is still a wrong claim.
            "withBio": len(bios),
            "withAge": sum(1 for b in bios if self_reported_age(b) is not None),
        }

    return rows[:TOP], {
        "roster": stats([r for r in rows if r["source"] == "roster"]),
        "discovery": stats([r for r in rows if r["source"] == "discovery"]),
        "listed": min(TOP, len(rows)),
        "total": len(rows),
    }


# TikTok writes "no licensed track here" in the viewer's own language, so one
# fact arrives as seven different sound names. Unfolded they took SEVEN of the
# top fourteen slots and pushed every real track off the card — a "Sounds"
# ranking whose answer was "no sound", said in Dutch, English, Spanish, Russian,
# French, Portuguese and German.
#
# Only the BARE label folds. "original sound - Lovelorn" stays as it is: that is
# one creator's audio that other people reused, which is the opposite of no
# track — it is a track that spread.
ORIGINAL_SOUND = {
    "origineel geluid", "original sound", "sonido original", "оригинальный звук",
    "оригінальний звук", "son original", "som original", "originalton",
    "suono originale", "audio originale", "originalljud",
    "オリジナル楽曲", "원본 오디오", "الصوت الأصلي",
}
ORIGINAL_LABEL = "eigen geluid (geen nummer)"


def fold_original(name: str) -> str:
    return ORIGINAL_LABEL if name.strip().lower() in ORIGINAL_SOUND else name


def context(ev: dict) -> dict:
    """Language, sounds and places — with denominators, because a top-5 with no
    total behind it invites the reader to supply their own."""
    langs, sounds, places = collections.Counter(), collections.Counter(), collections.Counter()
    posts = 0
    for kind in ("tiktok", "discovery"):
        for p in read_raw(ev, kind):
            posts += 1
            if p.get("textLanguage"):
                langs[p["textLanguage"]] += 1
            mm = p.get("musicMeta") or {}
            if mm.get("musicName"):
                sounds[fold_original(mm["musicName"])] += 1
    ig = 0
    for p in read_raw(ev, "ig-posts"):
        ig += 1
        if p.get("locationName"):
            places[p["locationName"]] += 1
    rank = lambda c, n: [{"label": k, "count": v} for k, v in c.most_common(n)]
    return {
        "languages": rank(langs, 12),
        "languagesKnownFor": sum(langs.values()),
        "languagePosts": posts,
        "sounds": rank(sounds, 15),
        # TWO different numbers, and the dashboard needs both. `soundsKnownFor`
        # is how many POSTS carried a sound — the only denominator a "this sound
        # was on X% of posts" claim can use. `soundsDistinct` is how many
        # different sounds those were. Dividing a post count by the distinct
        # count mixes units and yields a percentage of nothing.
        "soundsKnownFor": sum(sounds.values()),
        "soundsDistinct": len(sounds),
        "places": rank(places, 12),
        "placesKnownFor": sum(places.values()),
        "placePosts": ig,
    }


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--event", default="lowlands-2026", choices=E.available())
    args = ap.parse_args()

    ev = E.load(args.event)
    roster = {h.lower() for h in E.roster_accounts(ev)}
    print(f"  {ev['name']} — publiek uit gearchiveerde payloads (geen enkele API-call)")

    top_c, c_stats = commenters(ev, roster)
    top_t, t_stats = tagged(ev, roster)
    top_a, a_stats = accounts(ev, roster)
    ctx = context(ev)

    out = {
        "eventId": ev["id"],
        "commenters": {"top": top_c, **c_stats},
        "tagged": {"top": top_t, **t_stats},
        "accounts": {"top": top_a, **a_stats},
        "context": ctx,
    }
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(out, ensure_ascii=False, indent=1))

    print(f"\n  reageerders : {c_stats['people']:,} mensen · {c_stats['comments']:,} reacties"
          f" · {c_stats['shared']} op 2+ creators")
    print(f"  getagd      : {t_stats['accounts']:,} accounts"
          f" · {t_stats['onRoster']} daarvan op het roster")
    print(f"  roster (TT) : {a_stats['roster']['accounts']} accounts"
          f" · mediaan {a_stats['roster']['medianFollowers']:,} volgers"
          if a_stats['roster']['medianFollowers'] else "  roster (TT) : geen")
    print(f"  los (TT)    : {a_stats['discovery']['accounts']} accounts"
          f" · mediaan {a_stats['discovery']['medianFollowers']:,} volgers"
          if a_stats['discovery']['medianFollowers'] else "  los (TT)    : geen")
    top_langs = ", ".join(f"{l['label']} {l['count']}" for l in ctx["languages"][:4])
    print(f"  taal        : {top_langs}")
    print(f"  sounds      : {ctx['soundsDistinct']:,} unieke")
    print(f"\n  wrote {OUT.relative_to(ROOT)}")
    print("  open http://localhost:5173/evenementen/"
          f"{ev['id']}?preview=campaign&tab=publiek")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
