"""Firebase Cloud Functions entry points (Python 3.11).

Architecture:
  Scheduled (Cloud Scheduler):
    daily_pipeline        07:00 UTC  → hashtags → creators → srs (one function, chained)

  Pub/Sub triggered:
    on_detect_image       topic: detect-image  → OCR → embedding → Gemini → detections
    on_detect_video       topic: detect-video  → frame sample → detect each → detections

  HTTP (UI triggered):
    api_bootstrap_brand          create brand + add caller as owner-member
    api_step_hashtags            manual hashtag discovery
    api_step_creators            manual creator scrape (fans out detect-image/video)
    api_step_srs                 recompute resonance scores
    api_step_sentiment           score post sentiment on unscored hits
    api_step_subcultures         seed scene definitions + file creators into them
    api_step_profiles            refresh creator follower counts / bios / avatars
    api_rate_detection           moderator approve / reject
    api_brand_settings_update    edit brand profile (hashtags, identity, threshold)
    api_brand_members            list / add / remove brand members (access control)

Auth: HTTP functions require Firebase Auth ID token (verified inline).
"""
from __future__ import annotations
import base64
import json
import logging
import os

# Load .env from this directory (functions/) before anything else imports it.
try:
    from dotenv import load_dotenv
    load_dotenv(os.path.join(os.path.dirname(__file__), ".env"))
except ImportError:
    pass

import firebase_admin
from firebase_functions import https_fn, scheduler_fn, options, pubsub_fn
from firebase_admin import auth as fb_auth

# Initialize Admin SDK at module load — required for fb_auth + Firestore.
if not firebase_admin._apps:
    firebase_admin.initialize_app(
        options={"storageBucket": os.getenv("STORAGE_BUCKET", "brand-audit-4b2cc.firebasestorage.app")}
    )

from handlers import (
    analyze_sentiment,
    bootstrap_brand,
    expand_audience,
    import_event,
    projects,
    refresh_profiles,
    seed_subcultures,
    scan_hashtags,
    scan_creators,
    scan_stories,
    detect_image,
    detect_video,
    compute_resonance,
)
from lib import fs, scan_state  # noqa: ensure init

log = logging.getLogger(__name__)
options.set_global_options(region="europe-west1", memory=options.MemoryOption.MB_512)


# ─────────────────── SCHEDULED ───────────────────
# daily_pipeline and scan_watchdog stay removed: feed posts do not expire, so
# they can wait for someone to press Run scan, and the UI detects stalled
# sessions itself (5-min activity heartbeat).
#
# Stories are the one exception, and the reason is not convenience. A story is
# gone 24h after it is posted, so click-driven capture structurally misses
# whatever falls while nobody is looking — a festival weekend is exactly when
# nobody is looking. Any interval <= 24h catches every story; 6h gives 4x
# redundancy, so three consecutive failures still lose nothing.
#
# This is the first unattended spend in the codebase, so it is fenced:
#   - opt-in per brand (storiesAutoScan, absent = off — the kill switch),
#   - bounded (~$0.28 per run at 60 handles, one batched actor run),
#   - and scan_stories re-checks the budget ladder itself before spending.
# It deliberately does not touch brand.scan.steps: an unattended run must not
# repaint the progress panel of a scan a human is watching.


@scheduler_fn.on_schedule(
    # 4-hourly since 2026-08-21, at Lukas's request during Lowlands. A story
    # lives 24h so 6h already caught every one; 4h buys a fresher dashboard
    # while a festival is running, at 6 runs/day instead of 4 (~$1.68/day at
    # 60 handles). Worth returning to 6h once no event is live.
    schedule="every 4 hours",
    region="europe-west1",
    memory=options.MemoryOption.GB_1,
    timeout_sec=540,
)
def scheduled_stories(event: scheduler_fn.ScheduledEvent) -> None:
    for snap in fs.brands_col().stream():
        if (snap.to_dict() or {}).get("storiesAutoScan") is not True:
            continue
        try:
            out = scan_stories.run(snap.id)
            log.info(f"[{snap.id}] scheduled stories: {out}")
        except Exception:
            log.exception(f"scheduled_stories failed for {snap.id}")


