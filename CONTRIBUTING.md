# Contributing

Studio gets better through field notes. The contributions that help most are **recipes** (routes that now work as one call) and **dead ends** (routes that failed twice, with the fallback that worked).

## What each entry needs

- **Date**, as `YYYY-MM-DD`.
- **App name and version**, for example `Logic Pro 12.4`. Element ids and menus change between versions, so an entry without a version can't be trusted later.
- **Evidence**: a `dryRun` status from `ui_batch`, a ledger row from `measure_session.py`, or the exact error message.

## Where entries go

- Recipes and dead ends go under the matching heading in `skills/studio/references/<app>.md`, appended at the end of the list.
- A `ui_batch` recipe file goes in `skills/studio/recipes/`, with a `requireAbsent` step for every file the run waits for, and its vars listed in the app's reference file.

## What to leave out

No personal job content: no song, client or file names, no lyrics, no copy, no home-directory paths, no transcripts. Replace specifics with a description of what was tested. A lesson belongs here only if it would help a different job.

## How changes are accepted

The maintainer curates by pull request review. Entries may be reworded, merged with others, or declined if they can't be reproduced.

Before you open a pull request, run the checks:

```sh
CI=true scripts/verify.sh --skip 18
```

This runs what CI runs. Check 18 looks at the maintainer's own machine. With `CI=true`, the checks that need the maintainer's source folder (22) or drive your Creator Studio apps (21) print SKIP and are left out of the score. If you have the apps, `scripts/verify.sh --skip 18,22` also runs check 21, which keeps the apps hidden and writes only to a temporary folder. Without `CI=true`, a SKIP counts as a failure, so check 20 then also needs the `claude` and `codex` CLIs.
