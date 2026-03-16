/**
 * ConsensusForge Council Provider
 *
 * A lightweight Express server that exposes an OpenAI-compatible
 * POST /v1/chat/completions endpoint. Internally it calls the Python
 * council (via the existing call_council.js bridge) and returns the
 * chairman's synthesis formatted as an OpenAI chat-completion response.
 *
 * OpenClaw registers this as a custom LLM provider so that every
 * message routed through the bot is answered by the multi-model council.
 */

const path = require('path');
const fs = require('fs');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { runCouncil, formatCouncilResponse } = require('../openclaw-bridge/call_council');

// Ensure data directory exists for logs
const DATA_DIR = path.join(__dirname, '..', 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
const DECISION_LOG = path.join(DATA_DIR, 'decisions.log');

const app = express();
app.use(express.json());

const PORT = process.env.COUNCIL_PORT || 5001;

// Debug: Log .env status at startup
const apiKey = process.env.OPENROUTER_API_KEY;
if (apiKey) {
    const masked = apiKey.substring(0, 12) + '...' + apiKey.substring(apiKey.length - 4);
    console.log(`🔑 .env loaded! API Key: ${masked} (length: ${apiKey.length})`);
} else {
    console.log('❌ WARNING: OPENROUTER_API_KEY not found in .env!');
}

// Gemini key (used for intent classification + Gemini execution/summaries)
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
if (!GEMINI_API_KEY) {
    console.log('⚠️  WARNING: GEMINI_API_KEY not found in .env. OpenClaw must pass a valid Gemini key via Authorization header.');
}

/**
 * Extract plain text from OpenAI-format message content.
 * Content can be either:
 *   - A plain string: "Hello"
 *   - An array of parts: [{type: "text", text: "Hello"}, ...]
 * Returns a string (concatenated text parts) or empty string if no text found.
 */
function extractTextContent(content) {
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
        return content
            .filter(part => part.type === 'text' && part.text)
            .map(part => part.text)
            .join('\n');
    }
    // Fallback: try to stringify whatever it is
    return String(content || '');
}

// ── Extract OpenClaw metadata JSON (best-effort) ───────────────────
function parseOpenClawMetadata(rawText) {
    if (!rawText || typeof rawText !== 'string') return null;
    const text = rawText.trimStart();
    // Form A: "Conversation info (untrusted metadata):\n```json\n{...}\n```\n\n..."
    const a = text.match(/^Conversation info \(untrusted metadata\):\s*```(?:json)?\s*\n([\s\S]*?)\n```\s*/m);
    if (a && a[1]) {
        try { return JSON.parse(a[1]); } catch { return null; }
    }
    // Form B: "```json\n{...}\n```\n\n..."
    const b = text.match(/^```(?:json)?\s*\n([\s\S]*?)\n```\s*/m);
    if (b && b[1]) {
        try { return JSON.parse(b[1]); } catch { return null; }
    }
    return null;
}

// ── Trigger words that include a brief vote summary ──────────────
const VOTE_SUMMARY_TRIGGERS = [
    'analyze', 'verify', 'council', 'decide',
    'evaluate', 'review', 'consensus', 'compare'
];

/**
 * Check whether the user message should include a vote summary.
 */
function shouldShowVoteSummary(text) {
    const lower = text.toLowerCase();
    return VOTE_SUMMARY_TRIGGERS.some(kw => lower.includes(kw));
}

/**
 * Build a short vote summary from Stage 1 individual responses.
 */
function buildVoteSummary(stage1Results, aggregateRankings) {
    let summary = '';

    if (aggregateRankings && aggregateRankings.length > 0) {
        summary += '--- Council Vote ---\n';
        aggregateRankings.forEach((rank, i) => {
            summary += `  ${i + 1}. ${rank.model} (avg rank: ${rank.average_rank})\n`;
        });
        summary += '--- Final Synthesis ---\n\n';
    }

    return summary;
}

// ── Health check ─────────────────────────────────────────────────
app.get('/v1/models', (_req, res) => {
    res.json({
        object: 'list',
        data: [
            {
                id: 'council',
                object: 'model',
                created: Math.floor(Date.now() / 1000),
                owned_by: 'consensus-forge'
            }
        ]
    });
});

// ═══════════════════════════════════════════════════════════════════
// 3-LAYER INTENT-BASED ROUTER
// Layer 1: Safety Filter (instant keyword check)
// Layer 2: Intent Classifier (Gemini Flash ~200ms)
// Layer 3: Router (simple/moderate → Gemini, high_stakes/dangerous → Council)
// ═══════════════════════════════════════════════════════════════════

const GEMINI_URL = 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions';
const COUNCIL_URL = 'http://localhost:5001/v1/council';
const TAVILY_URL = 'https://api.tavily.com/search';
const TAVILY_API_KEY = process.env.TAVILY_API_KEY || '';

// ── Layer 1: Safety keywords (instant, no API call) ──
const SAFETY_KEYWORDS = [
    'rm ', 'rm -', 'rmdir', 'del ', 'delete', 'remove',
    'terminal', 'bash', 'shell', 'execute', 'script',
    'system command', 'file operations',
    'sudo', 'format', 'wipe', 'drop table', 'truncate',
    'chmod', 'chown', 'mkfs', 'fdisk'
];

function checkSafetyFilter(message) {
    const lower = message.toLowerCase();
    return SAFETY_KEYWORDS.some(kw => lower.includes(kw));
}

