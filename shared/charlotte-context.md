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

1. Ballantyne
2. Steele Creek
3. Berewick
4. Piper Glen
5. Stonecrest
6. Pineville
7. Tyvola / Yorkmount (closest to work)
8. South Charlotte in general
9. Matthews (verify commute)
10. Mint Hill (verify commute)

## Avoid

Do not include listings in these areas:

- Center City / Uptown (too expensive, wrong direction from work)
- University area / UNCC (too far from the south)
- NoDa / Plaza Midwood (too far from work)
- West Charlotte beyond Steele Creek
- Anywhere more than 12 miles from 500 Tyvola Rd
