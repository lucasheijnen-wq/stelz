"""Creator projects — the rules that guard spend and shared state.

Two behaviours here are load-bearing:

1. THE TRACKING CAP. Adding a creator to a project flips them to a 6h/12h scan
   cadence — up to 8x the default spend, drawn from the same $5/day budget as
   every hashtag scan. The cap on distinct tracked creators is the only thing
   between "enthusiastic account manager" and a silently multiplied Apify bill,
   so it must hold across projects, not per project.

2. ARRAYUNION, NOT READ-MODIFY-WRITE. Firestore merge=True REPLACES arrays; the
   promotion funnel was once severed by exactly that (scan_hashtags.py:58-64).
   Two teammates adding creators at the same moment must both land.
"""
from __future__ import annotations

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


class FakeArrayUnion:
    """Real union semantics, so the tests exercise what production relies on."""

    def __init__(self, values):
        self.values = list(values)


class FakeArrayRemove:
    """Real remove semantics — the fix for the review-confirmed lost-update bug
    (a filtered-array overwrite clobbered concurrent adds)."""

    def __init__(self, values):
        self.values = list(values)


_fsmod = _stub("google.cloud.firestore")
_fsmod.ArrayUnion = FakeArrayUnion
_fsmod.ArrayRemove = FakeArrayRemove
if not hasattr(_fsmod, "SERVER_TIMESTAMP"):
    _fsmod.SERVER_TIMESTAMP = "TS"
if not hasattr(_fsmod, "Increment"):
    _fsmod.Increment = lambda *a, **k: None

from handlers import projects  # noqa: E402

# handlers.projects captured ArrayUnion at import; make sure it is OUR class,
# not a lambda left behind by an earlier test module in the same process.
projects.ArrayUnion = FakeArrayUnion
projects.ArrayRemove = FakeArrayRemove


# ── In-memory Firestore double ──────────────────────────────────────────

class FakeSnap:
    def __init__(self, doc_id, exists, data):
        self.id = doc_id
        self.exists = exists
        self._d = data or {}

    def to_dict(self):
        return dict(self._d)


class FakeDoc:
    def __init__(self, store, key):
        self._store, self._key = store, key

    def get(self):
        return FakeSnap(self._key, self._key in self._store, self._store.get(self._key))

    def set(self, data, merge=False):
        cur = dict(self._store.get(self._key) or {}) if merge else {}
        for k, v in data.items():
            if isinstance(v, FakeArrayUnion):
                existing = list(cur.get(k) or [])
                cur[k] = existing + [x for x in v.values if x not in existing]
            elif isinstance(v, FakeArrayRemove):
                cur[k] = [x for x in (cur.get(k) or []) if x not in set(v.values)]
            else:
                cur[k] = v
        self._store[self._key] = cur


class FakeCol:
    def __init__(self, store):
        self.store = store

    def document(self, doc_id):
        return FakeDoc(self.store, doc_id)

    def stream(self):
        return [FakeSnap(k, True, v) for k, v in self.store.items()]


class ProjectsBase(unittest.TestCase):
    def setUp(self):
        self.projects_store: dict = {}
        self.creators_store: dict = {
            "instagram_anna": {"tier": "tier_3", "handle": "anna"},
            "instagram_bob": {"tier": "tier_3", "handle": "bob"},
            "tiktok_carla": {"tier": "tier_3", "handle": "carla"},
        }
        p1 = mock.patch.object(projects.fs, "projects_col", lambda bid: FakeCol(self.projects_store))
        p2 = mock.patch.object(projects.fs, "creators_col", lambda bid: FakeCol(self.creators_store))
        p1.start(); p2.start()
        self.addCleanup(p1.stop); self.addCleanup(p2.stop)

    def create(self, name="Zomer Campagne", **kw):
        return projects.run("stelz", "uid1", "create", {"name": name, **kw})


