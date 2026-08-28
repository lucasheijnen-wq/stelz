"""Creator projects — named groups of creators a brand actively tracks.

The client ask ("creators in project gooien en dan tracken") has two halves and
the second is the one with teeth. Grouping is a Firestore array. TRACKING means
the project's creators are scanned on the fast cadence: adding a creator patches
their doc to the project's trackingTier, and the existing cadence map in
scan_creators ({tier_1: 6h, tier_2: 12h, tier_3: 48h}) does the rest. That
finally gives the tier system its first real writer — until now nothing ever
set anything but tier_3, and the DetectionDrawer's "Promote to tier 1" button
had no onClick.

THE CAPS ARE NOT OPTIONAL. tier_1 means an 8x scrape cadence per creator
(48h -> 6h). One enthusiastic project with 200 members would silently multiply
the brand's Apify spend and starve the hashtag scans out of the shared $5/day
budget ladder. So two caps hold, server-side, and the errors say why: a tight
one on DISTINCT creators at effective tier_1 (the 8x cadence), and a wider one
on distinct creators tracked by any live project at all. Campaign rosters (the
Lowlands list is 53 platform-ids) fit comfortably under the wide cap at tier_2
without ever touching the expensive one.

Kept as a handler (main.py wraps it in the HTTP endpoint) so it is testable the
same way bootstrap_brand is: against an in-memory Firestore double, no emulator.
"""
from __future__ import annotations

import logging
from datetime import date
from typing import Any

from google.cloud.firestore import SERVER_TIMESTAMP, ArrayRemove, ArrayUnion

from lib import fs

log = logging.getLogger(__name__)

# Two caps. TIER1 guards the expensive 6h cadence (8x scrape cost per
# creator); TOTAL guards the overall tracked width across all live projects,
# any tier. Distinct creators in both cases.
TIER1_TRACKED_CAP = 25
TOTAL_TRACKED_CAP = 150

# What a project may track. tier_3 deliberately absent: it is the default
# cadence, so "tracking at tier_3" would be a no-op sold as a feature.
ALLOWED_TIERS = ("tier_1", "tier_2")

MAX_NAME_LEN = 80
MAX_NOTE_LEN = 500
MAX_FULLNAME_LEN = 120
# A project that is an EVENT also has a period and a set of tags. Both optional:
# a project can still be a plain shortlist with no dates at all, and every doc
# written before this existed keeps working without a migration.
MAX_HASHTAGS = 40
MAX_HASHTAG_LEN = 60
# One call must fit a whole campaign roster (the Lowlands list is 53 ids): the
# post-write rollback makes a single call all-or-nothing, while client-side
# chunking could strand a half-imported project when a later chunk trips a cap.
MAX_CREATORS_PER_CALL = 100


class ProjectError(Exception):
    """Validation / business-rule failure with an HTTP status. main.py maps it."""

    def __init__(self, msg: str, status: int = 400):
        super().__init__(msg)
        self.status = status


def _serialize(doc_id: str, d: dict) -> dict:
    created = d.get("createdAt")
    updated = d.get("updatedAt")
    return {
        "id": doc_id,
        "name": d.get("name"),
        "note": d.get("note"),
        "trackingTier": d.get("trackingTier"),
        "creatorIds": list(d.get("creatorIds") or []),
        "archived": bool(d.get("archived")),
        "createdBy": d.get("createdBy"),
        "createdAt": created.isoformat() if hasattr(created, "isoformat") else None,
        "updatedAt": updated.isoformat() if hasattr(updated, "isoformat") else None,
        # When this project is an event. None on every project that predates
        # the field, which is what the client reads as "not an event".
        "startsAt": d.get("startsAt"),
        "endsAt": d.get("endsAt"),
        "hashtags": list(d.get("hashtags") or []),
    }


