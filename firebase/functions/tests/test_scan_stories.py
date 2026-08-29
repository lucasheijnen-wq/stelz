"""Stories capture — the filter, the TTL, and the money.

Three things here are load-bearing:

1. THE LEAK FILTER. Stories endpoints return reels and feed posts mixed into
   their output. A reel filed as a story would make the product's central claim
   ("we caught it before it disappeared") false, so anything shaped like a feed
   item is rejected.

2. expiresAt IS COMPUTED. Two prototypes promised this field in their header
   and neither wrote it; without it nothing can say how long a story has left.

3. THE RUN FEE IS REAL. This actor charges per run AND per username, breaking
   the "runs are free" assumption baked into the rest of the cost table. If the
   run fee is not recorded, story scraping is invisible to the budget ladder —
   the exact bug that already shipped once in scan_creators.
"""
from __future__ import annotations

import datetime as dt
import os
import sys
import types
import unittest
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


def _stub(name: str) -> types.ModuleType:
    mod = sys.modules.get(name)
    if mod is None:
        mod = types.ModuleType(name)
        sys.modules[name] = mod
    if "." in name:
        parent, _, child = name.rpartition(".")
        setattr(_stub(parent), child, mod)
    return mod


for _n in (
    "firebase_admin", "firebase_admin.firestore", "firebase_admin.storage",
    "google.cloud", "google.cloud.firestore", "google.cloud.pubsub_v1",
):
    _stub(_n)
_stub("firebase_admin").initialize_app = lambda *a, **k: None
_stub("firebase_admin").get_app = lambda *a, **k: None
_stub("firebase_admin").credentials = types.SimpleNamespace(ApplicationDefault=lambda: None)
_fsmod = _stub("google.cloud.firestore")
if not hasattr(_fsmod, "SERVER_TIMESTAMP"):
    _fsmod.SERVER_TIMESTAMP = "TS"
for _attr, _val in (("Increment", lambda *a, **k: None), ("ArrayUnion", lambda v: v), ("ArrayRemove", lambda v: v)):
    if not hasattr(_fsmod, _attr):
        setattr(_fsmod, _attr, _val)

from handlers import scan_stories  # noqa: E402


# ── In-memory doubles ───────────────────────────────────────────────────

class FakeRef:
    """Creator reference that can actually be written to.

    It used to be a bare SimpleNamespace with only `.path`, so _enrich_creator's
    `.set()` raised AttributeError straight into its own try/except and the
    tests asserted nothing about enrichment while appearing to cover it.
    """

    def __init__(self, doc_id, store):
        self.path = f"creators/{doc_id}"
        self._store, self._key = store, doc_id
        self.writes: list[dict] = []

    def set(self, data, merge=False):
        self.writes.append(data)
        cur = dict(self._store.get(self._key) or {}) if merge else {}
        cur.update(data)
        self._store[self._key] = cur


class FakeSnap:
    def __init__(self, doc_id, data, exists=True, store=None):
        self.id = doc_id
        self._d = dict(data or {})
        self.exists = exists
        self.reference = FakeRef(doc_id, store if store is not None else {})

    def to_dict(self):
        return dict(self._d)


class FakeDoc:
    def __init__(self, store, key):
        self._store, self._key = store, key
        # The real DocumentReference exposes its id; get_all in the named-
        # roster fake resolves refs by it.
        self.id = key
        self.subs: dict[str, dict] = {}

    def get(self):
        return FakeSnap(self._key, self._store.get(self._key), self._key in self._store)

    def set(self, data, merge=False):
        cur = dict(self._store.get(self._key) or {}) if merge else {}
        cur.update(data)
        self._store[self._key] = cur

    def collection(self, name):
        return FakeCol(self.subs.setdefault(name, {}))


