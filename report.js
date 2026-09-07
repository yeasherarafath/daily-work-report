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

const GROQ_TIMEOUT = 180000; // 3 min, stays under cron.ps1's 300s process kill
const MAX_LLM_RETRIES = 3;
const MAX_COMPLETION_TOKENS = 8192;

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

/* ---------------------------
   GITHUB: GLOBAL COMMITS
----------------------------*/

async function fetchCommits() {
    const since = getStartOfDayISO();

    const url = `https://api.github.com/users/${GITHUB_USERNAME}/events?per_page=100`;

    const res = await axios.get(url, {
        headers: {
            Authorization: `Bearer ${GITHUB_TOKEN}`,
            Accept: "application/vnd.github+json"
        }
    });

    const events = res.data || [];

    // Find all unique repo and branch pairs pushed today
    const pushedBranches = new Map(); // key: "repo/branch", value: { repo, branch }

    for (const event of events) {
        if (event.type !== "PushEvent") continue;
        if (new Date(event.created_at) < new Date(since)) continue;

        const repo = event.repo?.name;
        const ref = event.payload?.ref;

        if (repo && ref && ref.startsWith("refs/heads/")) {
            const branch = ref.replace("refs/heads/", "");
            const key = `${repo}:${branch}`;
            pushedBranches.set(key, { repo, branch });
        }
    }

    const commits = [];
    const seenShas = new Set();

    // Fetch commits for each pushed branch since today
    for (const { repo, branch } of pushedBranches.values()) {
        try {
            const commitsUrl = `https://api.github.com/repos/${repo}/commits?sha=${encodeURIComponent(branch)}&since=${since}&author=${encodeURIComponent(GITHUB_USERNAME)}`;
            const commitsRes = await axios.get(commitsUrl, {
                headers: {
                    Authorization: `Bearer ${GITHUB_TOKEN}`,
                    Accept: "application/vnd.github+json"
                }
            });

            const branchCommits = commitsRes.data || [];
            for (const c of branchCommits) {
                if (c.sha && !seenShas.has(c.sha)) {
                    seenShas.add(c.sha);
                    commits.push({
                        sha: c.sha,
                        repository: {
                            full_name: repo
                        },
                        commit: {
                            message: c.commit?.message || ""
                        }
                    });
                }
            }
        } catch (err) {
            console.error(`⚠️ Failed to fetch commits for ${repo} branch ${branch}:`, err.message);
        }
    }

    return commits;
}

/* ---------------------------
   GITHUB: PRs
----------------------------*/

async function fetchPRs() {
    const since = getDateString();

    const query = `author:${GITHUB_USERNAME} type:pr created:${since}`;

    const url =
        `https://api.github.com/search/issues?q=${encodeURIComponent(query)}`;

    const res = await axios.get(url, {
        headers: {
            Authorization: `Bearer ${GITHUB_TOKEN}`,
            Accept: "application/vnd.github+json"
        }
    });

    const items = res.data.items || [];

    for (const item of items) {
        const repoFull = item.repository_url
            ? item.repository_url.split("/").slice(-2).join("/")
            : null;
        if (!repoFull || !item.number) continue;

        try {
            const commitsUrl = `https://api.github.com/repos/${repoFull}/pulls/${item.number}/commits`;
            const commitsRes = await axios.get(commitsUrl, {
                headers: {
                    Authorization: `Bearer ${GITHUB_TOKEN}`,
                    Accept: "application/vnd.github+json"
                }
            });
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

OUTPUT FORMAT:

Todays Work
---------------
Repository Name
System-level deliverable
System-level deliverable

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