class TestCreate(ProjectsBase):
    def test_creates_with_defaults(self):
        out = self.create()
        self.assertTrue(out["ok"])
        self.assertEqual(out["project"]["trackingTier"], "tier_1")
        self.assertEqual(out["project"]["creatorIds"], [])
        self.assertFalse(out["project"]["archived"])

    def test_empty_name_rejected(self):
        with self.assertRaises(projects.ProjectError):
            self.create(name="   ")

    def test_duplicate_name_is_409(self):
        self.create()
        with self.assertRaises(projects.ProjectError) as cm:
            self.create()
        self.assertEqual(cm.exception.status, 409)

    def test_tier_3_tracking_rejected(self):
        # tier_3 is the default cadence — "tracking" at it would be a no-op
        # sold as a feature.
        with self.assertRaises(projects.ProjectError):
            self.create(trackingTier="tier_3")

    def test_note_is_truncated_not_rejected(self):
        out = self.create(note="x" * 2000)
        self.assertLessEqual(len(out["project"]["note"]), projects.MAX_NOTE_LEN)


class TestAddCreators(ProjectsBase):
    def test_add_patches_tier_and_next_scan(self):
        pid = self.create()["project"]["id"]
        out = projects.run("stelz", "uid1", "addCreators",
                           {"projectId": pid, "creatorIds": ["instagram_anna"]})
        self.assertIn("instagram_anna", out["project"]["creatorIds"])
        self.assertEqual(self.creators_store["instagram_anna"]["tier"], "tier_1")
        # nextScanAt set to "now" → eligible on the very next creator-scan run.
        self.assertIn("nextScanAt", self.creators_store["instagram_anna"])

    def test_two_sequential_adds_accumulate(self):
        # The ArrayUnion semantics: second add must not replace the first.
        pid = self.create()["project"]["id"]
        projects.run("stelz", "uid1", "addCreators", {"projectId": pid, "creatorIds": ["instagram_anna"]})
        out = projects.run("stelz", "uid1", "addCreators", {"projectId": pid, "creatorIds": ["instagram_bob"]})
        self.assertEqual(sorted(out["project"]["creatorIds"]), ["instagram_anna", "instagram_bob"])

    def test_duplicate_add_does_not_double(self):
        pid = self.create()["project"]["id"]
        projects.run("stelz", "uid1", "addCreators", {"projectId": pid, "creatorIds": ["instagram_anna"]})
        out = projects.run("stelz", "uid1", "addCreators", {"projectId": pid, "creatorIds": ["instagram_anna"]})
        self.assertEqual(out["project"]["creatorIds"].count("instagram_anna"), 1)

    def test_unknown_creator_gets_a_tracking_stub_not_a_404(self):
        # Review-confirmed: most FEED creators were never promoted (promotion
        # needs 2 distinct generic tags), so a 404 here broke "Track in
        # project" for exactly the found-someone-great moment it exists for.
        pid = self.create()["project"]["id"]
        out = projects.run("stelz", "uid1", "addCreators",
                           {"projectId": pid, "creatorIds": ["instagram_nieuwevondst"]})
        self.assertIn("instagram_nieuwevondst", out["project"]["creatorIds"])
        stub = self.creators_store["instagram_nieuwevondst"]
        self.assertEqual(stub["handle"], "nieuwevondst")
        self.assertEqual(stub["platform"], "instagram")
        self.assertEqual(stub["status"], "discovered")  # scan_creators selects this
        self.assertEqual(stub["tier"], "tier_1")
        # In the stub write ITSELF: a creator doc missing nextScanAt is
        # invisible to the scanner's inequality filter forever, so it must not
        # depend on the separate stamp that follows succeeding.
        self.assertIn("nextScanAt", stub)

    def test_malformed_creator_id_is_still_rejected(self):
        # The stub-upsert must not turn a garbage id into a phantom doc.
        pid = self.create()["project"]["id"]
        with self.assertRaises(projects.ProjectError):
            projects.run("stelz", "uid1", "addCreators",
                         {"projectId": pid, "creatorIds": ["geenplatform"]})

    def test_archived_project_refuses_adds(self):
        pid = self.create()["project"]["id"]
        projects.run("stelz", "uid1", "archive", {"projectId": pid})
        with self.assertRaises(projects.ProjectError) as cm:
            projects.run("stelz", "uid1", "addCreators",
                         {"projectId": pid, "creatorIds": ["instagram_anna"]})
        self.assertEqual(cm.exception.status, 409)

    def test_tier_2_project_sets_tier_2(self):
        pid = self.create(name="Rustig volgen", trackingTier="tier_2")["project"]["id"]
        projects.run("stelz", "uid1", "addCreators", {"projectId": pid, "creatorIds": ["instagram_bob"]})
        self.assertEqual(self.creators_store["instagram_bob"]["tier"], "tier_2")

    def test_a_whole_roster_fits_in_one_call_but_101_does_not(self):
        # One call must fit a campaign list (Lowlands = 53 ids): the rollback
        # makes a single call all-or-nothing, while chunking could strand a
        # half-imported project.
        pid = self.create(name="Lowlands", trackingTier="tier_2")["project"]["id"]
        with self.assertRaises(projects.ProjectError):
            projects.run("stelz", "uid1", "addCreators",
                         {"projectId": pid, "creatorIds": [f"instagram_x{i}" for i in range(101)]})
        out = projects.run("stelz", "uid1", "addCreators",
                           {"projectId": pid, "creatorIds": [f"instagram_x{i}" for i in range(53)]})
        self.assertEqual(len(out["project"]["creatorIds"]), 53)


