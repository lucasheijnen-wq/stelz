"""Subcultures: the scenes a brand's audience belongs to, and who is in them.

Ported from the Supabase-era tools/stelz_brand_watch/30_seed_subcultures.py.
That script wrote to a database that was removed in 2026-06, which is why the
subculture layer in compute_resonance has been dead ever since — it was never
missing code, only missing data.

WHAT A SUBCULTURE IS HERE
-------------------------
A hand-curated scene definition (signature hashtags + keywords + creator
categories) that creators are matched against. It is deliberately NOT a
clustering result: the brand needs to recognise the names ("vrijmibo",
"student life") for the output to mean anything in a meeting, and an
unsupervised cluster labelled #7 does not survive that test.

The seed list below is Stelz-specific. A second brand plugs in its own; nothing
in the matching logic is Stelz-aware.

SCOPE OF THIS MODULE
--------------------
Pure functions only — no Firestore, no network — so the matching can be tested
without standing anything up. The Firestore side lives in
handlers/seed_subcultures.py.
"""
from __future__ import annotations

from typing import Any, Iterable

# Weight of one matching signature hashtag, and of a creator-category match.
# Carried over from the legacy scorer so links keep the same meaning: category
# is a stronger single signal than any one hashtag, because it was assigned by
# the discovery pipeline rather than typed by the creator.
HASHTAG_WEIGHT = 2
CATEGORY_WEIGHT = 3

# Score at which confidence saturates to 1.0 — three hashtags, or one category
# plus two hashtags. Above this the extra matches say nothing new.
CONFIDENCE_FULL_SCORE = 6.0

# Links below this are dropped rather than stored. Set so that ONE hashtag
# (score 2 → 0.33) is never enough on its own, while two hashtags (0.67) or a
# category assignment (0.5) are.
#
# The threshold is doing real work, so it is worth being exact about it. Many
# signature tags are shared between scenes — "borrel" belongs to both student
# life and vrijmibo, "cafe" to horeca and to foodies — and a creator who used
# one of them once is not a member of that scene. Admitting single-tag links
# would put most of the creator base in most of the scenes, which flattens the
# dashboard breakdown and leaves the SRS layer unable to separate anyone.
# Requiring a second signal is the cheapest guard against that.
MIN_CONFIDENCE = 0.5

STELZ_SUBCULTURES: list[dict[str, Any]] = [
    {
        "slug": "student_life",
        "name": "Student life",
        "description": "Dutch student culture: dorms, study breaks, week-night drinks, graduation parties.",
        "signature_hashtags": [
            "studentenleven", "studenten", "studentlife", "studentenhuis", "introweek",
            "huisfeest", "borrel", "studentenstad", "leiden", "groningen",
            "utrechtstudent", "amsterdamstudent", "rotterdamstudent",
        ],
        "signature_keywords": ["student", "studeren", "huisfeest", "borrel", "dorm", "studentenkamer"],
        "category_match": ["student_org"],
        "color": "#60a5fa",
        "emoji": "🎓",
    },
    {
        "slug": "vrijmibo",
        "name": "Vrijdagmiddagborrel",
        "description": "The Dutch Friday-afternoon-drink ritual: colleagues winding down, terraces, after-work drinks.",
        "signature_hashtags": [
            "vrijmibo", "vrijdagmiddagborrel", "vrijdagborrel", "borrel", "happyhour",
            "vrijdag", "afterwork", "werkborrel", "kerstborrel",
        ],
        "signature_keywords": ["vrijmibo", "vrijdagmiddag", "happy hour", "afterwork"],
        "category_match": [],
        "color": "#fb923c",
        "emoji": "🍻",
    },
    {
        "slug": "festivals_events",
        "name": "Festivals & events",
        "description": "Dutch festival scene: Koningsdag, summer festivals, music events, outdoor party culture.",
        "signature_hashtags": [
            "festival", "koningsdag", "kingsday", "amsterdamdance", "lowlands",
            "awakenings", "extrema", "pinkpop", "dgtl", "ade", "pride",
            "festivalseizoen", "zomerfeest", "mysteryland", "defqon1",
        ],
        "signature_keywords": ["festival", "koningsdag", "outdoor"],
        "category_match": ["festival"],
        "color": "#f472b6",
        "emoji": "🎉",
    },
    {
        "slug": "house_parties",
        "name": "House parties & pregames",
        "description": "Pre-going-out at someone's place, group gatherings, intimate party content.",
        "signature_hashtags": [
            "huisfeest", "preparty", "voorfeest", "feestje", "feest",
            "girlsnight", "boysnight", "thuisfeest", "huisfeestje",
            "vriendengroep", "vriendinnenuitje", "ladiesnight", "meidenavond",
        ],
        "signature_keywords": ["huisfeest", "feestje", "preparty", "house party"],
        "category_match": [],
        "color": "#a78bfa",
        "emoji": "🏠",
    },
    {
        "slug": "horeca_nightlife",
        "name": "Horeca & nightlife",
        "description": "Cafes, bars, clubs and restaurants stocking and serving the brand.",
        "signature_hashtags": [
            "cafe", "bar", "nachtleven", "uitgaan", "uitgaansleven", "club", "horeca",
            "amsterdamnightlife", "rotterdamcafe", "denhaagbar",
        ],
        "signature_keywords": ["cafe", "bar", "restaurant", "horeca", "nightlife", "uitgaan"],
        "category_match": ["horeca"],
        "color": "#fbbf24",
        "emoji": "🍸",
    },
    {
        "slug": "foodies_lifestyle",
        "name": "Foodies & lifestyle",
        "description": "Influencers around food, cocktails, drinks pairing, lifestyle aesthetic.",
        "signature_hashtags": [
            "foodie", "cocktails", "drinkstagram", "drinkrecipes",
            "summerdrinks", "mocktail",
        ],
        "signature_keywords": ["foodie", "cocktail", "recipe"],
        "category_match": [],
        "color": "#34d399",
        "emoji": "🥂",
    },
    {
        "slug": "retail_promo",
        "name": "Retail & supermarket promo",
        "description": "Supermarkets and liquor stores promoting the brand.",
        "signature_hashtags": [
            "albertheijn", "jumbo", "aanbieding", "korting", "folder",
            "weekaanbieding",
        ],
        "signature_keywords": ["albert heijn", "jumbo", "aanbieding", "supermarkt", "korting"],
        "category_match": ["retail"],
        "color": "#ef4444",
        "emoji": "🛒",
    },
    {
        "slug": "fitness_wellness",
        "name": "Fitness & wellness",
        "description": "Sports, gym, run clubs — the non-alcoholic 0.0 angle.",
        "signature_hashtags": [
            "fitness", "gym", "running", "hardlopen", "yoga",
            "padel", "padelnederland", "fitfam",
        ],
        "signature_keywords": ["fitness", "gym", "running", "padel", "yoga", "0.0"],
        "category_match": [],
        "color": "#22d3ee",
        "emoji": "🏃",
    },
    {
        "slug": "expats_internationals",
        "name": "Expats & internationals",
        "description": "English-speaking expat community in NL; international students, professionals.",
        "signature_hashtags": [
            "expat", "expatlife", "amsterdamexpat", "internationalstudents",
            "thehague",
        ],
        "signature_keywords": ["expat", "international"],
        "category_match": [],
        "color": "#c084fc",
        "emoji": "🌍",
    },
    {
        "slug": "media_press",
        "name": "Media & press",
        "description": "Drinks media, business press and marketing publications covering the brand.",
        "signature_hashtags": ["marketingtribune", "adformatie", "fmt_marketing"],
        "signature_keywords": ["marketing", "media", "press"],
        "category_match": ["media"],
        "color": "#94a3b8",
        "emoji": "📰",
    },
]

