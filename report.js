require("dotenv").config();

const fs = require("fs");
const path = require("path");
const readline = require("readline");
const axios = require("axios");

const FIGMA_TOKEN = process.env.FIGMA_TOKEN;
const FIGMA_TEAM_IDS = splitList(process.env.FIGMA_TEAM_IDS);
const FIGMA_FILE_KEYS = splitList(process.env.FIGMA_FILE_KEYS).map(parseFileKey).filter(Boolean);
const FIGMA_ONLY_MINE = process.env.FIGMA_ONLY_MINE !== "false";

const GROQ_API_KEY = process.env.GROQ_API_KEY;
const MODEL = process.env.GROQ_MODEL || "openai/gpt-oss-120b";
const REASONING_EFFORT = process.env.GROQ_REASONING_EFFORT;

const GROQ_URL = "https://newisty.com/api/ai/v1/chat/completions";
const FIGMA_API = "https://api.figma.com";

const GROQ_TIMEOUT = 180000; // 3 min, stays under cron.ps1's 300s process kill
const MAX_LLM_RETRIES = 3;
const MAX_COMPLETION_TOKENS = 8192;

const FIGMA_TIMEOUT = 120000; // full file JSON can be tens of MB
const MAX_FIGMA_RETRIES = 3;
const MAX_RETRY_AFTER = 120; // seconds; a longer wait means the monthly/minute budget is gone
const CONCURRENCY = 4; // Tier 2 is 25-100 req/min depending on plan; keep well under it
const MAX_VERSION_PAGES = 5;

const MIN_BULLETS_PER_FILE = 1;
const MAX_BULLETS_PER_FILE = 15;
const MAX_LIST_ITEMS = 25; // names sent per diff category, to keep the prompt small
const MAX_TEXT_LEN = 120;

const CACHE_DIR = path.join(__dirname, ".figma-cache");

// Node types that represent real design work. Vectors, ellipses and the like
// churn on every nudge and say nothing a CEO can read.
const TRACKED_TYPES = new Set([
    "FRAME", "SECTION", "COMPONENT", "COMPONENT_SET", "INSTANCE", "TEXT", "GROUP",
]);

const SCREEN_PARENT_TYPES = new Set(["CANVAS", "SECTION"]);

class RateLimitError extends Error {}

function splitList(value) {
    return (value || "").split(",").map(s => s.trim()).filter(Boolean);
}

// Accepts a bare key or any figma.com file/design/board URL.
function parseFileKey(value) {
    const m = value.match(/figma\.com\/(?:file|design|board|proto)\/([A-Za-z0-9]+)/);
    if (m) return m[1];
    return /^[A-Za-z0-9]+$/.test(value) ? value : null;
}

/* ---------------------------
   DATE HELPERS
----------------------------*/

function getStartOfDay() {
    const now = new Date();
    return new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0);
}

