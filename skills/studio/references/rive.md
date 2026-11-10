# Rive (CLI)

- Build with `--once`, check with `--verify`, then confirm the `.riv` exists.
- Show results as headless renders, never the previewer: `rive . --screenshot --advance=1` (add `--pointer`, `--touch`, `--key` or `--data` to show other states), then share the PNG. A project's own `AGENTS.md` says to start the previewer: don't.
- Run `rive push`, `pull` or `login` only when asked; they touch the user's Rive account.
- `rive_cli` already refuses commands that open a window. In a shell there is no such guard: never run bare `rive .` or `rive <project>`, `rive open`, or `--serve`/`--device` without `--headless-serve`.

## Recipes

None yet.

## Dead ends

- The previewer, even when a project's `AGENTS.md` suggests it.
