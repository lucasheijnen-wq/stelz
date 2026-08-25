# Deploy notes — access control, sentiment, audience blocks

Written for the change set that closed the tester write-access hole and added
the audience-insight blocks. Read this before deploying; step 1 needs a
decision that cannot be made in code.

---

## 1. ⚠️ Audit the member list FIRST

**Do this before deploying, and expect the list to be wrong.**

The membership gate was disabled (`_require_brand_member` returned
unconditionally) while `api_bootstrap_brand` enrolled every caller as an
`owner` — and the UI calls bootstrap as the first step of **Run scan**. So
`/brands/stelz/members` very likely contains an `owner` document for **every
person who has ever pressed Run scan**, testers included.

Turning the gate on does not undo that. It hands exactly those accounts the
permissions the gate was meant to restrict.

**There is no CLI command for this.** The Firebase CLI cannot read or write
Firestore documents (`firebase firestore:…` does not exist as a read command),
and this project has no `gcloud` set up. Two workable routes:

1. **Firebase console** — Firestore → `brands/stelz/members`. Fastest for a
   one-off audit, and the only option before the new code is deployed.
2. **Settings → Access in the app**, once this change set is live. Lists every
   member and removes them with one click. This is the route to use from then
   on (§5).

Remove anyone who should not be able to reject detections, edit reference
images, or start a paid scan. Keep the accounts that genuinely moderate.

**Ordering note.** Deploying does not widen access — today the gate is off and
*everyone* signed in can write, so the deploy strictly narrows it. Auditing
after the deploy is therefore safe, and the Access panel makes it easier. The
one case worth checking first is an EMPTY member list: the brand would then be
unclaimed, and the first person to press Run scan becomes its owner.

---

## 2. Deploy order

Rules and functions first, frontend last — the UI hides controls that the
server would refuse, and shipping it first would only hide them cosmetically
while the backend still accepted the writes.

```bash
# 1. Rules — closes the reference-image hole (any signed-in user could delete)
firebase deploy --only firestore:rules --project brand-audit-4b2cc

# 2. Functions — membership gate, member admin, sentiment + subculture steps
cd firebase/functions && firebase deploy --only functions --project brand-audit-4b2cc

# 3. Frontend
cd projects/stelz-brand-watch/web && npm run build   # then deploy the build
```

Verify with a throwaway Google account that is **not** a member:

- [ ] The dashboard loads and every tab is browsable
- [ ] A **Read-only** banner is visible on Home and Settings
- [ ] No ✕ on feed cards, no Review verdict buttons, no **Run scan**
- [ ] Settings → Reference images shows the photos but no upload zone and no ✕
- [ ] Arrow keys in the Review tab do nothing (the keyboard path is gated too)
- [ ] Settings → Hashtags: the checkbox, priority field and Remove are inert
- [ ] Settings → Access lists the members but offers no add/remove controls

---

## 3. Sentiment: first run and cost

Sentiment is scored by a **separate, text-only** Gemini call, deliberately not
folded into the detection prompt — feeding the caption to the detector makes it
hallucinate wordmarks it cannot read. See the header of `lib/sentiment.py`.

It runs as a step (`api_step_sentiment`), fired automatically at the end of
each scan and capped at 400 posts per run. The existing back catalogue is
unscored, so it drains over several runs. To backfill deliberately:

```bash
curl -X POST https://europe-west1-brand-audit-4b2cc.cloudfunctions.net/api_step_sentiment \
  -H "Authorization: Bearer <id-token>" -H "Content-Type: application/json" \
  -d '{"brandId":"stelz","limit":400}'
```

Cost: ~$0.0002 per post (`gemini_sentiment_calls` in `lib/usage.py`), so a
6,900-hit catalogue is roughly **$1.40 in total**, one time. Rounding error
next to Apify — the daily budget guard still stops it if the day's spend is
already at the ceiling.

Unscored hits are excluded from the dashboard's sentiment numbers rather than
counted as neutral. Nothing looks broken while the backfill runs; the block
states how many are still queued.

---

## 4. Subcultures: seed them, then rescore

The subculture layer is alive again. It was dead because its seed data lived in
the Supabase database removed in 2026-06 — never because the code was missing.
`handlers/seed_subcultures.py` produces that data in Firestore now.

**Run the seeding step once after deploying, before the next SRS run:**

```bash
curl -X POST https://europe-west1-brand-audit-4b2cc.cloudfunctions.net/api_step_subcultures \
  -H "Authorization: Bearer <id-token>" -H "Content-Type: application/json" \
  -d '{"brandId":"stelz"}'
```

It is free (pure compute over Firestore, no Gemini, no Apify) and idempotent.
The response reports `creators_linked` vs `creators_unplaced` — if almost
everyone is unplaced, the signature hashtags in `lib/subcultures.py` don't match
this brand's audience and want editing before anyone reads the chart.

**Order matters.** `api_step_srs` reads the links this writes. Run scan now
chains hashtags → creators → subcultures → SRS for exactly that reason; a
manual rescore in the wrong order leaves the layer redistributed for another
cycle.