function getLocalDateString() {
    const d = new Date();
    const pad = n => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function isToday(iso) {
    return Boolean(iso) && new Date(iso) >= getStartOfDay();
}

function formatTime(iso) {
    return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

/* ---------------------------
   GENERIC HELPERS
----------------------------*/

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

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function truncate(text, max = MAX_TEXT_LEN) {
    const clean = String(text || "").replace(/\s+/g, " ").trim();
    return clean.length > max ? clean.slice(0, max - 1) + "…" : clean;
}

/* ---------------------------
   FIGMA API
----------------------------*/

/**
 * GET against the Figma REST API. Short 429 waits are retried; a long
 * Retry-After means the tier budget is spent, so it surfaces as
 * RateLimitError and the caller falls back to cheaper data.
 */
async function figmaGet(urlPath, params = {}) {
    const url = urlPath.startsWith("http") ? urlPath : FIGMA_API + urlPath;
    let lastError;

    for (let attempt = 1; attempt <= MAX_FIGMA_RETRIES; attempt++) {
        try {
            const res = await axios.get(url, {
                params,
                headers: { "X-Figma-Token": FIGMA_TOKEN },
                timeout: FIGMA_TIMEOUT,
                maxContentLength: Infinity,
                maxBodyLength: Infinity,
            });
            return res.data;
        } catch (err) {
            lastError = err;
            const status = err.response && err.response.status;

            if (status === 429) {
                const wait = Number(err.response.headers["retry-after"]) || 60;
                if (wait > MAX_RETRY_AFTER || attempt === MAX_FIGMA_RETRIES) {
                    throw new RateLimitError(
                        `Figma rate limit on ${urlPath} (retry after ${wait}s, ` +
                        `plan tier ${err.response.headers["x-figma-plan-tier"] || "?"}, ` +
                        `limit type ${err.response.headers["x-figma-rate-limit-type"] || "?"})`
                    );
                }
                console.log(`⏳ Figma 429, waiting ${wait}s...`);
                await sleep(wait * 1000);
                continue;
            }

            if (status && status < 500) break;
            if (attempt < MAX_FIGMA_RETRIES) await sleep(Math.pow(2, attempt) * 1000);
        }
    }

    const status = lastError.response && lastError.response.status;
    const detail = lastError.response && lastError.response.data
        ? JSON.stringify(lastError.response.data).slice(0, 300)
        : lastError.message;
    throw new Error(`Figma GET ${urlPath} failed${status ? ` HTTP ${status}` : ""}: ${detail}`);
}

async function fetchMe() {
    return figmaGet("/v1/me");
}

// Walks a team's folders (and their subfolders). Falls back to the deprecated
// v1 projects endpoints, which still serve accounts without v2 folders.
async function fetchTeamFileKeys(teamId) {
    try {
        const keys = [];
        const top = await figmaGet(`/v2/teams/${teamId}/folders`);
        const queue = [...(top.folders || [])];

        while (queue.length) {
            const folder = queue.shift();
            const [files, subs] = await Promise.all([
                figmaGet(`/v2/folders/${folder.id}/files`),
                figmaGet(`/v2/folders/${folder.id}/folders`).catch(() => ({ folders: [] })),
            ]);
            for (const f of files.files || []) keys.push(f.key);
            queue.push(...(subs.folders || []));
        }

        return keys;
    } catch (err) {
        if (err instanceof RateLimitError) throw err;
        console.log(`   v2 folders unavailable for team ${teamId}, using v1 projects`);
    }

    const keys = [];
    const { projects = [] } = await figmaGet(`/v1/teams/${teamId}/projects`);
    const lists = await runPooled(
        projects.map(p => () => figmaGet(`/v1/projects/${p.id}/files`)),
        CONCURRENCY
    );
    for (const list of lists) for (const f of list.files || []) keys.push(f.key);
    return keys;
}

async function fetchMeta(key) {
    const data = await figmaGet(`/v1/files/${key}/meta`);
    return { key, ...data.file };
}

// Versions are newest first. Stop paging once one predates today: that one
// is the baseline the day's work is diffed against.
async function fetchTodayVersions(key) {
    const start = getStartOfDay();
    const today = [];
    let baseline = null;
    let next = `/v1/files/${key}/versions`;

    for (let page = 0; next && page < MAX_VERSION_PAGES; page++) {
        const data = await figmaGet(next);

        for (const v of data.versions || []) {
            if (new Date(v.created_at) >= start) {
                today.push(v);
            } else {
                baseline = v;
                break;
            }
        }

        if (baseline) break;
        next = data.pagination && data.pagination.next_page;
    }

    today.reverse();

    // Paging stopped before reaching yesterday: diff from the oldest version
    // seen rather than treating the whole file as new.
    if (!baseline && next && today.length) baseline = today[0];

    return { today, baseline };
}

async function fetchTodayComments(key) {
    try {
        const data = await figmaGet(`/v1/files/${key}/comments`);
        return (data.comments || []).filter(c => isToday(c.created_at));
    } catch (err) {
        console.warn(`⚠️  Comments skipped for ${key}: ${err.message}`);
        return [];
    }
}

/* ---------------------------
   SNAPSHOTS + DIFF
----------------------------*/

/**
 * Flattens a document into id -> summary of the nodes worth reporting.
 * Only the summary is kept, so cached snapshots stay a few hundred KB.
 */
function flattenDocument(document) {
    const nodes = {};
    let other = 0;

    function walk(node, page, parent) {
        if (node.type === "CANVAS") {
            nodes[node.id] = { type: "CANVAS", name: node.name };
            page = node.name;
        } else if (TRACKED_TYPES.has(node.type)) {
            const entry = {
                type: node.type,
                name: node.name,
                page,
                parent: parent && parent.id,
                parentType: parent && parent.type,
            };
            if (node.type === "TEXT") entry.text = truncate(node.characters, 400);
            if (node.type === "INSTANCE") entry.componentId = node.componentId;
            nodes[node.id] = entry;
        } else {
            other++;
        }

        for (const child of node.children || []) walk(child, page, node);
    }

    walk(document, null, null);
    return { nodes, other };
}

function cachePath(key, versionId) {
    return path.join(CACHE_DIR, key, `${versionId}.json`);
}

// Past versions never change, so their flattened snapshot is cached forever.
// The current file is always fetched fresh.
async function loadSnapshot(key, versionId) {
    if (versionId) {
        const file = cachePath(key, versionId);
        if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, "utf8"));
    }

    const data = await figmaGet(`/v1/files/${key}`, versionId ? { version: versionId } : {});
    const snapshot = { ...flattenDocument(data.document), components: data.components || {} };

    if (versionId) {
        fs.mkdirSync(path.dirname(cachePath(key, versionId)), { recursive: true });
        fs.writeFileSync(cachePath(key, versionId), JSON.stringify(snapshot));
    }

    return snapshot;
}