# The daily scan is the answer to "show me everything posted with the brand
# TODAY": click-driven scanning covers whatever day someone remembered to
# click. Same fences as scheduled_stories — opt-in per brand (dailyAutoScan,
# absent = off), publish_tags sizes itself to the remaining daily budget
# before committing a dollar, and every handler re-checks the budget ladder.
# 07:00 Amsterdam: yesterday evening's posts are up, the budget day is fresh.
# It does not touch brand.scan.steps beyond what the handlers already write —
# but hashtags DOES reset the scan session block, which is correct here: an
# unattended morning scan is a real scan, and its progress should be what the
# dashboard shows when someone opens it over coffee.
@scheduler_fn.on_schedule(
    schedule="every day 07:00",
    timezone=scheduler_fn.Timezone("Europe/Amsterdam"),
    region="europe-west1",
    memory=options.MemoryOption.GB_1,
    timeout_sec=540,
)
def scheduled_daily_scan(event: scheduler_fn.ScheduledEvent) -> None:
    for snap in fs.brands_col().stream():
        if (snap.to_dict() or {}).get("dailyAutoScan") is not True:
            continue
        bid = snap.id
        # Same order as the dashboard button; each step guards its own budget.
        # Failures are logged per step so one broken step never silences the
        # rest — the exact lesson the button's await-chain taught.
        for name, step in (
            ("hashtags", lambda: scan_hashtags.publish_tags(bid, per_tag=150, max_tags=30)),
            ("creators", lambda: scan_creators.run(bid, max_creators=80, posts_per=8)),
            ("profiles", lambda: refresh_profiles.run(bid)),
            ("subcultures", lambda: seed_subcultures.run(bid)),
            ("audience", lambda: expand_audience.run(bid)),
            ("srs", lambda: compute_resonance.run(bid)),
        ):
            try:
                out = step()
                log.info(f"[{bid}] daily {name}: {out}")
            except Exception:
                log.exception(f"scheduled_daily_scan {name} failed for {bid}")


# ─────────────────── PUB/SUB ───────────────────

def _decode_pubsub(event) -> dict:
    raw = event.data.message.data
    if not raw:
        return {}
    try:
        return json.loads(base64.b64decode(raw))
    except Exception:
        return json.loads(raw)


@pubsub_fn.on_message_published(
    topic="detect-image",
    memory=options.MemoryOption.GB_1,
    timeout_sec=180,
    # Gen2 default concurrency is 80 → one container juggling 80 images
    # shares (and corrupts) the global Gemini client across threads and
    # blows the memory limit. One message per container.
    concurrency=1,
    max_instances=50,
)
def on_detect_image(event: pubsub_fn.CloudEvent[pubsub_fn.MessagePublishedData]) -> None:
    msg = _decode_pubsub(event)
    brand_id, post_id, image_url = msg.get("brandId"), msg.get("postId"), msg.get("imageUrl")
    if not (brand_id and post_id and image_url):
        log.error(f"bad detect-image message: {msg}")
        return
    detect_image.run(brand_id, post_id, image_url)


@pubsub_fn.on_message_published(
    topic="detect-video",
    memory=options.MemoryOption.GB_2,  # video bytes + cv2 frames + OCR model held in RAM
    timeout_sec=300,
    # One video per container. Gen2's default concurrency (80) packed dozens
    # of videos into a single instance: guaranteed OOM at any memory limit,
    # plus cross-thread corruption of the shared Gemini client ("client has
    # been closed", SSL bad record mac).
    concurrency=1,
    max_instances=25,
)
def on_detect_video(event: pubsub_fn.CloudEvent[pubsub_fn.MessagePublishedData]) -> None:
    msg = _decode_pubsub(event)
    brand_id, post_id, video_url = msg.get("brandId"), msg.get("postId"), msg.get("videoUrl")
    if not (brand_id and post_id and video_url):
        log.error(f"bad detect-video message: {msg}")
        return
    detect_video.run(brand_id, post_id, video_url)


# ─────────────────── HTTP (UI) ───────────────────

class NotAuthenticated(Exception):
    """No usable Firebase ID token on the request.

    Raised instead of https_fn.HttpsError because str(HttpsError) is empty:
    every auth failure used to reach the client as `400 {"error": ""}`, which
    tells whoever is debugging it precisely nothing.
    """


class NotABrandMember(Exception):
    """Caller is authenticated but not a member of the brand they addressed.

    Distinct from a generic failure so the handlers can answer 403 rather than
    400/500 — the UI keys its read-only banner off that status code.
    """


def _require_auth(req: https_fn.Request) -> str:
    """Return uid, or raise 401."""
    auth_header = req.headers.get("Authorization", "")
    if not auth_header.startswith("Bearer "):
        raise NotAuthenticated("Not signed in: request carried no Bearer token.")
    token = auth_header.split(" ", 1)[1]
    try:
        decoded = fb_auth.verify_id_token(token)
    except Exception as e:
        raise NotAuthenticated(f"Sign-in token rejected ({type(e).__name__}). Sign out and back in.")
    return decoded["uid"]