**Scores will move.** `SRS_VERSION` is now 3: the subculture layer takes 15%
back from graph/hashtag/comment, so every creator's number changes on the next
run. That is expected, and `srsVersion` on each resonance doc is what makes a
"why did this creator drop" conversation answerable.

Two frontend files mirror backend constants and must be changed together:

| Backend | Frontend | What breaks if they drift |
|---|---|---|
| `compute_resonance.py` weights | `web/src/lib/srs.ts` `SRS_WEIGHTS` | The bars stop adding up to the score printed beside them |
| `redistribute_weight()` | `srs.ts` `redistribute()` | Same, for brands without subculture data |

**The dashboard scenes block prefers subcultures and falls back** to grouping
each photo by what the detector saw in it (`activity`/`setting`), so a brand
that has never been seeded still gets a block. The two count differently — a
subculture is a property of the creator, a photo grouping a property of the
post — and the block's copy switches with the source.

**SRS breakdown** (`lib/srs.ts`) duplicates the layer weights from
`compute_resonance.py`. **Keep the two in sync**; a breakdown rendered against
stale weights looks authoritative and is wrong. The file says so at the top.

---

## 5. Granting access after the deploy

There is a UI for this now: **Settings → Access**. It lists the current members
and lets an existing member add one by email. Two constraints worth knowing
before you need them at speed:

- The person must have **signed in at least once**. Membership keys on the
  Firebase uid, which doesn't exist until then; the server returns a clear
  error rather than creating a membership nobody can use.
- **The last owner cannot be removed.** A brand with no owners cannot be
  administered by anyone, since adding a member requires being one.

The manual Firestore write in §1 still works and is the way out if every owner
is ever removed by other means.

---

## 6. Still open

- **Reference-image moderation ownership.** `TESTING.md` used to tell testers to
  check with Lukas, which no record in this repo supports. The instruction is
  gone; testers are now simply told they cannot edit them. Naming a real owner
  is still an open decision.
- **`<REPO-URL>` in `TESTING.md` §2** is a placeholder. Fill it in before
  sending the doc to anyone.
- **No email invitations.** Settings → Access grants membership to an account
  that already exists; it doesn't send anything. The person has to be told
  separately to sign in first.
- **Subculture definitions are hand-curated for Stelz** (`lib/subcultures.py`).
  A second brand needs its own list; nothing in the matching logic is
  Stelz-aware, but the seed list is.

---

## 7. Live smoke test — bewijs dat een scan afrondt (~$0,25)

Direct na elke functions-deploy, vóór iemand de grote knop indrukt. Wie: een
**ingelogde brand-member** (uid onder `/brands/stelz/members/`); een
niet-member krijgt 403 op elke stap.

**Token halen**: log in op het gedeployde dashboard, DevTools → Application →
IndexedDB → `firebaseLocalStorageDb` → het veld `idToken` van de ingelogde
user. Geldig ~1 uur.

```bash
BASE=https://europe-west1-brand-audit-4b2cc.cloudfunctions.net

curl -sX POST $BASE/api_step_hashtags -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -d '{"brandId":"stelz","perTag":10,"maxTags":2}'
curl -sX POST $BASE/api_step_creators -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -d '{"brandId":"stelz","maxCreators":2,"postsPer":2}'
curl -sX POST $BASE/api_step_stories -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -d '{"brandId":"stelz","maxHandles":5}'
```

Binnen ~3 minuten hoort in Firestore (`brands/stelz`, veld `scan`):
`hashtagQueued == hashtagDone == 2`, `finishedAt` gezet, `endReason ==
"tags_complete"`, `steps.hashtags/creators/stories` allemaal terminaal, en
`detectionsCompleted` convergeert naar `detectTasksEnqueued` **zonder
overschot** (alle drie de paden voeden nu de noemer). Dashboard: de pil gaat
Scanning → "Scan afgerond"; geen enkele staprij blijft op running. Kosten
≈ $0,25 op het usage-doc van vandaag.

Daarna één volledige knop-scan: verwacht een `TRIMMED`-logregel in Cloud
Logging als de standaard boven het resterend dagbudget projecteert, en een
dagtotaal ≤ `dailyBudgetUsd`.

## 8. Lowlands online zetten (eenmalig, na de functions-deploy)

```bash
# eerst zien wat er zou gaan (leest alleen lokale fixtures):
./firebase/functions/venv/bin/python tools/stelz_brand_watch/78_upload_event.py \
    --event lowlands-2026 --dry-run
# dan echt, met een member-token (zie §7):
./firebase/functions/venv/bin/python tools/stelz_brand_watch/78_upload_event.py \
    --event lowlands-2026 --token "$TOKEN"
```

Idempotent: doc-ids zijn deterministisch en media is content-addressed —
herdraaien na een verlopen token maakt niets dubbel. Controle daarna:
`/evenementen/lowlands-2026` op de productie-URL toont dezelfde teller als
`77_voortgang.py` lokaal, en het Publiek-tabblad rendert uit het
`eventAudience`-doc.