// ── Search-needed + finance heuristics ────────────────────────────
function detectSearchNeeded(message) {
    if (!message) return false;
    const q = message.toLowerCase();
    const triggers = [
        'search the web', 'web search',
        'latest', 'today', 'as of', 'right now', 'current',
        'news', 'breaking',
        'price', 'quote', 'rate',
        'nifty', 'sensex', 'nse', 'bse',
        'crypto', 'bitcoin', 'btc',
        '2026', 'yesterday', 'last 24 hours', 'last week'
    ];
    return triggers.some(t => q.includes(t));
}

function isFinanceOrPredictionQuery(message) {
    if (!message) return false;
    const q = message.toLowerCase();
    const triggers = [
        'nifty', 'sensex', 'nse', 'bse',
        'portfolio', 'shares', 'equity',
        'invest', 'investment', 'should i',
        'forecast', 'predict', 'projection',
        'drawdown', 'monte carlo',
        'btc', 'bitcoin', 'crypto'
    ];
    return triggers.some(t => q.includes(t));
}

function financeDisclaimerBlock() {
    return (
        "⚠️ **Finance & prediction disclaimer**: This is informational analysis based on public sources and assumptions, " +
        "not financial advice. Markets are volatile; validate prices/news independently and consider your risk tolerance.\n\n"
    );
}

// ── Tavily web search (for moderate fact-lookup path) ─────────────
async function tavilySearch(query, { maxResults = 5, searchDepth = 'basic', topic = 'general', timeRange = null } = {}) {
    if (!TAVILY_API_KEY) {
        return { ok: false, error: 'TAVILY_API_KEY missing' };
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 20_000);
    try {
        const res = await fetch(TAVILY_URL, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${TAVILY_API_KEY}`
            },
            body: JSON.stringify({
                query,
                max_results: Math.max(0, Math.min(Number(maxResults) || 5, 10)),
                search_depth: searchDepth,
                topic,
                ...(timeRange ? { time_range: timeRange } : {})
            }),
            signal: controller.signal
        });
        clearTimeout(timeout);
        if (!res.ok) {
            const text = await res.text().catch(() => '');
            return { ok: false, error: `Tavily ${res.status}: ${text.substring(0, 300)}` };
        }
        return { ok: true, data: await res.json() };
    } catch (e) {
        clearTimeout(timeout);
        return { ok: false, error: e.message || String(e) };
    }
}

function buildTavilyEvidencePack(query, raw) {
    const ts = new Date().toISOString();
    const results = (raw && raw.results) ? raw.results : [];
    let out = `WEB_SEARCH_EVIDENCE (Tavily)\n` +
        `timestamp_utc: ${ts}\n` +
        `query: ${query}\n\n`;
    if (!results.length) {
        out += 'No results found.\n';
        return out;
    }
    results.slice(0, 8).forEach((r, i) => {
        const title = (r.title || r.url || `Result ${i + 1}`).toString().trim();
        const url = (r.url || '').toString().trim();
        const snippet = (r.content || r.snippet || '').toString().trim();
        out += `[${i + 1}] ${title}\nurl: ${url}\n`;
        if (snippet) out += `snippet: ${snippet}\n`;
        out += `\n`;
    });
    out += 'Instruction: Use ONLY the evidence above for freshness-dependent claims. When citing, include the matching URL.\n';
    return out;
}

// ── Layer 2: Intent classifier (lightweight Gemini call) ──
async function classifyIntent(message, apiKey) {
    const classifyBody = {
        model: 'gemini-2.5-flash',
        messages: [
            {
                role: 'user',
                content: `Classify this user query into exactly one category.
Reply with ONLY the category name, nothing else.

Categories:
- simple: casual chat, greetings, thanks, simple factual questions
- moderate: summaries, explanations, how-to questions, single-topic analysis
- high_stakes: investment advice, multi-factor analysis, complex decisions, strategy, "should I" questions, code architecture, portfolio analysis
- dangerous: file deletion, terminal commands, script execution, system modifications

Query: "${message.substring(0, 500)}"`
            }
        ],
        max_tokens: 5,
        stream: false
    };

    try {
        const res = await fetch(GEMINI_URL, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${apiKey}`
            },
            body: JSON.stringify(classifyBody)
        });

        if (!res.ok) return 'moderate'; // fallback on error

        const data = await res.json();
        const raw = (data.choices?.[0]?.message?.content || '').trim().toLowerCase();

        // Extract the classification
        if (raw.includes('high_stakes')) return 'high_stakes';
        if (raw.includes('dangerous')) return 'dangerous';
        if (raw.includes('simple')) return 'simple';
        if (raw.includes('moderate')) return 'moderate';
        return 'moderate'; // fallback
    } catch {
        return 'moderate'; // fallback on network error
    }
}

// ── Council caller ──
async function callCouncil(query, intent = null, conversationId = null, evidencePack = null, searchMeta = null) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 120_000);

    try {
        const res = await fetch(COUNCIL_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                query,
                intent,
                conversation_id: conversationId,
                evidence_pack: evidencePack,
                search: searchMeta
            }),
            signal: controller.signal
        });
        clearTimeout(timeout);

        if (!res.ok) {
            return { success: false, error: `Council returned ${res.status}` };
        }
        return await res.json();
    } catch (err) {
        clearTimeout(timeout);
        return { success: false, error: err.message };
    }
}

