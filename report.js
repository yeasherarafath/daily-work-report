require("dotenv").config();

const fs = require("fs");
const path = require("path");
const axios = require("axios");
const { execSync } = require("child_process");
const { log } = require("console");

const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const GITHUB_USERNAME = process.env.GITHUB_USERNAME;
const MISTRAL_API_KEY = process.env.MISTRAL_API_KEY;
const MODEL = process.env.MISTRAL_MODEL || "mistral-small-latest";

const MISTRAL_URL = "https://api.mistral.ai/v1/chat/completions";

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

    return res.data.items || [];
}

/* ---------------------------
   GROUP BY REPO
----------------------------*/

function groupData(commits, prs) {
    const grouped = {};

    for (const c of commits) {
        const repo = c.repository.full_name;

        if (!grouped[repo]) grouped[repo] = { commits: [], prs: [] };

        grouped[repo].commits.push({
            message: c.commit.message,
        });
    }

    for (const p of prs) {
        const repo = p.repository_url
            ? p.repository_url.split("/").slice(-2).join("/")
            : "unknown";

        if (!grouped[repo]) grouped[repo] = { commits: [], prs: [] };

        grouped[repo].prs.push({
            title: p.title,
        });
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
   MISTRAL REPORT GENERATION
 ----------------------------*/

async function generateReport(data) {
    const prompt = `
You are a senior engineering manager.

You will receive pre-grouped engineering work.

RULES:
- Do NOT regroup items
- Do NOT reorder items
- Do NOT merge across categories
- Keep repository structure unchanged
- Merge only closely related tasks within the same category
- Each bullet must be 5-10 words
- Minimum 1 bullet per category, no maximum limit
- Focus on WHAT changed, not WHY it matters
- Do NOT add business justification
- Do NOT mention user experience, growth, company goals, platform vision, scalability, reliability, etc. unless explicitly present in the work items
- Remove repetitive details
- Use concise engineering language

STYLE:
- Short
- Professional
- Engineering-focused
- One sentence per bullet

Follow EXAMPLE:

# Daily Work Report

## LMS Backend
- Added course, category, and instructor management pages
- Implemented navigation menu icon support
- Updated menu validation rules and form fields
- Added course statistics dashboard widgets
- Removed unused P2P Trading and Virtual Card templates

INPUT:

${JSON.stringify((data))}
`;
    console.log("🧠 Sending prompt to Mistral...", prompt);

    console.log("⏳ Waiting for Mistral response...");

    const res = await axios.post(
        MISTRAL_URL,
        {
            model: MODEL,
            messages: [
                {
                    role: "user",
                    content: prompt,
                },
            ],
        },
        {
            headers: {
                Authorization: `Bearer ${MISTRAL_API_KEY}`,
                "Content-Type": "application/json",
            },
        }
    );

    return res.data.choices[0].message.content;
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

    const date = getDateString();

    const reportsDir = ensureFolders();

    const todayFile = path.join(__dirname, "today-work.md");
    const historyFile = path.join(reportsDir, `${date}.md`);

    fs.writeFileSync(todayFile, report);
    fs.writeFileSync(historyFile, report);

    console.log("\n✅ DONE");
    console.log("📄 today-work.md updated");
    console.log(`📁 reports/${date}.md created`);
}

main().catch(console.error);