class FakeCol:
    def __init__(self, store):
        self.store = store
        self.docs: dict[str, FakeDoc] = {}
        self.added: list[dict] = []

    def document(self, doc_id):
        return self.docs.setdefault(doc_id, FakeDoc(self.store, doc_id))

    def add(self, data):
        self.added.append(data)

    def where(self, *a, **k):
        return self

    def limit(self, n):
        return self

    def stream(self):
        # One snapshot object per key, reused across calls, so a test can read
        # back what _enrich_creator wrote to a creator's reference.
        self._snaps = getattr(self, "_snaps", {})
        out = []
        for k, v in self.store.items():
            snap = self._snaps.get(k)
            if snap is None:
                snap = self._snaps[k] = FakeSnap(k, v, store=self.store)
            out.append(snap)
        return out


class StoriesBase(unittest.TestCase):
    def setUp(self):
        self.creators = {
            "instagram_anna": {"handle": "anna", "platform": "instagram", "tier": "tier_2"},
        }
        self.posts: dict = {}
        self.recorded: list[dict] = []
        self.runs_col = FakeCol({})

        self.posts_col = FakeCol(self.posts)
        self.brand = mock.Mock(get=lambda: mock.Mock(exists=True))
        fake_fs = types.SimpleNamespace(
            brand_doc=lambda bid: self.brand,
            creators_col=lambda bid: FakeCol(self.creators),
            posts_col=lambda bid: self.posts_col,
            scan_runs_col=lambda bid: self.runs_col,
            composite_id=lambda *parts: "_".join(p.lower() for p in parts if p),
            # get_all resolves refs by id, missing docs as exists=False — the
            # real client's behaviour, which the named-roster path filters on.
            db=lambda: types.SimpleNamespace(get_all=lambda refs: [
                FakeSnap(r.id, self.creators[r.id], store=self.creators)
                if r.id in self.creators else
                types.SimpleNamespace(id=r.id, exists=False, to_dict=lambda: {})
                for r in refs
            ]),
        )
        self.usage = types.SimpleNamespace(
            budget_exhausted=lambda bid: False,
            scraping_allowed=lambda bid: True,
            record=lambda bid, **kw: self.recorded.append(kw),
        )
        self.apify = mock.Mock()
        self.apify.run_sync = mock.Mock(return_value=[])
        self.session_open = True
        for p in (
            mock.patch.object(scan_stories, "fs", fake_fs),
            mock.patch.object(scan_stories, "usage", self.usage),
            mock.patch.object(scan_stories, "apify", self.apify),
            # Open unless a test says otherwise — the denominator bump is gated
            # on a live session as well as on the caller's flag.
            mock.patch.object(scan_stories, "scan_state", types.SimpleNamespace(
                session_is_open=lambda bid: self.session_open)),
        ):
            p.start()
            self.addCleanup(p.stop)

    def run_stories(self, **kw):
        return scan_stories.run("stelz", dry_run=True, **kw)

    def brand_scan_writes(self) -> list[dict]:
        """Every `scan` map written to the brand doc, in call order."""
        out = []
        for call in self.brand.set.call_args_list:
            payload = call.args[0] if call.args else {}
            if isinstance(payload, dict) and "scan" in payload:
                out.append(payload["scan"])
        return out

    def stamp(self) -> dict:
        """The `stories` map last written to the brand doc, or {}."""
        for call in reversed(self.brand.set.call_args_list):
            payload = call.args[0] if call.args else {}
            if "stories" in payload:
                return payload["stories"]
        return {}


# Shaped from a real actor response (Lowlands roster, 20 Aug 2026), not from
# the API docs and not from imagination. The previous fixture in this file was
# invented — camelCase feed-post fields that no vendor has ever returned — so
# sixteen passing tests proved nothing, and a live run rejected 69 of 69 real
# stories. URLs and ids are stand-ins; every KEY is what the vendor sends.
STORY = {
    "product_type": "story",
    # "{media_id}_{user_id}" — this is what broke the old str.isdigit() check.
    "id": "31415926535_314162194",
    # 64-bit id mangled by JSON's float: deliberately wrong here, and unread.
    "pk": 31415926500,
    "code": "DcOVs-KMRoO",          # stories DO have a shortcode
    "media_type": 1,                 # 1 = image, 2 = video
    "username": "anna",
    "user": {"username": "anna"},
    "taken_at": 1755680000,
    "expiring_at": 1755680000 + 86400,
    "image_versions2": {"candidates": [
        {"url": "https://cdn/story-1320.jpg", "width": 1320, "height": 2346},
        {"url": "https://cdn/story-750.jpg", "width": 750, "height": 1333},
    ]},
    "caption": None,
}

