/**
 * OpenClaw Command Adapter for ConsensusForge Council
 *
 * OpenClaw pipes a JSON request to stdin and reads the JSON response from stdout.
 * This script reads the full stdin, extracts the last user message,
 * runs the council pipeline, and writes the result to stdout.
 */

const { runCouncil } = require("./call_council");

let input = "";

process.stdin.on("data", d => input += d.toString());

process.stdin.on("end", async () => {
    try {
        const req = JSON.parse(input);
        const last = req.messages[req.messages.length - 1].content;

        const result = await runCouncil(last);

        process.stdout.write(JSON.stringify({
            content: result.stage3.response
        }));

    } catch (e) {
        process.stdout.write(JSON.stringify({
            content: "Council error: " + e.message
        }));
    }
});
