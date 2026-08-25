"""Hashtag pool generation — brand-agnostic, cost-aware.

Replaces two hand-maintained lists (`firebase/seed_brand.py` and
`handlers/bootstrap_brand.py`) that had already drifted apart: bootstrap seeded
10 TikTok tags including `carnaval2026` and `hardseltzer`, seed_brand seeded 3.
Neither contained a single misspelling.

WHY FAMILIES, AND WHY A PER-TAG RESULT CAP
------------------------------------------
Apify bills per RESULT, not per run — measured, see lib/usage.py. So the
expensive dial is how many results each tag pulls, NOT how many tags exist:

  #stelzcassis at 20 available posts   ->    20 results  -> $0.05
  #koningsdag at perTag=500            ->   500 results  -> $1.15

And measured conversion (projects/.../discovery-strategy.md) is brutally
lopsided: `hashtag:stelz` converts at 55.6%, lifestyle tags at ~0%.

The old code applied ONE global perTag to every tag, so lifestyle tags — the
ones that never find a can — consumed the same budget as the brand's own tag.
Each family now carries its own `max_results`, and publish_tags honours it.

That also makes wide typo coverage nearly free. A hashtag nobody has ever used
returns zero results and therefore costs nothing; the only real cost of a dead
tag is one actor invocation. This is why we can afford to chase misspellings.

Lifestyle tags are kept, but small and explicitly re-framed: their job is
creator PROSPECTING (find people, promote them, then scan their whole feed —
which is the only route to untagged content), not finding cans directly. Judge
them on creators promoted per euro, not on post-level hit rate.
"""
from __future__ import annotations

from lib import identity

# family -> (priority, max_results, why)
# priority drives which tags survive the max_tags cut in publish_tags().
# max_results is the per-tag Apify cap; None means "use the caller's default".
FAMILIES: dict[str, tuple[int, int | None, str]] = {
    "brand_core": (10, None, "The brand's own tags. Highest yield; take everything."),
    "product_line": (9, None, "#<brand>hardseltzer etc. Narrow and high-intent."),
    "brand_event": (8, 300, "Parties, venues, festivals the brand runs or sponsors."),
    "flavour": (8, 200, "Per-flavour tags. Small pools, saturate quickly."),
    "brand_typo": (6, 100, "Misspellings. Most return nothing, and nothing is free."),
    "category": (5, 150, "#hardseltzernl — competitor-adjacent, occasional finds."),
    "lifestyle": (3, 60, "Creator prospecting ONLY. ~0% post-level hit rate."),
}


def _tag(name: str, family: str) -> dict:
    prio, cap, _ = FAMILIES[family]
    return {"tag": name, "family": family, "priority": prio, "maxResults": cap}


def build_pool(
    slug: str,
    product_lines: dict[str, str] | None = None,
    flavours: list[str] | None = None,
    events: list[str] | None = None,
    lifestyle: list[str] | None = None,
    aliases: list[str] | None = None,
    include_typos: bool = True,
) -> list[dict]:
    """Generate the full hashtag pool for one brand.

    Returns dicts of {tag, family, priority, maxResults}, deduped, ordered by
    priority then name. Deterministic: same inputs always produce the same pool,
    so re-seeding is idempotent and a diff is reviewable.
    """
    canonical = identity.normalize(slug)
    if not canonical:
        return []

    out: dict[str, dict] = {}

    def add(name: str, family: str) -> None:
        n = identity.normalize(name).replace(" ", "").lstrip("#")
        # Instagram rejects tags under 2 chars; skip anything degenerate.
        if len(n) < 3 or n in out:
            return
        out[n] = _tag(n, family)

    # ── brand core ────────────────────────────────────────────────────
    add(canonical, "brand_core")
    for prefix in ("drink", "team", "thisis"):
        add(f"{prefix}{canonical}", "brand_core")
    for suffix in ("official", "nl", "int", "world"):
        add(f"{canonical}{suffix}", "brand_core")
    for a in aliases or []:
        add(a, "brand_core")

    # ── product lines ─────────────────────────────────────────────────
    # "hard_seltzer" -> #stelzhardseltzer. Skips internal-only keys like
    # logo_only / zero_zero that nobody would ever hashtag.
    for key in (product_lines or {}):
        compact = identity.normalize(key).replace("_", "")
        if compact and not compact.startswith(("logo", "zero")):
            add(f"{canonical}{compact}", "product_line")

    for f in flavours or []:
        add(f"{canonical}{f}", "flavour")

    for e in events or []:
        add(e, "brand_event")

    # ── misspellings ──────────────────────────────────────────────────
    # BOTH strict and loose here, which is safe precisely because this is
    # DISCOVERY, not acceptance. A loose variant finding junk posts costs one
    # scrape and vision still filters every image; a loose variant allowed to
    # ACCEPT a detection would put false positives in the client's feed. That
    # split is enforced in detect_image._accept_variants, which takes strict
    # only. See lib/identity.py.
    if include_typos:
        v = identity.generate_variants(canonical)
        for name in sorted(set(v["strict"]) | set(v["loose"])):
            add(name, "brand_typo")
        # Typo'd forms of the highest-value compound, e.g. #drinkstelzz.
        for name in sorted(v["strict"]):
            add(f"drink{name}", "brand_typo")

    for name in lifestyle or []:
        add(name, "lifestyle")

    return sorted(out.values(), key=lambda d: (-d["priority"], d["tag"]))