class TestTrackingCap(ProjectsBase):
    def _seed_many(self, n):
        for i in range(n):
            self.creators_store[f"instagram_c{i}"] = {"tier": "tier_3", "handle": f"c{i}"}

    def test_cap_holds_within_one_project(self):
        self._seed_many(30)
        pid = self.create()["project"]["id"]
        ids = [f"instagram_c{i}" for i in range(projects.TIER1_TRACKED_CAP)]
        projects.run("stelz", "uid1", "addCreators", {"projectId": pid, "creatorIds": ids[:25]})
        with self.assertRaises(projects.ProjectError) as cm:
            projects.run("stelz", "uid1", "addCreators",
                         {"projectId": pid, "creatorIds": ["instagram_c25"]})
        self.assertEqual(cm.exception.status, 409)
        self.assertIn("budget", str(cm.exception).lower())

    def test_cap_holds_ACROSS_projects(self):
        # The whole point of the cap: a second project is not a fresh allowance.
        self._seed_many(30)
        p1 = self.create(name="Project een")["project"]["id"]
        p2 = self.create(name="Project twee")["project"]["id"]
        projects.run("stelz", "uid1", "addCreators",
                     {"projectId": p1, "creatorIds": [f"instagram_c{i}" for i in range(25)]})
        with self.assertRaises(projects.ProjectError):
            projects.run("stelz", "uid1", "addCreators",
                         {"projectId": p2, "creatorIds": ["instagram_c25"]})

    def test_same_creator_in_two_projects_counts_once(self):
        pid1 = self.create(name="Een")["project"]["id"]
        pid2 = self.create(name="Twee")["project"]["id"]
        projects.run("stelz", "uid1", "addCreators", {"projectId": pid1, "creatorIds": ["instagram_anna"]})
        # Same creator again elsewhere — union, so this must not hit the cap
        # accounting twice, and must simply succeed.
        out = projects.run("stelz", "uid1", "addCreators", {"projectId": pid2, "creatorIds": ["instagram_anna"]})
        self.assertTrue(out["ok"])

    def test_archived_projects_free_their_slots(self):
        self._seed_many(30)
        p1 = self.create(name="Oud")["project"]["id"]
        projects.run("stelz", "uid1", "addCreators",
                     {"projectId": p1, "creatorIds": [f"instagram_c{i}" for i in range(25)]})
        projects.run("stelz", "uid1", "archive", {"projectId": p1})
        p2 = self.create(name="Nieuw")["project"]["id"]
        out = projects.run("stelz", "uid1", "addCreators",
                           {"projectId": p2, "creatorIds": ["instagram_c25"]})
        self.assertTrue(out["ok"])

    def test_tier_2_roster_may_exceed_the_tier_1_cap(self):
        # The Lowlands case: a 53-id campaign roster at tier_2 imports in one
        # call without touching the expensive tier_1 cap.
        pid = self.create(name="Lowlands", trackingTier="tier_2")["project"]["id"]
        ids = [f"instagram_ll{i}" for i in range(53)]
        out = projects.run("stelz", "uid1", "addCreators", {"projectId": pid, "creatorIds": ids})
        self.assertEqual(len(out["project"]["creatorIds"]), 53)
        self.assertEqual(self.creators_store["instagram_ll0"]["tier"], "tier_2")

    def test_total_cap_holds_for_tier_2_projects(self):
        pid = self.create(name="Breed", trackingTier="tier_2")["project"]["id"]
        for start in (0, 75):
            projects.run("stelz", "uid1", "addCreators",
                         {"projectId": pid, "creatorIds": [f"instagram_t{i}" for i in range(start, start + 75)]})
        with self.assertRaises(projects.ProjectError) as cm:
            projects.run("stelz", "uid1", "addCreators",
                         {"projectId": pid, "creatorIds": ["instagram_overflow"]})
        self.assertEqual(cm.exception.status, 409)
        self.assertIn("budget", str(cm.exception).lower())

    def test_tier_1_cap_ignores_tier_2_members(self):
        # 30 tier_2-tracked creators leave the tier_1 allowance untouched; the
        # 26th distinct tier_1 creator still trips it.
        p2 = self.create(name="Rustig", trackingTier="tier_2")["project"]["id"]
        projects.run("stelz", "uid1", "addCreators",
                     {"projectId": p2, "creatorIds": [f"instagram_t2c{i}" for i in range(30)]})
        p1 = self.create(name="Snel", trackingTier="tier_1")["project"]["id"]
        out = projects.run("stelz", "uid1", "addCreators",
                           {"projectId": p1, "creatorIds": [f"instagram_t1c{i}" for i in range(25)]})
        self.assertTrue(out["ok"])
        with self.assertRaises(projects.ProjectError) as cm:
            projects.run("stelz", "uid1", "addCreators",
                         {"projectId": p1, "creatorIds": ["instagram_t1c25"]})
        self.assertEqual(cm.exception.status, 409)


