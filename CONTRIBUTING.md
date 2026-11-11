# Contributing

Studio gets better through field notes. The contributions that help most are **recipes** (routes that now work as one call) and **dead ends** (routes that failed twice, with the fallback that worked).

## What each entry needs

- **Date**, as `YYYY-MM-DD`.
- **App name and version**, for example `Logic Pro 12.4`. Element ids and menus change between versions, so an entry without a version can't be trusted later.
- **Evidence**: the status file from a real `ui_batch` run, a ledger row from `measure_session.py`, or the exact error message.

## Where entries go

- Recipes and dead ends go under the matching heading in `skills/studio/references/<app>.md`, appended at the end of the list.
- A script that replaces a UI route goes in `skills/studio/scripts/`, with a PASS or FAIL first line, and its use goes under the app's Recipes.
- A `ui_batch` recipe file goes in `skills/studio/recipes/`, with a `requireAbsent` step for every file the run waits for, and its vars listed in the app's reference file.

## What to leave out

No personal job content: no song, client or file names, no lyrics, no copy, no home-directory paths, no transcripts. Replace specifics with a description of what was tested. A lesson belongs here only if it would help a different job.

## How changes are accepted

The maintainer curates by pull request review. Entries may be reworded, merged with others, or declined if they can't be reproduced.

Before you open a pull request, run the checks:

```sh
CI=true scripts/verify.sh --skip 18
```

CI runs these checks too, except check 10, which installs the skill through the skills CLI. Check 18 looks at the maintainer's own machine. With `CI=true`, the checks that need the maintainer's source folder (22) or drive your Creator Studio apps (21) print SKIP and are left out of the score. If you have the apps, `scripts/verify.sh --skip 18,22` also runs check 21, which keeps the apps hidden and writes only to a temporary folder. `CSMCP_SMOKE_FULL=1` makes check 21 run every remaining tool as well. It needs Blender, the Rive CLI, Godot, Final Cut Pro, Compressor, ffmpeg (for the headless render of the timeline it builds), Accessibility and Screen Recording, and an unlocked screen. It changes more than the default run: Final Cut Pro launches and reopens your last libraries (the run imports into two temporary libraries and closes them again, which brings Final Cut Pro to the front for a moment), and the first run adds a shortcut named "creator-studio-mcp smoke test" to Shortcuts. Without `CI=true`, a SKIP counts as a failure, so check 20 then also needs the `claude` and `codex` CLIs.
