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

function isOllamaRunning() {
    try {
        execSync("curl http://localhost:11434/api/tags", { stdio: "ignore" });
        return true;
    } catch {
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
function classify(msg) {
    const m = msg.toLowerCase();

    if (m.includes("fix")) return "fix";
    if (m.includes("remove")) return "cleanup";
    if (m.includes("refactor")) return "refactor";
    if (m.includes("add") || m.includes("feat")) return "feature";
    if (m.includes("update")) return "update";

    return "general";
}
function groupByType(data) {
    const result = {};

    for (const repo in data) {
        const grouped = {
            feature: [],
            fix: [],
            refactor: [],
            cleanup: [],
            update: [],
            general: []
        };

        for (const msg of data[repo]) {
            const type = classify(msg);
            grouped[type].push(msg);
        }

        result[repo] = grouped;
    }

    return result;
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
- Only convert each category into human readable bullets
- Keep repository structure unchanged

OUTPUT FORMAT:
# Daily Work Report

## Repo Name

### Features
- ...

### Fixes
- ...

### Refactoring
- ...

### Cleanup
- ...

### Updates
- ...
--------------------------------
STYLE:
--------------------------------

- Human readable
- Simple business summary
- Merge similar work

--------------------------------
EXAMPLE OUTPUT:
--------------------------------

# Daily Work Report

## SkillTrack
- Improved quiz system performance and reliability
- Enhanced overall system stability

## TradeLink Frontend
- Improved user interface consistency
- Enhanced navigation and layout experience

--------------------------------
INPUT:
--------------------------------

${JSON.stringify(simplify(data))}
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
    if (!isOllamaRunning()) {
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