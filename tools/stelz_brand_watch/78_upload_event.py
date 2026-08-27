#!/usr/bin/env python3
"""Upload een evenement naar productie: fixtures → Firestore, via api_import_event.

    ./firebase/functions/venv/bin/python tools/stelz_brand_watch/78_upload_event.py \\
        --event lowlands-2026 --token "$(cat /tmp/idtoken)"          # of --dry-run

WAAROM DIT BESTAAT. De Lowlands-campagne is lokaal geoogst en geanalyseerd;
het dashboard leest die data via dev-server previewfixtures. Online bestaat
dat pad niet — de evenementpagina's tonen daar "Nog geen data". Deze tool
duwt de fixture-inhoud (al ontdubbeld en geattribueerd door 72/76) door het
member-gated api_import_event endpoint naar dezelfde posts/detections-
collecties die de live pijplijn schrijft.

WAT ER PRECIES GAAT:
  - alle IN-VENSTER rijen (metadata) — de rest is geen onderdeel van het
    evenement en hoort niet in productie;
  - beeldbytes ALLEEN van de treffers (de kaarten en de lade tonen die;
    niet-treffers renderen nergens een beeld) — content-addressed naar
    Storage, dus herdraaien uploadt niets opnieuw;
  - de publiek-samenvatting als één doc (eventAudience/{eventId}).

DOC-IDS ZIJN DETERMINISTISCH, dus herdraaien is een upsert. Carrouseldia's
krijgen `instagram_{shortcode}_s{slot}` zodat parentPostKey (eerste twee
id-segmenten) ze in de live feed tot één post laat collapsen — hetzelfde
contract als de productie-ingest. Stories volgen productie exact:
`instagram_story{id}`, bewust zonder scheidingsteken.

TOKEN — DRIE ROUTES, in deze volgorde:

  --token <id-token>   een vers ID-token, met de hand geplakt. Verloopt na ~1
                       uur; goed voor een eenmalige upload.
  --token-file <pad>   JSON met een REFRESH-token, standaard
                       .tmp/scrape-auth-<event>.json. Dit is wat de knop
                       "Opnieuw scrapen" schrijft: de browser is al ingelogd als
                       member, en zijn refresh-token wordt hier vlak voor de
                       upload ingewisseld voor een vers ID-token. Daarom kan een
                       ronde van een uur nog steeds uploaden — een ID-token dat
                       bij de start werd meegegeven was tegen die tijd dood.
  niets                met --if-authed stopt de tool dan rustig (exit 0). De
                       verversronde draait die vlag, zodat een machine waar
                       niemand is ingelogd geen ronde als "gefaald" markeert.

Het refresh-token staat in .tmp/ (gitignored) en wordt na een geslaagde upload
verwijderd. Het is een langlevend inloggeheim: behandel het als een wachtwoord.
"""
from __future__ import annotations

import argparse
import base64
import importlib.util
import json
import mimetypes
import sys
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
TMP = ROOT / ".tmp"

_espec = importlib.util.spec_from_file_location(
    "_events", Path(__file__).with_name("_events.py"))
E = importlib.util.module_from_spec(_espec)
_espec.loader.exec_module(E)

DEFAULT_BASE = "https://europe-west1-brand-audit-4b2cc.cloudfunctions.net"
BRAND_ID = "stelz"
ROWS_PER_CALL = 300
# Firebase's public token endpoint: refresh token in, fresh ID token out.
SECURE_TOKEN = "https://securetoken.googleapis.com/v1/token"


def token_file_for(event_id: str) -> Path:
    """Where the "Opnieuw scrapen" knop parks the round's credentials."""
    return TMP / f"scrape-auth-{event_id}.json"