# A roster is 28 people across two platforms; 200 is generous headroom and
# still far below a number that could turn one click into a cost incident.
MAX_NAMED_CREATORS = 200


def _creator_ids(body: dict) -> list[str] | None:
    """`creatorIds` from a request body, or None for the brand-wide default.

    None and [] must not mean the same thing. None is "use the due queue";
    an empty list arriving from a caller that meant to name a roster would,
    if treated as None, silently scan the whole brand instead of the event —
    so it stays a list and the handler reports no_creators."""
    raw = body.get("creatorIds")
    if raw is None:
        return None
    if not isinstance(raw, list):
        raise ValueError("creatorIds must be a list of platform_handle ids")
    if len(raw) > MAX_NAMED_CREATORS:
        raise ValueError(f"creatorIds: at most {MAX_NAMED_CREATORS} per call")
    return [str(c).strip().lower() for c in raw if str(c).strip()]


def _require_brand_member(uid: str, brand_id: str) -> None:
    """Every write path goes through here. Non-members get PERMISSION_DENIED.

    This was stubbed out with a bare `return` during the MVP, which meant any
    signed-in Google account could reject detections, edit brand settings and
    start a paid scan on any brand. Testers were being handed the app with a
    doc warning as the only protection. The gate is live again; a tester who is
    not in /brands/{id}/members is read-only by construction, so no separate
    test mode is needed.

    Read access is deliberately NOT gated here — testers must still see
    everything. Reads are governed by firestore.rules.
    """
    member = fs.brand_doc(brand_id).collection("members").document(uid).get()
    if not member.exists:
        raise NotABrandMember(
            "Read-only: your account is not a member of this brand."
        )


@https_fn.on_request(cors=options.CorsOptions(cors_origins=["*"], cors_methods=["POST", "OPTIONS"]))
def api_bootstrap_brand(req: https_fn.Request) -> https_fn.Response:
    """First-run brand creation. Idempotent.

    Any authenticated user can create a brand and become the owner of a brand
    that has no members yet. Calling it against an already-claimed brand still
    succeeds — the UI calls it on the way to a scan — but grants nothing. See
    bootstrap_brand.run step 2.
    """
    if req.method == "OPTIONS":
        return https_fn.Response("", status=204)
    if req.method != "POST":
        return https_fn.Response("Method not allowed", status=405)
    try:
        # Manual auth check so we can grab email too
        auth_header = req.headers.get("Authorization", "")
        if not auth_header.startswith("Bearer "):
            return https_fn.Response(json.dumps({"error": "Missing token"}), status=401, mimetype="application/json")
        decoded = fb_auth.verify_id_token(auth_header.split(" ", 1)[1])
        uid = decoded["uid"]
        email = decoded.get("email")

        body = req.get_json(silent=True) or {}
        brand_id = body.get("brandId") or "stelz"
        brand_name = body.get("brandName") or "Stelz"

        stats = bootstrap_brand.run(brand_id, brand_name, uid, email)
        return https_fn.Response(json.dumps(stats), status=200, mimetype="application/json")
    except Exception as e:
        log.exception("bootstrap_brand failed")
        return https_fn.Response(json.dumps({"error": str(e)}), status=500, mimetype="application/json")