# Tags dropped from the legacy seed list on purpose. Each of them appears on a
# large share of ALL Dutch social posts, brand-related or not, so as a
# "signature" they matched nearly everyone and flattened the breakdown:
#   weekend, drinks, party, lifestyle, english, summer, plus, deal, feest*
# (*feest stays for house_parties, where it is the scene's own word, but
# "party" and "weekend" are gone from every list.)
# Removing them is the difference between a chart that says something and a
# chart where every creator is in six scenes.


def normalize_tag(tag: str) -> str:
    return (tag or "").strip().lstrip("#").lower()


def confidence_for(score: int) -> float:
    """Match score → 0-1 confidence, saturating at CONFIDENCE_FULL_SCORE."""
    if score <= 0:
        return 0.0
    return round(min(1.0, score / CONFIDENCE_FULL_SCORE), 2)


def match_creator(
    hashtags: Iterable[str],
    category: str | None = None,
    subcultures: list[dict[str, Any]] | None = None,
) -> list[dict[str, Any]]:
    """Which scenes this creator belongs to, and how strongly.

    Returns [{slug, score, confidence, matched}], strongest first, with links
    below MIN_CONFIDENCE dropped. `matched` names the hashtags that fired, so a
    surprising link can be explained rather than just trusted — the legacy
    version stored a bare confidence number and nobody could ever tell why a
    creator had been filed under "media".
    """
    specs = subcultures if subcultures is not None else STELZ_SUBCULTURES
    tags = {normalize_tag(t) for t in (hashtags or []) if normalize_tag(t)}
    out: list[dict[str, Any]] = []
    for spec in specs:
        sig = {normalize_tag(t) for t in spec.get("signature_hashtags", [])}
        hits = sorted(tags & sig)
        score = len(hits) * HASHTAG_WEIGHT
        category_hit = bool(category) and category in (spec.get("category_match") or [])
        if category_hit:
            score += CATEGORY_WEIGHT
        conf = confidence_for(score)
        if conf < MIN_CONFIDENCE:
            continue
        out.append({
            "slug": spec["slug"],
            "score": score,
            "confidence": conf,
            "matched": hits,
            "byCategory": category_hit,
        })
    out.sort(key=lambda r: (-r["confidence"], r["slug"]))
    return out


def spec_by_slug(subcultures: list[dict[str, Any]] | None = None) -> dict[str, dict[str, Any]]:
    return {s["slug"]: s for s in (subcultures if subcultures is not None else STELZ_SUBCULTURES)}