class TestRemoveAndArchive(ProjectsBase):
    def test_remove_reverts_tier_when_last_project(self):
        pid = self.create()["project"]["id"]
        projects.run("stelz", "uid1", "addCreators", {"projectId": pid, "creatorIds": ["instagram_anna"]})
        out = projects.run("stelz", "uid1", "removeCreators", {"projectId": pid, "creatorIds": ["instagram_anna"]})
        self.assertEqual(out["reverted"], 1)
        self.assertEqual(self.creators_store["instagram_anna"]["tier"], "tier_3")

    def test_remove_keeps_tier_when_still_in_another_project(self):
        p1 = self.create(name="Een")["project"]["id"]
        p2 = self.create(name="Twee")["project"]["id"]
        for pid in (p1, p2):
            projects.run("stelz", "uid1", "addCreators", {"projectId": pid, "creatorIds": ["instagram_anna"]})
        out = projects.run("stelz", "uid1", "removeCreators", {"projectId": p1, "creatorIds": ["instagram_anna"]})
        self.assertEqual(out["reverted"], 0)
        self.assertEqual(self.creators_store["instagram_anna"]["tier"], "tier_1")

    def test_archive_reverts_all_unclaimed_members(self):
        pid = self.create()["project"]["id"]
        projects.run("stelz", "uid1", "addCreators",
                     {"projectId": pid, "creatorIds": ["instagram_anna", "instagram_bob"]})
        out = projects.run("stelz", "uid1", "archive", {"projectId": pid})
        self.assertEqual(out["reverted"], 2)
        self.assertEqual(self.creators_store["instagram_anna"]["tier"], "tier_3")
        self.assertTrue(out["project"]["archived"])

    def test_remove_from_missing_project_is_404(self):
        with self.assertRaises(projects.ProjectError) as cm:
            projects.run("stelz", "uid1", "removeCreators",
                         {"projectId": "nope", "creatorIds": ["instagram_anna"]})
        self.assertEqual(cm.exception.status, 404)


