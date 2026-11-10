# Club remix and rework jobs

## Ask up front (within A1's three questions)

Ask what can't be inferred, and state the rest as assumptions in the brief.

- Does Logic stay in the chain for every version, including feedback rounds? Default: yes, the Logic recipe (`logic.md`) runs for every version the user listens to.
- Does the user listen to each song before the next one starts? Default: yes.
- Style, BPM and key per song, or pick per song and say so?
- Loudness target and true-peak ceiling. If not given, match the last approved master and state it as an assumption.

## Limits

The job lives where the user says (for example `~/Music/Remixes/<nn-song>/`). Source audio is read-only. Nothing is uploaded. Lyrics are never reproduced or stored. Audio goes to Logic as 48 kHz, 24-bit AIFF, and stems in a set share one gain.

## Who makes the sound

Code makes stems (Demucs), drums, bass, filters, drive, reverb and sidechain, and renders the layers. Logic imports the layers through FCPXML, sets tempo and key, runs Mastering Assistant, bounces and saves (`logic.md`). Before mastering, Logic's flat bounce must null against the code sum: it adds nothing audible, so all sound decisions happen in code.

## One song per session

- Start: read `plan.md`, the song's spec and the last log lines. Nothing else.
- Run: the pipeline script for the song (for example `run_song.py <spec>`), which prints at most 20 lines. Then the Logic recipe, then the checks.
- End: tick stages, log decisions and numbers, write the next step. The next song starts in a new session.

## Feedback rounds

Fix in code, re-render only the affected layers, then run the Logic recipe once for the version the user will hear. Log each change with its timestamp (for example "2:04 vocal hand-over") in `plan.md`.

## Checks (each printed as PASS or FAIL)

- **Null**: flat Logic bounce vs code sum at -100 dB or lower (in testing: -113 dB).
- **Master**: 48 kHz, 24-bit; length matches the spec after trim; integrated LUFS and true peak logged against the target; lag measured above 2 kHz, because mastering EQ smears a full-band measure (in testing: 48 frames).
- **Review**: the user's notes at timestamps, section hand-overs, loudness against the reference.

## Token budget per song (target)

About 30 requests and 6M tokens, peak context 250k or less. Stop and write state to `plan.md` if a stage takes twice its expected requests, the same step fails twice, or the Logic recipe fails a second time after one fix. Never fall back to driving Logic click by click without the user's OK.