VIDEO_STORY = {
    **STORY,
    "media_type": 2,
    "video_duration": 14.232,
    "video_versions": [
        {"url": "https://cdn/story-720.mp4", "width": 720, "height": 1280},
        {"url": "https://cdn/story-360.mp4", "width": 360, "height": 640},
    ],
}

# Everything the payload carries that used to be discarded. Field names and
# nesting copied from the live response; the poll numbers are the shape of the
# real ones (one story in that run had 18,412 votes).
RICH_STORY = {
    **STORY,
    "is_paid_partnership": True,
    "story_polls": [{"poll_sticker": {
        "question": "WAT MOETEN WIJ BESTELLEN?",
        "total_votes": 18412,
        "tallies": [{"count": 11561, "text": "Stelz"}, {"count": 6851, "text": "Iets anders"}],
    }}],
    "story_link_stickers": [{"story_link": {
        "display_url": "drinkstelz.com/nl",
        "url": "https://l.instagram.com/?u=https%3A%2F%2Fdrinkstelz.com",
        "link_type": "web",
    }}],
    "story_music_stickers": [{"music_asset_info": {
        "title": "Bette Davis Eyes (Instrumental)",
        "display_artist": "The Hit Crew",
        "audio_asset_id": "245185149714723",
    }}],
    "user": {
        "username": "anna",
        "full_name": "Anna de Vries",
        "profile_pic_url": "https://cdn/anna.jpg",
        "is_verified": True,
    },
}


class TestLeakFilter(StoriesBase):
    def test_product_type_is_the_discriminator(self):
        # Stories endpoints leak reels and feed posts. Instagram labels the
        # media itself, so this reads the label instead of guessing from shape.
        for leak in (
            {**STORY, "product_type": "clips"},
            {**STORY, "product_type": "feed"},
            {**STORY, "product_type": "igtv"},
            {k: v for k, v in STORY.items() if k != "product_type"},
        ):
            self.assertIsNone(scan_stories._normalize_item(leak))

    def test_a_shortcode_does_not_make_it_a_post(self):
        # The old filter rejected anything carrying a shortCode. Every one of
        # the 69 real stories in the live run had a `code`, so that heuristic
        # alone would have thrown the entire feature away.
        self.assertIsNotNone(scan_stories._normalize_item({**STORY, "code": "DcOVs-KMRoO"}))

    def test_accepts_the_real_composite_id(self):
        # "{media_id}_{user_id}" — str.isdigit() on the whole string is what
        # rejected 69 of 69 genuine stories.
        out = scan_stories._normalize_item(STORY)
        self.assertEqual(out["story_id"], "31415926535")
        self.assertEqual(out["handle"], "anna")

    def test_rejects_ids_that_are_not_ids(self):
        for bad in ("abc", "", None, "_314162194"):
            self.assertIsNone(scan_stories._normalize_item({**STORY, "id": bad}), bad)

    def test_takes_the_widest_image_and_best_video(self):
        # Candidates arrive widest-first; the detector should see full res.
        self.assertEqual(scan_stories._normalize_item(STORY)["image_url"],
                         "https://cdn/story-1320.jpg")
        self.assertEqual(scan_stories._normalize_item(VIDEO_STORY)["video_url"],
                         "https://cdn/story-720.mp4")

    def test_falls_back_to_nested_username(self):
        out = scan_stories._normalize_item({k: v for k, v in STORY.items() if k != "username"})
        self.assertEqual(out["handle"], "anna")

    def test_leaked_items_are_counted_not_silently_dropped(self):
        self.apify.run_sync.return_value = [
            STORY, {**STORY, "id": "999_1", "product_type": "clips"},
        ]
        out = self.run_stories()
        self.assertEqual(out["storiesFound"], 1)
        self.assertEqual(out["skippedNonStory"], 1)

    def test_foreign_handle_is_skipped(self):
        # An account we never asked about must not enter the corpus.
        self.apify.run_sync.return_value = [
            {**STORY, "username": "vreemde", "user": {"username": "vreemde"}},
        ]
        out = self.run_stories()
        self.assertEqual(out["storiesFound"], 0)
        self.assertEqual(out["skippedNonStory"], 1)