class TestRenameAndMisc(ProjectsBase):
    def test_rename_changes_name_and_note(self):
        pid = self.create()["project"]["id"]
        out = projects.run("stelz", "uid1", "rename",
                           {"projectId": pid, "name": "Herfst", "note": "Q4"})
        self.assertEqual(out["project"]["name"], "Herfst")
        self.assertEqual(out["project"]["note"], "Q4")

    def test_unknown_action_rejected(self):
        with self.assertRaises(projects.ProjectError):
            projects.run("stelz", "uid1", "explode", {})


if __name__ == "__main__":
    unittest.main(verbosity=2)


class TestTierReconciliation(ProjectsBase):
    """Review-confirmed: a blind per-project tier stamp was wrong in both
    directions. The effective tier is the FASTEST cadence among the live
    projects that claim the creator, recomputed on every membership change."""

    def test_add_to_slower_project_does_not_downgrade(self):
        p1 = self.create(name="Snel", trackingTier="tier_1")["project"]["id"]
        p2 = self.create(name="Rustig", trackingTier="tier_2")["project"]["id"]
        projects.run("stelz", "uid1", "addCreators", {"projectId": p1, "creatorIds": ["instagram_anna"]})
        projects.run("stelz", "uid1", "addCreators", {"projectId": p2, "creatorIds": ["instagram_anna"]})
        # tier_1 project still claims anna — the tier_2 add must not slow her down.
        self.assertEqual(self.creators_store["instagram_anna"]["tier"], "tier_1")

    def test_leaving_the_fast_project_drops_to_the_remaining_slower_tier(self):
        # The 2x cost leak: leaving tier_1 while a tier_2 project remains used
        # to keep the 6h cadence forever. Now it reconciles to tier_2.
        p1 = self.create(name="Snel", trackingTier="tier_1")["project"]["id"]
        p2 = self.create(name="Rustig", trackingTier="tier_2")["project"]["id"]
        for pid in (p1, p2):
            projects.run("stelz", "uid1", "addCreators", {"projectId": pid, "creatorIds": ["instagram_anna"]})
        out = projects.run("stelz", "uid1", "removeCreators", {"projectId": p1, "creatorIds": ["instagram_anna"]})
        self.assertEqual(out["reverted"], 0)  # still tracked, so not reverted...
        self.assertEqual(self.creators_store["instagram_anna"]["tier"], "tier_2")  # ...but reconciled

    def test_archiving_the_fast_project_reconciles_too(self):
        p1 = self.create(name="Snel", trackingTier="tier_1")["project"]["id"]
        p2 = self.create(name="Rustig", trackingTier="tier_2")["project"]["id"]
        for pid in (p1, p2):
            projects.run("stelz", "uid1", "addCreators", {"projectId": pid, "creatorIds": ["instagram_anna"]})
        projects.run("stelz", "uid1", "archive", {"projectId": p1})
        self.assertEqual(self.creators_store["instagram_anna"]["tier"], "tier_2")


