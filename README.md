# Daily Work Report — Figma branch

This branch's `report.js` reports on Figma design work instead of GitHub commits.

1. Lists files touched today (team folders from `FIGMA_TEAM_IDS` plus `FIGMA_FILE_KEYS`), keeping only files you edited.
2. Lets you pick files from a numbered list (`0` = all). `--all` skips the picker; `--file <key|url>` reports one file. Non-interactive runs (cron) take all files.
3. Diffs each file between the last version before today and now (pages, screens, components, text, placed components), adds today's named versions and comments.
4. Sends the summary to the Newisty AI endpoint and writes `today-work.md` and `reports/YYYY-MM-DD.md`.

Setup: add `FIGMA_TOKEN`, `FIGMA_TEAM_IDS` and/or `FIGMA_FILE_KEYS` to `.env` (see `.env.example`). The Figma API cannot list drafts, so add draft files to `FIGMA_FILE_KEYS`.

Rate limits: full file fetches are Figma's Tier 1 endpoint (10-20/min on Full/Dev seats, 20/month on View/Collab). Past versions are cached in `.figma-cache/`. If the limit is hit, the report falls back to versions and comments.

```
node report.js            # pick files
node report.js --all      # every file touched today
node report.js --file https://www.figma.com/design/<key>/...
```

---

# Daily Work Report

A small Node.js script that gathers your GitHub commits/PRs for the day and generates a human-readable report using an on-host Ollama model.

## Prerequisites

- Node.js (v16+ recommended)
- npm
- Ollama server running locally (optional but recommended for AI generation)

## Setup

1. Install dependencies:

```
npm install
```

2. Create a `.env` file in the project root with the following variables:

```
# .env example
GITHUB_TOKEN=your_github_token
GITHUB_USERNAME=your_github_username
# optional: set the Ollama model name
OLLAMA_MODEL=qwen3:4b
```

3. Ensure Ollama is available at `http://localhost:11434` or start it as needed. The script will attempt to start `ollama serve` if it can't reach the API.

## Run

Run the report generation with:

```
node report.js
```

Outputs:
- `today-work.md` — updated with the AI-generated report
- `reports/YYYY-MM-DD.md` — archived copy for the current date

## Notes

- The script uses GitHub's Search API for commits and PRs. Make sure your `GITHUB_TOKEN` has appropriate scopes (repo/public_repo as needed).
- If you prefer to run Ollama manually, start it in a separate terminal: `ollama serve`.

## Troubleshooting

- If the script fails to reach Ollama, check that `ollama` is in your PATH and that the server is running on port `11434`.
- For Windows PowerShell, set environment variables like:

```
$env:GITHUB_TOKEN = 'your_token'
$env:GITHUB_USERNAME = 'your_name'
```

For bash (WSL/Git Bash/Cygwin):

```
export GITHUB_TOKEN=your_token
export GITHUB_USERNAME=your_name
```