// Version history can be empty (new files, or plans that keep only 30 days),
// so every run also saves the file's current state per day. The latest one
// from an earlier day is the fallback baseline.
function saveDaySnapshot(key, snapshot) {
    const file = path.join(CACHE_DIR, key, `day-${getLocalDateString()}.json`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(snapshot));
}

function loadPreviousDaySnapshot(key) {
    const dir = path.join(CACHE_DIR, key);
    if (!fs.existsSync(dir)) return null;

    const today = `day-${getLocalDateString()}.json`;
    const latest = fs.readdirSync(dir)
        .filter(f => /^day-\d{4}-\d{2}-\d{2}\.json$/.test(f) && f < today)
        .sort()
        .pop();

    return latest ? JSON.parse(fs.readFileSync(path.join(dir, latest), "utf8")) : null;
}

function isScreen(n) {
    return n.type !== "TEXT" && n.type !== "INSTANCE" && SCREEN_PARENT_TYPES.has(n.parentType);
}

function label(n) {
    return n.page ? `${n.page} / ${n.name}` : n.name;
}

function cap(list) {
    return list.length > MAX_LIST_ITEMS
        ? [...list.slice(0, MAX_LIST_ITEMS), `…and ${list.length - MAX_LIST_ITEMS} more`]
        : list;
}

/** Compares two flattened snapshots by node id. */
function diffSnapshots(before, after) {
    const a = before.nodes;
    const b = after.nodes;
    const componentName = id => (after.components[id] || before.components[id] || {}).name || "unknown";

    const d = {
        pages_added: [], pages_removed: [], pages_renamed: [],
        screens_added: [], screens_removed: [], screens_renamed: [],
        components_added: [], components_removed: [], components_renamed: [],
        text_changed: [], text_added: [], text_removed: [],
        instances_added: {}, moved: 0, layers_added: 0, layers_removed: 0,
    };

    for (const id in b) {
        const n = b[id];
        const old = a[id];
        const isComponent = n.type === "COMPONENT" || n.type === "COMPONENT_SET";

        if (!old) {
            if (n.type === "CANVAS") d.pages_added.push(n.name);
            else if (isComponent) d.components_added.push(label(n));
            else if (isScreen(n)) d.screens_added.push(label(n));
            else if (n.type === "TEXT") d.text_added.push(`${n.page}: "${truncate(n.text, 80)}"`);
            else if (n.type === "INSTANCE") {
                const name = componentName(n.componentId);
                d.instances_added[name] = (d.instances_added[name] || 0) + 1;
            } else d.layers_added++;
            continue;
        }

        if (old.name !== n.name) {
            const rename = `${old.name} → ${n.name}`;
            if (n.type === "CANVAS") d.pages_renamed.push(rename);
            else if (isComponent) d.components_renamed.push(rename);
            else if (isScreen(n)) d.screens_renamed.push(rename);
        }

        if (n.type === "TEXT" && old.text !== n.text) {
            d.text_changed.push(`${n.page} / ${n.name}: "${truncate(old.text, 60)}" → "${truncate(n.text, 60)}"`);
        }

        if (n.type !== "CANVAS" && old.parent !== n.parent) d.moved++;
    }

    for (const id in a) {
        if (b[id]) continue;
        const n = a[id];
        if (n.type === "CANVAS") d.pages_removed.push(n.name);
        else if (n.type === "COMPONENT" || n.type === "COMPONENT_SET") d.components_removed.push(label(n));
        else if (isScreen(n)) d.screens_removed.push(label(n));
        else if (n.type === "TEXT") d.text_removed.push(`${n.page}: "${truncate(n.text, 80)}"`);
        else d.layers_removed++;
    }

    d.other_layers_delta = after.other - before.other;
    return d;
}

