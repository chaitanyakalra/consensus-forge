/**
 * OpenClaw Command Adapter for ConsensusForge Council
 *
 * OpenClaw pipes a JSON request to stdin and reads the JSON response from stdout.
 * This script reads the full stdin, extracts the last user message,
 * runs the council pipeline, and writes the result to stdout.
 *
 * IMPORTANT: OpenClaw command providers expect plain { content: "text" }
 * NOT the full OpenAI envelope. OpenClaw wraps it into a message internally.
 */

const { runCouncil } = require("./call_council");

/**
 * Extract plain text from message content (handles string or array-of-parts).
 */
function extractText(content) {
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
        return content
            .filter(p => p.type === "text" && p.text)
            .map(p => p.text)
            .join("\n");
    }
    return String(content || "");
}

/**
 * Light cleanup of the council response.
 * The stage-3 prompt now produces direct conversational output,
 * so no heavy stripping is needed — just trim whitespace.
 */
function cleanResponse(text) {
    return text.trim();
}

let input = "";

process.stdin.on("data", d => input += d.toString());

process.stdin.on("end", async () => {
    try {
        const req = JSON.parse(input);
        const lastUserMsg = [...req.messages].reverse().find(m => m.role === "user");
        const query = lastUserMsg ? extractText(lastUserMsg.content) : "";

        const result = await runCouncil(query);
        const raw = result?.stage3?.response || "Council returned no response";

        process.stdout.write(JSON.stringify({
            content: cleanResponse(raw)
        }));

    } catch (e) {
        process.stdout.write(JSON.stringify({
            content: "Council error: " + e.message
        }));
    }
});