def _run_step(req: https_fn.Request, runner_factory, step: str | None = None,
              completes_inline: bool = True) -> https_fn.Response:
    """Shared boilerplate: auth check + brand membership + run one step.

    `step` also records progress on brand.scan.steps.{step}, which is how the
    UI can show a scan as seven named stages instead of one. Doing it here
    rather than in each handler means no step can be added later and silently
    stay invisible — which is exactly what happened to the five steps that ran
    fire-and-forget behind the hashtag phase.

    completes_inline=False for steps that finish asynchronously (hashtags fans
    out to Pub/Sub workers; the last worker marks it done).
    """
    if req.method == "OPTIONS":
        return https_fn.Response("", status=204)
    if req.method != "POST":
        return https_fn.Response("Method not allowed", status=405)
    brand_id = None
    try:
        uid = _require_auth(req)
        body = req.get_json(silent=True) or {}
        brand_id = body.get("brandId")
        if not brand_id:
            return https_fn.Response(json.dumps({"error": "brandId required"}), status=400, mimetype="application/json")
        _require_brand_member(uid, brand_id)
        if step:
            scan_state.step_started(brand_id, step)
        result = runner_factory(brand_id, body)
        if step and completes_inline:
            scan_state.step_finished(brand_id, step, result if isinstance(result, dict) else {})
        return https_fn.Response(json.dumps(result), status=200, mimetype="application/json")
    except NotAuthenticated as e:
        return https_fn.Response(json.dumps({"error": str(e)}), status=401, mimetype="application/json")
    except NotABrandMember as e:
        return https_fn.Response(json.dumps({"error": str(e)}), status=403, mimetype="application/json")
    except https_fn.HttpsError as e:
        if step and brand_id:
            scan_state.step_failed(brand_id, step, str(e))
        return https_fn.Response(json.dumps({"error": str(e)}), status=400, mimetype="application/json")
    except Exception as e:
        log.exception("step failed")
        if step and brand_id:
            scan_state.step_failed(brand_id, step, str(e))
        return https_fn.Response(json.dumps({"error": str(e)}), status=500, mimetype="application/json")


CORS_POST = options.CorsOptions(cors_origins=["*"], cors_methods=["POST", "OPTIONS"])


@https_fn.on_request(cors=CORS_POST, memory=options.MemoryOption.MB_512, timeout_sec=60)
def api_step_hashtags(req: https_fn.Request) -> https_fn.Response:
    """Step 1/3 — Fans out one Pub/Sub message per active hashtag onto the
    scrape-tag topic. Returns immediately (~3s). Each tag worker (on_scrape_tag
    below) does the actual scrape + persist + detect-fanout with its own 540s
    budget. Look at scrapeLog / scanRuns in the Debug tab for progress."""
    return _run_step(req, lambda brand_id, body: scan_hashtags.publish_tags(
        brand_id,
        per_tag=int(body.get("perTag") or 500),
        max_tags=int(body.get("maxTags") or 50),
        # An event passes its own hashtags; without this the brand pool is
        # scanned and a festival's tags are never reached. See publish_tags.
        tags=body.get("tags") if isinstance(body.get("tags"), list) else None,
    ), step="hashtags", completes_inline=False)


@pubsub_fn.on_message_published(
    topic="scrape-tag",
    memory=options.MemoryOption.GB_1,
    timeout_sec=540,
    region="europe-west1",
)
def on_scrape_tag(event: pubsub_fn.CloudEvent[pubsub_fn.MessagePublishedData]) -> None:
    """One hashtag scrape, end-to-end. Fired by api_step_hashtags fan-out."""
    try:
        raw = event.data.message.data
        decoded = base64.b64decode(raw).decode("utf-8") if raw else "{}"
        payload = json.loads(decoded or "{}")
    except Exception as e:
        log.error(f"on_scrape_tag bad payload: {e}")
        return
    brand_id = payload.get("brandId")
    tag = payload.get("tag")
    platform = payload.get("platform") or "instagram"
    per_tag = int(payload.get("perTag") or 100)
    if not brand_id or not tag:
        log.error(f"on_scrape_tag missing fields: {payload}")
        return
    try:
        scan_hashtags.process_one_tag(brand_id, tag, platform, per_tag=per_tag)
    except Exception:
        log.exception(f"on_scrape_tag #{tag} failed")


@https_fn.on_request(cors=CORS_POST, memory=options.MemoryOption.GB_1, timeout_sec=540)
def api_step_creators(req: https_fn.Request) -> https_fn.Response:
    """Step 2/3 — Apify profile scrape → posts + images + fan-out detect-image/video."""
    return _run_step(req, lambda brand_id, body: scan_creators.run(
        brand_id,
        max_creators=int(body.get("maxCreators") or 80),
        posts_per=int(body.get("postsPer") or 6),
        # An event page names its roster so the scan is not at the mercy of the
        # due queue; the brand-wide button sends nothing and keeps that queue.
        creator_ids=_creator_ids(body),
    ), step="creators")


@https_fn.on_request(cors=CORS_POST, memory=options.MemoryOption.GB_1, timeout_sec=540)
def api_step_stories(req: https_fn.Request) -> https_fn.Response:
    """Instagram stories for tracked creators → posts + detect fan-out.

    Independent of the other steps: nothing downstream reads its output, so the
    UI fires it in parallel rather than in the creators chain.
    """
    return _run_step(req, lambda brand_id, body: scan_stories.run(
        brand_id,
        max_handles=int(body.get("maxHandles") or scan_stories.DEFAULT_MAX_HANDLES),
        creator_ids=_creator_ids(body),
        # A person started this session from the dashboard, so its fan-out
        # belongs in the scan panel's denominator. The 6-hourly scheduler
        # deliberately leaves this off.
        session_counters=True,
    ), step="stories")