def _clean_date(value: Any, field: str) -> str | None:
    """A calendar day as 'YYYY-MM-DD', or None.

    A string, not a timestamp. Every date comparison downstream is already
    lexicographic on ISO text, and a festival day has no timezone of its own —
    storing an instant would force a conversion at both ends to answer a
    question that was never about instants.
    """
    if value in (None, ""):
        return None
    text = str(value).strip()[:10]
    try:
        date.fromisoformat(text)
    except ValueError:
        raise ProjectError(f"{field} must be YYYY-MM-DD, got {value!r}")
    return text


def _clean_hashtags(value: Any) -> list[str]:
    """Tags as the platforms spell them: lowercase, no '#', no duplicates."""
    if value in (None, ""):
        return []
    if not isinstance(value, list):
        raise ProjectError("hashtags must be a list")
    if len(value) > MAX_HASHTAGS:
        raise ProjectError(f"too many hashtags (max {MAX_HASHTAGS})")
    out: list[str] = []
    for t in value:
        tag = str(t).strip().lstrip("#").lower()[:MAX_HASHTAG_LEN]
        if tag and tag not in out:
            out.append(tag)
    return out


def _event_patch(body: dict, existing: dict | None = None) -> dict:
    """The event fields present in `body`, validated.

    Absent keys are left alone rather than cleared: a rename that does not
    mention dates must not wipe them. An explicit null does clear — that is how
    a project stops being an event.
    """
    patch: dict[str, Any] = {}
    if "startsAt" in body:
        patch["startsAt"] = _clean_date(body.get("startsAt"), "startsAt")
    if "endsAt" in body:
        patch["endsAt"] = _clean_date(body.get("endsAt"), "endsAt")
    if "hashtags" in body:
        patch["hashtags"] = _clean_hashtags(body.get("hashtags"))

    # Checked against what the doc will actually hold, not only against what
    # this call sent: moving `endsAt` earlier than a `startsAt` the caller never
    # mentioned is the same mistake as sending both the wrong way round.
    start = patch.get("startsAt", (existing or {}).get("startsAt"))
    end = patch.get("endsAt", (existing or {}).get("endsAt"))
    if start and end and end < start:
        raise ProjectError("endsAt cannot be before startsAt")
    return patch


def _live_projects(brand_id: str) -> list[tuple[str, dict]]:
    out = []
    for doc in fs.projects_col(brand_id).stream():
        d = doc.to_dict() or {}
        if not d.get("archived"):
            out.append((doc.id, d))
    return out


def _tracked_union(
    projects: list[tuple[str, dict]],
    exclude_id: str | None = None,
    only_tier: str | None = None,
) -> set[str]:
    """Distinct creator ids across live projects (optionally excluding one).

    only_tier narrows to projects of that tracking tier. The `or "tier_1"`
    default MUST mirror _effective_tier: a creator is effective tier_1 exactly
    when some live tier_1 project claims them, so the union of tier_1 projects'
    members IS the tier_1-cap set.
    """
    union: set[str] = set()
    for pid, d in projects:
        if pid == exclude_id:
            continue
        if only_tier is not None and (d.get("trackingTier") or "tier_1") != only_tier:
            continue
        union.update(d.get("creatorIds") or [])
    return union


def _check_caps(total: set[str], tier1: set[str]) -> None:
    """Raise 409 when either cap is exceeded. Both messages keep the word
    "budget" — the UI shows them verbatim and the tests key on it."""
    if len(tier1) > TIER1_TRACKED_CAP:
        raise ProjectError(
            f"Tier-1 tracking cap reached: {TIER1_TRACKED_CAP} creators at the 6h cadence. "
            f"Tier-1 creators are scanned 8x as often, and this cap is what keeps that from "
            f"consuming the daily scan budget. Track this group at tier_2 instead, or free "
            f"tier-1 slots (remove creators or archive a tier-1 project).",
            status=409,
        )
    if len(total) > TOTAL_TRACKED_CAP:
        raise ProjectError(
            f"Tracking cap reached: {TOTAL_TRACKED_CAP} creators across all projects. Every "
            f"tracked creator is scanned on a faster cadence, and this cap protects the daily "
            f"scan budget. Remove creators from a project (or archive one) to free slots.",
            status=409,
        )