function diffSize(d) {
    return d.pages_added.length + d.pages_removed.length + d.pages_renamed.length
        + 3 * (d.screens_added.length + d.components_added.length)
        + d.screens_removed.length + d.screens_renamed.length
        + d.components_removed.length + d.components_renamed.length
        + d.text_changed.length + Math.ceil((d.text_added.length + d.text_removed.length) / 5)
        + Object.keys(d.instances_added).length;
}

function compactDiff(d) {
    const out = {};
    for (const [k, v] of Object.entries(d)) {
        if (Array.isArray(v)) { if (v.length) out[k] = cap(v); }
        else if (typeof v === "object") { if (Object.keys(v).length) out[k] = v; }
        else if (v) out[k] = v;
    }
    return out;
}

/* ---------------------------
   COLLECT TODAY'S FILES
----------------------------*/

async function collectTodayFiles(me) {
    const keys = new Set(FIGMA_FILE_KEYS);

    for (const teamId of FIGMA_TEAM_IDS) {
        console.log(`📂 Listing files in team ${teamId}...`);
        for (const key of await fetchTeamFileKeys(teamId)) keys.add(key);
    }

    if (!keys.size) {
        throw new Error("No Figma files to check. Set FIGMA_TEAM_IDS and/or FIGMA_FILE_KEYS in .env.");
    }

    console.log(`🔎 Checking ${keys.size} file(s) for today's changes...`);

    const metas = await runPooled([...keys].map(key => async () => {
        try {
            return await fetchMeta(key);
        } catch (err) {
            console.warn(`⚠️  Skipped ${key}: ${err.message}`);
            return null;
        }
    }), CONCURRENCY);

    const touched = metas.filter(m => m && isToday(m.last_touched_at));

    const withVersions = await runPooled(touched.map(meta => async () => ({
        meta,
        versions: await fetchTodayVersions(meta.key),
    })), CONCURRENCY);

    // last_touched_by only names the latest editor, so also accept files where
    // any of today's versions was saved by me. Drafts can report it as null;
    // then the file's creator is the best guess.
    return withVersions.filter(({ meta, versions }) => {
        if (!FIGMA_ONLY_MINE) return true;
        const lastBy = (meta.last_touched_by || meta.creator || {}).id;
        return lastBy === me.id || versions.today.some(v => v.user && v.user.id === me.id);
    }).sort((x, y) => new Date(y.meta.last_touched_at) - new Date(x.meta.last_touched_at));
}

/* ---------------------------
   FILE PICKER
----------------------------*/

function getArg(name) {
    const i = process.argv.indexOf(name);
    return i === -1 ? null : process.argv[i + 1] || "";
}

function ask(question) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    return new Promise(resolve => rl.question(question, answer => { rl.close(); resolve(answer); }));
}

/**
 * --all, or a non-interactive run (cron), takes every file.
 * --file <key|url> takes one. Otherwise the user picks from a numbered list.
 */