// ── SSE helper: send text content as streaming chunks ──
function sendSSEText(res, content, model) {
    res.set('Content-Type', 'text/event-stream');
    res.set('Cache-Control', 'no-cache');
    res.set('Connection', 'keep-alive');

    const chunkId = `chatcmpl-${Date.now()}`;
    const created = Math.floor(Date.now() / 1000);

    // Role chunk
    res.write(`data: ${JSON.stringify({
        id: chunkId, object: 'chat.completion.chunk', created, model,
        choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }]
    })}\n\n`);

    // Content chunk
    res.write(`data: ${JSON.stringify({
        id: chunkId, object: 'chat.completion.chunk', created, model,
        choices: [{ index: 0, delta: { content }, finish_reason: 'stop' }]
    })}\n\n`);

    res.write('data: [DONE]\n\n');
    res.end();
}

// ── SSE helper: forward a Gemini JSON response as streaming chunks ──
function sendSSEFromGeminiJson(res, jsonRes) {
    res.set('Content-Type', 'text/event-stream');
    res.set('Cache-Control', 'no-cache');
    res.set('Connection', 'keep-alive');

    const choice = jsonRes.choices?.[0];
    const chunkId = jsonRes.id || `chatcmpl-${Date.now()}`;
    const created = jsonRes.created || Math.floor(Date.now() / 1000);

    if (choice?.message?.tool_calls) {
        res.write(`data: ${JSON.stringify({
            id: chunkId, object: 'chat.completion.chunk', created, model: jsonRes.model,
            choices: [{ index: 0, delta: { role: 'assistant', content: null, tool_calls: choice.message.tool_calls }, finish_reason: 'tool_calls' }]
        })}\n\n`);
    } else {
        res.write(`data: ${JSON.stringify({
            id: chunkId, object: 'chat.completion.chunk', created, model: jsonRes.model,
            choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }]
        })}\n\n`);
        res.write(`data: ${JSON.stringify({
            id: chunkId, object: 'chat.completion.chunk', created, model: jsonRes.model,
            choices: [{ index: 0, delta: { content: choice?.message?.content || '' }, finish_reason: 'stop' }]
        })}\n\n`);
    }

    res.write('data: [DONE]\n\n');
    res.end();
}

// ── Extract last user message text from OpenAI messages array ──
function extractLastUserMessage(messages) {
    if (!Array.isArray(messages)) return null;
    for (let i = messages.length - 1; i >= 0; i--) {
        const m = messages[i];
        if (m.role === 'user') {
            let text = '';
            if (typeof m.content === 'string') text = m.content;
            else if (Array.isArray(m.content)) {
                text = m.content
                    .filter(p => p.type === 'text' && p.text)
                    .map(p => p.text)
                    .join('\n');
            }
            return cleanUserMessage(text);
        }
    }
    return null;
}

function extractLastUserMessageRaw(messages) {
    if (!Array.isArray(messages)) return null;
    for (let i = messages.length - 1; i >= 0; i--) {
        const m = messages[i];
        if (m.role === 'user') {
            let text = '';
            if (typeof m.content === 'string') text = m.content;
            else if (Array.isArray(m.content)) {
                text = m.content
                    .filter(p => p.type === 'text' && p.text)
                    .map(p => p.text)
                    .join('\n');
            } else {
                text = String(m.content || '');
            }
            return text;
        }
    }
    return null;
}

