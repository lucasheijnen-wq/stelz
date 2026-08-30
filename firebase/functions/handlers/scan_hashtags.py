"""Hashtag discovery scan.

Reads brand.hashtagPool, scrapes each hashtag via Apify, then:
  1. Writes each scraped post to /brands/{id}/posts so detect-image has context
  2. Fans out detect-image / detect-video Pub/Sub messages directly
     (so we don't depend on scan_creators to revisit these — that's a
     deep-pass for known creators)
  3. Upserts candidate handles to discoveryQueue
  4. Auto-promotes to creators only after handle is seen using
     >= PROMOTION_UNIQUE_TAGS different brand hashtags (quality gate).

The direct fan-out makes a hashtag scan immediately productive: each scan
produces hundreds of detection attempts, not just discovery candidates.
"""
from __future__ import annotations
import datetime as dt
import json
import logging
from concurrent.futures import ThreadPoolExecutor, as_completed
from typing import Any

from google.cloud import pubsub_v1
from google.cloud.firestore import SERVER_TIMESTAMP, ArrayUnion, Increment

# scan_state is load-bearing here: publish_tags closes the hashtags step ITSELF
# on the budget-refused and empty-pool paths (no worker will ever exist to close
# it), and _mark_tag_done closes it from the last Pub/Sub worker. This import
# was missing for four commits — every close raised NameError, the step stayed
# "running" forever, and the dashboard read "Bezig met scannen" for weeks.
# tests/test_handler_imports.py now fails the suite if any handler references a
# name it never imports.
from lib import apify, fanout, fs, hashtags, scan_state, usage

log = logging.getLogger(__name__)

PROJECT_ID = "brand-audit-4b2cc"
DETECT_IMAGE_TOPIC = "detect-image"
DETECT_VIDEO_TOPIC = "detect-video"
SCRAPE_TAG_TOPIC = "scrape-tag"


def _slugify(text: str) -> str:
    """TikTok music URL slug: lowercase, non-alnum → dash."""
    import re
    s = (text or "").lower()
    s = re.sub(r"[^a-z0-9]+", "-", s).strip("-")
    return s or "sound"


def _tiktok_music_url(music_id: str | None, music_name: str | None) -> str | None:
    """Build the public TikTok music page URL from id + name."""
    if not music_id:
        return None
    slug = _slugify(music_name or "original-sound")
    return f"https://www.tiktok.com/music/{slug}-{music_id}"


def _tagged_users(item: dict) -> list[str]:
    """Who is tagged IN the media, normalised to bare handles.

    Instagram sends `taggedUsers: [{username}]`, TikTok `detailedMentions`
    (dicts or strings depending on actor version). Stored on the post doc
    because expand_audience reads it back: a person tagged in a photo of the
    can was AT the party — the warmest discovery signal the data holds, and it
    used to be dropped at ingest.
    """
    out: list[str] = []
    for u in (item.get("taggedUsers") or item.get("detailedMentions") or []):
        name = u.get("username") or u.get("name") if isinstance(u, dict) else u
        h = str(name or "").strip().lstrip("@").lower()
        if h and h not in out:
            out.append(h)
    return out

# How many DIFFERENT hashtags a handle must be seen on before it is auto-promoted
# from discoveryQueue to a tracked creator.
#
# Brand-specific tags (#stelz, #drinkstelz, #stelzhardicedtea) promote on the
# FIRST signal — using one is already brand intent, and requiring cross-tag
# confirmation there throws away the overwhelming majority of good candidates.
# Generic lifestyle tags (#vrijmibo, #koningsdag) still require two distinct
# tags, otherwise every account at a Dutch house party floods the creator list.
#
# NB: promotion is the ONLY route to untagged content — a promoted creator gets
# their whole feed scraped, including posts with no brand hashtag at all. Before
# this was fixed, `sources` was written as a plain array with merge=True, which
# Firestore REPLACES rather than unions; since each Pub/Sub worker handles one
# tag, it was always length 1 and the >= 2 check never passed. Promotion never
# fired, so the untagged funnel was severed. See ArrayUnion in _upsert below.
PROMOTION_UNIQUE_TAGS_GENERIC = 2
PROMOTION_UNIQUE_TAGS_BRAND = 1


def _is_brand_specific_tag(tag: str, brand_slug: str, aliases: list[str] | None = None) -> bool:
    """True when the hashtag contains the brand slug or one of its wordmark
    aliases. #stelz / #drinkstelz / #stelzhardseltzer qualify; #vrijmibo does not.
    Kept brand-agnostic so a second tenant works without a code change."""
    t = (tag or "").lower()
    if not t:
        return False
    needles = {(brand_slug or "").lower()}
    needles.update((a or "").lower() for a in (aliases or []))
    return any(n and n in t for n in needles)


class _PlainTag:
    """A hashtag that came from a caller rather than from the pool.

    Everything downstream expects a Firestore snapshot, so this is the smallest
    thing that behaves like one. `family` is set to brand_core because that is
    what an explicitly requested tag is: the highest-priority kind, never a
    candidate for the stratifier to drop.
    """

    def __init__(self, entry: dict[str, Any]):
        self._d = {
            "tag": entry["tag"],
            "platform": entry.get("platform") or "instagram",
            "family": "brand_core",
            "priority": 10,
            "maxResults": entry.get("maxResults"),
            "active": True,
        }

    def to_dict(self) -> dict[str, Any]:
        return dict(self._d)