class TestRemoveIsArrayRemove(ProjectsBase):
    def test_remove_does_not_clobber_a_concurrent_add(self):
        # The review-confirmed HIGH: removeCreators used to write back a
        # filtered snapshot of the whole array, erasing any creator a teammate
        # added between the read and the write. With ArrayRemove the write only
        # touches the ids being removed. Simulated by injecting the concurrent
        # add between run()'s snapshot read and its write — the fake applies
        # ArrayRemove against CURRENT state, exactly like Firestore.
        pid = self.create()["project"]["id"]
        projects.run("stelz", "uid1", "addCreators", {"projectId": pid, "creatorIds": ["instagram_anna"]})

        real_run = projects.run
        store = self.projects_store

        # Inject bob directly into the stored array to model a write that lands
        # after removeCreators has read its snapshot.
        class SneakyCol(FakeCol):
            def document(self, doc_id):
                doc = super().document(doc_id)
                orig_get = doc.get
                def get_with_race():
                    snap = orig_get()
                    if snap.exists and "instagram_bob" not in (store[doc_id].get("creatorIds") or []):
                        store[doc_id]["creatorIds"] = list(store[doc_id].get("creatorIds") or []) + ["instagram_bob"]
                    return snap  # snapshot WITHOUT bob — the stale read
                doc.get = get_with_race
                return doc

        with mock.patch.object(projects.fs, "projects_col", lambda bid: SneakyCol(store)):
            out = real_run("stelz", "uid1", "removeCreators", {"projectId": pid, "creatorIds": ["instagram_anna"]})
        # bob survived the remove of anna — the old overwrite erased him.
        self.assertIn("instagram_bob", store[pid]["creatorIds"])
        self.assertNotIn("instagram_anna", store[pid]["creatorIds"])
        self.assertTrue(out["ok"])


class TestUnarchive(ProjectsBase):
    def test_unarchive_exists_and_restores_tracking(self):
        # The addCreators error says "unarchive it first" — so it has to exist.
        pid = self.create()["project"]["id"]
        projects.run("stelz", "uid1", "addCreators", {"projectId": pid, "creatorIds": ["instagram_anna"]})
        projects.run("stelz", "uid1", "archive", {"projectId": pid})
        self.assertEqual(self.creators_store["instagram_anna"]["tier"], "tier_3")
        out = projects.run("stelz", "uid1", "unarchive", {"projectId": pid})
        self.assertFalse(out["project"]["archived"])
        self.assertEqual(self.creators_store["instagram_anna"]["tier"], "tier_1")

    def test_unarchive_respects_the_cap(self):
        for i in range(30):
            self.creators_store[f"instagram_c{i}"] = {"tier": "tier_3", "handle": f"c{i}"}
        p1 = self.create(name="Oud")["project"]["id"]
        projects.run("stelz", "uid1", "addCreators",
                     {"projectId": p1, "creatorIds": [f"instagram_c{i}" for i in range(20)]})
        projects.run("stelz", "uid1", "archive", {"projectId": p1})
        p2 = self.create(name="Nieuw")["project"]["id"]
        projects.run("stelz", "uid1", "addCreators",
                     {"projectId": p2, "creatorIds": [f"instagram_c{i}" for i in range(20, 30)] + ["instagram_anna"]})
        # Reviving p1 would put 20 + 11 = 31 creators on tracked cadence.
        with self.assertRaises(projects.ProjectError) as cm:
            projects.run("stelz", "uid1", "unarchive", {"projectId": p1})
        self.assertEqual(cm.exception.status, 409)

    def test_unarchive_of_a_live_project_is_an_error(self):
        pid = self.create()["project"]["id"]
        with self.assertRaises(projects.ProjectError):
            projects.run("stelz", "uid1", "unarchive", {"projectId": pid})