class TestStoryMetadata(StoriesBase):
    def test_mentions_and_hashtags_are_carried(self):
        # A story that @-mentions the brand is a hit whether or not a can is in
        # frame. These were being written as empty lists while the payload
        # carried them.
        item = {**STORY,
                "reel_mentions": [{"user": {"username": "Stelz"}},
                                  {"user": {"username": "lowlands"}}],
                "story_hashtags": [{"hashtag": {"name": "Vrijmibo"}}]}
        self.apify.run_sync.return_value = [item]
        self.run_stories()
        doc = self.posts["instagram_story31415926535"]
        self.assertEqual(doc["mentions"], ["stelz", "lowlands"])
        self.assertEqual(doc["hashtags"], ["vrijmibo"])

    def test_malformed_mention_entries_are_dropped_not_fatal(self):
        item = {**STORY, "reel_mentions": [{}, {"user": {}}, {"user": {"username": "ok"}}]}
        self.apify.run_sync.return_value = [item]
        self.run_stories()
        self.assertEqual(self.posts["instagram_story31415926535"]["mentions"], ["ok"])


class TestPersistence(StoriesBase):
    def test_uses_instagrams_own_expiry_when_given(self):
        # The payload states expiring_at. Preferring it over our arithmetic
        # gives the true countdown for a story near the boundary.
        self.apify.run_sync.return_value = [{**STORY, "expiring_at": STORY["taken_at"] + 3600}]
        self.run_stories()
        doc = self.posts["instagram_story31415926535"]
        self.assertEqual(doc["expiresAt"] - doc["postedAt"], dt.timedelta(hours=1))

    def test_falls_back_to_posted_at_plus_24h(self):
        self.apify.run_sync.return_value = [
            {k: v for k, v in STORY.items() if k != "expiring_at"},
        ]
        self.run_stories()
        doc = self.posts["instagram_story31415926535"]
        self.assertEqual(doc["expiresAt"] - doc["postedAt"], dt.timedelta(hours=24))

    def test_doc_id_and_permalink_shape(self):
        self.apify.run_sync.return_value = [STORY]
        self.run_stories()
        self.assertIn("instagram_story31415926535", self.posts)
        doc = self.posts["instagram_story31415926535"]
        # A story permalink, not the raw CDN jpeg — "open original" must look
        # like a story rather than a stray image.
        self.assertEqual(doc["url"], "https://www.instagram.com/stories/anna/31415926535/")
        self.assertEqual(doc["contentType"], "story")
        self.assertEqual(doc["caption"], "")
        self.assertEqual(doc["hashtags"], [])
        self.assertEqual(doc["creatorTier"], "tier_2")

    def test_post_id_has_exactly_two_segments(self):
        # The frontend groups frames and carousel slots by the first TWO
        # underscore-separated parts of the post id (lib/types.parentPostKey).
        # An id like "instagram_story_123" parses as post "story", so every
        # story in the corpus would collapse into one feed row — the whole
        # feature, invisible. Two stories from the same creator must stay two.
        self.apify.run_sync.return_value = [STORY, {**STORY, "id": "27182818284_314162194"}]
        self.run_stories()
        ids = [k for k in self.posts if k.startswith("instagram_story")]
        self.assertEqual(len(ids), 2, ids)
        for post_id in ids:
            head = "_".join(post_id.split("_")[:2])
            self.assertEqual(head, post_id, f"{post_id} would dedupe into {head}")

    def test_missing_timestamp_is_flagged_as_estimated(self):
        self.apify.run_sync.return_value = [
            {k: v for k, v in STORY.items() if k not in ("taken_at", "expiring_at")},
        ]
        self.run_stories()
        doc = self.posts["instagram_story31415926535"]
        self.assertTrue(doc["postedAtEstimated"])
        self.assertIsNotNone(doc["expiresAt"])

    def test_video_story_enqueues_video_and_its_cover(self):
        # Story video URLs are short-lived signed links that routinely expire in
        # the queue; the cover is the pass that reliably succeeds.
        self.apify.run_sync.return_value = [VIDEO_STORY]
        out = self.run_stories()
        self.assertEqual(out["videosEnqueued"], 1)
        self.assertEqual(out["imagesEnqueued"], 1)

    def test_image_story_enqueues_one_image(self):
        self.apify.run_sync.return_value = [STORY]
        out = self.run_stories()
        self.assertEqual(out["imagesEnqueued"], 1)
        self.assertEqual(out["videosEnqueued"], 0)