def _effective_tier(live: list[tuple[str, dict]], cid: str) -> str | None:
    """The tier a creator SHOULD carry: the fastest cadence among the live
    projects that claim them, or None when no project does.

    This exists because a per-project stamp is wrong in both directions
    (review-confirmed): adding a tier_1-tracked creator to a tier_2 project
    silently downgraded them to 12h, and removing them from the tier_1 project
    while a tier_2 project remained left the 6h cadence running forever — a 2x
    cost leak with nothing that would ever correct it. Every membership change
    now recomputes from the projects that actually claim the creator.
    """
    tiers = [
        d.get("trackingTier") or "tier_1"
        for _, d in live
        if cid in (d.get("creatorIds") or [])
    ]
    if not tiers:
        return None
    return "tier_1" if "tier_1" in tiers else "tier_2"


def _restamp(brand_id: str, creator_ids: list[str], live: list[tuple[str, dict]]) -> int:
    """Reconcile creator docs with the projects that claim them.

    Untracked creators go back to tier_3. Only the tier is patched — nextScanAt
    is left alone, so an in-flight fast scan completes and the next cycle simply
    schedules at the new cadence. Returns how many reverted to tier_3.
    """
    reverted = 0
    for cid in creator_ids:
        tier = _effective_tier(live, cid)
        if tier is None:
            fs.creators_col(brand_id).document(cid).set({"tier": "tier_3"}, merge=True)
            reverted += 1
        else:
            fs.creators_col(brand_id).document(cid).set({"tier": tier}, merge=True)
    return reverted