// ── Strip OpenClaw metadata injected at the top of user messages ──
// OpenClaw prepends one of these forms:
//   Form A: "Conversation info (untrusted metadata):\n```json\n{...}\n```\n\n<actual message>"
//   Form B: "```json\n{...}\n```\n\n<actual message>"  (truncated, no header)
function cleanUserMessage(text) {
    if (!text) return text;
    const t = String(text).trimStart();
    return t
        // Form A: full header + JSON block
        .replace(/^Conversation info \(untrusted metadata\):\s*```(?:json)?\s*\n[\s\S]*?\n```\s*\n?/m, '')
        // Form B: bare ```json block at the very start (no header)
        .replace(/^```(?:json)?\s*\n[\s\S]*?\n```\s*\n?/m, '')
        // Safety: strip any lone ``` fence left at the top
        .replace(/^```\s*\n?/, '')
        .trim();
}

// ── Decision logger — appends a JSON line to data/decisions.log ──
function logDecision(entry) {
    const line = JSON.stringify({ timestamp: new Date().toISOString(), ...entry }) + '\n';
    fs.appendFile(DECISION_LOG, line, (err) => {
        if (err) console.error('[logger] Failed to write decision log:', err.message);
    });
}

// ── Detect if a query/response requires Gemini to execute tools ──
const EXECUTION_KEYWORDS = ['save', 'create', 'write', 'run', 'execute', 'make', 'build',
    'send', 'generate and save', 'store', 'add to', 'put in', 'delete', 'remove'];
function detectRequiresExecution(query, councilResponse) {
    const combined = (query + ' ' + councilResponse).toLowerCase();
    return EXECUTION_KEYWORDS.some(kw => combined.includes(kw));
}

// ── Detect council response type from context ──
function detectResponseType(safetyTriggered, query) {
    if (safetyTriggered) return 'safety_review';
    const q = query.toLowerCase();
    if (['should i', 'recommend', 'advise', 'suggest', 'decide', 'choose', 'which'].some(kw => q.includes(kw)))
        return 'recommendation';
    return 'analysis';
}

// ── Check if this is a tool-loop iteration (bypass routing) ──
function isToolLoop(messages) {
    if (!Array.isArray(messages) || messages.length === 0) return false;
    const last = messages[messages.length - 1];
    return last.role === 'tool' || last.role === 'function';
}

// ── Strip web_search / brave_search artifacts from conversation history ──
// OpenClaw's history may contain assistant messages with web_search tool_calls
// and tool-role messages with Brave Search errors.  If Gemini sees those it
// either retries web_search (which isn't in the stripped tools list) or echoes
// the "Brave API key not configured" error text to the user.
// This function removes those messages so Gemini starts with a clean slate;
// live web data is injected separately via Tavily by this server's routing.
function stripWebSearchHistory(messages) {
    if (!Array.isArray(messages)) return messages;

    // 1. Collect tool_call IDs that belong to web_search / brave_search
    const webSearchCallIds = new Set();
    for (const m of messages) {
        if (m.role === 'assistant' && Array.isArray(m.tool_calls)) {
            for (const tc of m.tool_calls) {
                const name = (tc?.function?.name || tc?.name || '').toLowerCase();
                if (name === 'web_search' || name === 'brave_search') {
                    if (tc.id) webSearchCallIds.add(tc.id);
                }
            }
        }
    }

    // 2. Walk & filter
    const cleaned = [];
    for (const m of messages) {
        // Drop tool-role messages that are responses to a web_search call
        if (m.role === 'tool' && m.tool_call_id && webSearchCallIds.has(m.tool_call_id)) {
            continue;
        }

        // For assistant messages, strip web_search entries from tool_calls
        if (m.role === 'assistant' && Array.isArray(m.tool_calls)) {
            const kept = m.tool_calls.filter(tc => {
                const name = (tc?.function?.name || tc?.name || '').toLowerCase();
                return name !== 'web_search' && name !== 'brave_search';
            });
            if (kept.length === 0 && !m.content) {
                // The entire message was just a web_search tool_call — skip it
                continue;
            }
            // Preserve the message but without the web_search tool_calls
            cleaned.push({ ...m, tool_calls: kept.length > 0 ? kept : undefined });
            continue;
        }

        cleaned.push(m);
    }
    return cleaned;
}

// ── Strip unsupported params from OpenClaw request ──
function cleanOpenClawBody(body) {
    const {
        thinking, reasoning_effort, verbosity,
        stream, stream_options,
        store,
        max_completion_tokens,
        tools: rawTools,
        tool_choice,
        ...clean
    } = body;
    clean.stream = false;
    if (max_completion_tokens && !clean.max_tokens) {
        clean.max_tokens = max_completion_tokens;
    }

    // Strip OpenClaw's native web_search tool so all searches route through
    // this server's Tavily integration instead of Brave Search.
    // Any other tools (e.g. file/execution tools) are preserved if present.
    if (Array.isArray(rawTools)) {
        const filtered = rawTools.filter(t => {
            const name = (t?.function?.name || t?.name || '').toLowerCase();
            return name !== 'web_search' && name !== 'brave_search';
        });
        if (filtered.length > 0) {
            // Re-attach remaining tools + tool_choice so the execution pipeline still works
            clean.tools = filtered;
            if (tool_choice !== undefined) clean.tool_choice = tool_choice;
        }
        // If all tools were filtered out, omit tools/tool_choice entirely
        // (Gemini returns an error on an empty tools array)
    }

    // Strip stale web_search / brave_search tool_calls & responses from history
    // so Gemini never sees "Brave API key not configured" errors.
    if (Array.isArray(clean.messages)) {
        const before = clean.messages.length;
        clean.messages = stripWebSearchHistory(clean.messages);
        const after = clean.messages.length;
        if (before !== after) {
            console.log(`[cleanBody] 🧹 Stripped ${before - after} web_search history message(s)`);
        }
    }

    return clean;
}

// ── Forward request to Gemini and return parsed JSON ──
async function callGemini(cleanBody, apiKey) {
    const res = await fetch(GEMINI_URL, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey}`
        },
        body: JSON.stringify(cleanBody)
    });
    const text = await res.text();
    return { status: res.status, text, json: res.ok ? JSON.parse(text) : null };
}

