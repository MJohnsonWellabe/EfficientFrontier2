# Efficient Frontier — Capital Deployment Model

Browser-viewable model that finds the efficient frontier of new-business mixes across Medicare Supplement, Preneed, and Hospital Indemnity — maximizing portfolio IRR subject to RBC/capital constraints over 2026–2030.

## Repo layout
```
efficient-frontier/
├── CLAUDE.md            # Claude Code reads this automatically — standing rules + architecture
├── MODEL_CANON.md       # validated targets, mechanics, intentional inconsistencies (source of truth)
├── BUILD_STANDARDS.md   # definition of done / recurring-bug checklist
├── data/                # workbook-derived inputs (NOT embedded in code)
├── src/                 # engine modules: vnb, ev-recalc, rbc-surplus
├── runner/              # headless scenario runner (100 LHS × 100 stochastic)
└── viewer/              # thin six-tab HTML app over results
```

## How to migrate your existing single-file app
1. Drop your current working file in as `legacy/index.html` (create the folder).
2. In Claude Code, from the repo root, ask:
   > "Read CLAUDE.md and MODEL_CANON.md. Decompose legacy/index.html into the structure described, moving the embedded workbook data into data/ and the inlined engines into src/. Change no computed result. Then re-run the validation gate in BUILD_STANDARDS.md and show me the numbers vs. MODEL_CANON §1."
3. Review the diff, confirm the targets still match to full precision, commit.

After that, every future change is a targeted edit against files on disk — no more re-emitting the whole file through a chat window.

## Backups

This repo auto-mirrors itself to a second GitHub repo, **`EFBackup`**, so the
project survives this repo being accidentally deleted. A GitHub Action
(`.github/workflows/backup-mirror.yml`) mirror-pushes the whole repo (every
branch, tag, and the full history) into `EFBackup` on **every push**, once
**daily** as a safety net, and on demand from the **Actions → Backup mirror to
EFBackup → Run workflow** button. `EFBackup` ends up byte-for-byte aligned with
`main`.

### One-time setup
GitHub's built-in token can only touch this repo, so pushing to `EFBackup`
needs one token you create once:

1. Create a **fine-grained Personal Access Token**
   (GitHub → Settings → Developer settings → Personal access tokens →
   Fine-grained tokens): **Repository access → Only select repositories →
   `EFBackup`**, and under **Permissions → Repository permissions** set
   **Contents: Read and write**. Copy the token.
2. In **this** repo: **Settings → Secrets and variables → Actions →
   New repository secret**, name it exactly **`BACKUP_TOKEN`**, paste the
   token, save.

That's it — every push to this repo now auto-mirrors to `EFBackup`. (If
`EFBackup` lives under a *different* account/org than this repo, edit the one
`BACKUP_REPO:` line in `.github/workflows/backup-mirror.yml` to point at it.)

### Restoring from the backup
If this repo is ever lost, `git clone https://github.com/<owner>/EFBackup.git`
gives you the full history back. To fully re-establish the project, create a
fresh empty repo and `git push --mirror` the clone into it.
