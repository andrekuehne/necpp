# NEC2++ Agent Guide

## Card Documentation

The NEC-2 input format is based on "cards" (e.g. `CE`, `GW`, `GE`, `FR`, `EX`, `RP`, `EN`).
The authoritative reference for these cards is the NEC-2 Part 3 (Program Description)
manual:

https://www.nec2.org/other/nec2prt3.pdf

Consult it when you need the field layout, parameters, or semantics of a specific card.

## Agent skills

### Issue tracker

Issues are tracked in GitHub Issues on `andrekuehne/necpp`, managed with the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

The default label names: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: one `GLOSSARY.md` and one `docs/adr/` at the repo root. See `docs/agents/domain.md`.