// ── Council route handler: runs council then feeds result to Gemini if execution needed ──
async function routeThroughCouncil(res, cleanBody, apiKey, userMessage, safetyTriggered, intent, conversationId) {
    const councilLabel = safetyTriggered ? '🛡️ Safety Review' : '🏛️ Council';
    console.log(`[router] ${councilLabel} → calling council for: "${userMessage.substring(0, 80)}..."`);

    const searchNeeded = detectSearchNeeded(userMessage);
    let evidencePack = null;
    let searchMeta = null;
    if (searchNeeded) {
        const search = await tavilySearch(userMessage, { maxResults: 5, searchDepth: 'basic', topic: 'general' });
        evidencePack = search.ok ? buildTavilyEvidencePack(userMessage, search.data) : null;
        const results = search.ok ? (search.data?.results || []) : [];
        searchMeta = {
            used: !!search.ok,
            error: search.ok ? null : search.error,
            results: results.slice(0, 5).map(r => ({
                title: r.title || '',
                url: r.url || '',
                snippet: (r.content || r.snippet || '').toString().slice(0, 500)
            }))
        };
        console.log(`[router] 🌐 search_needed=${searchNeeded} tavily_ok=${search.ok} results=${searchMeta.results.length}`);
    }

    const council = await callCouncil(userMessage, intent, conversationId, evidencePack, searchMeta);

    if (!council.success) {
        console.log(`[router] ⚠️ Council failed (${council.error}) → falling back to Gemini`);
        logDecision({ query: userMessage.substring(0, 200), safety_triggered: safetyTriggered, intent, route: 'gemini_fallback' });
        try {
            const gemini = await callGemini(cleanBody, apiKey);
            if (gemini.status >= 400) return res.status(gemini.status).set('Content-Type', 'application/json').send(gemini.text);
            sendSSEFromGeminiJson(res, gemini.json);
        } catch (err) {
            res.status(502).json({ error: { message: err.message } });
        }
        return;
    }

    // Detect if this task needs Gemini to execute tools (file creation, shell, etc.)
    const requiresExecution = detectRequiresExecution(userMessage, council.response);
    const type = detectResponseType(safetyTriggered, userMessage);

    logDecision({
        query: userMessage.substring(0, 200),
        safety_triggered: safetyTriggered,
        intent,
        route: 'council',
        conversation_id: conversationId,
        council_models: council.models_used,
        council_duration_s: council.duration_seconds,
        requires_execution: requiresExecution,
        type
    });

    const councilSearchUsed = !!(council.search && council.search.used);
    const transparencyPrefix = councilSearchUsed
        ? `🌐 **Used web search (Tavily)**\n`
        : '';
    const maybeFinanceDisclaimer = isFinanceOrPredictionQuery(userMessage) ? financeDisclaimerBlock() : '';

    if (requiresExecution) {
        // ── Council → Gemini Execution Pipeline ──
        // Council acts as decision engine; Gemini executes the actual tools
        console.log(`[router] 🔧 requires_execution=true → handing off to Gemini with council context`);
        const prefix = safetyTriggered
            ? `🛡️ **Safety Review Complete** — Council approved this action.\n\n`
            : `🏛️ **Council Analysis** (${council.models_used} models, ${council.duration_seconds}s)\n\n`;

        const councilContextMsg = {
            role: 'system',
            content: `The ConsensusForge council of AI models has analyzed the user's request and produced the following response:\n\n---\n${council.response}\n---\n\nUse this council analysis as your basis. The user's original request requires tool execution (file creation, shell commands, web search, etc.). Perform those actions now using the available tools.\n\nStart your reply with this prefix:\n"${transparencyPrefix}${maybeFinanceDisclaimer}${prefix}"\nThen perform the required tasks and confirm what was done.`
        };

        // Inject council context into the messages array before calling Gemini
        const augmentedBody = {
            ...cleanBody,
            messages: [...cleanBody.messages, councilContextMsg]
        };

        try {
            const gemini = await callGemini(augmentedBody, apiKey);
            if (gemini.status >= 400) {
                console.log(`[router]   Gemini execution error: ${gemini.status}`);
                return res.status(gemini.status).set('Content-Type', 'application/json').send(gemini.text);
            }
            sendSSEFromGeminiJson(res, gemini.json);
            const content = gemini.json?.choices?.[0]?.message?.content || '';
            console.log(`[router] ✅ Gemini executed with council context (${content.substring(0, 60)}...)`);
        } catch (err) {
            console.error(`[router] ❌ Gemini execution error: ${err.message}`);
            res.status(502).json({ error: { message: err.message } });
        }
    } else {
        // ── Text-only response: council result is the final reply ──
        const header = safetyTriggered
            ? `🛡️ **Safety Review** (${council.models_used} models, ${council.duration_seconds}s)\n\n`
            : `🏛️ **Council Response** (${council.models_used} models, ${council.duration_seconds}s)\n\n`;
        console.log(`[router] ✅ Council text reply sent (${council.duration_seconds}s)`);
        sendSSEText(res, transparencyPrefix + maybeFinanceDisclaimer + header + council.response, cleanBody.model);
    }
}

