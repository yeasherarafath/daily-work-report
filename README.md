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