@https_fn.on_request(cors=CORS_POST, memory=options.MemoryOption.GB_1, timeout_sec=300)
def api_step_srs(req: https_fn.Request) -> https_fn.Response:
    """Step 3/3 — Compute SRS over all candidates."""
    return _run_step(req, lambda brand_id, body: compute_resonance.run(brand_id), step="srs")


@https_fn.on_request(cors=CORS_POST, memory=options.MemoryOption.MB_512, timeout_sec=540)
def api_step_profiles(req: https_fn.Request) -> https_fn.Response:
    """Refresh Instagram creator profiles (followers, bio, avatar).

    Instagram post rows carry no follower count — verified against the live
    actor — so this separate profile scrape is the only source. Costs about
    $1.15 per 500 creators. See handlers/refresh_profiles.py.
    """
    return _run_step(req, lambda brand_id, body: refresh_profiles.run(
        brand_id,
        limit=int(body.get("limit") or refresh_profiles.DEFAULT_LIMIT),
    ), step="profiles")


@https_fn.on_request(cors=CORS_POST, memory=options.MemoryOption.MB_512, timeout_sec=300)
def api_step_subcultures(req: https_fn.Request) -> https_fn.Response:
    """Seed the brand's subcultures and classify creators into them.

    Must run BEFORE api_step_srs for the subculture layer to contribute — SRS
    reads the links this writes. Pure compute over data already in Firestore:
    no Gemini, no Apify, so it is free to re-run.
    """
    return _run_step(req, lambda brand_id, body: seed_subcultures.run(brand_id), step="subcultures")


@https_fn.on_request(cors=CORS_POST, memory=options.MemoryOption.MB_512, timeout_sec=300)
def api_step_audience(req: https_fn.Request) -> https_fn.Response:
    """Turn the people AROUND recent hits into discovery candidates and edges.

    Reads data already in Firestore (tagged users and mentions on hit posts):
    no Gemini, no Apify, free to re-run. Must run BEFORE api_step_srs — the
    edges this writes are the graph layer SRS reads, which was consuming 30%
    of the hot-mode weight while nothing wrote the collection.
    """
    return _run_step(req, lambda brand_id, body: expand_audience.run(
        brand_id,
        max_hits=int(body.get("maxHits") or expand_audience.DEFAULT_MAX_HITS),
    ), step="audience")


@https_fn.on_request(cors=CORS_POST, memory=options.MemoryOption.GB_1, timeout_sec=300)
def api_import_event(req: https_fn.Request) -> https_fn.Response:
    """Import locally harvested event rows/media — see handlers/import_event.

    Member-gated like every write. No `step`: an import is not a scan session
    and must not repaint the scan panel.
    """
    return _run_step(req, lambda brand_id, body: import_event.run(brand_id, body))


@https_fn.on_request(cors=CORS_POST, memory=options.MemoryOption.MB_512, timeout_sec=540)
def api_step_sentiment(req: https_fn.Request) -> https_fn.Response:
    """Score post sentiment on hits that don't have it yet (batched, resumable).

    Runs after the scan steps rather than inside detection — see the docstring
    of lib/sentiment.py for why the caption must stay out of the detect call.
    One run is capped; call again to continue through a back catalogue.
    """
    return _run_step(req, lambda brand_id, body: analyze_sentiment.run(
        brand_id,
        limit=int(body.get("limit") or analyze_sentiment.DEFAULT_LIMIT),
    ), step="sentiment")


