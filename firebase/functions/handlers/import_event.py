"""Event import: locally harvested archives become production Firestore docs.

WHY THIS EXISTS. The Lowlands campaign was harvested and analysed LOCALLY
(tools/stelz_brand_watch 6x-7x) because the Cloud Functions pipeline did not
exist yet when the festival ran. The dashboard's event pages read that local
data through dev-server preview fixtures — which means that in production the
same pages say "Nog geen data". This handler is the bridge: a member POSTs the
fixture rows (already deduped and event-attributed by 72_campaign_fixture) and
they land in the SAME posts/detections collections the live pipeline writes,
in the SAME shape, plus an `eventId` field the event pages query on.

Three actions, all member-gated by main.py's _run_step boilerplate:

  rows      — up to ~450 post/detection docs per call (Firestore batch limit
              is 500 writes). Doc ids are supplied by the uploader and are
              deterministic, so re-running an upload is an upsert, not a dupe.
  media     — one image, base64. Stored content-addressed under the SAME path
              scheme detect_image mirrors to (thumbnails/{brand}/{sha16}.jpg),
              made public, URL returned. Content-addressing makes retries free
              and collisions impossible.
  audience  — the event's audience summary as one doc
              (/brands/{id}/eventAudience/{eventId}). It is an analysis
              artefact, not row data, so it gets a doc, not a collection.

Timestamps arrive as ISO strings (JSON has no other way) and are converted to
real datetimes here — a postedAt stored as a string would silently fall out of
every postedAt-ordered query in the app.
"""
from __future__ import annotations

import base64
import datetime as dt
import hashlib
import logging
from typing import Any

from lib import fs

log = logging.getLogger(__name__)

MAX_ROWS = 450  # Firestore batch cap is 500 writes; headroom for safety.

# Fields that must be Timestamps in Firestore. Strings would sort wrongly and
# fall out of range queries; naming them here beats guessing by suffix.
TS_FIELDS = {"postedAt", "expiresAt", "ingestedAt"}


def _to_ts(value: Any) -> Any:
    if isinstance(value, str) and value:
        try:
            return dt.datetime.fromisoformat(value.replace("Z", "+00:00"))
        except ValueError:
            return None
    return value


def _clean_doc(data: dict) -> dict:
    out = {}
    for k, v in (data or {}).items():
        out[k] = _to_ts(v) if k in TS_FIELDS else v
    return out


def run(brand_id: str, body: dict) -> dict[str, Any]:
    action = body.get("action") or "rows"

    if action == "media":
        b64 = body.get("b64") or ""
        content_type = body.get("contentType") or "image/jpeg"
        raw = base64.b64decode(b64)
        if not raw:
            raise ValueError("media: empty payload")
        digest = hashlib.sha256(raw).hexdigest()[:16]
        ext = "jpg" if "jpeg" in content_type or "jpg" in content_type else \
              "png" if "png" in content_type else "webp"
        path = f"thumbnails/{brand_id}/{digest}.{ext}"
        bucket = fs.bucket()
        blob = bucket.blob(path)
        if not blob.exists():
            blob.upload_from_string(raw, content_type=content_type)
            blob.make_public()
        return {"url": blob.public_url, "path": path, "bytes": len(raw)}

    if action == "audience":
        event_id = body.get("eventId")
        data = body.get("data")
        if not event_id or not isinstance(data, dict):
            raise ValueError("audience: eventId and data required")
        fs.brand_doc(brand_id).collection("eventAudience").document(event_id).set(
            {**data, "importedAt": dt.datetime.now(dt.timezone.utc)})
        return {"written": 1, "eventId": event_id}

    if action == "rows":
        posts = body.get("posts") or []
        detections = body.get("detections") or []
        if len(posts) + len(detections) > MAX_ROWS:
            raise ValueError(f"rows: at most {MAX_ROWS} docs per call")
        batch = fs.db().batch()
        posts_col = fs.posts_col(brand_id)
        det_col = fs.detections_col(brand_id)
        for row in posts:
            doc_id, data = row.get("id"), row.get("data")
            if not doc_id or not isinstance(data, dict):
                raise ValueError("rows: every post needs id + data")
            batch.set(posts_col.document(str(doc_id)), _clean_doc(data), merge=True)
        for row in detections:
            doc_id, data = row.get("id"), row.get("data")
            if not doc_id or not isinstance(data, dict):
                raise ValueError("rows: every detection needs id + data")
            batch.set(det_col.document(str(doc_id)), _clean_doc(data), merge=True)
        batch.commit()
        return {"posts": len(posts), "detections": len(detections)}

    raise ValueError(f"unknown action: {action}")
