# Shared Charlotte Context

Location and commute facts that apply to every real-estate agent in this
repo. Per-agent prompts reference this file instead of duplicating the
content, so a change to (for example) the work address or neighborhood
ranking happens in one place.

## Origin

- Current residence: Ballantyne, south Charlotte, NC
- Timezone: `America/New_York`

## Work address

- 500 Tyvola Rd, Charlotte, NC 28217
- Near exit 5 of I-77
- In-person work — commute is a real constraint, not a soft preference

## Commute envelope

- Max distance to work: **12 miles**
- Max morning rush-hour drive time: **30 minutes**
- For each listing, estimate driving distance and rush-hour drive time to
  500 Tyvola Rd. Discard anything beyond the envelope.

## Preferred neighborhoods (ranked)

All inside the 12 mi / 30 min envelope. Higher rank = stronger preference.

1. Tyvola / Yorkmount (closest to work)
2. Steele Creek
3. Berewick
4. Piper Glen
5. Pineville
6. Matthews (verify commute)
7. Mint Hill (verify commute)

## Avoid

Do not include listings in these areas:

- Ballantyne
- Stonecrest
- South Charlotte in general
- Center City / Uptown (too expensive, wrong direction from work)
- University area / UNCC (too far from the south)
- NoDa / Plaza Midwood (too far from work)
- West Charlotte beyond Steele Creek
- Anywhere more than 12 miles from 500 Tyvola Rd

## ZIP code whitelist

Fast rejection filter: apply this **before** doing per-listing distance
math. Extract the ZIP from the address (last 5-digit token in the
listing's street address). If the ZIP isn't in one of the sets below,
reject the listing outright — saves search-quota and distance-lookup
cost.

### Preferred ZIPs — accept and score normally

- **28217** — Tyvola / Yorkmount (work zone)
- **28273** — Steele Creek core
- **28278** — Steele Creek / Berewick south
- **28134** — Pineville

### Edge-case ZIPs — accept only if the listing is in a preferred neighborhood

These ZIPs contain BOTH preferred and avoided areas. Cross-check the
neighborhood name in the listing before accepting:

- **28277** — includes Piper Glen (preferred) AND Ballantyne (avoid).
  Accept only if the address is clearly in Piper Glen proper. If the
  listing lists "Ballantyne" as the neighborhood, reject.
- **28210** — mixed south-Charlotte edge. Accept only if the address is
  in Tyvola/Yorkmount side, not near SouthPark.

### Verify-commute ZIPs — 1BR agent may accept, 2BR agent must reject

Outside the 2BR agent's 8 mi cap but potentially inside the shared
12 mi / 30 min envelope. The 1BR agent must still confirm rush-hour
drive time ≤ 30 min per listing:

- **28105** — Matthews
- **28227** — Mint Hill
- **28270** — East Charlotte between Providence Rd and Matthews (~8–10 mi from 28217, borderline)

### Explicit avoid ZIPs — reject on sight

Even if the neighborhood name looks preferred, reject listings in these
ZIPs:

- **28226** — Ballantyne core / SouthPark
- **28202**, **28203**, **28204**, **28206** — Center City / Uptown
- **28211**, **28207**, **28209** — Myers Park / Foxcroft / SouthPark
- **28205** — NoDa / Plaza Midwood
- **28212**, **28213**, **28215** — east Charlotte
- **28262**, **28269** — University area / north Charlotte
- **28214**, **28216** — west Charlotte far

**Missing ZIP in the listing?** Fall back to the neighborhood name check
against the preferred / avoid lists above. Do not accept a listing with
no verifiable location.