@https_fn.on_request(cors=options.CorsOptions(cors_origins=["*"], cors_methods=["POST", "OPTIONS"]))
def api_rate_detection(req: https_fn.Request) -> https_fn.Response:
    if req.method == "OPTIONS":
        return https_fn.Response("", status=204)
    if req.method != "POST":
        return https_fn.Response("Method not allowed", status=405)
    try:
        uid = _require_auth(req)
        body = req.get_json(silent=True) or {}
        brand_id = body.get("brandId")
        detection_id = body.get("detectionId")
        verdict = body.get("verdict")  # 'confirmed' | 'plausible' | 'rejected'
        if not (brand_id and detection_id and verdict):
            return https_fn.Response(json.dumps({"error": "brandId, detectionId, verdict required"}), status=400, mimetype="application/json")
        _require_brand_member(uid, brand_id)
        from google.cloud.firestore import SERVER_TIMESTAMP
        fs.detections_col(brand_id).document(detection_id).set({
            "verified": verdict == "confirmed",
            "isFalsePositive": verdict == "rejected",
            "moderationLabel": verdict,
            "verifiedBy": uid,
            "verifiedAt": SERVER_TIMESTAMP,
        }, merge=True)
        return https_fn.Response(json.dumps({"ok": True}), status=200, mimetype="application/json")
    except NotAuthenticated as e:
        return https_fn.Response(json.dumps({"error": str(e)}), status=401, mimetype="application/json")
    except NotABrandMember as e:
        return https_fn.Response(json.dumps({"error": str(e)}), status=403, mimetype="application/json")
    except https_fn.HttpsError as e:
        return https_fn.Response(json.dumps({"error": str(e)}), status=400, mimetype="application/json")
    except Exception as e:
        log.exception("rate_detection failed")
        return https_fn.Response(json.dumps({"error": str(e)}), status=500, mimetype="application/json")


# Allowed editable brand fields. Whitelist prevents UI from sneaking in
# server-only fields like visualCentroid, hashtagYield, etc.
_BRAND_EDITABLE_FIELDS = {
    "name", "slug", "website",
    "visualIdentity",      # multiline prompt fragment Gemini sees
    "wordmarkAliases",     # list[str] for OCR shortcut
    "productLines",        # dict[key, label]
    "confidenceMin",       # float, hides feed entries below this
    "embeddingThreshold",  # float, embedding pre-filter cosine
    "dailyBudgetUsd",      # float, budget guard ceiling
    "storiesAutoScan",     # bool, kill switch for the 6-hourly stories scan
    "dailyAutoScan",       # bool, kill switch for the 07:00 daily scan
}


@https_fn.on_request(cors=CORS_POST)
def api_brand_settings_update(req: https_fn.Request) -> https_fn.Response:
    """Settings page write endpoint. Whitelisted brand fields only."""
    if req.method == "OPTIONS":
        return https_fn.Response("", status=204)
    if req.method != "POST":
        return https_fn.Response("Method not allowed", status=405)
    try:
        uid = _require_auth(req)
        body = req.get_json(silent=True) or {}
        brand_id = body.get("brandId")
        patch = body.get("patch") or {}
        if not brand_id or not isinstance(patch, dict):
            return https_fn.Response(json.dumps({"error": "brandId + patch required"}), status=400, mimetype="application/json")
        _require_brand_member(uid, brand_id)

        safe = {k: v for k, v in patch.items() if k in _BRAND_EDITABLE_FIELDS}
        if not safe:
            return https_fn.Response(json.dumps({"error": "no editable fields in patch"}), status=400, mimetype="application/json")

        # Hashtag pool edits go to a subcollection — caller passes a separate
        # `hashtagPool: [{tag, platform, priority, active}]` payload if needed.
        from google.cloud.firestore import SERVER_TIMESTAMP
        safe["updatedAt"] = SERVER_TIMESTAMP
        safe["updatedBy"] = uid
        fs.brand_doc(brand_id).set(safe, merge=True)

        # Optional hashtag pool patch. The new/existing two-regime rule
        # (custom-tag defaults incl. the cost cap vs. never restamping seeded
        # tags) lives in hashtags.pool_patch_docs — pure, tested.
        pool = body.get("hashtagPool")
        if isinstance(pool, list):
            from lib import hashtags as hashtags_lib
            existing = {d.id: d for d in fs.hashtag_pool_col(brand_id).stream()}
            writes = hashtags_lib.pool_patch_docs(pool, set(existing))
            seen = {doc_id for doc_id, _ in writes}
            for doc_id, doc in writes:
                fs.hashtag_pool_col(brand_id).document(doc_id).set(doc, merge=True)
            # Optionally remove tags the client says are gone (body.replaceHashtags)
            if body.get("replaceHashtags") is True:
                for doc_id, doc in existing.items():
                    if doc_id not in seen:
                        doc.reference.delete()

        return https_fn.Response(json.dumps({"ok": True, "patched": list(safe.keys())}), status=200, mimetype="application/json")
    except NotAuthenticated as e:
        return https_fn.Response(json.dumps({"error": str(e)}), status=401, mimetype="application/json")
    except NotABrandMember as e:
        return https_fn.Response(json.dumps({"error": str(e)}), status=403, mimetype="application/json")
    except https_fn.HttpsError as e:
        return https_fn.Response(json.dumps({"error": str(e)}), status=400, mimetype="application/json")
    except Exception as e:
        log.exception("brand_settings_update failed")
        return https_fn.Response(json.dumps({"error": str(e)}), status=500, mimetype="application/json")


