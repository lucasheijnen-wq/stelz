"""expand_audience — the people around a hit become candidates and edges.

The two invariants worth money:

  1. NOTHING brand-owned or already-tracked lands in the discoveryQueue — the
     queue feeds promotion, promotion feeds paid deep-scans, and enqueueing
     @drinkstelz or a roster member would spend Apify credit re-discovering
     what the brand already owns or follows.
  2. Edges ARE written for tracked creators — the SRS graph layer wants to
     know who points at whom, and it was reading a collection nothing wrote.

Everything is faked in-memory; the handler never talks to the network.
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
_fsmod = _stub("google.cloud.firestore")
for _attr, _val in (("SERVER_TIMESTAMP", "TS"), ("Increment", lambda n: ("INC", n)),
                    ("ArrayUnion", lambda v: ("UNION", tuple(v))), ("ArrayRemove", lambda v: v)):
    if not hasattr(_fsmod, _attr):
        setattr(_fsmod, _attr, _val)

from handlers import expand_audience  # noqa: E402


class Snap:
    def __init__(self, data, exists=True):
        self._d = data
        self.exists = exists

    def to_dict(self):
        return dict(self._d)


class RecordingCol:
    def __init__(self):
        self.docs: dict[str, dict] = {}

    def document(self, doc_id):
        col = self

        class Doc:
            def set(self, payload, merge=False):
                col.docs[doc_id] = payload
        return Doc()


class StreamCol:
    def __init__(self, rows):
        self._rows = rows

    def stream(self):
        return iter([Snap(r) for r in self._rows])

    def where(self, *a):
        return self

    def order_by(self, *a, **k):
        return self

    def limit(self, n):
        return self


class PostsCol:
    def __init__(self, posts):
        self._posts = posts

    def document(self, doc_id):
        posts = self._posts

        class Doc:
            def get(self):
                d = posts.get(doc_id)
                return Snap(d or {}, exists=d is not None)
        return Doc()


class ExpandBase(unittest.TestCase):
    def setUp(self):
        self.posts: dict[str, dict] = {}
        self.hits: list[dict] = []
        self.tracked: list[dict] = []
        self.queue = RecordingCol()
        self.edges = RecordingCol()
        fake_fs = types.SimpleNamespace(
            brand_doc=lambda bid: types.SimpleNamespace(get=lambda: Snap(
                {"slug": "stelz", "wordmarkAliases": ["stëlz"]})),
            creators_col=lambda bid: StreamCol(self.tracked),
            detections_col=lambda bid: StreamCol(self.hits),
            posts_col=lambda bid: PostsCol(self.posts),
            discovery_queue_col=lambda bid: self.queue,
            edges_col=lambda bid: self.edges,
            composite_id=lambda *parts: "_".join(str(p).lower() for p in parts if p),
        )
        p = mock.patch.object(expand_audience, "fs", fake_fs)
        p.start()
        self.addCleanup(p.stop)

    def hit_post(self, post_id, **fields):
        self.hits.append({"postId": post_id, "detected": True})
        self.posts[post_id] = {"creatorHandle": "anna", "platform": "instagram",
                               **fields}


class TestExpansion(ExpandBase):
    def test_tagged_friend_becomes_candidate_and_edge(self):
        self.hit_post("instagram_p1", taggedUsers=["bram"])
        out = expand_audience.run("stelz")
        self.assertEqual(out["candidates"], 1)
        q = self.queue.docs["instagram_bram"]
        self.assertEqual(q["handle"], "bram")
        self.assertEqual(q["sources"], ("UNION", ("audience:tag",)))
        edge = list(self.edges.docs.values())[0]
        self.assertEqual((edge["srcHandle"], edge["dstHandle"], edge["edgeType"]),
                         ("anna", "bram", "tag"))

    def test_mention_becomes_candidate_with_its_own_source(self):
        self.hit_post("instagram_p1", mentions=["@carla"])
        expand_audience.run("stelz")
        self.assertEqual(self.queue.docs["instagram_carla"]["sources"],
                         ("UNION", ("audience:mention",)))

    def test_brand_owned_handles_are_never_enqueued_nor_edged(self):
        self.hit_post("instagram_p1", taggedUsers=["drinkstelz", "stelzbelgie"],
                      mentions=["stëlz_nl"])
        out = expand_audience.run("stelz")
        self.assertEqual(out["candidates"], 0)
        self.assertEqual(self.queue.docs, {})
        self.assertEqual(self.edges.docs, {})

    def test_tracked_creator_gets_an_edge_but_no_queue_entry(self):
        self.tracked.append({"handle": "bram"})
        self.hit_post("instagram_p1", taggedUsers=["bram"])
        out = expand_audience.run("stelz")
        self.assertEqual(out["candidates"], 0)
        self.assertEqual(len(self.edges.docs), 1)

    def test_poster_tagging_themselves_is_noise(self):
        self.hit_post("instagram_p1", taggedUsers=["anna"], mentions=["anna"])
        out = expand_audience.run("stelz")
        self.assertEqual(out["candidates"], 0)
        self.assertEqual(self.edges.docs, {})

    def test_rerun_converges_on_the_same_edge_ids(self):
        self.hit_post("instagram_p1", taggedUsers=["bram"])
        expand_audience.run("stelz")
        first = set(self.edges.docs)
        expand_audience.run("stelz")
        self.assertEqual(set(self.edges.docs), first,
                         "edge-ids moeten deterministisch zijn — herdraaien is upsert")

    def test_duplicate_detections_walk_the_post_once(self):
        # A video hit has a detection doc per frame; the post must count once.
        self.hit_post("instagram_p1", taggedUsers=["bram"])
        self.hits.append({"postId": "instagram_p1", "detected": True})
        out = expand_audience.run("stelz")
        self.assertEqual(out["hitsWalked"], 1)
        self.assertEqual(self.queue.docs["instagram_bram"]["signalCount"], ("INC", 1))


if __name__ == "__main__":
    unittest.main()