def publish_tags(
    brand_id: str,
    per_tag: int = 500,
    max_tags: int = 50,
    tags: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    """Fast publisher: enqueues one Pub/Sub message per active hashtag onto
    the scrape-tag topic. Returns immediately. The on_scrape_tag worker
    processes each tag independently with its own 540s budget.

    `tags` overrides the brand pool with an explicit list of
    {tag, platform?, maxResults?} — that is how an EVENT gets scraped.

    Without it the event pages cannot scrape their own festival. An event's
    hashtags (#lowlands, #lowlands2026) live in its JSON, and nothing copies
    them into the brand pool — deliberately, because a festival tag left in the
    pool is scraped forever after the festival ends. So a scrape started from an
    event page was quietly scanning #vrijmibo and never #lowlands.

    The budget gate, the degrade ladder and the per-tag result cap all still
    apply: an event scrape spends from the same daily budget as any other.
    """
    brand = fs.brand_doc(brand_id).get()
    if not brand.exists:
        raise ValueError(f"brand not found: {brand_id}")

    # Budget gate at PUBLISH time. Apify bills per result, so the cost of a scan
    # is committed the moment we enqueue the tags — refusing 50 messages here is
    # worth far more than refusing each of the 25,000 detections downstream.
    # At the UI defaults (perTag=500, maxTags=50) one click can pull 25,000
    # results ~= $57, against a default daily budget of $5.
    level = usage.degrade_level(brand_id)
    if level >= usage.DEGRADE_NO_SCRAPE:
        log.warning(f"[{brand_id}] scrape refused — budget degrade level {level}")
        out = {"queued": 0, "tags": [], "skipped": "budget", "degradeLevel": level}
        scan_state.step_finished(brand_id, "hashtags", out)
        return out
    if level >= usage.DEGRADE_TRIM:
        per_tag = max(30, per_tag // 2)
        max_tags = max(5, max_tags // 2)
        log.info(f"[{brand_id}] degrade {level}: perTag->{per_tag} maxTags->{max_tags}")

    if tags:
        # Explicit list: no stratified selection, since the caller already chose.
        # Still capped by max_tags so a hand-assembled list cannot outspend the
        # pool path.
        pool_entries = [
            {"tag": str(t.get("tag") or "").lower().lstrip("#"),
             "platform": t.get("platform") or "instagram",
             "maxResults": t.get("maxResults")}
            for t in tags
        ]
        pool_entries = [e for e in pool_entries if e["tag"]][:max_tags]
        if not pool_entries:
            scan_state.step_finished(brand_id, "hashtags", {"queued": 0})
            return {"queued": 0, "tags": []}
        # Wrapped so the rest of this function cannot tell the difference: the
        # budget sizing, the per-tag cap and the publish loop all read a doc-like
        # object. An event scrape must be trimmed by the same guard as any other
        # — it is the same money.
        pool_raw = [_PlainTag(e) for e in pool_entries]
        log.info(f"[{brand_id}] explicit tag list: {len(pool_entries)} tags")
    else:
        pool_raw = list(fs.hashtag_pool_col(brand_id).where("active", "==", True).stream())
        if not pool_raw:
            # Nothing to fan out, so no worker exists to close the step later.
            scan_state.step_finished(brand_id, "hashtags", {"queued": 0})
            return {"queued": 0, "tags": []}

    # Stratified selection, NOT a plain priority sort. A plain sort cut EVERY
    # lifestyle, typo and category tag out of the shipped 117-tag pool at the
    # shipped max_tags=50 — including the entire creator-prospecting surface,
    # which lib/hashtags.py calls the only route to untagged content. See
    # hashtags.select_tags for the measurement. It also costs slightly less:
    # the restored families carry per-tag result caps and displace uncapped ones
    # (18,130 vs 19,200 projected results on the real pool).
    pool_dicts = [{**(d.to_dict() or {}), "_doc": d} for d in pool_raw]
    selected = hashtags.select_tags(pool_dicts, max_tags)

    # ── SIZE THE SCAN TO THE BUDGET BEFORE COMMITTING IT ─────────────────
    # Apify bills at enqueue time, and the degrade ladder above only reacts to
    # spend that already happened: at level 0 it happily let the shipped
    # defaults through — ~$40 projected against a $5 daily budget, the whole
    # day gone in one click and the NEXT click refused. Trim deterministically
    # until the projection fits inside today's remaining room: halve per_tag
    # first (floor 30 — for discovery, breadth of tags beats depth per tag),
    # then shrink max_tags by a quarter WITH re-selection so the family
    # stratification survives (a plain slice would cut the lifestyle floor
    # first, exactly what select_tags exists to prevent). If the floors still
    # project over, proceed at the floors: refusing outright remains the
    # ladder's job, not this guard's.
    APIFY_SHARE = 0.5  # the other half of the day pays Gemini for what lands
    allowed_usd = usage.remaining_budget_usd(brand_id) * APIFY_SHARE
    unit = usage.COST_PER_UNIT["apify_ig_results"]
    trimmed = False
    while hashtags.projected_results(selected, per_tag) * unit > allowed_usd:
        if per_tag > 30:
            per_tag = max(30, per_tag // 2)
            trimmed = True
            continue
        if max_tags > 5:
            max_tags = max(5, int(max_tags * 0.75))
            selected = hashtags.select_tags(pool_dicts, max_tags)
            trimmed = True
            continue
        break
    projected = hashtags.projected_results(selected, per_tag)
    projected_usd = round(projected * unit, 2)
    pool = [d["_doc"] for d in selected]
    log.info(
        f"[{brand_id}] selected {len(pool)}/{len(pool_raw)} tags, "
        f"~{projected} projected Apify results (~${projected_usd})"
        + (f" — TRIMMED to fit ${allowed_usd:.2f} remaining" if trimmed else "")
    )

    # ── BUILD FIRST, RESET SECOND, PUBLISH LAST ──────────────────────────
    # The session reset used to run AFTER the publishes (behind only a 15s
    # publisher flush). A tag worker that finished inside that window had its
    # Increment(1) overwritten by the literal 0 — hashtagDone could then never
    # reach hashtagQueued and finishedAt was never stamped. Nothing may be in
    # flight before the zeroes land.
    payloads: list[dict] = []
    queued: list[str] = []
    for h_doc in pool:
        h = h_doc.to_dict() or {}
        tag = (h.get("tag") or "").lower().lstrip("#")
        platform = h.get("platform") or "instagram"
        if not tag:
            continue
        # Per-tag result cap. Apify bills per RESULT, so one global perTag made
        # a ~0%-yield lifestyle tag cost exactly as much as the brand's own tag
        # (#koningsdag at 500 results = $1.15 to find nothing). Families now
        # carry their own ceiling — see lib/hashtags.FAMILIES. Never raises the
        # caller's number, only lowers it, so the budget-degrade ladder above
        # still wins.
        cap = h.get("maxResults")
        tag_per = min(per_tag, int(cap)) if isinstance(cap, (int, float)) and cap else per_tag
        payloads.append({
            "brandId": brand_id,
            "tag": tag,
            "platform": platform,
            "perTag": tag_per,
        })
        queued.append(f"{platform}:{tag}")

    if not payloads:
        # Every selected tag was blank — no worker will ever close the step.
        scan_state.step_finished(brand_id, "hashtags", {"queued": 0})
        return {"queued": 0, "tags": []}

    # Write the scan session state so the UI can subscribe and show progress
    # without polling. Reset counters at every new scan click. Worker
    # `process_one_tag` increments hashtagDone as it finishes each tag; each
    # detect_image / detect_video invocation increments detectionsCompleted.
    fs.brand_doc(brand_id).set({
        "scan": {
            "startedAt": SERVER_TIMESTAMP,
            "finishedAt": None,
            "hashtagQueued": len(queued),
            "hashtagDone": 0,
            "postsWritten": 0,
            "detectTasksEnqueued": 0,
            "detectionsCompleted": 0,
            "detectionsHit": 0,
            "skippedCount": 0,
            "endReason": None,
            "tags": queued,
            "lastActivityAt": SERVER_TIMESTAMP,
        }
    }, merge=True)

    publisher = pubsub_v1.PublisherClient()
    topic = publisher.topic_path(PROJECT_ID, SCRAPE_TAG_TOPIC)
    futures = [publisher.publish(topic, json.dumps(p).encode()) for p in payloads]
    if futures:
        # Flush the publisher's local futures before the HTTP function returns —
        # an unflushed publish can be dropped when the container is frozen.
        from concurrent.futures import wait as _fwait
        _fwait(futures, timeout=15)

    return {"queued": len(queued), "tags": queued,
            "trimmed": trimmed, "projectedResults": projected,
            "projectedUsd": projected_usd}


def _mark_tag_done(brand_id: str, posts_written: int = 0, detect_tasks: int = 0) -> None:
    """Idempotently bump the per-tag counter. Safe to call from finally so
    the session eventually converges to `hashtagDone == hashtagQueued` even
    if the worker crashed mid-scrape."""
    try:
        fs.brand_doc(brand_id).set({
            "scan": {
                "hashtagDone": Increment(1),
                "postsWritten": Increment(posts_written),
                "detectTasksEnqueued": Increment(detect_tasks),
                "lastActivityAt": SERVER_TIMESTAMP,
            }
        }, merge=True)
        # If we're the last worker, mark finished. Race-safe: same client
        # sees its own Increment, and Firestore merge on the same field with
        # SERVER_TIMESTAMP is idempotent.
        snap = fs.brand_doc(brand_id).get()
        scan = (snap.to_dict() or {}).get("scan") or {}
        done = scan.get("hashtagDone", 0)
        queued = scan.get("hashtagQueued", 0)
        step_open = ((scan.get("steps") or {}).get("hashtags") or {}).get("state") == "running"
        if queued > 0 and done >= queued and (not scan.get("finishedAt") or step_open):
            # ONE WRITE, not two. This used to stamp scan.finishedAt and then
            # call scan_state.step_finished separately, and both failures are
            # swallowed — so a transient Firestore error or the 540s container
            # deadline landing between them left steps.hashtags on 'running'
            # with finishedAt already set. The old guard was `not finishedAt`
            # alone, which made that state PERMANENT: every later worker, and
            # every Pub/Sub redelivery, found finishedAt set and skipped the
            # close, and main.py:70 records that scan_watchdog was removed, so
            # nothing repaired it server-side either. The panel then showed a
            # step pulsing for six hours before the client relabelled it red.
            #
            # A Firestore document write is atomic, so folding both into one
            # update means the pair can no longer half-land. `step_open` is the
            # repair path for sessions already in the broken state.
            fs.brand_doc(brand_id).update({
                "scan.finishedAt": SERVER_TIMESTAMP,
                "scan.endReason": "tags_complete",
                "scan.lastActivityAt": SERVER_TIMESTAMP,
                # The step closes here rather than in the endpoint: publish_tags
                # returns as soon as the fan-out is queued, so the HTTP request
                # is long gone by the time the work is actually finished.
                "scan.steps.hashtags.state": "done",
                "scan.steps.hashtags.finishedAt": SERVER_TIMESTAMP,
                "scan.steps.hashtags.counts": {
                    "hashtagDone": done,
                    "postsWritten": scan.get("postsWritten", 0),
                    "detectTasksEnqueued": scan.get("detectTasksEnqueued", 0),
                },
            })
    except Exception as e:
        log.error(f"_mark_tag_done failed: {e}")


def process_one_tag(brand_id: str, tag: str, platform: str, per_tag: int = 500) -> dict[str, Any]:
    """Pub/Sub worker entrypoint — scrapes ONE hashtag and writes its posts +
    fans out detect-image/video messages. Idempotent: re-running is harmless
    (downstream detect handlers dedupe via imageHashCache + videoProcessed).
    Guarantees the session counter increments even on partial failure so the
    UI never gets stuck at "18/19".
    """
    result: dict[str, Any] = {}
    try:
        result = _do_process_one_tag(brand_id, tag, platform, per_tag)
        return result
    finally:
        _mark_tag_done(
            brand_id,
            posts_written=int(result.get("posts_written") or 0),
            detect_tasks=int((result.get("images_enqueued") or 0) + (result.get("videos_enqueued") or 0)),
        )


def _do_process_one_tag(brand_id: str, tag: str, platform: str, per_tag: int) -> dict[str, Any]:
    brand = fs.brand_doc(brand_id).get()
    if not brand.exists:
        log.warning(f"[scrape-tag] brand not found: {brand_id}")
        return {"status": "skip", "reason": "no_brand"}

    existing_handles = _existing_creator_handles(brand_id)
    posts_col = fs.posts_col(brand_id)
    publisher = pubsub_v1.PublisherClient()
    image_topic = publisher.topic_path(PROJECT_ID, DETECT_IMAGE_TOPIC)
    video_topic = publisher.topic_path(PROJECT_ID, DETECT_VIDEO_TOPIC)
    queue_col = fs.discovery_queue_col(brand_id)

    # ── Scrape ────────────────────────────────────────────────────────
    # Both platforms go through Apify actors. TikTok used to run through our
    # own Playwright function, but TikTok blocks GCP egress IPs and Apify's
    # residential proxy needs a separate password we don't have — clockworks
    # runs on Apify's own proxy pool and just works (same actor the creator
    # scan uses for 500+ videos/run).
    diag: dict | None = None
    try:
        if platform == "instagram":
            items = apify.scrape_hashtag_ig(tag, per_tag)
        else:
            items = apify.scrape_hashtag_tiktok(tag, min(per_tag, 200))
    except Exception as e:
        log.error(f"[scrape-tag] #{tag} scrape failed: {e}")
        _scrape_log(brand_id, tag, platform, error=f"scrape_exception:{type(e).__name__}", diag=diag)
        return {"status": "error", "tag": tag, "reason": "scrape_exception"}

    # Apify bills per RESULT ($2.30/1k), so the result count is the billed unit —
    # recording only the run count under-reports spend by ~11x. See lib/usage.py.
    _n_items = len(items) if items else 0
    if platform == "instagram":
        usage.record(brand_id, apify_runs=1, apify_ig_results=_n_items)
    else:
        usage.record(brand_id, apify_runs=1, apify_tt_results=_n_items)

    if items is None:
        _scrape_log(brand_id, tag, platform, error="scrape_returned_none", diag=diag)
        return {"status": "ok", "tag": tag, "items": 0}

    _audit_scrape(brand_id, tag, platform, items, diag=diag)

    # ── Aggregate + persist + fan out detection ──────────────────────
    candidates: dict[str, dict] = {}
    posts_written = 0
    images_enqueued = 0
    videos_enqueued = 0
    detect_futures: list = []

    for item in items:
        handle = (
            (item.get("ownerUsername") or item.get("authorMeta", {}).get("name") or "")
            .strip()
            .lower()
            .lstrip("@")
        )
        if not handle:
            continue
        entry = candidates.setdefault(
            handle,
            {
                "handle": handle,
                "platform": platform,
                "fullName": item.get("ownerFullName") or item.get("authorMeta", {}).get("nickName"),
                "followerCount": item.get("ownerFollowersCount") or item.get("authorMeta", {}).get("fans"),
                "signalCount": 0,
                "sources": [],
            },
        )
        entry["signalCount"] += 1
        if tag not in entry["sources"]:
            entry["sources"].append(tag)

        wrote, kind, url, cover = _persist_hashtag_post(brand_id, item, platform, handle, posts_col)
        if wrote:
            posts_written += 1
        if wrote and url:
            payload = {"brandId": brand_id, "postId": wrote}
            if kind == "video":
                payload["videoUrl"] = url
                detect_futures.append(("video", publisher.publish(video_topic, json.dumps(payload).encode())))
                # Also analyse the cover. The video path fails often (TikTok
                # blocks GCP egress IPs; IG videoUrls are short-lived signed
                # URLs that expire in the queue) and when it does, this is the
                # only chance the post has of producing any detection at all.
                if cover:
                    detect_futures.append(("image", publisher.publish(
                        image_topic,
                        json.dumps({"brandId": brand_id, "postId": wrote, "imageUrl": cover}).encode(),
                    )))
            else:
                payload["imageUrl"] = url
                detect_futures.append(("image", publisher.publish(image_topic, json.dumps(payload).encode())))

        # IG Sidecar children
        if platform == "instagram" and item.get("type") == "Sidecar":
            for child in (item.get("childPosts") or []):
                c_wrote, c_kind, c_url, c_cover = _persist_sidecar_child(brand_id, item, child, handle, posts_col)
                if c_wrote:
                    posts_written += 1
                if c_wrote and c_url:
                    payload = {"brandId": brand_id, "postId": c_wrote}
                    if c_kind == "video":
                        payload["videoUrl"] = c_url
                        detect_futures.append(("video", publisher.publish(video_topic, json.dumps(payload).encode())))
                        if c_cover:
                            detect_futures.append(("image", publisher.publish(
                                image_topic,
                                json.dumps({"brandId": brand_id, "postId": c_wrote, "imageUrl": c_cover}).encode(),
                            )))
                    else:
                        payload["imageUrl"] = c_url
                        detect_futures.append(("image", publisher.publish(image_topic, json.dumps(payload).encode())))

    candidates_added = 0
    for handle, entry in candidates.items():
        if handle in existing_handles:
            continue
        doc_id = fs.composite_id(platform, handle)
        queue_col.document(doc_id).set(
            {
                "handle": entry["handle"],
                "platform": entry["platform"],
                "fullName": entry.get("fullName"),
                "followerCount": entry.get("followerCount"),
                "signalCount": Increment(entry["signalCount"]),
                # ArrayUnion, not a plain list: merge=True REPLACES an array
                # field, and this worker only ever knows its own single tag.
                # A plain write clobbers every other tag's contribution.
                "sources": ArrayUnion(entry["sources"]),
                "lastSeenAt": SERVER_TIMESTAMP,
                "status": "queued",
            },
            merge=True,
        )
        candidates_added += 1

    # COUNT WHAT LANDED, not what we tried to send. The counters used to be
    # incremented beside each publish() call while this wait inspected no
    # future at all — and concurrent.futures.wait() holds a raised exception
    # silently and abandons anything still pending. Every rejected publish
    # therefore inflated detectTasksEnqueued with a message that never
    # existed, leaving the analysis bar short in a way indistinguishable from
    # dead workers. See lib/fanout.
    images_enqueued, videos_enqueued, _failed = fanout.count_landed(
        brand_id, detect_futures, flush_timeout_s=20)

    # Promote handles out of the queue into tracked creators. One brand-specific
    # tag is enough; generic lifestyle tags need two distinct ones. Filtering on
    # len(sources) in Python — Firestore can't do this server-side. Keeps the
    # query cheap by prefiltering on status.
    _bd = brand.to_dict() or {}
    brand_slug = _bd.get("slug") or brand_id
    brand_aliases = _bd.get("wordmarkAliases") or []
    promoted = 0
    creators_col = fs.creators_col(brand_id)
    queue_to_promote = (
        fs.discovery_queue_col(brand_id)
        .where("status", "==", "queued")
        .stream()
    )
    for q in queue_to_promote:
        q_data = q.to_dict() or {}
        ph = q_data.get("handle")
        pp = q_data.get("platform", "instagram")
        srcs = q_data.get("sources") or []
        needed = (
            PROMOTION_UNIQUE_TAGS_BRAND
            if any(_is_brand_specific_tag(s, brand_slug, brand_aliases) for s in srcs)
            else PROMOTION_UNIQUE_TAGS_GENERIC
        )
        if not ph or ph in existing_handles or len(srcs) < needed:
            continue
        creator_id = fs.composite_id(pp, ph)
        # followerCount and fullName are written ONLY when this scrape actually
        # carried them. Instagram's hashtag endpoint returns neither, so the
        # values here are usually None — and with merge=True, writing None is
        # not a no-op, it OVERWRITES. That silently wiped the follower counts
        # fetched by refresh_profiles on the very next scan, which reads as
        # "the refresh didn't work" long after the refresh worked fine.
        creator_patch = {
            "handle": ph,
            "platform": pp,
            "status": "discovered",
            "tier": "tier_3",
            "discoveredAt": SERVER_TIMESTAMP,
            "discoverySources": q_data.get("sources", []),
            "lastScannedAt": None,
            "nextScanAt": SERVER_TIMESTAMP,
        }
        if q_data.get("followerCount"):
            creator_patch["followerCount"] = q_data["followerCount"]
        if q_data.get("fullName"):
            creator_patch["fullName"] = q_data["fullName"]
        creators_col.document(creator_id).set(creator_patch, merge=True)
        q.reference.update({"status": "auto_added", "reviewedAt": SERVER_TIMESTAMP, "reviewedBy": "scrape_tag"})
        existing_handles.add(ph)
        promoted += 1

    fs.scan_runs_col(brand_id).add({
        "type": "scrape_tag",
        "tag": tag,
        "platform": platform,
        "finishedAt": SERVER_TIMESTAMP,
        "stats": {
            "itemsReturned": len(items),
            "postsWritten": posts_written,
            "imagesEnqueued": images_enqueued,
            "videosEnqueued": videos_enqueued,
            "candidatesAdded": candidates_added,
            "promoted": promoted,
        },
        "status": "ok",
    })

    # Session counters + finishedAt handled in the outer process_one_tag's
    # `finally` block via _mark_tag_done so failed workers still count.

    return {
        "status": "ok",
        "tag": tag,
        "platform": platform,
        "items": len(items),
        "posts_written": posts_written,
        "images_enqueued": images_enqueued,
        "videos_enqueued": videos_enqueued,
        "candidates_added": candidates_added,
        "promoted": promoted,
    }


def run(
    brand_id: str,
    per_tag: int = 200,
    max_tags: int = 16,
    concurrency: int = 10,
    dry_run: bool = False,
) -> dict[str, Any]:
    """Legacy monolithic run — kept for backwards compat but api_step_hashtags
    now uses publish_tags + on_scrape_tag fan-out instead.
    """
    brand = fs.brand_doc(brand_id).get()
    if not brand.exists:
        raise ValueError(f"brand not found: {brand_id}")
    if usage.budget_exhausted(brand_id):
        return {"hashtags_scanned": 0, "candidates_added": 0, "promoted": 0, "skipped": "budget_exhausted"}
    brand_data = brand.to_dict() or {}
    brand_slug = brand_data.get("slug", brand_id)

    # Fetch active hashtag pool — top N by priority to stay under timeout.
    pool_raw = list(fs.hashtag_pool_col(brand_id).where("active", "==", True).stream())
    if not pool_raw:
        log.warning(f"[{brand_slug}] no active hashtags in pool")
        return {"hashtags_scanned": 0, "candidates_added": 0, "promoted": 0}
    pool = sorted(
        pool_raw,
        key=lambda d: (d.to_dict() or {}).get("priority", 0),
        reverse=True,
    )[:max_tags]

    existing_handles = _existing_creator_handles(brand_id)

    candidates_added = 0
    promoted = 0
    hashtags_scanned = 0

    posts_col = fs.posts_col(brand_id)
    publisher = None if dry_run else pubsub_v1.PublisherClient()
    image_topic = None if publisher is None else publisher.topic_path(PROJECT_ID, DETECT_IMAGE_TOPIC)
    video_topic = None if publisher is None else publisher.topic_path(PROJECT_ID, DETECT_VIDEO_TOPIC)
    detect_futures: list = []
    images_enqueued = 0
    videos_enqueued = 0
    posts_written = 0

    # Parallel scrape — each hashtag is an independent Apify run.
    def _scrape_one(h_doc):
        h = h_doc.to_dict() or {}
        tag = h.get("tag", "").lower().lstrip("#")
        platform = h.get("platform", "instagram")
        if not tag:
            return tag, platform, None, None
        try:
            if platform == "instagram":
                items = apify.scrape_hashtag_ig(tag, per_tag)
            else:
                items = apify.scrape_hashtag_tiktok(tag, min(per_tag, 200))
            return tag, platform, items, None
        except Exception as e:
            log.error(f"  apify #{tag} failed: {e}")
            return tag, platform, None, None

    log.info(f"[{brand_slug}] scanning {len(pool)} hashtags @ concurrency={concurrency}")
    results = []
    with ThreadPoolExecutor(max_workers=concurrency) as ex:
        futures = [ex.submit(_scrape_one, h) for h in pool]
        for fut in as_completed(futures):
            results.append(fut.result())
    # Record Apify usage — one actor run per hashtag attempt (succeeded or not).
    usage.record(brand_id, apify_runs=len(pool))

    queue_col = fs.discovery_queue_col(brand_id)

    for tag, platform, items, diag in results:
        if items is None:
            # Apify returned nothing or errored. Log so we can see it in Debug.
            _scrape_log(brand_id, tag, platform, error="apify_returned_none_or_err", diag=diag)
            continue
        hashtags_scanned += 1

        # ── Per-tag visibility: what did Apify actually give us? ──────
        _audit_scrape(brand_id, tag, platform, items, diag=diag)

        # Aggregate candidates per tag + write posts + fan out detect-image/video
        candidates: dict[str, dict] = {}
        for item in items:
            handle = (
                (item.get("ownerUsername") or item.get("authorMeta", {}).get("name") or "")
                .strip()
                .lower()
                .lstrip("@")
            )
            if not handle:
                continue
            entry = candidates.setdefault(
                handle,
                {
                    "handle": handle,
                    "platform": platform,
                    "fullName": item.get("ownerFullName") or item.get("authorMeta", {}).get("nickName"),
                    "followerCount": item.get("ownerFollowersCount") or item.get("authorMeta", {}).get("fans"),
                    "signalCount": 0,
                    "sources": [],
                },
            )
            entry["signalCount"] += 1
            if tag not in entry["sources"]:
                entry["sources"].append(tag)

            # Persist post + fan out detection.
            if not dry_run:
                wrote, kind, url, cover = _persist_hashtag_post(brand_id, item, platform, handle, posts_col)
                if wrote:
                    posts_written += 1
                if wrote and url and publisher:
                    payload = {"brandId": brand_id, "postId": wrote}
                    if kind == "video":
                        payload["videoUrl"] = url
                        detect_futures.append(("video", publisher.publish(video_topic, json.dumps(payload).encode())))
                        if cover:
                            detect_futures.append(("image", publisher.publish(
                                image_topic,
                                json.dumps({"brandId": brand_id, "postId": wrote, "imageUrl": cover}).encode(),
                            )))
                    else:
                        payload["imageUrl"] = url
                        detect_futures.append(("image", publisher.publish(image_topic, json.dumps(payload).encode())))

                # IG Sidecar (carousel): also process each child slot. The
                # parent post above used the cover; child slots may be videos
                # that are otherwise invisible to detection.
                if platform == "instagram" and item.get("type") == "Sidecar":
                    for child in (item.get("childPosts") or []):
                        c_wrote, c_kind, c_url, c_cover = _persist_sidecar_child(
                            brand_id, item, child, handle, posts_col
                        )
                        if c_wrote:
                            posts_written += 1
                        if c_wrote and c_url and publisher:
                            payload = {"brandId": brand_id, "postId": c_wrote}
                            if c_kind == "video":
                                payload["videoUrl"] = c_url
                                detect_futures.append(("video", publisher.publish(video_topic, json.dumps(payload).encode())))
                                if c_cover:
                                    detect_futures.append(("image", publisher.publish(
                                        image_topic,
                                        json.dumps({"brandId": brand_id, "postId": c_wrote, "imageUrl": c_cover}).encode(),
                                    )))
                            else:
                                payload["imageUrl"] = c_url
                                detect_futures.append(("image", publisher.publish(image_topic, json.dumps(payload).encode())))

        if dry_run:
            log.info(f"  DRY #{tag}: {len(candidates)} candidates")
            continue

        for handle, entry in candidates.items():
            if handle in existing_handles:
                continue
            doc_id = fs.composite_id(platform, handle)
            queue_col.document(doc_id).set(
                {
                    "handle": entry["handle"],
                    "platform": entry["platform"],
                    "fullName": entry.get("fullName"),
                    "followerCount": entry.get("followerCount"),
                    "signalCount": Increment(entry["signalCount"]),
                    # See the live path above — merge=True replaces arrays.
                    "sources": ArrayUnion(entry["sources"]),
                    "lastSeenAt": SERVER_TIMESTAMP,
                    "status": "queued",
                },
                merge=True,
            )
            candidates_added += 1

    # Wait on detection publishes so messages flush before function exit —
    # bulk wait with a hard cap. Any laggards after the cap are abandoned
    # (the publish API has already accepted them locally; Pub/Sub publisher
    # client flushes async on process exit).
    # Same rule as the live path above — see lib/fanout.
    images_enqueued, videos_enqueued, _failed = fanout.count_landed(
        brand_id, detect_futures, flush_timeout_s=30)

    # One brand-specific tag promotes; generic tags need two. See the live path.
    _legacy_aliases = brand_data.get("wordmarkAliases") or []
    queue_to_promote = (
        fs.discovery_queue_col(brand_id)
        .where("status", "==", "queued")
        .stream()
    )
    creators_col = fs.creators_col(brand_id)
    for q in queue_to_promote:
        q_data = q.to_dict() or {}
        handle = q_data.get("handle")
        platform = q_data.get("platform", "instagram")
        srcs = q_data.get("sources") or []
        needed = (
            PROMOTION_UNIQUE_TAGS_BRAND
            if any(_is_brand_specific_tag(s, brand_slug, _legacy_aliases) for s in srcs)
            else PROMOTION_UNIQUE_TAGS_GENERIC
        )
        if not handle or handle in existing_handles or len(srcs) < needed:
            continue
        creator_id = fs.composite_id(platform, handle)
        # followerCount and fullName are written ONLY when this scrape actually
        # carried them. Instagram's hashtag endpoint returns neither, so the
        # values here are usually None — and with merge=True, writing None is
        # not a no-op, it OVERWRITES. That silently wiped the follower counts
        # fetched by refresh_profiles on the very next scan, which reads as
        # "the refresh didn't work" long after the refresh worked fine.
        creator_patch = {
            "handle": handle,
            "platform": platform,
            "status": "discovered",
            "tier": "tier_3",
            "discoveredAt": SERVER_TIMESTAMP,
            "discoverySources": q_data.get("sources", []),
            "lastScannedAt": None,
            "nextScanAt": SERVER_TIMESTAMP,
        }
        if q_data.get("followerCount"):
            creator_patch["followerCount"] = q_data["followerCount"]
        if q_data.get("fullName"):
            creator_patch["fullName"] = q_data["fullName"]
        creators_col.document(creator_id).set(creator_patch, merge=True)
        q.reference.update({"status": "auto_added", "reviewedAt": SERVER_TIMESTAMP, "reviewedBy": "scan_hashtags"})
        existing_handles.add(handle)
        promoted += 1

    # Audit log
    fs.scan_runs_col(brand_id).add(
        {
            "type": "scan_hashtags",
            "startedAt": SERVER_TIMESTAMP,
            "finishedAt": SERVER_TIMESTAMP,
            "stats": {
                "hashtagsScanned": hashtags_scanned,
                "candidatesAdded": candidates_added,
                "promoted": promoted,
                "postsWritten": posts_written,
                "imagesEnqueued": images_enqueued,
                "videosEnqueued": videos_enqueued,
            },
            "status": "ok",
        }
    )

    return {
        "hashtags_scanned": hashtags_scanned,
        "candidates_added": candidates_added,
        "promoted": promoted,
        "posts_written": posts_written,
        "images_enqueued": images_enqueued,
        "videos_enqueued": videos_enqueued,
    }


def _persist_hashtag_post(
    brand_id: str,
    item: dict,
    platform: str,
    handle: str,
    posts_col,
) -> tuple[str | None, str, str | None]:
    """Write a post doc from an Apify hashtag-scrape item. Returns
    (post_id, kind, media_url). kind is 'video' or 'image'. media_url is what
    the detect-image/video pipeline should pull."""
    video_url: str | None = None
    music: dict | None = None
    extras_tiktok: dict | None = None
    if platform == "instagram":
        ext_id = str(item.get("id") or item.get("shortCode") or "")
        url = item.get("url")
        caption = item.get("caption") or ""
        hashtags = item.get("hashtags") or []
        mentions = item.get("mentions") or []
        posted_at_iso = item.get("timestamp")
        likes = item.get("likesCount") or 0
        comments = item.get("commentsCount") or 0
        views = item.get("videoViewCount") or 0
        if item.get("type") == "Video" or item.get("videoUrl"):
            video_url = item.get("videoUrl")
        image_url = item.get("displayUrl")
        # IG Reels carry audio in `musicInfo` (name, artist). Falls back to None.
        mi = item.get("musicInfo") or {}
        if mi:
            music = {
                "title": mi.get("songName") or mi.get("song_name") or mi.get("title"),
                "artist": mi.get("artistName") or mi.get("artist_name") or mi.get("author"),
                "original": bool(mi.get("isOriginal")),
            }
    else:  # tiktok
        ext_id = str(item.get("id") or item.get("aweme_id") or "")
        url = item.get("webVideoUrl") or item.get("shareUrl")
        caption = item.get("text") or item.get("desc") or ""
        hashtags = [h.get("name") for h in (item.get("hashtags") or []) if h.get("name")]
        mentions = [m for m in (item.get("mentions") or []) if isinstance(m, str)]
        posted_at_iso = item.get("createTimeISO") or item.get("createTime")
        # Rich TikTok extras — saved on the post for analytics + UI display.
        mm = item.get("musicMeta") or {}
        if mm:
            mid = mm.get("musicId")
            music = {
                "title": mm.get("musicName"),
                "artist": mm.get("musicAuthor"),
                "musicId": mid,
                "original": bool(mm.get("musicOriginal")),
                "playUrl": mm.get("playUrl"),
                "url": _tiktok_music_url(mid, mm.get("musicName")),
                "coverUrl": mm.get("coverMediumUrl") or mm.get("originalCoverMediumUrl"),
            }
        vmeta = item.get("videoMeta") or {}
        ameta = item.get("authorMeta") or {}
        loc = item.get("locationMeta") or {}
        extras_tiktok = {
            "shareCount": item.get("shareCount") or 0,
            "collectCount": item.get("collectCount") or 0,
            "repostCount": item.get("repostCount") or 0,
            "isPinned": bool(item.get("isPinned")),
            "isAd": bool(item.get("isAd")),
            "isSponsored": bool(item.get("isSponsored")),
            "isSlideshow": bool(item.get("isSlideshow")),
            "duration": vmeta.get("duration"),
            "definition": vmeta.get("definition"),
            "width": vmeta.get("width"),
            "height": vmeta.get("height"),
            "effects": [s.get("name") for s in (item.get("effectStickers") or []) if s.get("name")],
            "textLanguage": item.get("textLanguage"),
            "location": ({
                "city": loc.get("locationName") or loc.get("city"),
                "country": loc.get("address"),
            } if loc else None),
            "author": ({
                "nickName": ameta.get("nickName"),
                "avatar": ameta.get("avatar"),
                "verified": bool(ameta.get("verified")),
                "signature": (ameta.get("signature") or "")[:300],
                "profileUrl": ameta.get("profileUrl"),
                "ttSeller": bool(ameta.get("ttSeller")),
                "privateAccount": bool(ameta.get("privateAccount")),
            } if ameta else None),
        }
        likes = item.get("diggCount") or 0
        comments = item.get("commentCount") or 0
        views = item.get("playCount") or 0
        # downloadAddr is usually empty in the free actor; webVideoUrl is the
        # TikTok web page URL which yt-dlp can resolve into an MP4.
        video_url = (
            item.get("videoMeta", {}).get("downloadAddr")
            or item.get("downloadAddr")
            or item.get("videoUrl")
            or item.get("webVideoUrl")
        )
        image_url = item.get("videoMeta", {}).get("coverUrl")

    if not ext_id:
        return None, "image", None, None

    post_id = fs.composite_id(platform, ext_id)
    posted_at = None
    if posted_at_iso:
        try:
            posted_at = (
                dt.datetime.fromisoformat(posted_at_iso.replace("Z", "+00:00"))
                if isinstance(posted_at_iso, str)
                else dt.datetime.fromtimestamp(int(posted_at_iso), dt.timezone.utc)
            )
        except Exception:
            posted_at = None

    # NB: we used to read each post doc here to skip re-publishing. With 800+
    # posts that's 800 Firestore reads in the hot path. Detect-image's
    # imageHashCache and detect_video's videoProcessed flag already do the
    # "skip if already done" work, so dedupe is moved downstream.
    doc = {
        "creatorHandle": handle,
        "platform": platform,
        "externalId": ext_id,
        "url": url,
        "caption": caption[:2000],
        "hashtags": [h.lower() for h in hashtags],
        "mentions": mentions,
        "taggedUsers": _tagged_users(item),
        "postedAt": posted_at,
        "likesCount": likes,
        "commentsCount": comments,
        "viewsCount": views,
        "contentType": "video" if video_url else "image",
        "videoUrl": video_url,
        # Persist the cover even for videos. It used to be computed and thrown
        # away, which meant that when the video download failed there was no
        # fallback image to fall back TO. Storing it makes the post recoverable.
        "coverUrl": image_url,
        "music": music,
        "ingestedAt": SERVER_TIMESTAMP,
        "ingestedBy": "scan_hashtags",
    }
    if extras_tiktok:
        doc["extras"] = extras_tiktok
    posts_col.document(post_id).set(doc, merge=True)

    # 4-tuple: (post_id, kind, primary_url, cover_url). cover_url is only set
    # for videos — for images the primary URL already IS the cover.
    return (
        post_id,
        ("video" if video_url else "image"),
        (video_url or image_url),
        (image_url if video_url else None),
    )


def _slot_of(child: dict) -> int | None:
    """A carousel slide's position, where slide ONE is 0.

    Explicit None checks rather than `or`, because 0 is falsy and 0 is a real
    slot — the first slide of every carousel, and the one the cover comes from.
    """
    for key in ("order", "position"):
        v = child.get(key)
        if v is not None:
            return v
    return None


def _persist_sidecar_child(
    brand_id: str,
    parent: dict,
    child: dict,
    handle: str,
    posts_col,
) -> tuple[str | None, str, str | None, str | None]:
    """Persist one child slot of an IG carousel as its own post + return what to
    fan out: (post_id, kind, primary_url, cover_url). Parent provides
    caption/handle/timestamp; child provides media.
    """
    parent_id = str(parent.get("id") or parent.get("shortCode") or "")
    child_id = str(child.get("id") or child.get("shortCode") or "")
    if not parent_id or not child_id:
        return None, "image", None, None

    is_video = child.get("type") == "Video" or bool(child.get("videoUrl"))
    video_url = child.get("videoUrl") if is_video else None
    image_url = child.get("displayUrl")
    if not video_url and not image_url:
        return None, "image", None, None

    post_id = fs.composite_id("instagram", f"{parent_id}_{child_id}")
    posted_at_iso = parent.get("timestamp")
    posted_at = None
    if posted_at_iso:
        try:
            posted_at = dt.datetime.fromisoformat(posted_at_iso.replace("Z", "+00:00"))
        except Exception:
            posted_at = None

    # Dedupe handled downstream by detect handlers' own caches.
    posts_col.document(post_id).set({
        "creatorHandle": handle,
        "platform": "instagram",
        "externalId": child_id,
        "parentPostId": parent_id,
        # `or` was wrong here: slot 0 is falsy, so the FIRST slide of every
        # carousel was stored with no slot at all. That is the slide the cover
        # image comes from, and a null slot does not match the imported row's
        # explicit 0 — so slide one of every carousel deduped against nothing.
        "carouselSlot": _slot_of(child),
        # THE PARENT'S key, deliberately shared by every slide of the carousel.
        # The metrics below are the parent's, copied onto each slide so a slide
        # can show its post's numbers — which meant a ten-slide carousel with
        # 500 likes reported 5.000 when the rollup counted per row. Slides that
        # agree on postKey collapse to one post before any count is taken, the
        # same rule parentPostKey() already applies to detections. `slot` is
        # what the web client reads; carouselSlot above stays for the callers
        # that already read it.
        "postKey": (parent.get("shortCode") or "").lower() or None,
        "slot": _slot_of(child),
        "url": parent.get("url"),
        "caption": (parent.get("caption") or "")[:2000],
        "hashtags": [h.lower() for h in (parent.get("hashtags") or [])],
        "postedAt": posted_at,
        # Absent is not zero — see the same note in scan_creators._persist_post.
        "likesCount": parent.get("likesCount"),
        "commentsCount": parent.get("commentsCount"),
        "viewsCount": parent.get("videoViewCount"),
        "contentType": "video" if is_video else "image",
        "videoUrl": video_url,
        "coverUrl": image_url,
        "ingestedAt": SERVER_TIMESTAMP,
        "ingestedBy": "scan_hashtags_sidecar",
    }, merge=True)

    return (
        post_id,
        ("video" if is_video else "image"),
        (video_url or image_url),
        (image_url if video_url else None),
    )


def _scrape_log(
    brand_id: str, tag: str, platform: str,
    items_returned: int = 0,
    error: str | None = None,
    breakdown: dict | None = None,
    sample_keys: list[str] | None = None,
    sample: dict | None = None,
    diag: dict | None = None,
) -> None:
    """Write a per-hashtag scrape audit row to /brands/{id}/scrapeLog."""
    try:
        fs.brand_doc(brand_id).collection("scrapeLog").add({
            "tag": tag,
            "platform": platform,
            "itemsReturned": items_returned,
            "error": error,
            "breakdown": breakdown,
            "sampleKeys": sample_keys,
            "sample": sample,
            "diag": diag,
            "source": "scan_hashtags",
            "createdAt": SERVER_TIMESTAMP,
        })
    except Exception:
        pass


def _shrink_value(v, max_str: int = 200):
    if v is None or isinstance(v, (int, float, bool)):
        return v
    if isinstance(v, str):
        return v[:max_str]
    if isinstance(v, list):
        return [_shrink_value(x, 120) for x in v[:5]]
    if isinstance(v, dict):
        return {k: _shrink_value(v[k], 120) for k in list(v.keys())[:12]}
    return f"<{type(v).__name__}>"


def _shrink_sample(sample: dict) -> dict:
    out: dict = {}
    for k in list(sample.keys())[:30]:
        out[k] = _shrink_value(sample[k], 200)
    return out


def _audit_scrape(brand_id: str, tag: str, platform: str, items: list[dict], diag: dict | None = None) -> None:
    """Inspect what Apify gave us so the UI can show why videos are rare."""
    if not items:
        _scrape_log(brand_id, tag, platform, items_returned=0, diag=diag)
        return

    # Type/kind breakdown
    kinds: dict[str, int] = {}
    has_video_url = 0
    has_display_url = 0
    has_download_addr = 0  # tiktok-specific
    for it in items:
        if platform == "instagram":
            t = it.get("type") or "Unknown"
            kinds[t] = kinds.get(t, 0) + 1
            if it.get("videoUrl"):
                has_video_url += 1
            if it.get("displayUrl"):
                has_display_url += 1
        else:  # tiktok — everything is a video
            kinds["Video"] = kinds.get("Video", 0) + 1
            vm = it.get("videoMeta") or {}
            if vm.get("downloadAddr") or it.get("downloadAddr") or it.get("videoUrl"):
                has_download_addr += 1
            # webVideoUrl is the resolvable URL (yt-dlp consumes it). Count it
            # as "has video url" so the audit reflects how many TikToks we can
            # actually process — not how many have a (mostly-empty) CDN URL.
            if it.get("webVideoUrl"):
                has_video_url += 1
            if vm.get("coverUrl"):
                has_display_url += 1

    sample = items[0] if items else None
    sample_keys = sorted(sample.keys()) if isinstance(sample, dict) else None

    # Truncate sample to keep doc small (Firestore 1MB doc limit). Open
    # nested dict / list one level deep so we can see videoMeta/mediaUrls.
    if isinstance(sample, dict):
        sample = _shrink_sample(sample)

    _scrape_log(
        brand_id, tag, platform,
        items_returned=len(items),
        breakdown={
            "kinds": kinds,
            "hasVideoUrl": has_video_url,
            "hasDisplayUrl": has_display_url,
            "hasDownloadAddr": has_download_addr,
        },
        sample_keys=sample_keys,
        sample=sample,
        diag=diag,
    )


def _existing_creator_handles(brand_id: str) -> set[str]:
    """Set of handles already in creators collection (lowercased)."""
    out = set()
    for c in fs.creators_col(brand_id).stream():
        d = c.to_dict() or {}
        h = (d.get("handle") or "").strip().lower()
        if h:
            out.add(h)
    return out