class TestNames(ProjectsBase):
    """Display names ride along with list imports so a roster is readable
    before the first profile refresh — but Apify-owned data always wins."""

    def _add(self, ids, names, tier="tier_2"):
        pid = self.create(name="Met namen", trackingTier=tier)["project"]["id"]
        return projects.run("stelz", "uid1", "addCreators",
                            {"projectId": pid, "creatorIds": ids, "names": names})

    def test_stub_carries_full_name(self):
        self._add(["instagram_pleunbierbooms"], {"instagram_pleunbierbooms": "Pleun Bierbooms"})
        self.assertEqual(self.creators_store["instagram_pleunbierbooms"]["fullName"], "Pleun Bierbooms")

    def test_existing_doc_without_name_is_backfilled(self):
        self._add(["instagram_anna"], {"instagram_anna": "Anna A."})
        self.assertEqual(self.creators_store["instagram_anna"]["fullName"], "Anna A.")

    def test_existing_full_name_is_never_overwritten(self):
        self.creators_store["instagram_anna"]["fullName"] = "Anna van Apify"
        self._add(["instagram_anna"], {"instagram_anna": "Anders"})
        self.assertEqual(self.creators_store["instagram_anna"]["fullName"], "Anna van Apify")

    def test_name_is_truncated_not_rejected(self):
        self._add(["instagram_lang"], {"instagram_lang": "x" * 500})
        self.assertEqual(len(self.creators_store["instagram_lang"]["fullName"]),
                         projects.MAX_FULLNAME_LEN)

    def test_names_keys_are_normalized_to_match_ids(self):
        # Ids get lowercased on the way in; a names map built from the same
        # raw strings must still line up.
        self._add(["Instagram_Anna"], {"Instagram_Anna": "Anna"})
        self.assertEqual(self.creators_store["instagram_anna"]["fullName"], "Anna")

    def test_non_dict_names_rejected(self):
        pid = self.create()["project"]["id"]
        with self.assertRaises(projects.ProjectError):
            projects.run("stelz", "uid1", "addCreators",
                         {"projectId": pid, "creatorIds": ["instagram_anna"], "names": ["Anna"]})


class TestEventFields(ProjectsBase):
    """A project that is an EVENT also has a period and a set of tags.

    The period is the load-bearing half. Without it a festival page counts
    whatever the archive happens to hold: on the real Lowlands fixture that was
    50 sightings for a weekend that had 8, and 100.9M TikTok views where 1.2M
    fell inside the festival. Both errors ran in the flattering direction.
    """

    def test_defaults_are_absent_not_invented(self):
        # No dates means "not an event", and that must be distinguishable from
        # "an event starting at the epoch".
        p = self.create()["project"]
        self.assertIsNone(p["startsAt"])
        self.assertIsNone(p["endsAt"])
        self.assertEqual(p["hashtags"], [])

    def test_create_with_a_period_and_tags(self):
        p = self.create(startsAt="2026-08-20", endsAt="2026-08-23",
                        hashtags=["#Stelz", "lowlands"])["project"]
        self.assertEqual((p["startsAt"], p["endsAt"]), ("2026-08-20", "2026-08-23"))
        # As the platforms spell them: no '#', lowercase.
        self.assertEqual(p["hashtags"], ["stelz", "lowlands"])

    def test_a_day_is_a_day_not_an_instant(self):
        # A timestamp is accepted and stored as the calendar day it names. A
        # festival day has no timezone of its own, and every comparison
        # downstream is lexicographic on ISO text.
        p = self.create(startsAt="2026-08-20T22:00:00Z")["project"]
        self.assertEqual(p["startsAt"], "2026-08-20")

    def test_nonsense_dates_rejected(self):
        for bad in ("20-08-2026", "yesterday", "2026-13-01"):
            with self.assertRaises(projects.ProjectError):
                self.create(name=f"P {bad}", startsAt=bad)

    def test_end_before_start_rejected(self):
        with self.assertRaises(projects.ProjectError):
            self.create(startsAt="2026-08-23", endsAt="2026-08-20")

    def test_end_cannot_be_moved_before_an_untouched_start(self):
        # The check has to run against what the doc will HOLD, not only against
        # what this call sent — otherwise one field at a time walks the period
        # into an impossible shape.
        pid = self.create(startsAt="2026-08-20", endsAt="2026-08-23")["project"]["id"]
        with self.assertRaises(projects.ProjectError):
            projects.run("stelz", "uid1", "rename",
                         {"projectId": pid, "endsAt": "2026-08-19"})

    def test_rename_leaves_dates_alone_but_can_clear_them(self):
        pid = self.create(startsAt="2026-08-20", endsAt="2026-08-23",
                          hashtags=["stelz"])["project"]["id"]
        # Renaming is not "forget when this happened".
        p = projects.run("stelz", "uid1", "rename",
                         {"projectId": pid, "name": "Lowlands 2026"})["project"]
        self.assertEqual(p["startsAt"], "2026-08-20")
        self.assertEqual(p["hashtags"], ["stelz"])
        # An explicit null does clear — that is how a project stops being one.
        p = projects.run("stelz", "uid1", "rename",
                         {"projectId": pid, "startsAt": None, "endsAt": None})["project"]
        self.assertIsNone(p["startsAt"])

    def test_dates_alone_are_enough_to_edit(self):
        # Before this, "rename" with only dates raised "nothing to rename".
        pid = self.create()["project"]["id"]
        p = projects.run("stelz", "uid1", "rename",
                         {"projectId": pid, "startsAt": "2026-08-20"})["project"]
        self.assertEqual(p["startsAt"], "2026-08-20")

    def test_hashtags_are_deduped_and_bounded(self):
        p = self.create(hashtags=["stelz", "#STELZ", " stelz "])["project"]
        self.assertEqual(p["hashtags"], ["stelz"])
        with self.assertRaises(projects.ProjectError):
            self.create(name="Too many", hashtags=[f"t{i}" for i in range(200)])
        with self.assertRaises(projects.ProjectError):
            self.create(name="Not a list", hashtags="stelz")

    def test_a_doc_written_before_this_existed_still_serializes(self):
        # No migration was run. An old doc has none of these keys.
        self.projects_store["oud"] = {"name": "Oud", "creatorIds": []}
        out = projects._serialize("oud", self.projects_store["oud"])
        self.assertIsNone(out["startsAt"])
        self.assertEqual(out["hashtags"], [])