// ═══════════════════════════════════════════════════════════════════
// MAIN PROXY ENDPOINT — 3-layer routing + council→Gemini execution
// ═══════════════════════════════════════════════════════════════════
app.post('/gemini/v1/chat/completions', async (req, res) => {
    const apiKey =
        (req.headers.authorization?.replace('Bearer ', '') || '').trim() ||
        GEMINI_API_KEY;
    const cleanBody = cleanOpenClawBody(req.body);
    const rawUser = extractLastUserMessageRaw(cleanBody.messages);
    const meta = parseOpenClawMetadata(rawUser);
    const conversationId = meta?.sender ? `openclaw-${String(meta.sender)}` : null;
    const userMessage = cleanUserMessage(rawUser); // already cleaned of metadata
    const toolLoop = isToolLoop(cleanBody.messages);

    // ── Bypass: tool loops, no user message, or very short messages ──
    if (toolLoop || !userMessage || userMessage.length < 5) {
        console.log(`[router] ⚡ BYPASS → Gemini (${toolLoop ? 'tool-loop' : 'short/no message'})`);
        logDecision({ query: (userMessage || '').substring(0, 200), route: 'bypass_gemini', intent: 'n/a' });
        try {
            const gemini = await callGemini(cleanBody, apiKey);
            if (gemini.status >= 400) return res.status(gemini.status).set('Content-Type', 'application/json').send(gemini.text);
            sendSSEFromGeminiJson(res, gemini.json);
            const content = gemini.json?.choices?.[0]?.message?.content || '';
            console.log(`[router] ✅ Gemini replied (${content.substring(0, 60)}...)`);
        } catch (err) {
            console.error(`[router] ❌ Gemini error: ${err.message}`);
            res.status(502).json({ error: { message: err.message } });
        }
        return;
    }

    // ── Layer 1: Safety Filter ──
    const isDangerous = checkSafetyFilter(userMessage);
    if (isDangerous) {
        console.log(`[router] 🛡️ SAFETY FILTER triggered`);
        await routeThroughCouncil(res, cleanBody, apiKey, userMessage, true, 'dangerous', conversationId);
        return;
    }

    // ── Layer 2: Intent Classification (~200ms) ──
    console.log(`[router] 🧠 Classifying intent...`);
    const startClassify = Date.now();
    const rawIntent = await classifyIntent(userMessage, apiKey);
    const classifyMs = Date.now() - startClassify;

    // Heuristic upgrade:
    // - finance + analysis/decision/simulation language => high_stakes
    // - pure price/news lookups should remain moderate and use Tavily-only path
    let intent = rawIntent;
    const lowerMsg = userMessage.toLowerCase();
    const financeKeywords = [
        'nifty 50',
        'sensex',
        'portfolio',
        'reliance',
        'tcs',
        'infy',
        'stock',
        'stocks',
        'shares',
        'equity',
        'btc',
        'bitcoin',
        'crypto',
        'investment',
        'invest',
        'drawdown',
        'monte carlo'
    ];
    const highStakesSignals = [
        'analyze',
        'simulate',
        'monte carlo',
        'drawdown',
        'recovery',
        'recommend',
        'should i',
        'decide',
        'verify',
        'projection',
        'worst-case',
        'worst case',
        'scenario',
        'risk',
    ];
    const looksLikeHighStakesFinance =
        financeKeywords.some(kw => lowerMsg.includes(kw)) &&
        highStakesSignals.some(kw => lowerMsg.includes(kw));

    if ((rawIntent === 'simple' || rawIntent === 'moderate') && looksLikeHighStakesFinance) {
        intent = 'high_stakes';
        console.log(`[router]   Intent upgraded from ${rawIntent} → high_stakes based on finance+analysis signals`);
    } else {
        console.log(`[router]   Intent: ${rawIntent} (${classifyMs}ms)`);
    }

    // ── Layer 3: Route (matches your flow table) ──
    // - simple: Gemini direct
    // - moderate + needs current data: Tavily → Gemini summarizes + cites
    // - high_stakes/dangerous: Council (Tavily handled inside council when needed) → Gemini executes if required

    if (intent === 'high_stakes' || intent === 'dangerous') {
        await routeThroughCouncil(res, cleanBody, apiKey, userMessage, false, intent, conversationId);
        return;
    }

    if ((intent === 'simple' || intent === 'moderate') && detectSearchNeeded(userMessage)) {
        console.log(`[router] 🌐 moderate+search_needed → Tavily → Gemini summarize`);
        const search = await tavilySearch(userMessage, { maxResults: 5, searchDepth: 'basic', topic: 'general' });
        logDecision({
            query: userMessage.substring(0, 200),
            route: 'tavily_gemini',
            intent,
            conversation_id: conversationId,
            search_used: search.ok
        });

        const evidencePack = search.ok ? buildTavilyEvidencePack(userMessage, search.data) : '';
        const transparencyPrefix = `🌐 **Used web search (Tavily)**\n\n`;
        const maybeFinanceDisclaimer = isFinanceOrPredictionQuery(userMessage) ? financeDisclaimerBlock() : '';

        const systemMsg = {
            role: 'system',
            content:
                `${transparencyPrefix}${maybeFinanceDisclaimer}` +
                (search.ok
                    ? `Use the evidence pack below to answer. Cite URLs inline for any factual claims.\n\n${evidencePack}`
                    : `Web search was requested/needed but failed: ${search.error}. Answer with what you know and clearly label assumptions; suggest retrying.\n`)
        };

        const augmentedBody = { ...cleanBody, messages: [...cleanBody.messages, systemMsg] };
        try {
            const gemini = await callGemini(augmentedBody, apiKey);
            if (gemini.status >= 400) return res.status(gemini.status).set('Content-Type', 'application/json').send(gemini.text);
            sendSSEFromGeminiJson(res, gemini.json);
        } catch (err) {
            res.status(502).json({ error: { message: err.message } });
        }
        return;
    }

    // simple / default: Gemini direct
    console.log(`[router] ⚡ → Gemini (intent: ${intent})`);
    logDecision({ query: userMessage.substring(0, 200), route: 'gemini', intent, conversation_id: conversationId });
    try {
        const gemini = await callGemini(cleanBody, apiKey);
        if (gemini.status >= 400) {
            console.log(`[router]   Gemini error: ${gemini.status}`);
            return res.status(gemini.status).set('Content-Type', 'application/json').send(gemini.text);
        }
        sendSSEFromGeminiJson(res, gemini.json);
    } catch (err) {
        console.error(`[router] ❌ Gemini error: ${err.message}`);
        res.status(502).json({ error: { message: err.message } });
    }
});

