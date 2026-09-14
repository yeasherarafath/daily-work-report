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

const MAX_REPO_PAGES = 6;
const MAX_BRANCH_PAGES = 3;
const MIN_BULLETS_PER_REPO = 3;
const MAX_BULLETS_PER_REPO = 6;
const CONCURRENCY = 8; // parallel GitHub requests; well under the secondary rate limit

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

// Branch heads, deduped by commit SHA. Stale branches that share a head with
// another branch cost one commits request instead of several - the commits API
// takes a raw SHA in ?sha= just as happily as a branch name.
async function fetchBranchHeads(repo) {
    const heads = new Map(); // key: head sha, value: branch name (for error output)

    for (let page = 1; page <= MAX_BRANCH_PAGES; page++) {
        const url = `https://api.github.com/repos/${repo}/branches?per_page=100&page=${page}`;
        const res = await axios.get(url, { headers: GH_HEADERS });
        const items = res.data || [];

        for (const b of items) {
            if (b.commit?.sha && !heads.has(b.commit.sha)) heads.set(b.commit.sha, b.name);
        }

        if (items.length < 100) break;
    }

    return heads;
}

// Runs tasks with a bounded number in flight. The branch walk is ~60 requests
// of pure network wait, so serial execution wastes most of the runtime.
async function runPooled(tasks, limit) {
    const results = [];
    let next = 0;

    const workers = Array.from({ length: Math.min(limit, tasks.length) }, async () => {
        while (next < tasks.length) {
            const i = next++;
            results[i] = await tasks[i]();
        }
    });

    await Promise.all(workers);
    return results;
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

    const searchTasks = ["author-date", "committer-date"].map(field => async () => {
        try {
            // Search only indexes each repo's DEFAULT branch, so this is a fast
            // path, not full coverage. committer-date catches rebased work.
            return await searchCommits(field, today);
        } catch (err) {
            console.error(`⚠️ Commit search failed for ${field}:`, err.message);
            return [];
        }
    });

    // Repo discovery and the commit search do not depend on each other.
    const [searchResults, activeRepos, eventRepos] = await Promise.all([
        runPooled(searchTasks, CONCURRENCY),
        fetchActiveRepos(since),
        fetchReposFromEvents(since)
    ]);

    for (const items of searchResults) {
        for (const c of items) {
            const repo = c.repository?.full_name;
            if (repo) repos.add(repo);
            add(c.sha, repo, c.commit?.message);
        }
    }

    for (const r of activeRepos) repos.add(r);
    for (const r of eventRepos) repos.add(r);

    // Walk every branch of every active repo. This is what picks up work on
    // feature branches, which commit search never returns.
    const headLists = await runPooled([...repos].map(repo => async () => {
        try {
            return { repo, heads: await fetchBranchHeads(repo) };
        } catch (err) {
            console.error(`⚠️ Failed to fetch branches for ${repo}:`, err.message);
            return { repo, heads: new Map() };
        }
    }), CONCURRENCY);

    const commitTasks = [];

    for (const { repo, heads } of headLists) {
        for (const [sha, branch] of heads) {
            commitTasks.push(async () => {
                try {
                    const commitsUrl = `https://api.github.com/repos/${repo}/commits?sha=${sha}&since=${since}&author=${encodeURIComponent(GITHUB_USERNAME)}&per_page=100`;
                    const commitsRes = await axios.get(commitsUrl, { headers: GH_HEADERS });
                    return { repo, commits: commitsRes.data || [] };
                } catch (err) {
                    // 409 = empty repo, not worth reporting
                    if (err.response?.status !== 409) {
                        console.error(`⚠️ Failed to fetch commits for ${repo} branch ${branch}:`, err.message);
                    }
                    return { repo, commits: [] };
                }
            });
        }
    }

    for (const { repo, commits: branchCommits } of await runPooled(commitTasks, CONCURRENCY)) {
        for (const c of branchCommits) add(c.sha, repo, c.commit?.message);
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
// How many bullets a repo is allowed, derived from real commit volume.
// A repo with one commit must not produce a dozen deliverables - that is what
// made earlier reports read as padded.
function bulletBudget(commitCount) {
    // Floor of 3: even a single commit usually covers a few distinct changes,
    // and two bullets reads as if work was left out.
    return Math.min(MAX_BULLETS_PER_REPO, Math.max(MIN_BULLETS_PER_REPO, Math.ceil(commitCount / 3)));
}

function simplify(data) {
    const result = {};

    for (const repo in data) {
        const cleaned = [];

        for (const c of data[repo].commits || []) {
            const msg = c?.msg || c?.message || "";

            if (isNoise(msg)) continue;

            cleaned.push(cleanMessage(msg, repo));
        }

        // Repos whose commits were all noise carry no signal worth a section.
        if (!cleaned.length) continue;

        result[repo] = {
            commit_count: cleaned.length,
            max_bullets: bulletBudget(cleaned.length),
            commits: cleaned
        };
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

    if (m.length < 8) return true;

    // Merge commits describe branch plumbing, not delivered work.
    if (m.startsWith("merge branch") || m.startsWith("merge pull request") || m.startsWith("merge remote")) return true;

    return (
        m === "debug" ||
        m === "done" ||
        m === "wip" ||
        m.startsWith("wip:") ||
        m.startsWith("wip ") ||
        m === "update readme" ||
        m === "initial commit" ||
        /^(fix|test|update|chore|cleanup|minor fix)(\.|!)?$/.test(m)
    );
}

// The model treats bullet limits as suggestions. This does not.
// Trims each "## repo" section to that repo's budget and reports when it fires.
function enforceBulletLimits(markdown, simplified) {
    const lines = markdown.split("\n");
    const out = [];

    let budget = Infinity;
    let used = 0;
    let trimmed = 0;

    for (const line of lines) {
        const heading = line.match(/^##\s+(.+?)\s*$/);

        if (heading) {
            budget = simplified[heading[1]]?.max_bullets ?? Infinity;
            used = 0;
            out.push(line);
            continue;
        }

        if (/^\s*[-*]\s+/.test(line)) {
            if (used >= budget) {
                trimmed++;
                continue;
            }
            used++;
        }

        out.push(line);
    }

    if (trimmed) {
        console.warn(`⚠️  Trimmed ${trimmed} over-budget bullet(s) - the model ignored max_bullets.`);
    }

    return out.join("\n");
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
        temperature: 0.3,
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
    const simplified = simplify(data);

    const prompt = `You are writing a short daily work summary for a CEO who is not technical.

You receive commit messages grouped by repository. Each repository carries a commit_count
and a max_bullets budget.

GOAL:
Say what got done today, in plain language, at the level of detail a CEO can skim.

HARD RULES:

Write exactly max_bullets bullets per repository. That is the target, not a ceiling to stay under.
Go below max_bullets only when the commits genuinely describe fewer separate changes.
Never merge two unrelated changes into one bullet just to write fewer bullets.
Every bullet must come from actual commits. Never invent work to fill space.
Merge related commits into one bullet.
Keep repository names and order exactly as given.
Skip a repository entirely if its commits say nothing meaningful.

WRITING STYLE:

Start each bullet with a plain verb: Added, Improved, Updated, Fixed, Enhanced.
5 to 10 words per bullet.
Use concrete numbers and feature names when the commits contain them.
Bold a feature name with ** only when it is a real named feature.
No jargon: no lifecycle, subsystem, architecture, capability, module, layer.
No benefit claims, no explanations, no filler.

GOOD (this is exactly the target):

## acme/storefront

* Added **Dead Stock** detection for products with no sales for 60+ days
* Added inventory cost and dead stock reporting
* Improved stock health dashboard and analysis

## acme/bank-portal

* Added 36 business categories
* Improved business account and onboarding forms
* Updated KYC, validation, and business data handling

BAD (padded, vague, and far too many bullets):

* Enhanced visibility into engineering delivery
* Streamlined administrative workflow for data ingestion
* Improved data consistency across frontend and backend
* Centralized enum management for business types

OUTPUT FORMAT:

# Today's Work

---

## Repository Name

* Bullet
* Bullet

INPUT:
${JSON.stringify(simplified)}
`;
    if (!GROQ_API_KEY) {
        throw new Error("GROQ_API_KEY is missing. Add it to .env (see .env.example).");
    }

    console.log(`🧠 Sending ${Object.keys(simplified).length} repo(s) to Groq...`);

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

    return enforceBulletLimits(stripReasoning(choice.message.content), simplified);
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