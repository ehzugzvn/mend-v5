# mend

[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/ehzugzvn/mend-v5/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/ehzugzvn/mend-v5/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

`mend` applies an edit that an AI model wrote to a tree of text files. Models write
edits in four formats — unified diffs (often with wrong line numbers),
SEARCH/REPLACE blocks, the V4A patch format, and text-editor tool calls as JSON —
and mend reads each format exactly as `SPEC.md` says, changing every file or
nothing at all.

## Design

A class per format. `PatchReader` is the abstract reader; `UnifiedReader`,
`SearchReplaceReader`, `V4aReader` and `JsonReader` each turn patch text into
edit objects — `ChangeEdit`, `CreateEdit`, `DeleteEdit` and `MoveEdit` — and
every edit knows how to apply itself to a `Workspace`, which wraps the file map
and tracks each path's initial and final state for the `A`/`D`/`M`/`R` report.
A `Matcher` utility class holds the spec's three matching tiers (exact,
trailing-whitespace-insensitive, fully trimmed with re-indentation) as static
methods shared by the line-based formats.

## Running it

Requires Node 22; the standard library alone is used.

```
node main.ts [--format=NAME] [--check] [--strict] [PATCH]
```

- `PATCH` is the patch file, relative to the working directory (the root of the
  tree). When it is absent or `-`, the patch is read from standard input.
- `--format=NAME` forces one format: `unified`, `search-replace`, `v4a` or
  `json`. The default, `auto`, detects the format from the patch text.
- `--check` does everything but write: the same output and exit code, and no
  file is created, changed or deleted.
- `--strict` matches lines exactly (tier 0 only).

On success mend prints one `A`/`D`/`M` line per changed path (a move prints
`R <old> -> <new>`) and a final `ok: <n> files` line, and exits 0. If any edit
fails it prints one `error: <code> <path>` line per failed edit and
`failed: <k> of <n> edits`, exits 1, and writes nothing. Usage, unreadable-patch,
format-detection and parse problems print a single `error: ...` line and exit 2.

The full contract lives in `SPEC.md`. `check.ts` runs the practice check set:

```
node check.ts <practice.json>
```

## License

MIT — see `LICENSE`.
