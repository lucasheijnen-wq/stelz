"""One-shot bootstrap for a new brand.

Called by an authenticated user from the UI. Creates:
  - /brands/{brandId}            (if missing)
  - /brands/{brandId}/members/{uid}   (caller becomes owner — FIRST CLAIM ONLY)
  - /brands/{brandId}/hashtagPool/{tag}   (default seed)

Idempotent — safe to call multiple times.

Membership is granted only when the brand has no members yet. See the comment
at step 2: enrolling every caller turned the membership gate into a no-op.
"""
from __future__ import annotations
from typing import Any

from google.cloud.firestore import SERVER_TIMESTAMP

from lib import fs, hashtags


DEFAULT_PRODUCT_LINES = {
    "hard_lemonade": "Hard Lemonade",
    "hard_seltzer": "Hard Seltzer",
    "hard_iced_tea": "Hard Iced Tea",
    "mixed_classics": "Mixed Classics",
    "logo_only": "Logo only",
    "zero_zero": "Zero-zero",
}

DEFAULT_VISUAL_IDENTITY = """- "STËLZ" wordmark with an umlaut on the E, set in navy blue
- An S-in-circle ring icon; ring color encodes the product line:
  orange = Hard Lemonade, red/pink = Hard Seltzer, teal/green = Hard Iced Tea,
  yellow = Mixed Classics, brown = 0.0 (non-alc)
- Curved tagline on the can: HARD SELTZER / HARD LEMONADE / HARD ICED TEA / MIXED CLASSICS
- Slim Dutch beverage can (250ml or 330ml) with these visual cues
- Logo-only matches are ok if no can is visible but the wordmark is clear"""

DEFAULT_WORDMARK_ALIASES = ["stelz", "stélz", "stëlz"]

DEFAULT_TUNING = {
    "confidenceMin": 0.85,
    "embeddingThreshold": 0.55,
    "dailyBudgetUsd": 5.0,
}

# Hashtag seeds now come from lib/hashtags.build_pool(). The two hand-kept
# lists that used to live here and in firebase/seed_brand.py had already
# drifted apart (this file seeded 10 TikTok tags, that one seeded 3), and
# neither contained a single misspelling of the brand name.


def run(brand_id: str, brand_name: str, uid: str, user_email: str | None = None) -> dict[str, Any]:
    """Create brand + add caller as owner-member + seed hashtag pool."""
    # 1. Brand doc — create with full defaults if missing, otherwise top up
    # only the fields that are currently absent/empty (preserves user edits).
    brand_ref = fs.brand_doc(brand_id)
    brand_snap = brand_ref.get()
    if not brand_snap.exists:
        brand_ref.set({
            "slug": brand_id,
            "name": brand_name,
            "active": True,
            "productLines": DEFAULT_PRODUCT_LINES,
            "visualIdentity": DEFAULT_VISUAL_IDENTITY,
            "wordmarkAliases": DEFAULT_WORDMARK_ALIASES,
            **DEFAULT_TUNING,
            "createdAt": SERVER_TIMESTAMP,
        })
        created_brand = True
    else:
        created_brand = False
        existing = brand_snap.to_dict() or {}
        topup: dict[str, Any] = {}
        if not existing.get("productLines"):
            topup["productLines"] = DEFAULT_PRODUCT_LINES
        if not existing.get("visualIdentity"):
            topup["visualIdentity"] = DEFAULT_VISUAL_IDENTITY
        if not existing.get("wordmarkAliases"):
            topup["wordmarkAliases"] = DEFAULT_WORDMARK_ALIASES
        for k, v in DEFAULT_TUNING.items():
            if existing.get(k) is None:
                topup[k] = v
        if topup:
            brand_ref.set(topup, merge=True)

    # 2. Membership for caller — FIRST CLAIM ONLY.
    #
    # This used to enrol every caller as an owner unconditionally, which made
    # the membership gate in main.py meaningless: "Run scan" calls bootstrap
    # first (Home.tsx), so anyone who signed in with any Google account and
    # pressed the button promoted themselves to owner of an existing brand,
    # and with it the right to reject detections and delete reference images.
    #
    # A brand with no members yet is unclaimed — the first caller owns it, which
    # is what makes self-serve onboarding work. Once it has one, membership is
    # an invite-only decision and this function must not grant it.
    member_ref = brand_ref.collection("members").document(uid)
    if member_ref.get().exists:
        added_member = False
    elif any(True for _ in brand_ref.collection("members").limit(1).stream()):
        # Brand already claimed by someone else. Not an error — the caller may
        # legitimately be a read-only tester whose UI called bootstrap on the
        # way to a scan. They simply don't become a member.
        added_member = False
    else:
        member_ref.set({
            "role": "owner",
            "email": user_email,
            "addedAt": SERVER_TIMESTAMP,
        })
        added_member = True

    # 3. Hashtag pool — idempotent at the doc level. Missing ones get created;
    # existing ones get priority/active refreshed (safe). Count active afterwards.
    pool_col = fs.hashtag_pool_col(brand_id)
    written = 0
    for platform in ("instagram", "tiktok"):
        # For stelz: the CANONICAL pool builder, which is also what
        # seed_brand.py and the tests use. Building a near-copy inline here is
        # how the category family (#hardseltzernl — the only competitor-
        # adjacent surface) silently never reached a UI-bootstrapped brand:
        # only stelz_pool() adds it. Since bootstrap runs at the start of
        # every dashboard scan and these writes are merge-idempotent, this is
        # also how pool WIDENINGS reach an existing brand without a manual
        # seed — the next Run scan click syncs them.
        entries = (
            hashtags.stelz_pool(platform) if brand_id == "stelz"
            else hashtags.build_pool(
                slug=brand_id,
                product_lines=DEFAULT_PRODUCT_LINES,
                # TikTok search is fuzzy and tag-poor; misspelled tags mostly
                # return noise there while still costing an actor run each.
                include_typos=(platform == "instagram"),
            )
        )
        for entry in entries:
            pool_col.document(f"{platform}_{entry['tag']}").set(
                {
                    "tag": entry["tag"],
                    "platform": platform,
                    "priority": entry["priority"],
                    "family": entry["family"],
                    "maxResults": entry["maxResults"],
                    "active": True,
                },
                merge=True,
            )
            written += 1

    active_count = sum(1 for _ in pool_col.where("active", "==", True).stream())

    return {
        "brand_id": brand_id,
        "created_brand": created_brand,
        "added_member": added_member,
        "hashtags_seeded": written,
        "hashtags_active": active_count,
    }