class TestCostAndGates(StoriesBase):
    def test_one_run_for_all_handles(self):
        self.creators.update({
            f"instagram_c{i}": {"handle": f"c{i}", "platform": "instagram", "tier": "tier_2"}
            for i in range(20)
        })
        self.run_stories()
        # The run fee dwarfs the per-username price: 21 separate runs would cost
        # roughly sixteen times one batched run.
        self.assertEqual(self.apify.run_sync.call_count, 1)
        actor, payload = self.apify.run_sync.call_args[0][:2]
        self.assertEqual(actor, scan_stories.STORIES_ACTOR)
        self.assertEqual(len(payload["usernames"]), 21)

    def test_records_both_billed_units(self):
        self.run_stories()
        self.assertEqual(self.recorded[0]["apify_story_runs"], 1)
        self.assertEqual(self.recorded[0]["apify_story_usernames"], 1)

    def test_spend_is_recorded_even_when_the_actor_throws(self):
        # The actor start is billed whether or not items come back.
        self.apify.run_sync.side_effect = RuntimeError("actor exploded")
        out = self.run_stories()
        self.assertEqual(out["storiesFound"], 0)
        self.assertEqual(self.recorded[0]["apify_story_runs"], 1)

    def test_budget_gates_refuse_before_spending(self):
        for gate in ("budget_exhausted", "scraping_allowed"):
            with self.subTest(gate=gate):
                self.apify.run_sync.reset_mock()
                self.recorded.clear()
                setattr(self.usage, gate, (lambda bid: True) if gate == "budget_exhausted" else (lambda bid: False))
                out = self.run_stories()
                self.assertIn("skipped", out)
                self.apify.run_sync.assert_not_called()
                self.assertEqual(self.recorded, [])
                # restore
                self.usage.budget_exhausted = lambda bid: False
                self.usage.scraping_allowed = lambda bid: True

    def test_no_tracked_creators_skips_without_spending(self):
        self.creators.clear()
        out = self.run_stories()
        self.assertEqual(out["skipped"], "no_creators")
        self.apify.run_sync.assert_not_called()


class TestEmptyIsNormal(StoriesBase):
    def test_zero_stories_is_a_success_not_an_error(self):
        # Most creators have no active story at any given moment. If this ever
        # reads as a failure, the UI will cry wolf four times a day.
        self.apify.run_sync.return_value = []
        out = self.run_stories()
        self.assertEqual(out["storiesFound"], 0)
        self.assertNotIn("skipped", out)
        self.assertEqual(self.runs_col.added[0]["status"], "ok")


