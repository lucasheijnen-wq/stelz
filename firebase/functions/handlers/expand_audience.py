"""Audience expansion: the people AROUND a hit become discovery candidates.

WHY THIS EXISTS. Discovery candidates used to come from exactly one signal:
who OWNS a post that a hashtag search returned. Everything the hits themselves
measure about the brand's social circles — who gets tagged in a hit, who the
caption mentions, who co-authored it — was stored and never read. On the
Lowlands archives alone that unused layer held 429 tagged accounts and 516
TikTok mentions. A person tagged in a photo of someone holding the can was AT
the party; that is a warmer lead than a stranger under a lifestyle hashtag,
and it costs nothing to enqueue because the data is already ours.

Two outputs per run:

  1. /discoveryQueue upserts — same doc shape as scan_hashtags, sources like
     "audience:tag" / "audience:mention". The promotion rule is untouched and
     deliberately conservative: audience signals count as GENERIC (two
     distinct signals promote), because being tagged once at a party is
     presence, not brand intent.
  2. /edges docs — srcHandle→dstHandle with edgeType tag|mention, the exact
     shape compute_resonance has been reading since it shipped. That graph
     layer carries 30% of the hot-mode SRS weight and was scoring 0 for
     everyone: this collection is read by SRS and was written by NOTHING (its
     writers died with the Supabase era).

Excluded from both: the brand's own accounts (any handle carrying the brand
slug or an alias), tracked creators (they are already followed), and the
poster themselves. Idempotent: edge doc ids are deterministic, queue writes
are merge+ArrayUnion — rerunning changes nothing but lastSeenAt.
"""
from __future__ import annotations

import logging
from typing import Any

from google.cloud.firestore import SERVER_TIMESTAMP, ArrayUnion, Increment

from lib import fs

log = logging.getLogger(__name__)

# How many recent hits one run walks. Detections carry their post id, so this
# bounds reads at max_hits detection docs + as many post docs.
DEFAULT_MAX_HITS = 400


def _brand_owned(handle: str, slug: str, aliases: list[str]) -> bool:
    h = (handle or "").lower()
    needles = {(slug or "").lower(), *[(a or "").lower() for a in aliases]}
    return any(n and n in h for n in needles)


def _clean(handle: Any) -> str:
    return str(handle or "").strip().lstrip("@").lower()


def run(brand_id: str, max_hits: int = DEFAULT_MAX_HITS) -> dict[str, Any]:
    brand = fs.brand_doc(brand_id).get()
    if not brand.exists:
        raise ValueError(f"brand not found: {brand_id}")
    bdata = brand.to_dict() or {}
    slug = bdata.get("slug") or brand_id
    aliases = bdata.get("wordmarkAliases") or []

    tracked: set[str] = set()
    for c in fs.creators_col(brand_id).stream():
        h = _clean((c.to_dict() or {}).get("handle"))
        if h:
            tracked.add(h)

    # Recent hits, newest first — the same (detected, postedAt) index the
    # dashboard's feed query uses.
    hits = list(
        fs.detections_col(brand_id)
        .where("detected", "==", True)
        .order_by("postedAt", direction="DESCENDING")
        .limit(max_hits)
        .stream()
    )

    posts_col = fs.posts_col(brand_id)
    queue_col = fs.discovery_queue_col(brand_id)
    edges_col = fs.edges_col(brand_id)

    seen_posts: set[str] = set()
    # handle -> {"platform", "sources": set, "signals": int}
    candidates: dict[str, dict[str, Any]] = {}
    edges_written = 0

    for d in hits:
        dd = d.to_dict() or {}
        post_id = dd.get("postId")
        if not post_id or post_id in seen_posts:
            continue
        seen_posts.add(post_id)
        post = posts_col.document(str(post_id)).get()
        if not post.exists:
            continue
        pd = post.to_dict() or {}
        poster = _clean(pd.get("creatorHandle"))
        platform = pd.get("platform") or "instagram"

        related: list[tuple[str, str]] = []  # (handle, via)
        for m in pd.get("mentions") or []:
            related.append((_clean(m), "mention"))
        for t in pd.get("taggedUsers") or []:
            related.append((_clean(t), "tag"))

        for handle, via in related:
            if not handle or handle == poster:
                continue
            if _brand_owned(handle, slug, aliases):
                continue
            # An edge is knowledge about the graph even for tracked creators —
            # SRS wants to know who points at whom. The QUEUE is only for
            # accounts nobody follows yet.
            if poster:
                edge_id = fs.composite_id(platform, f"{poster}_{via}_{handle}")
                edges_col.document(edge_id).set({
                    "srcHandle": poster,
                    "dstHandle": handle,
                    "edgeType": via,
                    "weight": 1.0,
                    "postId": post_id,
                    "updatedAt": SERVER_TIMESTAMP,
                }, merge=True)
                edges_written += 1
            if handle in tracked:
                continue
            entry = candidates.setdefault(handle, {
                "platform": platform, "sources": set(), "signals": 0})
            entry["sources"].add(f"audience:{via}")
            entry["signals"] += 1

    for handle, entry in candidates.items():
        doc_id = fs.composite_id(entry["platform"], handle)
        queue_col.document(doc_id).set({
            "handle": handle,
            "platform": entry["platform"],
            "signalCount": Increment(entry["signals"]),
            # ArrayUnion, not a plain list — merge=True REPLACES arrays, and
            # this run only knows its own contribution (the same lesson the
            # promotion gate in scan_hashtags was once severed by).
            "sources": ArrayUnion(sorted(entry["sources"])),
            "lastSeenAt": SERVER_TIMESTAMP,
            "status": "queued",
        }, merge=True)

    out = {
        "hitsWalked": len(seen_posts),
        "candidates": len(candidates),
        "edgesWritten": edges_written,
    }
    log.info(f"[{brand_id}] expand_audience: {out}")
    return out