# ── Stelz tenant defaults ────────────────────────────────────────────
# Everything below is Stelz-specific CONFIG, not logic. A second tenant
# supplies its own and the code above is unchanged.
STELZ_FLAVOURS = ["cassis", "peach", "lime", "mango", "lemon", "raspberry"]
STELZ_EVENTS = [
    "casastelz", "stelzhouse", "stelzibiza", "stelzfest", "stelzbeuk",
    "stelzcheck", "stelzparty", "stelzsummer",
    # Fan-coined tags measured in the wild during Lowlands 2026 — real people
    # already write these, so searching them is free precision.
    "welovestelz", "ilovestelz",
]
# Dutch party/occasion tags. Deliberately few and capped low — see module
# docstring. Their measured post-level hit rate is ~0%; they exist to surface
# creators whose feeds are then deep-scanned.
#
# The names come from the repo's own measured circle lists (the dormant
# 04_discover_lifestyle groups and the 13-seed creator list), NOT from
# brainstorming: borrel-family, vriendengroep/ladiesnight, nachtleven,
# introweek, huisfeest variants. The denylist below subcultures.py still
# applies in spirit — nothing here is a word that matches all of Dutch social
# media (no "weekend", no "party", no "gezelligheid").
STELZ_LIFESTYLE_IG = [
    "vrijmibo", "huisfeest", "koningsdag", "studentenleven",
    "borrel", "festivalseizoen", "terrasweer",
    "werkborrel", "afterwork", "thuisfeest", "zomerfeest",
    "vriendinnenuitje", "ladiesnight", "meidenavond",
    "nachtleven", "uitgaansleven", "introweek",
]
STELZ_LIFESTYLE_TT = [
    "vrijmibo", "huisfeest", "studentenleven", "nederland", "carnaval",
    "borrel", "koningsdag", "festivalseizoen",
    "ladiesnight", "nachtleven", "introweek",
]
STELZ_CATEGORY = ["hardseltzernl", "hardseltzer", "hardlemonade"]


def stelz_pool(platform: str = "instagram") -> list[dict]:
    """The Stelz pool for one platform.

    TikTok gets no typo family: its search is fuzzy and tag-poor compared with
    Instagram, so misspelled tags mostly return unrelated noise there while
    still costing an actor run each.
    """
    pool = build_pool(
        slug="stelz",
        product_lines={
            "hard_seltzer": "", "hard_lemonade": "",
            "hard_iced_tea": "", "mixed_classics": "",
        },
        flavours=STELZ_FLAVOURS,
        events=STELZ_EVENTS,
        lifestyle=(STELZ_LIFESTYLE_IG if platform == "instagram" else STELZ_LIFESTYLE_TT),
        aliases=["stelzdrinks"],
        include_typos=(platform == "instagram"),
    )
    for name in STELZ_CATEGORY:
        if not any(t["tag"] == name for t in pool):
            pool.append(_tag(name, "category"))
    return sorted(pool, key=lambda d: (-d["priority"], d["tag"]))


# Minimum slots guaranteed to each family present in the pool, before the
# remaining capacity is handed out by priority.
#
# WHY THIS EXISTS — a measured bug, not a preference.
# publish_tags used to take `sorted(pool, key=priority, reverse=True)[:max_tags]`.
# With the shipped 117-tag pool and the shipped max_tags=50, the top 50 is
# exactly brand_core + product_line + brand_event + flavour, so the cut landed
# mid-priority-8 and removed:
#
#     brand_typo   45 of 45 tags
#     lifestyle    12 of 12 tags
#     category      6 of 6 tags
#
# Every lifestyle tag, every time. Those are the tags this module's own docstring
# calls "the only route to untagged content" — and untagged content is the entire
# product. A pure priority sort cannot express "mostly the good stuff, but never
# zero of the prospecting stuff", so it silently chose zero.
#
# Cost is NOT what this trades away: the per-family max_results caps already do
# that job. Three lifestyle tags cost 3 x 60 = 180 results (~$0.41); three
# brand_core tags cost 3 x 500 = 1500 (~$3.45). The cheap families were the ones
# being cut.
FAMILY_FLOOR = 3