class TestPublicMetrics(StoriesBase):
    """The numbers that DO exist, and the one that does not.

    Instagram shows story views to the account owner only — every item in the
    live run carried `can_see_insights_as_brand: false`, and there is no view,
    viewer, reach or impression field anywhere in the payload. So the honest
    set is: poll votes (a vote requires a viewer, so it is a verified floor),
    link stickers, music, mentions, hashtags, duration.
    """

    def doc(self):
        return self.posts["instagram_story31415926535"]

    def test_the_story_id_is_written_as_the_shared_key(self):
        """Stories are the one surface where both writers already agreed on
        the doc id, so they deduped for free. The web client now collapses on
        postKey WHERE A ROW HAS ONE, and 78_upload_event sends it for every
        story — so a scanner row without it would key on its doc id while its
        imported twin keyed on the story id, and a pair that used to be one row
        would silently become two."""
        self.apify.run_sync.return_value = [STORY]
        self.run_stories()
        self.assertEqual(self.doc()["postKey"], "31415926535")

    def test_likes_and_comments_are_null_not_zero(self):
        # Same rule as viewsCount below: a story carries no public like or
        # comment count, and the KPI tiles average over posts that carry a
        # number — so a zero here drags down the mean of every post that really
        # was measured.
        self.apify.run_sync.return_value = [STORY]
        self.run_stories()
        self.assertIsNone(self.doc()["likesCount"])
        self.assertIsNone(self.doc()["commentsCount"])

    def test_views_are_null_not_zero(self):
        # Zero is a claim — "nobody watched" — and it would be read straight
        # into a client report. Unknown is the truth.
        self.apify.run_sync.return_value = [STORY]
        self.run_stories()
        self.assertIsNone(self.doc()["viewsCount"])

    def test_poll_votes_use_instagrams_stated_total(self):
        self.apify.run_sync.return_value = [RICH_STORY]
        self.run_stories()
        self.assertEqual(self.doc()["pollVotes"], 18412)
        self.assertEqual(self.doc()["pollCount"], 1)
        self.assertEqual(self.doc()["pollQuestions"], ["WAT MOETEN WIJ BESTELLEN?"])

    def test_poll_votes_fall_back_to_summing_tallies(self):
        item = {**RICH_STORY}
        item["story_polls"] = [{"poll_sticker": {
            "tallies": [{"count": 10}, {"count": 5}],
        }}]
        self.apify.run_sync.return_value = [item]
        self.run_stories()
        self.assertEqual(self.doc()["pollVotes"], 15)
        # A poll with no question text is still a poll; it must not vanish.
        self.assertEqual(self.doc()["pollCount"], 1)
        self.assertEqual(self.doc()["pollQuestions"], [])

    def test_no_polls_is_zero_not_missing(self):
        self.apify.run_sync.return_value = [STORY]
        self.run_stories()
        self.assertEqual(self.doc()["pollVotes"], 0)

    def test_link_stickers_music_and_paid_label(self):
        self.apify.run_sync.return_value = [RICH_STORY]
        self.run_stories()
        d = self.doc()
        self.assertEqual(d["linkUrls"], ["drinkstelz.com/nl"])
        self.assertEqual(d["music"]["title"], "Bette Davis Eyes (Instrumental)")
        self.assertEqual(d["music"]["artist"], "The Hit Crew")
        self.assertTrue(d["isPaidPartnership"])

    def test_media_type_and_duration(self):
        self.apify.run_sync.return_value = [VIDEO_STORY]
        self.run_stories()
        self.assertEqual(self.doc()["mediaType"], "video")
        self.assertAlmostEqual(self.doc()["videoDuration"], 14.232)

    def test_media_type_reads_the_label_not_the_video_url(self):
        # The vendor sometimes cannot resolve a stream; the item is still a
        # video story and mislabelling it as a photo would misreport the mix.
        item = {k: v for k, v in VIDEO_STORY.items() if k != "video_versions"}
        self.apify.run_sync.return_value = [item]
        self.run_stories()
        self.assertEqual(self.doc()["mediaType"], "video")


