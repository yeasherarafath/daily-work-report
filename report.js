require("dotenv").config();

const fs = require("fs");
const path = require("path");
const axios = require("axios");
const { execSync } = require("child_process");
const { log } = require("console");

const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const GITHUB_USERNAME = process.env.GITHUB_USERNAME;
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const MODEL = process.env.GROQ_MODEL || "openai/gpt-oss-120b";
const REASONING_EFFORT = process.env.GROQ_REASONING_EFFORT;

const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";

const GH_HEADERS = {
    Authorization: `Bearer ${GITHUB_TOKEN}`,
    Accept: "application/vnd.github+json"
};

const GROQ_TIMEOUT = 180000; // 3 min, stays under cron.ps1's 300s process kill
const MAX_LLM_RETRIES = 3;
const MAX_COMPLETION_TOKENS = 8192;

const MAX_REPO_PAGES = 5;
const MAX_BRANCH_PAGES = 3;

/* ---------------------------
   DATE HELPERS
----------------------------*/

function getStartOfDayISO() {
    const now = new Date();
    const start = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0);
    return start.toISOString();
}

function getDateString() {
    return new Date().toISOString().split("T")[0];
}

// Local calendar date. getDateString() is UTC, so at UTC+6 it still returns
// yesterday until 06:00 local - wrong day for GitHub's date qualifiers.
function getLocalDateString() {
    const d = new Date();
    const pad = n => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/* ---------------------------
   GITHUB: GLOBAL COMMITS
----------------------------*/

// GitHub's commit search, paginated. Covers every repo the token can see,
// so repos are not discovered through the events feed.
async function searchCommits(dateField, date) {
    const q = `author:${GITHUB_USERNAME} ${dateField}:${date}`;
    const items = [];

    for (let page = 1; page <= 3; page++) {
        const url = `https://api.github.com/search/commits?q=${encodeURIComponent(q)}&per_page=100&page=${page}`;
        const res = await axios.get(url, { headers: GH_HEADERS });
        const pageItems = res.data?.items || [];
        items.push(...pageItems);
        if (pageItems.length < 100) break;
    }

    return items;
}

// Repos this user pushed to today, from the events feed.
// Only used to widen the repo list - branches come from the branches API.
async function fetchReposFromEvents(since) {
    const repos = new Set();

    // The events feed is capped at 300 and is NOT sorted by date, so all
    // three pages must be read or today's pushes can be missed.
    for (let page = 1; page <= 3; page++) {
        const url = `https://api.github.com/users/${GITHUB_USERNAME}/events?per_page=100&page=${page}`;
        let events;

        try {
            const res = await axios.get(url, { headers: GH_HEADERS });
            events = res.data || [];
        } catch (err) {
            console.error(`⚠️ Failed to fetch events page ${page}:`, err.message);
            break;
        }

        for (const event of events) {
            if (event.type !== "PushEvent") continue;
            if (new Date(event.created_at) < new Date(since)) continue;
            if (event.repo?.name) repos.add(event.repo.name);
        }

        if (events.length < 100) break;
    }

    return repos;
}

// Repos touched today, across every affiliation. Sorted by push time, so the
// walk stops at the first repo that went quiet before today.
async function fetchActiveRepos(since) {
    const repos = new Set();

    for (let page = 1; page <= MAX_REPO_PAGES; page++) {
        const url = `https://api.github.com/user/repos?affiliation=owner,collaborator,organization_member&sort=pushed&direction=desc&per_page=100&page=${page}`;
        let items;

        try {
            const res = await axios.get(url, { headers: GH_HEADERS });
            items = res.data || [];
        } catch (err) {
            console.error(`⚠️ Failed to fetch repo page ${page}:`, err.message);
            break;
        }

        let stop = false;
        for (const r of items) {
            if (!r.pushed_at || new Date(r.pushed_at) < new Date(since)) {
                stop = true;
                break;
            }
            repos.add(r.full_name);
        }

        if (stop || items.length < 100) break;
    }

    return repos;
}

async function fetchBranches(repo) {
    const branches = [];

    for (let page = 1; page <= MAX_BRANCH_PAGES; page++) {
        const url = `https://api.github.com/repos/${repo}/branches?per_page=100&page=${page}`;
        const res = await axios.get(url, { headers: GH_HEADERS });
        const items = res.data || [];
        branches.push(...items.map(b => b.name).filter(Boolean));
        if (items.length < 100) break;
    }

    return branches;
}

async function fetchCommits() {
    const since = getStartOfDayISO();
    const today = getLocalDateString();

    const commits = [];
    const seenShas = new Set();

    const add = (sha, repo, message) => {
        if (!sha || seenShas.has(sha)) return;
        seenShas.add(sha);
        commits.push({
            sha,
            repository: {
                full_name: repo
            },
            commit: {
                message: message || ""
            }
        });
    };

    const repos = new Set();

    // Primary source: commit search on both author date and committer date.
    // committer-date catches rebased or cherry-picked work. Search only indexes
    // each repo's DEFAULT branch, so it is a fast path, not full coverage.
    for (const field of ["author-date", "committer-date"]) {
        try {
            const items = await searchCommits(field, today);
            for (const c of items) {
                const repo = c.repository?.full_name;
                if (repo) repos.add(repo);
                add(c.sha, repo, c.commit?.message);
            }
        } catch (err) {
            console.error(`⚠️ Commit search failed for ${field}:`, err.message);
        }
    }

    // Widen the repo list: everything pushed today, by any affiliation, plus
    // the events feed as a backstop.
    for (const r of await fetchActiveRepos(since)) repos.add(r);
    for (const r of await fetchReposFromEvents(since)) repos.add(r);

    // Walk every branch of every active repo. This is what picks up work on
    // feature branches, which commit search never returns.
    for (const repo of repos) {
        let branches;

        try {
            branches = await fetchBranches(repo);
        } catch (err) {
            console.error(`⚠️ Failed to fetch branches for ${repo}:`, err.message);
            continue;
        }

        for (const branch of branches) {
            try {
                const commitsUrl = `https://api.github.com/repos/${repo}/commits?sha=${encodeURIComponent(branch)}&since=${since}&author=${encodeURIComponent(GITHUB_USERNAME)}&per_page=100`;
                const commitsRes = await axios.get(commitsUrl, { headers: GH_HEADERS });

                for (const c of (commitsRes.data || [])) {
                    add(c.sha, repo, c.commit?.message);
                }
            } catch (err) {
                // 409 = empty repo, not worth reporting
                if (err.response?.status === 409) continue;
                console.error(`⚠️ Failed to fetch commits for ${repo} branch ${branch}:`, err.message);
            }
        }
    }

    return commits;
}

/* ---------------------------
   GITHUB: PRs
----------------------------*/

async function fetchPRs() {
    const since = getLocalDateString();

    const query = `author:${GITHUB_USERNAME} type:pr created:${since}`;

    const url =
        `https://api.github.com/search/issues?q=${encodeURIComponent(query)}`;

    const res = await axios.get(url, { headers: GH_HEADERS });

    const items = res.data.items || [];

    for (const item of items) {
        const repoFull = item.repository_url
            ? item.repository_url.split("/").slice(-2).join("/")
            : null;
        if (!repoFull || !item.number) continue;

        try {
            const commitsUrl = `https://api.github.com/repos/${repoFull}/pulls/${item.number}/commits`;
            const commitsRes = await axios.get(commitsUrl, { headers: GH_HEADERS });
            item.pr_commits = (commitsRes.data || []).map(c => ({
                sha: c.sha,
                message: c.commit?.message || ""
            }));
        } catch (err) {
            console.error(`⚠️ Failed to fetch commits for PR #${item.number} in ${repoFull}:`, err.message);
            item.pr_commits = [];
        }
    }

    return items;
}

/* ---------------------------
   GROUP BY REPO
----------------------------*/

function groupData(commits, prs) {
    const grouped = {};
    const seenShas = new Set();

    for (const c of commits) {
        const repo = c.repository.full_name;

        if (!grouped[repo]) grouped[repo] = { commits: [], prs: [] };

        grouped[repo].commits.push({
            message: c.commit.message,
        });
        if (c.sha) seenShas.add(c.sha);
    }

    for (const p of prs) {
        const repo = p.repository_url
            ? p.repository_url.split("/").slice(-2).join("/")
            : "unknown";

        if (!grouped[repo]) grouped[repo] = { commits: [], prs: [] };

        grouped[repo].prs.push({
            title: p.title,
            commits: (p.pr_commits || []).map(c => c.message),
        });

        for (const c of (p.pr_commits || [])) {
            if (!seenShas.has(c.sha)) {
                seenShas.add(c.sha);
                grouped[repo].commits.push({
                    message: c.message,
                });
            }
        }
    }

    return grouped;
}

/* ---------------------------
   HELPER: SIMPLIFY FOR AI
----------------------------*/
function simplify(data) {
    const result = {};

    for (const repo in data) {
        const cleaned = [];

        for (const c of data[repo].commits || []) {
            const msg = c?.msg || c?.message || "";

            if (isNoise(msg)) continue;

            cleaned.push(cleanMessage(msg, repo));
        }

        result[repo] = cleaned;
    }

    return result;
}

function cleanMessage(msg, repo) {
    return msg
        .replace(/feat\(|fix\(|refactor\(|docs\(|test\(/gi, '')
        .replace(/merge branch.*$/gi, '')
        .replace(/\s+/g, ' ')
        .trim();
}

function isNoise(msg) {
    if (!msg || typeof msg !== "string") return true;

    const m = msg.toLowerCase().trim();

    return (
        m === "debug" ||
        m === "done" ||
        m.startsWith("merge branch") ||
        m.length < 5
    );
}


/* ---------------------------
   GROQ REQUEST HELPERS
----------------------------*/

/**
 * Reasoning models (gpt-oss, qwen3) can emit their chain of thought inline in
 * the message content. Strip it so it never reaches today-work.md.
 * Also handles an unterminated opening tag, which happens on truncated output.
 */
function stripReasoning(text) {
    return text
        .replace(/<think>[\s\S]*?<\/think>/gi, "")
        .replace(/<reasoning>[\s\S]*?<\/reasoning>/gi, "")
        .replace(/<think>[\s\S]*$/i, "")
        .replace(/<reasoning>[\s\S]*$/i, "")
        .trim();
}

/** 429 and 5xx are transient. A missing response means network error or timeout. */
function isRetryable(err) {
    const status = err.response && err.response.status;

    if (!status) return true;

    return status === 429 || status >= 500;
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * POST the prompt to Groq, retrying transient failures with exponential
 * backoff. Config errors (400/401/404) fail immediately instead of burning
 * three timeouts on a mistake that will not fix itself.
 */
async function requestCompletion(prompt) {
    const body = {
        model: MODEL,
        messages: [
            {
                role: "user",
                content: prompt,
            },
        ],
        temperature: 0.6,
        top_p: 0.95,
        max_completion_tokens: MAX_COMPLETION_TOKENS,
        ...(REASONING_EFFORT ? { reasoning_effort: REASONING_EFFORT } : {}),
    };

    const config = {
        headers: {
            Authorization: `Bearer ${GROQ_API_KEY}`,
            "Content-Type": "application/json",
        },
        timeout: GROQ_TIMEOUT,
    };

    let lastError;

    for (let attempt = 1; attempt <= MAX_LLM_RETRIES; attempt++) {
        try {
            return await axios.post(GROQ_URL, body, config);
        } catch (err) {
            lastError = err;

            const status = err.response && err.response.status;

            console.error(
                `❌ Groq request failed (attempt ${attempt}/${MAX_LLM_RETRIES})` +
                (status ? ` HTTP ${status}` : ` ${err.code || err.message}`)
            );

            if (err.response && err.response.data) {
                console.error(JSON.stringify(err.response.data));
            }

            if (!isRetryable(err) || attempt === MAX_LLM_RETRIES) break;

            const delay = Math.pow(2, attempt) * 1000;

            console.log(`⏳ Retrying in ${delay / 1000}s...`);

            await sleep(delay);
        }
    }

    throw lastError;
}

/* ---------------------------
   GROQ REPORT GENERATION
 ----------------------------*/

async function generateReport(data) {
    const prompt = `You are a senior engineering manager writing a daily engineering progress report.

You will receive commit messages grouped by repository.

GOAL:
Transform commit history into high-level engineering delivery summaries that reflect completed systems, features, and meaningful technical work.

CORE RULE:
Think in terms of “what was delivered to the system”, not “what was changed in code”.

RULES:

Keep repository names and order unchanged.
Do NOT output commit-level details.
Merge all related commits into system-level or feature-level outcomes.
Each bullet must represent a completed engineering deliverable (feature, module, subsystem, or significant enhancement).
Use senior engineering language (system, lifecycle, workflow, architecture, capability, module).
Avoid technical noise such as individual methods, files, or minor refactors.
Group UI, backend, database, API, and tests under one coherent feature when related.
Ignore trivial changes unless they contribute to a larger system change.
No repetition of the same feature across bullets.

TONE:

Senior engineering manager level
Concise, structured, and authoritative
Focus on systems and capabilities, not implementation steps
No commit-style wording (“added”, “fixed”, “refactored”) unless part of a broader system description

QUANTITY:

Minimum 12 bullets per repository when sufficient scope exists
Maximum 22 bullets per repository
If work is small, naturally consolidate into fewer but higher-level system descriptions

WRITING STYLE:

Each bullet should describe a delivered capability or subsystem
8–16 words per bullet
Prefer nouns over verbs (e.g., “activation management system”, not “added activation system”)
Avoid explanations, benefits, or storytelling

make this list more easy to read for fully non tech person, he is ceo

EXAMPLES:

BAD:

Added activation page
Fixed modal UI
Updated validation logic

GOOD:

Activation management system with lifecycle tracking and bulk operations
Standardized administrative UI components across modal interfaces
Enhanced license validation and rule enforcement layer

make the daily work report a bit short and clear for a bit less not tech people

OUTPUT FORMAT:

# Today's Work
---------------


## Repository Name

- System-level deliverable
- System-level deliverable

INPUT:
${JSON.stringify(data)}
`;
    if (!GROQ_API_KEY) {
        throw new Error("GROQ_API_KEY is missing. Add it to .env (see .env.example).");
    }

    console.log("🧠 Sending prompt to Groq...", prompt);

    console.log(`⏳ Waiting for Groq response (${MODEL})...`);

    const res = await requestCompletion(prompt);

    const choice = res.data && res.data.choices && res.data.choices[0];

    if (!choice || !choice.message || typeof choice.message.content !== "string") {
        throw new Error(`Unexpected Groq response shape: ${JSON.stringify(res.data)}`);
    }

    if (choice.finish_reason === "length") {
        console.warn(
            `⚠️  Report was TRUNCATED - hit max_completion_tokens (${MAX_COMPLETION_TOKENS}). ` +
            "Raise MAX_COMPLETION_TOKENS or reduce the number of repositories."
        );
    }

    return stripReasoning(choice.message.content);
}

/* ---------------------------
   FILE OUTPUT
----------------------------*/

function ensureFolders() {
    const reportsDir = path.join(__dirname, "reports");

    if (!fs.existsSync(reportsDir)) {
        fs.mkdirSync(reportsDir, { recursive: true });
        console.log("📁 Created reports folder");
    }

    return reportsDir;
}

/* ---------------------------
   MAIN
----------------------------*/

async function main() {
    console.log("🔍 Initializing system...");

    console.log("📥 Fetching GitHub activity...");

    const commits = await fetchCommits();

    console.log(`✅ Fetched ${commits.length} commits`);

    const prs = await fetchPRs();

    console.log(`📦 Commits: ${commits.length}`);
    console.log(`📦 PRs: ${prs.length}`);

    const grouped = groupData(commits, prs);

    console.log("🧠 Generating AI report...");

    const report = await generateReport(grouped);

    writeReportToFile(report);
    const date = getDateString();

    console.log("\n✅ DONE");
    console.log("📄 today-work.md updated");
    console.log(`📁 reports/${date}.md created`);
}

function writeReportToFile(report) {
    const date = getDateString();

    const reportsDir = ensureFolders();

    const todayFile = path.join(__dirname, "today-work.md");
    const historyFile = path.join(reportsDir, `${date}.md`);

    fs.writeFileSync(todayFile, report);
    fs.writeFileSync(historyFile, report);
}

main().catch(console.error);