// ── Feedback endpoint (thumbs up/down) ────────────────────────────
app.post('/v1/feedback', (req, res) => {
    const { conversation_id, message_id, rating, notes } = req.body || {};
    if (!conversation_id || !rating) {
        return res.status(400).json({ success: false, error: 'conversation_id and rating are required' });
    }
    logDecision({
        route: 'feedback',
        conversation_id: String(conversation_id),
        message_id: message_id ? String(message_id) : null,
        rating: String(rating),
        notes: notes ? String(notes).substring(0, 500) : null
    });
    res.json({ success: true });
});

app.get('/health', (_req, res) => {
    res.json({ status: 'ok', service: 'consensus-council-provider' });
});

// ── Direct council endpoint (for /council plugin command) ────────
app.post('/v1/council', async (req, res) => {
    const startTime = Date.now();
    const rawQuery = req.body.query;
    const intent = req.body.intent || null;
    const conversationId = req.body.conversation_id || null;
    let evidencePack = req.body.evidence_pack || null;
    let searchMeta = req.body.search || null;
    const query = cleanUserMessage(rawQuery); // strip any metadata

    if (!query) {
        return res.status(400).json({ error: 'query field is required' });
    }

    console.log(`\n${'='.repeat(60)}`);
    console.log(`[${new Date().toISOString()}] 🏛️ COUNCIL SKILL REQUEST`);
    console.log(`  Query: "${query.substring(0, 120)}"`);
    if (intent) console.log(`  Intent: "${String(intent)}"`);
    if (conversationId) console.log(`  Conversation: "${String(conversationId)}"`);

    try {
        // Deterministic router-layer web search (only when freshness signals are present)
        // If the caller already provided evidence_pack/search, respect it.
        const searchNeeded = detectSearchNeeded(query);
        if (!evidencePack && !searchMeta && searchNeeded) {
            const search = await tavilySearch(query, { maxResults: 5, searchDepth: 'basic', topic: 'general' });
            evidencePack = search.ok ? buildTavilyEvidencePack(query, search.data) : null;
            const results = search.ok ? (search.data?.results || []) : [];
            searchMeta = {
                used: !!search.ok,
                error: search.ok ? null : search.error,
                results: results.slice(0, 5).map(r => ({
                    title: r.title || '',
                    url: r.url || '',
                    snippet: (r.content || r.snippet || '').toString().slice(0, 500)
                }))
            };
            console.log(`[router] 🌐 /v1/council search_needed=${searchNeeded} tavily_ok=${search.ok} results=${searchMeta.results.length}`);
        }

        const result = await runCouncil(query, conversationId, intent, evidencePack, searchMeta);
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

        if (!result.success) {
            console.log(`  ❌ Council failed: ${result.error}`);
            return res.json({ success: false, error: result.error, duration_seconds: parseFloat(elapsed) });
        }

        let response = '';
        if (result.stage3 && result.stage3.response) {
            response = result.stage3.response.replace(/^FINAL ANSWER:\s*/i, '').trim();
        }

        const modelsUsed = result.stage1 ? result.stage1.length : 0;
        const requiresExecution = detectRequiresExecution(query, response);
        const type = detectResponseType(false, query);

        console.log(`  ✅ Council completed in ${elapsed}s (${modelsUsed} models)`);
        console.log(`  requires_execution: ${requiresExecution}`);
        console.log(`  Response preview: "${response.substring(0, 150)}..."`);
        console.log(`${'='.repeat(60)}\n`);

        logDecision({
            query: query.substring(0, 200),
            route: 'council_skill',
            intent: intent || 'n/a',
            conversation_id: conversationId,
            council_models: modelsUsed,
            council_duration_s: parseFloat(elapsed),
            requires_execution: requiresExecution
        });

        res.json({
            success: true,
            response,
            models_used: modelsUsed,
            duration_seconds: parseFloat(elapsed),
            rankings: result.metadata?.aggregate_rankings || [],
            search: result.metadata?.search || { used: false, results: [], error: null },
            structured: { type, confidence: 0.85, requires_execution: requiresExecution }
        });
    } catch (err) {
        console.error(`  ❌ Error: ${err.message}`);
        res.status(500).json({ success: false, error: err.message });
    }
});