class TestCreatorEnrichment(StoriesBase):
    """Names and avatars ride along free; refresh_profiles stays authoritative."""

    def test_fills_blank_profile_fields(self):
        self.apify.run_sync.return_value = [RICH_STORY]
        self.run_stories()
        c = self.creators["instagram_anna"]
        self.assertEqual(c["fullName"], "Anna de Vries")
        self.assertEqual(c["avatarUrl"], "https://cdn/anna.jpg")
        self.assertTrue(c["verifiedAccount"])

    def test_never_overwrites_what_is_already_there(self):
        # refresh_profiles scrapes these properly. A story payload must not be
        # able to clobber a better value — the same backfill-only rule that
        # protects fullName in handlers/projects.py.
        self.creators["instagram_anna"].update(
            {"fullName": "Anna V.", "avatarUrl": "https://cdn/better.jpg"},
        )
        self.apify.run_sync.return_value = [RICH_STORY]
        self.run_stories()
        c = self.creators["instagram_anna"]
        self.assertEqual(c["fullName"], "Anna V.")
        self.assertEqual(c["avatarUrl"], "https://cdn/better.jpg")

    def test_enrichment_failure_cannot_fail_the_sweep(self):
        # The write has to actually blow up, or this asserts nothing: an
        # earlier version of these doubles had no .set at all, so enrichment
        # raised AttributeError into its own except and the tests looked green
        # while covering none of it.
        with mock.patch.object(FakeRef, "set", side_effect=RuntimeError("firestore down")):
            self.apify.run_sync.return_value = [RICH_STORY]
            out = self.run_stories()
        self.assertEqual(out["storiesFound"], 1)
        self.assertNotIn("fullName", self.creators["instagram_anna"])


class TestReanalysisIsSkipped(StoriesBase):
    def test_a_story_already_captured_is_not_queued_again(self):
        # A story lives 24h and the sweep runs every 6h, so the same story
        # returns up to four times. Re-analysing costs no Gemini (the image
        # hash cache absorbs that) but does cost four fetches and four Storage
        # writes where one would do.
        self.apify.run_sync.return_value = [STORY]
        first = self.run_stories()
        self.assertEqual(first["imagesEnqueued"], 1)
        self.assertEqual(first["alreadyHad"], 0)

        second = self.run_stories()
        self.assertEqual(second["storiesFound"], 1)
        self.assertEqual(second["alreadyHad"], 1)
        self.assertEqual(second["imagesEnqueued"], 0)

    def test_metadata_still_refreshes_on_a_second_sweep(self):
        # Poll counts climb while a story is live, so the doc is rewritten even
        # though the image is not re-analysed.
        self.apify.run_sync.return_value = [RICH_STORY]
        self.run_stories()
        grown = {**RICH_STORY}
        grown["story_polls"] = [{"poll_sticker": {"question": "WAT MOETEN WIJ BESTELLEN?",
                                                  "total_votes": 20000, "tallies": []}}]
        self.apify.run_sync.return_value = [grown]
        self.run_stories()
        self.assertEqual(self.posts["instagram_story31415926535"]["pollVotes"], 20000)


class TestLastRunStamp(StoriesBase):
    """`brands/{id}.stories` is how the panel answers "when did this last look?".

    Three quarters of these sweeps come from the 6-hourly scheduler, which runs
    outside any scan session and therefore writes no step state. Without this
    stamp an empty strip looks identical whether the scheduler ran ten minutes
    ago and found nothing, or stopped firing a week ago.
    """

    def test_success_records_when_and_how_many(self):
        self.apify.run_sync.return_value = [STORY]
        self.run_stories()
        s = self.stamp()
        self.assertEqual(s["lastFound"], 1)
        self.assertEqual(s["lastChecked"], 1)
        self.assertIsNone(s["lastSkipped"])
        self.assertIsNotNone(s["lastRunAt"])

    def test_empty_sweep_still_records(self):
        # The distinction the UI depends on: looked and found nothing.
        self.apify.run_sync.return_value = []
        self.run_stories()
        self.assertEqual(self.stamp()["lastFound"], 0)
        self.assertIsNone(self.stamp()["lastSkipped"])

    def test_skips_record_their_reason(self):
        self.creators.clear()
        self.run_stories()
        self.assertEqual(self.stamp()["lastSkipped"], "no_creators")

    def test_stamping_can_never_fail_the_sweep(self):
        self.brand.set.side_effect = RuntimeError("firestore down")
        self.apify.run_sync.return_value = [STORY]
        out = self.run_stories()
        self.assertEqual(out["storiesFound"], 1)