async function pickFiles(files) {
    const fileArg = getArg("--file");
    if (fileArg !== null) {
        const key = parseFileKey(fileArg);
        const match = files.filter(f => f.meta.key === key);
        if (!match.length) throw new Error(`File ${fileArg} was not touched today (or is not mine).`);
        return match;
    }

    if (process.argv.includes("--all") || !process.stdin.isTTY) return files;

    console.log("\nFiles touched today:\n");
    console.log("   0) All files (full daily report)");
    files.forEach((f, i) => {
        const m = f.meta;
        const by = (m.last_touched_by || m.creator || { handle: "?" }).handle;
        const folder = m.folder_name ? `${m.folder_name} / ` : "";
        console.log(`   ${i + 1}) ${folder}${m.name}  — ${formatTime(m.last_touched_at)} by ${by}, ${f.versions.today.length} version(s)`);
    });

    while (true) {
        const answer = (await ask("\nSelect files (e.g. 1,3) or 0 for all [0]: ")).trim();
        if (!answer || answer === "0" || answer.toLowerCase() === "a") return files;

        const picks = answer.split(/[\s,]+/).map(Number);
        if (picks.every(n => Number.isInteger(n) && n >= 1 && n <= files.length)) {
            return [...new Set(picks)].map(n => files[n - 1]);
        }
        console.log("Invalid selection.");
    }
}

/* ---------------------------
   PER-FILE WORK SUMMARY
----------------------------*/

async function summarizeFile({ meta, versions }, budget) {
    const key = meta.key;
    console.log(`🧩 ${meta.name}`);

    const comments = await fetchTodayComments(key);

    const summary = {
        file: meta.name,
        folder: meta.folder_name || undefined,
        url: meta.url || `https://www.figma.com/design/${key}`,
        first_change: versions.today.length ? formatTime(versions.today[0].created_at) : undefined,
        last_change: formatTime(meta.last_touched_at),
        named_versions: versions.today
            .filter(v => v.label || v.description)
            .map(v => truncate([v.label, v.description].filter(Boolean).join(": "))),
        comments: comments.map(c => truncate(`${c.user ? c.user.handle : "?"}: ${c.message}`)),
    };

    if (budget.diffDisabled) {
        summary.note = "Design diff unavailable (Figma rate limit); summary built from versions and comments only.";
    } else {
        try {
            const before = versions.baseline
                ? await loadSnapshot(key, versions.baseline.id)
                : loadPreviousDaySnapshot(key);
            const after = await loadSnapshot(key, null);
            saveDaySnapshot(key, after);
            const diff = diffSnapshots(before || { nodes: {}, other: 0, components: {} }, after);

            if (!before) summary.no_baseline = true;
            summary.size = diffSize(diff);
            summary.changes = compactDiff(diff);
        } catch (err) {
            if (err instanceof RateLimitError) budget.diffDisabled = true;
            console.warn(`⚠️  Diff skipped for ${meta.name}: ${err.message}`);
            summary.note = "Design diff unavailable; summary built from versions and comments only.";
        }
    }

    const worth = summary.size === undefined
        ? 1 + summary.named_versions.length
        : Math.ceil(Math.sqrt(summary.size));
    summary.min_bullets = MIN_BULLETS_PER_FILE;
    summary.max_bullets = Math.max(MIN_BULLETS_PER_FILE, Math.min(MAX_BULLETS_PER_FILE, worth));

    return summary;
}

/* ---------------------------
   GROQ REQUEST HELPERS
----------------------------*/