@https_fn.on_request(cors=CORS_POST, memory=options.MemoryOption.MB_512, timeout_sec=60)
def api_brand_members(req: https_fn.Request) -> https_fn.Response:
    """List / add / remove brand members. Members only.

    Membership is the entire access model — it decides who can reject
    detections, edit the reference images the detector is trained on, and spend
    money on a scan. Before this endpoint the only ways to grant it were the
    self-enrolment bug (any caller became an owner) and a hand-written Firestore
    document. Neither is something to run a team on.

    Deliberate limits, because this hands out the keys:
      * members only — no self-service. A tester cannot add themselves.
      * an owner cannot be removed by a non-owner, and the LAST owner cannot be
        removed at all. A brand with no owners is unadministrable: nobody can
        add anyone, since adding requires membership.
      * removing yourself is allowed (leaving), subject to the same last-owner
        rule.
    """
    if req.method == "OPTIONS":
        return https_fn.Response("", status=204)
    if req.method != "POST":
        return https_fn.Response("Method not allowed", status=405)
    try:
        uid = _require_auth(req)
        body = req.get_json(silent=True) or {}
        brand_id = body.get("brandId")
        action = (body.get("action") or "list").lower()
        if not brand_id:
            return https_fn.Response(json.dumps({"error": "brandId required"}), status=400, mimetype="application/json")
        _require_brand_member(uid, brand_id)

        members_col = fs.brand_doc(brand_id).collection("members")

        def _list() -> list[dict]:
            out = []
            for d in members_col.stream():
                x = d.to_dict() or {}
                added = x.get("addedAt")
                out.append({
                    "uid": d.id,
                    "email": x.get("email"),
                    "role": x.get("role") or "member",
                    "addedAt": added.isoformat() if hasattr(added, "isoformat") else None,
                    "isYou": d.id == uid,
                })
            out.sort(key=lambda m: (m["role"] != "owner", (m["email"] or "").lower()))
            return out

        if action == "list":
            return https_fn.Response(json.dumps({"members": _list()}), status=200, mimetype="application/json")

        caller = members_col.document(uid).get().to_dict() or {}
        caller_is_owner = caller.get("role") == "owner"

        if action == "add":
            email = (body.get("email") or "").strip().lower()
            role = (body.get("role") or "member").lower()
            if role not in ("member", "owner"):
                return https_fn.Response(json.dumps({"error": "role must be member or owner"}), status=400, mimetype="application/json")
            if role == "owner" and not caller_is_owner:
                return https_fn.Response(json.dumps({"error": "Only an owner can grant owner"}), status=403, mimetype="application/json")
            if not email:
                return https_fn.Response(json.dumps({"error": "email required"}), status=400, mimetype="application/json")
            # The person has to have signed in at least once: membership keys on
            # the Firebase uid, and there is no uid until an account exists.
            # Inviting an address that has never signed in would silently do
            # nothing, so say so instead.
            try:
                user = fb_auth.get_user_by_email(email)
            except Exception:
                return https_fn.Response(
                    json.dumps({"error": f"No account for {email}. Ask them to sign in once first, then add them."}),
                    status=404, mimetype="application/json",
                )
            from google.cloud.firestore import SERVER_TIMESTAMP
            members_col.document(user.uid).set({
                "role": role,
                "email": email,
                "addedAt": SERVER_TIMESTAMP,
                "addedBy": uid,
            }, merge=True)
            return https_fn.Response(json.dumps({"ok": True, "members": _list()}), status=200, mimetype="application/json")

        if action == "remove":
            target = body.get("uid")
            if not target:
                return https_fn.Response(json.dumps({"error": "uid required"}), status=400, mimetype="application/json")
            target_snap = members_col.document(target).get()
            if not target_snap.exists:
                return https_fn.Response(json.dumps({"error": "Not a member"}), status=404, mimetype="application/json")
            target_role = (target_snap.to_dict() or {}).get("role")
            if target_role == "owner":
                if not caller_is_owner:
                    return https_fn.Response(json.dumps({"error": "Only an owner can remove an owner"}), status=403, mimetype="application/json")
                owners = [m for m in _list() if m["role"] == "owner"]
                if len(owners) <= 1:
                    return https_fn.Response(
                        json.dumps({"error": "Can't remove the last owner — the brand would have nobody who can administer it."}),
                        status=409, mimetype="application/json",
                    )
            members_col.document(target).delete()
            return https_fn.Response(json.dumps({"ok": True, "members": _list()}), status=200, mimetype="application/json")

        return https_fn.Response(json.dumps({"error": f"unknown action {action}"}), status=400, mimetype="application/json")
    except NotAuthenticated as e:
        return https_fn.Response(json.dumps({"error": str(e)}), status=401, mimetype="application/json")
    except NotABrandMember as e:
        return https_fn.Response(json.dumps({"error": str(e)}), status=403, mimetype="application/json")
    except https_fn.HttpsError as e:
        return https_fn.Response(json.dumps({"error": str(e)}), status=400, mimetype="application/json")
    except Exception as e:
        log.exception("brand_members failed")
        return https_fn.Response(json.dumps({"error": str(e)}), status=500, mimetype="application/json")