class TestSessionCounters(StoriesBase):
    """The scan panel's denominator, from the stories path.

    Only the HTTP step a person started may bump scan.detectTasksEnqueued —
    the 6-hourly scheduler leaves the panel alone (that is the whole reason
    the stories stamp lives in its own `stories` block on the brand doc)."""

    class _Publisher:
        def topic_path(self, project, topic):
            return f"{project}/{topic}"

        def publish(self, topic, payload):
            from concurrent.futures import Future
            f = Future()
            f.set_result("id")
            return f

    def _run_live(self, **kw):
        self.apify.run_sync.return_value = [STORY]
        with mock.patch.object(scan_stories, "pubsub_v1", types.SimpleNamespace(
            PublisherClient=lambda: self._Publisher()),
        ), mock.patch.object(scan_stories, "Increment", lambda n: ("INC", n)):
            return scan_stories.run("stelz", dry_run=False, **kw)

    def test_http_step_bumps_the_denominator(self):
        out = self._run_live(session_counters=True)
        self.assertEqual(out["imagesEnqueued"], 1)
        bumps = [s["detectTasksEnqueued"] for s in self.brand_scan_writes()
                 if "detectTasksEnqueued" in s]
        self.assertEqual(bumps, [("INC", 1)])

    def test_scheduled_sweep_leaves_the_panel_alone(self):
        out = self._run_live()  # session_counters defaults to False
        self.assertEqual(out["imagesEnqueued"], 1)
        self.assertEqual([s for s in self.brand_scan_writes()
                          if "detectTasksEnqueued" in s], [])

    def test_no_bump_when_the_session_is_closed(self):
        """The caller asking for counters is not proof a session is open. A
        closed session's completions are frozen, so raising its denominator
        snaps a finished scan back to 'analysing' and prints an ETA measured
        from a startedAt that may be days old."""
        self.session_open = False
        out = self._run_live(session_counters=True)
        self.assertEqual(out["imagesEnqueued"], 1)
        self.assertEqual([s for s in self.brand_scan_writes()
                          if "detectTasksEnqueued" in s], [])



class TestScopeMarker(StoriesBase):
    """The event button reads `scope` back to detect a deployed backend that
    silently ignored its roster — old code has no marker at all, so it must be
    exactly 'named' when the list was used and present-but-different otherwise."""

    def test_the_tier_sweep_says_tier(self):
        self.assertEqual(self.run_stories()["scope"], "tier")

    def test_a_named_roster_says_named(self):
        out = self.run_stories(creator_ids=["instagram_anna"])
        self.assertEqual(out["scope"], "named")
        self.assertEqual(out["accountsChecked"], 1)

    def test_naming_drops_tiktok_ids_stories_are_instagram_only(self):
        self.creators["tiktok_anna"] = {
            "handle": "annatt", "platform": "tiktok", "tier": "tier_2"}
        out = self.run_stories(creator_ids=["instagram_anna", "tiktok_anna"])
        self.assertEqual(out["accountsChecked"], 1)

    def test_an_empty_named_set_does_not_fall_back_to_the_tier_sweep(self):
        # Same rule as scan_creators: [] means "the caller named a roster and
        # came up with nobody", and falling through would sweep the brand.
        out = self.run_stories(creator_ids=[])
        self.assertEqual(out.get("skipped"), "no_creators")
        self.apify.run_sync.assert_not_called()


if __name__ == "__main__":
    unittest.main(verbosity=2)