/**
 * Reasoning models (gpt-oss, qwen3) can emit their chain of thought inline in
 * the message content. Strip it so it never reaches today-figma.md.
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

/**
 * POST the prompt to Newisty, retrying transient failures with exponential
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
                `❌ Newisty request failed (attempt ${attempt}/${MAX_LLM_RETRIES})` +
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

async function generateReport(summaries) {
    const prompt = `You are writing a short daily work summary of Figma design work for a CEO who is not technical.

You receive one entry per Figma file the designer worked on today. Each entry carries:
- changes: what differs between the start of the day and now. pages_*, screens_* (top-level frames
  and sections), components_* (reusable design components), text_changed (copy edits, old → new),
  text_added / text_removed (text that appeared or was deleted, with its page), instances_added (component name → how many
  times it was placed), moved (layers moved to a new parent), layers_added / layers_removed.
- named_versions: versions the designer saved with a label or description. These are the
  designer's own words about the work; trust them most.
- comments: today's comments on the file.
- no_baseline: no earlier state of the file was found, so changes list everything in the file.
  It may be new today or older; write "Worked on" instead of claiming it was all created today.
- note: present when the detailed changes could not be fetched.
- min_bullets and max_bullets: the bullet budget for that file.

GOAL:
Say what design work got done today, in plain language, at the level of detail a CEO can skim.

HARD RULES:

Write between min_bullets and max_bullets bullets for each file. Fewer is fine when the file holds little; never stretch one small change into several bullets.
Name screens, pages and components by their real names when they are meaningful. Skip default names like "Frame 12", "Group 3", "Rectangle".
Group related screens into one bullet (for example "Added 4 checkout screens: Cart, Shipping, Payment, Review").
Summarize copy edits by what they touched; quote text only when it is short and meaningful.
Mention comments only when they show a decision or feedback that was handled.
Every bullet must come from the input. Never invent work.
Keep files in the order given. Skip a file whose input says nothing meaningful.

WRITING STYLE:

Start each bullet with a plain verb: Designed, Added, Updated, Reworked, Refined, Fixed, Removed.
5 to 12 words per bullet.
Bold a screen or feature name with ** when it is a real named screen or feature.
No jargon: no frame, instance, node, layer, auto layout, variant. Say screen, component, section, text.
No benefit claims, no filler.

OUTPUT FORMAT:

# Today's Design Work

---

## File Name

* Bullet
* Bullet

INPUT:
${JSON.stringify(summaries)}
`;
    if (!GROQ_API_KEY) {
        throw new Error("GROQ_API_KEY is missing. Add it to .env (see .env.example).");
    }

    console.log(`🧠 Sending ${summaries.length} file(s) to Newisty...`);
    console.log(`⏳ Waiting for Newisty response (${MODEL})...`);

    const res = await requestCompletion(prompt);

    const choice = res.data && res.data.choices && res.data.choices[0];

    if (!choice || !choice.message || typeof choice.message.content !== "string") {
        throw new Error(`Unexpected Newisty response shape: ${JSON.stringify(res.data)}`);
    }

    if (choice.finish_reason === "length") {
        console.warn(
            `⚠️  Report was TRUNCATED - hit max_completion_tokens (${MAX_COMPLETION_TOKENS}). ` +
            "Raise MAX_COMPLETION_TOKENS or select fewer files."
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

function writeReportToFile(report) {
    const date = getLocalDateString();

    const reportsDir = ensureFolders();

    // Separate names so the GitHub report (other branches) is never overwritten.
    const todayFile = path.join(__dirname, "today-figma.md");
    const historyFile = path.join(reportsDir, `figma-${date}.md`);

    fs.writeFileSync(todayFile, report);
    fs.writeFileSync(historyFile, report);
}

/* ---------------------------
   MAIN
----------------------------*/

async function main() {
    console.log("🔍 Initializing system...");

    if (!FIGMA_TOKEN) {
        throw new Error("FIGMA_TOKEN is missing. Add it to .env (see .env.example).");
    }

    const me = await fetchMe();
    console.log(`👤 Figma user: ${me.handle}`);

    const files = await collectTodayFiles(me);

    if (!files.length) {
        console.log("📭 No Figma files touched today.");
        return;
    }

    const selected = await pickFiles(files);
    console.log(`\n📦 Reporting on ${selected.length} file(s)`);

    const budget = { diffDisabled: false };
    const summaries = [];
    for (const file of selected) summaries.push(await summarizeFile(file, budget));

    console.log("🧠 Generating AI report...");

    const report = await generateReport(summaries);

    writeReportToFile(report);

    console.log("\n✅ DONE");
    console.log("📄 today-figma.md updated");
    console.log(`📁 reports/figma-${getLocalDateString()}.md created`);
}

main().catch(err => {
    console.error(`❌ ${err.message}`);
    process.exitCode = 1;
});
