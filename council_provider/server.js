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
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { runCouncil, formatCouncilResponse } = require('../openclaw-bridge/call_council');

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

app.get('/health', (_req, res) => {
    res.json({ status: 'ok', service: 'consensus-council-provider' });
});

// ── Main completions endpoint ────────────────────────────────────
app.post('/v1/chat/completions', async (req, res) => {
    const startTime = Date.now();

    console.log(`\n${'='.repeat(60)}`);
    console.log(`[${new Date().toISOString()}] 📥 INCOMING REQUEST`);
    console.log(`  Model requested: ${req.body.model}`);
    console.log(`  Messages count: ${req.body.messages?.length || 0}`);

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
        const completion = formatAsCompletion(content, startTime);
        console.log(`[Council Provider] 📤 Sending response to OpenClaw (${elapsed}s)`);
        console.log(`  Response content length: ${content.length} chars`);
        console.log(`  Response preview: "${content.substring(0, 150)}..."`);
        console.log(`  Completion ID: ${completion.id}`);
        console.log(`${'='.repeat(60)}\n`);

        res.json(completion);

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