// ── Main completions endpoint ────────────────────────────────────
app.post('/v1/chat/completions', async (req, res) => {
    const startTime = Date.now();

    console.log(`\n${'='.repeat(60)}`);
    console.log(`[${new Date().toISOString()}] 📥 INCOMING REQUEST`);
    console.log(`  Model requested: ${req.body.model}`);
    console.log(`  Messages count: ${req.body.messages?.length || 0}`);
    console.log(`  Stream requested: ${!!req.body.stream}`);

    try {
        const { messages, model } = req.body;

        if (!messages || !Array.isArray(messages) || messages.length === 0) {
            return res.status(400).json({
                error: {
                    message: 'messages array is required',
                    type: 'invalid_request_error'
                }
            });
        }

        // Extract the latest user message (OpenClaw sends the full history)
        const userMessage = [...messages]
            .reverse()
            .find(m => m.role === 'user');

        if (!userMessage) {
            return res.status(400).json({
                error: {
                    message: 'No user message found in messages array',
                    type: 'invalid_request_error'
                }
            });
        }

        // Extract text from message content.
        // OpenAI spec allows content to be either a plain string or an array
        // of parts: [{type: "text", text: "..."}, {type: "image_url", ...}].
        // OpenClaw sends the array format, so we must handle both.
        const query = extractTextContent(userMessage.content);
        console.log(`  📝 Extracted text content type: ${typeof userMessage.content}`);
        console.log(`  📝 Extracted query: "${String(query).substring(0, 120)}"`);

        if (!query) {
            console.log(`  ❌ No extractable text content found!`);
            return res.status(400).json({
                error: {
                    message: 'User message had no extractable text content',
                    type: 'invalid_request_error'
                }
            });
        }

        console.log(`[Council Provider] ⏳ Starting council pipeline...`);

        // Run the full council pipeline
        const result = await runCouncil(query);
        const councilElapsed = ((Date.now() - startTime) / 1000).toFixed(1);
        console.log(`[Council Provider] ✅ Council returned after ${councilElapsed}s`);
        console.log(`  success: ${result.success}`);
        console.log(`  has stage1: ${!!result.stage1}, has stage2: ${!!result.stage2}, has stage3: ${!!result.stage3}`);

        if (!result.success) {
            console.error('[Council Provider] ❌ Council FAILED:', result.error);
            const errorResponse = formatAsCompletion(
                `I encountered an error while consulting the council: ${result.error}`,
                startTime
            );
            console.log(`  📤 Sending error response to OpenClaw`);
            return res.json(errorResponse);
        }

        // Build the response content
        let content = '';

        // Optionally prepend vote summary for trigger words
        if (shouldShowVoteSummary(query)) {
            const rankings = result.metadata && result.metadata.aggregate_rankings;
            content += buildVoteSummary(result.stage1, rankings);
        }

        // Append the chairman's final synthesis
        // Strip "FINAL ANSWER:" prefix so OpenClaw treats this as a plain chat reply
        if (result.stage3 && result.stage3.response) {
            content += result.stage3.response.replace(/^FINAL ANSWER:\s*/i, '').trim();
        } else {
            content += 'The council was unable to produce a synthesis. Individual model responses were collected but synthesis failed.';
        }

        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
        console.log(`[Council Provider] 📤 Sending response to OpenClaw (${elapsed}s)`);
        console.log(`  Response content length: ${content.length} chars`);
        console.log(`  Response preview: "${content.substring(0, 150)}..."`);

        // OpenClaw sends stream: true and expects SSE format
        if (req.body.stream) {
            console.log(`  📡 Streaming response via SSE`);
            res.setHeader('Content-Type', 'text/event-stream');
            res.setHeader('Cache-Control', 'no-cache');
            res.setHeader('Connection', 'keep-alive');

            const chunkId = `chatcmpl-${uuidv4()}`;
            const created = Math.floor(startTime / 1000);

            // Send the content as a single chunk
            const chunk = {
                id: chunkId,
                object: 'chat.completion.chunk',
                created: created,
                model: 'council/consensus',
                choices: [{
                    index: 0,
                    delta: { role: 'assistant', content: content },
                    finish_reason: null
                }]
            };
            res.write(`data: ${JSON.stringify(chunk)}\n\n`);

            // Send the stop chunk
            const stopChunk = {
                id: chunkId,
                object: 'chat.completion.chunk',
                created: created,
                model: 'council/consensus',
                choices: [{
                    index: 0,
                    delta: {},
                    finish_reason: 'stop'
                }]
            };
            res.write(`data: ${JSON.stringify(stopChunk)}\n\n`);

            // Send the [DONE] signal
            res.write('data: [DONE]\n\n');
            console.log(`  Completion ID: ${chunkId}`);
            console.log(`${'='.repeat(60)}\n`);
            res.end();
        } else {
            const completion = formatAsCompletion(content, startTime);
            console.log(`  Completion ID: ${completion.id}`);
            console.log(`${'='.repeat(60)}\n`);
            res.json(completion);
        }

    } catch (err) {
        console.error(`[Council Provider] ❌ UNEXPECTED ERROR:`, err.message);
        console.error(`  Stack:`, err.stack);
        console.log(`${'='.repeat(60)}\n`);
        res.status(500).json({
            error: {
                message: err.message || 'Internal server error',
                type: 'server_error'
            }
        });
    }
});

/**
 * Format text as an OpenAI-compatible chat completion response.
 */
function formatAsCompletion(content, startTime) {
    return {
        id: `chatcmpl-${uuidv4()}`,
        object: 'chat.completion',
        created: Math.floor(startTime / 1000),
        model: 'council/consensus',
        choices: [
            {
                index: 0,
                message: {
                    role: 'assistant',
                    content: content
                },
                finish_reason: 'stop'
            }
        ],
        usage: {
            prompt_tokens: 0,
            completion_tokens: 0,
            total_tokens: 0
        }
    };
}

// ── Start server ─────────────────────────────────────────────────
app.listen(PORT, () => {
    console.log(`\n=== ConsensusForge Council Provider ===`);
    console.log(`Listening on http://localhost:${PORT}`);
    console.log(`OpenAI-compatible endpoint: http://localhost:${PORT}/v1/chat/completions`);
    console.log(`Health check: http://localhost:${PORT}/health`);
    console.log(`\nRegister in openclaw.json as:`);
    console.log(`  "providers": {`);
    console.log(`    "consensus-council": {`);
    console.log(`      "baseUrl": "http://localhost:${PORT}/v1",`);
    console.log(`      "api": "openai-completions",`);
    console.log(`      "apiKey": "not-needed"`);
    console.log(`    }`);
    console.log(`  }`);
    console.log(`\nSet primary model to: "consensus-council/council"\n`);
});
