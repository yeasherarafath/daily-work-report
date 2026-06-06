require("dotenv").config();

const fs = require("fs");
const path = require("path");
const axios = require("axios");
const { spawn, execSync } = require("child_process");
const { log } = require("console");

const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const GITHUB_USERNAME = process.env.GITHUB_USERNAME;
const MODEL = process.env.OLLAMA_MODEL || "qwen3:4b";

const OLLAMA_URL = "http://localhost:11434/api/generate";

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
   OLLAMA BOOT
----------------------------*/

async function isOllamaRunning() {
    const axios = require("axios");

    try {
        const res = await axios.get("http://localhost:11434/api/tags", {
            timeout: 2000
        });

        // extra safety check
        return res.status === 200 && res.data;
    } catch (e) {
        return false;
    }
}

function startOllama() {
    console.log("🚀 Starting Ollama...");
    const p = spawn("ollama", ["serve"], {
        detached: true,
        stdio: "ignore"
    });
    p.unref();
}

/* ---------------------------
   GITHUB: GLOBAL COMMITS
----------------------------*/

async function fetchCommits() {
    const since = getStartOfDayISO();

    const query = `author:${GITHUB_USERNAME} committer-date:>${since}`;

    const url =
        `https://api.github.com/search/commits?q=${encodeURIComponent(query)}`;

    const res = await axios.get(url, {
        headers: {
            Authorization: `Bearer ${GITHUB_TOKEN}`,
            Accept: "application/vnd.github.cloak-preview+json"
        }
    });

    return res.data.items || [];
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
   OLLAMA REPORT GENERATION
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
- Each bullet must be 5-15 words
- Maximum 5 bullets per category
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

EXAMPLE:

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
    console.log("🧠 Sending prompt to Ollama...", prompt);

    console.log("⏳ Waiting for Ollama response...");

    const res = await axios.post(OLLAMA_URL, {
        model: MODEL,
        prompt,
        stream: false,
        options: {
            num_ctx: 2048,     // safer for large repos
            temperature: 0.1,  // even more stable
            top_p: 0.7
        }
    });

    return res.data.response;
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

    // Start Ollama if needed
    if (!(await isOllamaRunning())) {
        startOllama();
        console.log("⏳ Waiting for Ollama...");
        await new Promise(r => setTimeout(r, 4000));
    } else {
        console.log("✅ Ollama already running");
    }

    console.log("📥 Fetching GitHub activity...");

    const commits = await fetchCommits();
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