def id_token_from_refresh(refresh_token: str, api_key: str) -> str:
    """Exchange a refresh token for a fresh ID token.

    Done HERE, immediately before the upload, and not at the start of the round:
    an ID token lives ~1 hour and a round can take one, so a token handed over at
    the click would be dead exactly on the busy days when it matters most."""
    data = urllib.parse.urlencode({
        "grant_type": "refresh_token", "refresh_token": refresh_token,
    }).encode()
    req = urllib.request.Request(
        f"{SECURE_TOKEN}?key={urllib.parse.quote(api_key)}", data=data,
        headers={"Content-Type": "application/x-www-form-urlencoded"}, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return json.loads(resp.read())["id_token"]
    except urllib.error.HTTPError as e:
        raise SystemExit(
            "  \u2715 inloggegevens afgewezen door Firebase "
            f"({e.code}) — log opnieuw in op het dashboard en scrape nog een keer.\n"
            f"  {e.read().decode()[:200]}")


def resolve_token(args) -> tuple[str | None, Path | None]:
    """(ID-token, het bestand dat het opleverde) — zie de docstring."""
    if args.token:
        return args.token, None
    path = Path(args.token_file) if args.token_file else token_file_for(args.event)
    if not path.exists():
        return None, None
    try:
        blob = json.loads(path.read_text())
    except (OSError, json.JSONDecodeError):
        return None, path
    rt, key = blob.get("refreshToken"), blob.get("apiKey")
    if not rt or not key:
        return None, path
    return id_token_from_refresh(rt, key), path


def post_doc_id(it: dict) -> str:
    """Production-shaped doc id. The contract that matters: a carousel slide's
    first two `_`-segments must equal its siblings' (parentPostKey collapse),
    and stories must match scan_stories' scheme exactly."""
    if it["surface"] == "story":
        raw = str(it["itemId"]).removeprefix("instagram_story")
        return f"instagram_story{raw}"
    pk = it.get("postKey") or str(it["itemId"]).split("_")[-1]
    if it["surface"] == "post":
        if it.get("slots") and (it.get("slots") or 0) > 1 and it.get("slot") is not None:
            return f"instagram_{pk}_s{it['slot']}"
        return f"instagram_{pk}"
    return f"tiktok_{pk}"


def to_post_doc(it: dict, event_id: str) -> dict:
    """CampaignItem → production post doc. camelCase zoals de ingest schrijft;
    plus de event-laagvelden (foundVia/scrapedFor/postKey/slot/slots/itemId)
    die de live event-fetcher terugleest. Extra velden hinderen productie
    niet — Firestore is schemaloos en niets leest wat het niet kent."""
    return {
        "eventId": event_id,
        "itemId": it["itemId"],  # de join-sleutel van de evenementpagina's
        "surface": it["surface"],
        "platform": it["platform"],
        "creatorHandle": it.get("creatorHandle"),
        "platformHandle": it.get("platformHandle"),
        "scrapedFor": it.get("scrapedFor"),
        "foundVia": it.get("foundVia"),
        "postKey": it.get("postKey"),
        "slot": it.get("slot"),
        "slots": it.get("slots"),
        "url": it.get("url"),
        "mediaType": it.get("mediaType"),
        "postedAt": it.get("postedAt"),
        "caption": it.get("caption"),
        "hashtags": it.get("hashtags") or [],
        "mentions": it.get("mentions") or [],
        "videoDuration": it.get("videoDuration"),
        "viewsCount": it.get("views"),
        "likesCount": it.get("likes"),
        "commentsCount": it.get("comments"),
        "sharesCount": it.get("shares"),
        "savesCount": it.get("saves"),
        "pollVotes": it.get("pollVotes"),
        "isPaidPartnership": bool(it.get("isPaidPartnership")),
        "contentType": ("story" if it["surface"] == "story"
                        else it.get("mediaType") or "image"),
        "ingestedBy": "import_event",
    }


def to_detection_doc(d: dict, event_id: str, media_urls: dict[str, str]) -> tuple[str, dict]:
    """DetectionRow (fixture) → production detection doc, camelCase zoals
    detect_image schrijft. `itemId` blijft de originele join-sleutel; `postId`
    wordt hier bewust NIET naar het post-doc-id herschreven — de feed dedupet
    op parentPostKey over postId, en het originele itemId collapst daar net zo
    goed omdat dia's hun shortcode delen na het eerste segment."""
    doc_id = "evt_" + str(d["detection_id"]).removeprefix("preview_")
    stored = media_urls.get(str(d.get("image_url") or ""))
    return doc_id, {
        "eventId": event_id,
        "itemId": d.get("post_id"),
        "postId": d.get("post_id"),
        "creatorHandle": d.get("creator_handle"),
        "creatorCategory": d.get("creator_category"),
        "platform": d.get("platform"),
        "productLine": d.get("product_line"),
        "confidence": d.get("confidence"),
        "sizeInFrame": d.get("size_in_frame"),
        "isPrimarySubject": d.get("is_primary_subject"),
        "imageUrl": stored or None,
        "storedPath": stored or None,
        "postUrl": d.get("post_url"),
        "postCaption": d.get("post_caption"),
        "postedAt": d.get("posted_at"),
        "followerCount": d.get("follower_count"),
        "creatorTier": d.get("creator_tier"),
        "verified": d.get("verified"),
        "context": d.get("context"),
        "postHashtags": d.get("post_hashtags") or [],
        "postMentions": d.get("post_mentions") or [],
        "music": d.get("music"),
        "extras": d.get("extras"),
        "contentType": d.get("content_type"),
        "expiresAt": d.get("expires_at"),
        "frameIdx": d.get("frame_idx"),
        "framesJudged": d.get("frames_judged"),
        "nearMiss": bool(d.get("near_miss")),
        "nearMissReason": d.get("near_miss_reason"),
        "coverOnly": bool(d.get("cover_only")),
        "surfaceType": d.get("surface_type"),
        "visibleText": d.get("visible_text"),
        "falsePositiveRisk": d.get("false_positive_risk"),
        "peopleCount": d.get("people_count"),
        "setting": d.get("setting"),
        "activity": d.get("activity"),
        "gate": d.get("gate"),
        "verifyVerdict": d.get("verify_verdict"),
        "verifyBrand": d.get("verify_brand"),
        "verifyReason": d.get("verify_reason"),
        "verifyPlacement": d.get("verify_placement"),
        "foundAtProdRes": d.get("found_at_prod_res"),
        "maxDim": d.get("max_dim"),
        "detected": bool(d.get("detected")),
        "isFalsePositive": d.get("is_false_positive"),
    }


def media_path_for(preview_url: str) -> Path | None:
    """'/preview-media/{event}/{kind}/{file}' → het archiefbestand op schijf."""
    parts = str(preview_url or "").strip("/").split("/")
    if len(parts) != 4 or parts[0] != "preview-media":
        return None
    _, event_id, kind, fname = parts
    p = E.archive_dir({"id": event_id}, kind) / "media" / fname
    return p if p.exists() else None


def call_api(base: str, token: str, body: dict) -> dict:
    req = urllib.request.Request(
        f"{base}/api_import_event",
        data=json.dumps(body).encode(),
        headers={"Content-Type": "application/json",
                 "Authorization": f"Bearer {token}"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=120) as resp:
            return json.loads(resp.read())
    except urllib.error.HTTPError as e:
        detail = e.read().decode()[:300]
        if e.code in (401, 403):
            raise SystemExit(
                f"  ✕ {e.code}: token verlopen of geen member — haal een vers "
                f"ID-token op en draai opnieuw (upserts, niets gaat dubbel).\n  {detail}")
        raise SystemExit(f"  ✕ HTTP {e.code}: {detail}")


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--event", default="lowlands-2026", choices=E.available())
    ap.add_argument("--token", help="Firebase ID-token van een brand-member")
    ap.add_argument("--token-file",
                    help="JSON met refreshToken+apiKey; standaard "
                         ".tmp/scrape-auth-<event>.json (door de knop geschreven)")
    ap.add_argument("--if-authed", action="store_true",
                    help="geen inloggegevens = rustig stoppen (exit 0) in plaats "
                         "van een fout. De verversronde draait met deze vlag.")
    ap.add_argument("--base", default=DEFAULT_BASE)
    ap.add_argument("--dry-run", action="store_true",
                    help="alleen tellen en tonen wat er zou gaan")
    args = ap.parse_args()
    ev = E.load(args.event)

    items = json.loads((TMP / "preview-campaign.json").read_text())
    dets = json.loads((TMP / "preview-campaign-detections.json").read_text())
    audience_p = TMP / "preview-audience.json"
    audience = json.loads(audience_p.read_text()) if audience_p.exists() else None

    # Alleen het evenement zelf. De archieven reiken jaren terug; buiten het
    # venster is het echte content van dezelfde makers, maar geen {ev-naam}.
    inside = [i for i in items if E.in_window(ev, i.get("postedAt"))]
    inside_ids = {i["itemId"] for i in inside}
    dets_inside = [d for d in dets if d.get("post_id") in inside_ids]
    hits = [d for d in dets_inside if d.get("detected")]

    hit_media: dict[str, Path] = {}
    for d in hits:
        u = str(d.get("image_url") or "")
        p = media_path_for(u)
        if p:
            hit_media[u] = p

    print(f"{ev['name']}: {len(inside)} in-venster rijen · {len(dets_inside)} "
          f"oordelen · {len(hits)} treffers · {len(hit_media)} treffer-beelden "
          f"({sum(p.stat().st_size for p in hit_media.values()) / 1e6:.1f} MB)")

    if args.dry_run:
        print("  dry-run: niets verstuurd")
        return 0

    token, token_path = resolve_token(args)
    if not token:
        # Not a failure when the caller said so. The verversronde marks a round
        # as clean only when EVERY step exited 0, and "nobody is logged in on
        # this machine" must not turn a good harvest into a red round.
        #
        # A REJECTED credential is a different thing and does NOT come through
        # here — id_token_from_refresh raises, the step exits non-zero, and the
        # knop turns red. Only a missing or unreadable file lands in this branch,
        # and the two cases get different sentences because they have different
        # fixes: log in, versus find out who mangled the file.
        msg = (f"  {token_path.name} is er wel maar bevat geen bruikbaar "
               "refreshToken+apiKey — deze ronde blijft lokaal."
               if token_path and token_path.exists() else
               "  geen inloggegevens — deze ronde blijft lokaal. Log in op het "
               "dashboard en scrape opnieuw om ook online bij te werken.")
        if args.if_authed:
            print(msg)
            return 0
        print("  geen --token en geen bruikbaar --token-file — zie de docstring")
        return 2
    args.token = token

    # 1. Treffer-beelden eerst: de rijen verwijzen naar de Storage-URLs.
    #
    # DE LEDGER. Storage is content-addressed, dus een beeld dat al boven staat
    # krijgt bij een herhaling exact dezelfde URL — de serverkant slaat de
    # schrijfactie dan over, maar de 575 kB base64 is dan al over de lijn
    # gegaan. Als staande stap in elke verversronde is dat 76 MB per ronde voor
    # niets, en het groeit met elk festival mee. De ledger onthoudt lokaal welk
    # bestand welke URL oplevert, zodat ronde 2 en verder alleen de NIEUWE
    # treffers versturen. Sleutel is het pad plus de bytegrootte: verandert het
    # bestand, dan verandert de sleutel en gaat het opnieuw omhoog.
    ledger_p = TMP / f"uploaded-media-{ev['id']}.json"
    try:
        ledger: dict[str, str] = json.loads(ledger_p.read_text())
    except (OSError, json.JSONDecodeError):
        ledger = {}

    media_urls: dict[str, str] = {}
    fresh = 0
    for n, (u, p) in enumerate(sorted(hit_media.items()), 1):
        key = f"{p.name}:{p.stat().st_size}"
        known = ledger.get(key)
        if known:
            media_urls[u] = known
            continue
        ctype = mimetypes.guess_type(p.name)[0] or "image/jpeg"
        out = call_api(args.base, args.token, {
            "brandId": BRAND_ID, "action": "media",
            "b64": base64.b64encode(p.read_bytes()).decode(),
            "contentType": ctype,
        })
        media_urls[u] = ledger[key] = out["url"]
        fresh += 1
        if fresh % 20 == 0:
            print(f"  media {fresh} nieuw verstuurd ({n}/{len(hit_media)} bekeken)")
    try:
        ledger_p.write_text(json.dumps(ledger, indent=0, sort_keys=True))
    except OSError:
        pass  # zonder ledger stuurt de volgende ronde gewoon alles opnieuw
    print(f"  media: {fresh} nieuw, {len(hit_media) - fresh} stond er al")

    # 2. Rijen in batches. Post-doc-ids zijn productie-vormig; detection-ids
    #    deterministisch — herdraaien is een upsert.
    posts = [{"id": post_doc_id(i), "data": to_post_doc(i, ev["id"])} for i in inside]
    detections = []
    for d in dets_inside:
        doc_id, data = to_detection_doc(d, ev["id"], media_urls)
        detections.append({"id": doc_id, "data": data})

    sent_p = sent_d = 0
    while posts or detections:
        batch_p, posts = posts[:ROWS_PER_CALL], posts[ROWS_PER_CALL:]
        room = ROWS_PER_CALL - len(batch_p)
        batch_d, detections = detections[:room], detections[room:]
        call_api(args.base, args.token, {
            "brandId": BRAND_ID, "action": "rows",
            "posts": batch_p, "detections": batch_d,
        })
        sent_p += len(batch_p)
        sent_d += len(batch_d)
        print(f"  rijen {sent_p} posts · {sent_d} oordelen")

    # 3. Publiek-samenvatting.
    if audience:
        call_api(args.base, args.token, {
            "brandId": BRAND_ID, "action": "audience",
            "eventId": ev["id"], "data": audience,
        })
        print("  publiek-samenvatting geschreven")

    # The refresh token is a long-lived login secret and it has now done its one
    # job. The next round gets a fresh one from the browser at the click.
    if token_path and token_path.exists():
        try:
            token_path.unlink()
        except OSError:
            print(f"  let op: {token_path.name} kon niet worden opgeruimd")

    print(f"\n  klaar — open /evenementen/{ev['id']} op de productie-URL; "
          "de teller daar hoort gelijk te zijn aan 77_voortgang lokaal")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