@https_fn.on_request(cors=CORS_POST, memory=options.MemoryOption.MB_512, timeout_sec=60)
def api_projects(req: https_fn.Request) -> https_fn.Response:
    """Creator projects: create / rename / archive / addCreators / removeCreators.

    Thin HTTP wrapper — all rules live in handlers/projects.py so they are
    testable against the in-memory Firestore double, same as bootstrap_brand.
    Members only: adding a creator to a project changes their scan cadence,
    which is spend.
    """
    if req.method == "OPTIONS":
        return https_fn.Response("", status=204)
    if req.method != "POST":
        return https_fn.Response("Method not allowed", status=405)
    try:
        uid = _require_auth(req)
        body = req.get_json(silent=True) or {}
        brand_id = body.get("brandId")
        action = (body.get("action") or "").strip()
        if not brand_id or not action:
            return https_fn.Response(json.dumps({"error": "brandId + action required"}), status=400, mimetype="application/json")
        _require_brand_member(uid, brand_id)
        out = projects.run(brand_id, uid, action, body)
        return https_fn.Response(json.dumps(out), status=200, mimetype="application/json")
    except projects.ProjectError as e:
        return https_fn.Response(json.dumps({"error": str(e)}), status=e.status, mimetype="application/json")
    except NotAuthenticated as e:
        return https_fn.Response(json.dumps({"error": str(e)}), status=401, mimetype="application/json")
    except NotABrandMember as e:
        return https_fn.Response(json.dumps({"error": str(e)}), status=403, mimetype="application/json")
    except Exception as e:
        log.exception("api_projects failed")
        return https_fn.Response(json.dumps({"error": str(e)}), status=500, mimetype="application/json")

@https_fn.on_request(cors=CORS_POST, memory=options.MemoryOption.MB_512, timeout_sec=120)
def api_recompute_centroid(req: https_fn.Request) -> https_fn.Response:
    """Recompute the brand visual centroid from current reference images.
    Called after the user uploads/removes a reference image."""
    if req.method == "OPTIONS":
        return https_fn.Response("", status=204)
    if req.method != "POST":
        return https_fn.Response("Method not allowed", status=405)
    try:
        uid = _require_auth(req)
        body = req.get_json(silent=True) or {}
        brand_id = body.get("brandId")
        if not brand_id:
            return https_fn.Response(json.dumps({"error": "brandId required"}), status=400, mimetype="application/json")
        _require_brand_member(uid, brand_id)
        from lib import embedding
        centroid, diag = embedding.compute_centroid(brand_id)
        return https_fn.Response(
            json.dumps({
                "ok": True,
                "computed": centroid is not None,
                "dims": len(centroid) if centroid else 0,
                "refsFound": diag.get("refsFound", 0),
                "refsUsed": diag.get("refsUsed", 0),
                "fetchErrors": diag.get("fetchErrors", []),
                "embedErrors": diag.get("embedErrors", 0),
            }),
            status=200, mimetype="application/json",
        )
    except NotAuthenticated as e:
        return https_fn.Response(json.dumps({"error": str(e)}), status=401, mimetype="application/json")
    except NotABrandMember as e:
        return https_fn.Response(json.dumps({"error": str(e)}), status=403, mimetype="application/json")
    except https_fn.HttpsError as e:
        return https_fn.Response(json.dumps({"error": str(e)}), status=400, mimetype="application/json")
    except Exception as e:
        log.exception("recompute_centroid failed")
        return https_fn.Response(json.dumps({"error": str(e)}), status=500, mimetype="application/json")