def run(brand_id: str, uid: str, action: str, body: dict[str, Any]) -> dict[str, Any]:
    col = fs.projects_col(brand_id)

    if action == "create":
        name = (body.get("name") or "").strip()
        if not name:
            raise ProjectError("name required")
        if len(name) > MAX_NAME_LEN:
            raise ProjectError(f"name too long (max {MAX_NAME_LEN})")
        tier = body.get("trackingTier") or "tier_1"
        if tier not in ALLOWED_TIERS:
            raise ProjectError(f"trackingTier must be one of {ALLOWED_TIERS}")
        event = _event_patch(body)
        doc_id = fs.composite_id(name)[:60] or "project"
        if col.document(doc_id).get().exists:
            raise ProjectError(f'A project named "{name}" already exists', status=409)
        col.document(doc_id).set({
            "name": name,
            "note": (body.get("note") or "")[:MAX_NOTE_LEN],
            "trackingTier": tier,
            "creatorIds": [],
            "archived": False,
            "createdBy": uid,
            "createdAt": SERVER_TIMESTAMP,
            "updatedAt": SERVER_TIMESTAMP,
            # Written explicitly, even when absent from the body, so every doc
            # created from here on has the same shape and a reader never has to
            # tell "no dates" apart from "created before dates existed".
            "startsAt": event.get("startsAt"),
            "endsAt": event.get("endsAt"),
            "hashtags": event.get("hashtags") or [],
        })
        return {"ok": True, "project": _serialize(doc_id, col.document(doc_id).get().to_dict() or {})}

    # Every other action addresses an existing project.
    project_id = body.get("projectId")
    if not project_id:
        raise ProjectError("projectId required")
    snap = col.document(project_id).get()
    if not snap.exists:
        raise ProjectError("project not found", status=404)
    project = snap.to_dict() or {}

    if action == "rename":
        patch: dict[str, Any] = {}
        if "name" in body:
            name = (body.get("name") or "").strip()
            if not name:
                raise ProjectError("name cannot be empty")
            if len(name) > MAX_NAME_LEN:
                raise ProjectError(f"name too long (max {MAX_NAME_LEN})")
            patch["name"] = name
        if "note" in body:
            patch["note"] = (body.get("note") or "")[:MAX_NOTE_LEN]
        patch.update(_event_patch(body, project))
        if not patch:
            raise ProjectError(
                "nothing to rename — pass name, note, startsAt, endsAt and/or hashtags")
        patch["updatedAt"] = SERVER_TIMESTAMP
        col.document(project_id).set(patch, merge=True)
        return {"ok": True, "project": _serialize(project_id, col.document(project_id).get().to_dict() or {})}

    if action == "addCreators":
        ids = body.get("creatorIds")
        if not isinstance(ids, list) or not ids:
            raise ProjectError("creatorIds (non-empty list) required")
        if len(ids) > MAX_CREATORS_PER_CALL:
            raise ProjectError(f"max {MAX_CREATORS_PER_CALL} creators per call")
        ids = [str(c).strip().lower() for c in ids if str(c).strip()]
        if project.get("archived"):
            raise ProjectError("project is archived — unarchive it first", status=409)
        bad = [c for c in ids if "_" not in c]
        if bad:
            raise ProjectError(f"creatorIds must be platform_handle composites, got: {', '.join(bad[:3])}")

        # Optional display names ({compositeId: name}) from list imports, so a
        # roster shows "Pleun Bierbooms" instead of a bare handle before the
        # first profile refresh. Truncated, not rejected — same convention as
        # note. Keys lowercased to line up with the normalized ids above.
        names_raw = body.get("names") or {}
        if not isinstance(names_raw, dict):
            raise ProjectError("names must be an object of creatorId -> displayName")
        names: dict[str, str] = {}
        for k, v in names_raw.items():
            key, val = str(k).strip().lower(), str(v).strip()[:MAX_FULLNAME_LEN]
            if key and val:
                names[key] = val

        # THE COST CAPS, fast path. This check races (two concurrent adds can
        # both pass — no transactions here), so it is re-checked AFTER the write
        # below; this pre-check just avoids a pointless write in the common case.
        this_tier = project.get("trackingTier") or "tier_1"
        live = _live_projects(brand_id)
        total = _tracked_union(live) | set(ids)
        tier1 = _tracked_union(live, only_tier="tier_1")
        if this_tier == "tier_1":
            tier1 |= set(ids)
        _check_caps(total, tier1)

        # Creators the pipeline has seen but never promoted get a tracking stub
        # HERE rather than a 404. This matters because the drawer's "Track in
        # project" is used on FEED detections, and most feed creators were never
        # promoted (promotion needs 2 distinct generic tags) — a 404 would make
        # the button fail for exactly the "found someone great, follow them"
        # moment the feature exists for. status "discovered" puts the stub on
        # the same path scan_creators already selects.
        for cid in ids:
            snap_c = fs.creators_col(brand_id).document(cid).get()
            if not snap_c.exists:
                platform, _, handle = cid.partition("_")
                stub: dict[str, Any] = {
                    "handle": handle,
                    "platform": platform,
                    "status": "discovered",
                    "tier": "tier_3",  # real tier stamped below via _restamp
                    "addedVia": "project",
                    "createdAt": SERVER_TIMESTAMP,
                    # In the stub write itself, not only in the later per-cid
                    # stamp: the scanner's inequality filter skips docs missing
                    # nextScanAt entirely, so a failure of that later write
                    # would otherwise leave a permanently invisible creator.
                    "nextScanAt": SERVER_TIMESTAMP,
                }
                if cid in names:
                    stub["fullName"] = names[cid]
                fs.creators_col(brand_id).document(cid).set(stub, merge=True)
            elif cid in names and not (snap_c.to_dict() or {}).get("fullName"):
                # Backfill only — the Apify profile refresh owns fullName once
                # real platform data exists; an import must never overwrite it.
                fs.creators_col(brand_id).document(cid).set({"fullName": names[cid]}, merge=True)

        # ArrayUnion, not read-modify-write: two teammates adding simultaneously
        # must both land. The merge=True-replaces-arrays trap is documented at
        # scan_hashtags.py:58-64 — same lesson.
        # Only the ids this call actually ADDS are written, and therefore only
        # those can be rolled back below. Re-adding an existing member is normal
        # — the paste-import flow re-sends a whole roster, overlaps included —
        # and rolling back the raw `ids` would remove creators whose membership
        # predates this call and had nothing to do with the cap breach.
        # _restamp would then demote them to tier_3 and tracking would stop.
        already = set(project.get("creatorIds") or [])
        added = [c for c in ids if c not in already]

        if added:
            col.document(project_id).set({
                "creatorIds": ArrayUnion(added),
                "updatedAt": SERVER_TIMESTAMP,
            }, merge=True)

        # Post-write re-check (review-confirmed TOCTOU): re-read the unions and
        # ROLL BACK this addition if a concurrent add pushed either past its
        # cap. Not bulletproof — two racers can both roll back — but it converts
        # "cap silently breached forever" into "briefly exceeded, then repaired,
        # caller gets the honest error".
        live = _live_projects(brand_id)
        try:
            _check_caps(_tracked_union(live), _tracked_union(live, only_tier="tier_1"))
        except ProjectError:
            if added:
                col.document(project_id).set({"creatorIds": ArrayRemove(added)}, merge=True)
                live = _live_projects(brand_id)
                _restamp(brand_id, added, live)
            raise

        # Tier via _effective_tier, not a blind stamp of THIS project's tier —
        # a creator also tracked by a faster project must keep the fast cadence.
        _restamp(brand_id, ids, live)
        for cid in ids:
            # nextScanAt now → eligible on the very next creator-scan run,
            # which is what "start tracking" should mean.
            fs.creators_col(brand_id).document(cid).set({"nextScanAt": SERVER_TIMESTAMP}, merge=True)
        log.info(f"[{brand_id}] project {project_id}: +{len(ids)} creators at {this_tier} (by {uid})")
        return {"ok": True, "project": _serialize(project_id, col.document(project_id).get().to_dict() or {})}

    if action == "removeCreators":
        ids = body.get("creatorIds")
        if not isinstance(ids, list) or not ids:
            raise ProjectError("creatorIds (non-empty list) required")
        ids = [str(c).strip().lower() for c in ids if str(c).strip()]
        # ArrayRemove, NOT a filtered-array overwrite. The overwrite variant
        # (review-confirmed HIGH) clobbered a concurrent teammate's ArrayUnion
        # add: their creator vanished from the project while keeping tier_1 on
        # the creator doc — scanned at 8x cost forever, claimed by nothing,
        # repaired by nothing.
        col.document(project_id).set({
            "creatorIds": ArrayRemove(ids),
            "updatedAt": SERVER_TIMESTAMP,
        }, merge=True)
        reverted = _restamp(brand_id, ids, _live_projects(brand_id))
        return {
            "ok": True, "reverted": reverted,
            "project": _serialize(project_id, col.document(project_id).get().to_dict() or {}),
        }

    if action == "archive":
        col.document(project_id).set({
            "archived": True,
            "updatedAt": SERVER_TIMESTAMP,
        }, merge=True)
        # Everything this project tracked reconciles against the remaining live
        # projects: unclaimed creators revert, creators a slower project still
        # claims drop to that project's cadence.
        reverted = _restamp(brand_id, list(project.get("creatorIds") or []), _live_projects(brand_id))
        return {
            "ok": True, "reverted": reverted,
            "project": _serialize(project_id, col.document(project_id).get().to_dict() or {}),
        }

    if action == "unarchive":
        # The addCreators error says "unarchive it first", so the action has to
        # exist (review finding: it didn't). Reviving a project re-claims its
        # members' fast cadence, so it must pass the same cap the add path does.
        if not project.get("archived"):
            raise ProjectError("project is not archived")
        members = set(project.get("creatorIds") or [])
        live = _live_projects(brand_id)
        total = _tracked_union(live) | members
        tier1 = _tracked_union(live, only_tier="tier_1")
        if (project.get("trackingTier") or "tier_1") == "tier_1":
            tier1 |= members
        _check_caps(total, tier1)
        col.document(project_id).set({
            "archived": False,
            "updatedAt": SERVER_TIMESTAMP,
        }, merge=True)
        _restamp(brand_id, list(project.get("creatorIds") or []), _live_projects(brand_id))
        return {"ok": True, "project": _serialize(project_id, col.document(project_id).get().to_dict() or {})}

    raise ProjectError(f"unknown action {action}")