class TestRollbackKeepsExistingMembers(ProjectsBase):
    """A cap rollback must undo only what THIS call added.

    Re-adding someone already in the project is routine: the paste-import flow
    re-sends a whole roster, overlaps included. Rolling back the raw request
    would then evict members whose membership predates the call and had nothing
    to do with the breach — and _restamp would drop them to tier_3, so tracking
    would stop silently.

    Reaching the rollback at all takes a CONCURRENT add: the pre-check catches
    an over-cap request on its own, so the post-write re-check only fires when
    somebody else consumed the slots in between. That race is what the patched
    _live_projects below simulates — without it this test passes whether the
    bug is present or not, which is how the first version of it fooled me.
    """

    def test_rollback_removes_only_the_newly_added(self):
        pid = self.create(trackingTier="tier_2")["project"]["id"]
        projects.run("stelz", "uid1", "addCreators",
                     {"projectId": pid, "creatorIds": ["instagram_anna"]})

        real_live = projects._live_projects
        calls = {"n": 0}
        breach = [f"instagram_x{i}" for i in range(projects.TOTAL_TRACKED_CAP)]

        def racing_live(brand_id):
            """First call = the world before the race; later calls = after a
            concurrent project consumed every slot."""
            calls["n"] += 1
            live = real_live(brand_id)
            if calls["n"] == 1:
                return live
            return live + [("concurrent", {"trackingTier": "tier_2", "creatorIds": breach})]

        with mock.patch.object(projects, "_live_projects", racing_live):
            with self.assertRaises(projects.ProjectError):
                projects.run("stelz", "uid1", "addCreators",
                             {"projectId": pid, "creatorIds": ["instagram_anna", "instagram_bob"]})

        members = self.projects_store[pid].get("creatorIds") or []
        self.assertIn("instagram_anna", members,
                      "a pre-existing member was evicted by this call's rollback")
        self.assertNotIn("instagram_bob", members)
        self.assertEqual(self.creators_store["instagram_anna"]["tier"], "tier_2",
                         "the surviving member must keep being tracked")
