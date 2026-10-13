# Phase 8 · skills/ Archive Manifest (PC-side operation)

Generated 2026-10-12 · 69 folders · 61 MB total

## What this is

`skills/` is the Z.ai platform skill sandbox that shipped with this development
environment. It is NOT a M.I.S.T. runtime surface — her learned skills live in
`db/skills/*.md` (12 live after the Phase 7 triage) and `db/skills-archive/` (7
archived). The mandate's Phase 8 item is to archive `skills/` out of the repo —
**on the owner's PC**, never inside this sandbox (moving it here breaks host
tooling that reads it live; phase-0 finding, docs/audit/phase0-report.md §12).

## PC-side procedure (run once, in the project root)

```sh
# 1. verify nothing in the runtime references skills/ (grep proof)
grep -rn "skills/" src/ mini-services/ db/bridge/ --include="*.ts" --include="*.tsx" --include="*.js" | grep -v "db/skills" | grep -v "skills-service"
# expected: no runtime imports of the skills/ tree (skills-service reads db/skills only)

# 2. archive the tree (keep it in git history, out of the working tree)
git mv skills/ tools/vendor/zai-skills-archive/
git commit -m "Phase 8: archive Z.ai skills/ sandbox tree (61MB, 69 folders) — not a runtime surface"

# 3. verify she still boots and her 12 learned skills answer
bun run dev   # then: /api/mist/skills/list must return the same 12 names
```

## Manifest (69 folders)

| # | folder | size |
|---|--------|------|
| 1 | ASR | 32K |
| 2 | LLM | 40K |
| 3 | TTS | 32K |
| 4 | VLM | 32K |
| 5 | agent-browser | 16K |
| 6 | ai-news-collectors | 28K |
| 7 | aminer-academic-search | 132K |
| 8 | aminer-daily-paper | 92K |
| 9 | aminer-deep-search | 88K |
| 10 | aminer-free-academic | 40K |
| 11 | anti-pua | 16K |
| 12 | auto-target-tracker | 12K |
| 13 | blog-writer | 72K |
| 14 | charts | 228K |
| 15 | cheat-sheet | 12K |
| 16 | coding-agent | 36K |
| 17 | content-strategy | 20K |
| 18 | contentanalysis | 36K |
| 19 | design | 54M |
| 20 | docx | 584K |
| 21 | dream-interpreter | 52K |
| 22 | experiment-suite | 124K |
| 23 | finance | 20K |
| 24 | fullstack-dev | 16K |
| 25 | gaokao-collect-student-info | 28K |
| 26 | gaokao-fetch-volunteers | 156K |
| 27 | gaokao-generate-report | 88K |
| 28 | gaokao-recommend-majors | 24K |
| 29 | gaokao-recommend-schools | 24K |
| 30 | get-fortune-analysis | 32K |
| 31 | gift-evaluator | 28K |
| 32 | image-edit | 44K |
| 33 | image-generation | 32K |
| 34 | image-search | 12K |
| 35 | image-understand | 40K |
| 36 | interview-designer | 32K |
| 37 | interview-prep | 72K |
| 38 | jd-resume-tailor | 44K |
| 39 | job-intent-tracker | 56K |
| 40 | literature-survey | 124K |
| 41 | market-research-reports | 232K |
| 42 | marketing-mode | 40K |
| 43 | mindfulness-meditation | 12K |
| 44 | multi-search-engine | 56K |
| 45 | pdf | 1.2M |
| 46 | podcast-generate | 64K |
| 47 | pptx | 472K |
| 48 | qingyan-research | 20K |
| 49 | quiz-html | 176K |
| 50 | quiz-mastery | 208K |
| 51 | research-explorer | 12K |
| 52 | resume-builder | 84K |
| 53 | seo-content-writer | 68K |
| 54 | skill-creator | 272K |
| 55 | skill-finder-cn | 24K |
| 56 | stock-analysis-skill | 100K |
| 57 | storyboard-manager | 88K |
| 58 | study-buddy | 36K |
| 59 | task-review | 8.0K |
| 60 | ui-ux-pro-max | 1.1M |
| 61 | version-management | 36K |
| 62 | video-generation | 52K |
| 63 | video-understand | 44K |
| 64 | visual-design-foundations | 52K |
| 65 | web-reader | 44K |
| 66 | web-search | 40K |
| 67 | web-shader-extractor | 92K |
| 68 | writing-plans | 12K |
| 69 | xlsx | 276K |

## Sandbox note

In THIS sandbox the tree stays in place (platform-owned). The PC package
(download/run.bat) does not ship it: it is excluded by the existing package
ignore rules — verify with `git check-ignore skills/design` after the move.