def select_tags(pool: list[dict], max_tags: int, floor: int = FAMILY_FLOOR) -> list[dict]:
    """Choose which tags to scan, guaranteeing every family a foothold.

    Two passes, the same shape as refs._select_reference_docs (which exists for
    the identical failure: an unstratified pick that silently drops a whole
    category):

      1. up to `floor` tags from each family, best-priority first
      2. fill the remaining slots by priority

    Ordering within a family is by priority then tag name, so the result is
    deterministic — two runs with the same pool must enqueue the same tags, or
    week-on-week yield comparisons mean nothing.
    """
    if max_tags <= 0 or not pool:
        return []

    def _key(d: dict):
        return (-int(d.get("priority") or 0), str(d.get("tag") or ""))

    ordered = sorted(pool, key=_key)

    by_family: dict[str, list[dict]] = {}
    for d in ordered:
        by_family.setdefault(str(d.get("family") or "_none"), []).append(d)

    picked: list[dict] = []
    seen: set[int] = set()

    # Pass 1 — floor per family, families themselves taken best-priority first so
    # that when max_tags is too small to cover every family, the ones that get
    # squeezed out are the lowest-value.
    for fam in sorted(by_family, key=lambda f: _key(by_family[f][0])):
        for d in by_family[fam][:floor]:
            if len(picked) >= max_tags:
                break
            picked.append(d)
            seen.add(id(d))

    # Pass 2 — everything else, best priority first.
    for d in ordered:
        if len(picked) >= max_tags:
            break
        if id(d) not in seen:
            picked.append(d)
            seen.add(id(d))

    return sorted(picked, key=_key)


def projected_results(tags: list[dict], per_tag: int) -> int:
    """Upper bound on Apify results for a selection — i.e. what it will cost.

    Apify bills per RESULT, so this is the number that matters, not the tag
    count. Worth logging on every publish: the shipped defaults
    (per_tag=500, max_tags=50) project ~19,200 results ~= $44 against a $5
    default daily budget, which is why the second scan of a day gets refused.
    """
    total = 0
    for d in tags:
        cap = d.get("maxResults")
        total += min(per_tag, int(cap)) if isinstance(cap, (int, float)) and cap else per_tag
    return total


def pool_patch_docs(pool: list[dict], existing_ids: set[str]) -> list[tuple[str, dict]]:
    """Turn a client hashtag-pool payload into (doc_id, doc) writes.

    Pure — extracted from api_brand_settings_update so the two-regime rule
    below is testable without the functions runtime.

    NEW tag (id not in existing_ids — i.e. a client-added custom term):
    defaults family="custom", maxResults=200, kind="hashtag". The cap is the
    feature: an uncapped UI-added tag scrapes at the caller's full per_tag
    (500 results ~= $1.15/tag/scan; ten of them is +$11.50 per scan click
    against a $5/day budget). family="custom" also buys the FAMILY_FLOOR
    guarantee in select_tags, so client terms are never starved by priority.

    EXISTING tag: only fields the client explicitly sent are written. The UI
    round-trips the entire pool on save, and defaulting here would silently
    restamp every seeded brand_core/lifestyle tag as "custom" — corrupting the
    taxonomy select_tags budgets by.

    "keyword" kind is accepted as data-model prep only; nothing scrapes
    keywords yet (no actor exists) and publish_tags treats every doc as a
    hashtag.
    """
    valid_families = set(FAMILIES) | {"custom"}
    out: list[tuple[str, dict]] = []
    for h in pool:
        tag = (h.get("tag") or "").strip().lower().lstrip("#")
        platform = h.get("platform") or "instagram"
        if not tag:
            continue
        doc_id = f"{platform}_{tag}"
        doc: dict = {
            "tag": tag,
            "platform": platform,
            "priority": int(h.get("priority", 5)),
            "active": bool(h.get("active", True)),
        }
        is_new = doc_id not in existing_ids
        fam = h.get("family")
        if fam is not None or is_new:
            fam = fam or "custom"
            if fam in valid_families:
                doc["family"] = fam
        cap = h.get("maxResults")
        if cap is not None or is_new:
            try:
                cap = int(cap) if cap is not None else 200
            except (TypeError, ValueError):
                cap = 200
            doc["maxResults"] = max(10, min(1000, cap))
        kind = h.get("kind")
        if kind is not None or is_new:
            doc["kind"] = kind if kind in ("hashtag", "keyword") else "hashtag"
        out.append((doc_id, doc))
    return out
