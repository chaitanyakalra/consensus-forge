/**
 * OpenClaw Bridge to Python Council
 * 
 * This module provides a bridge between OpenClaw (Node.js) and 
 * the Python-based consensus council.
 */

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

/**
 * Execute the Python council with a user query
 * 
 * @param {string} query - The user's question to send to the council
 * @param {string} conversationId - Optional conversation ID for tracking
 * @returns {Promise<Object>} - The council's response
 */
async function runCouncil(query, conversationId = null, intent = null, evidencePack = null, searchMeta = null) {
    return new Promise((resolve, reject) => {
        const startTime = Date.now();
        // Path to the backend directory
        const backendPath = path.join(__dirname, '..', 'backend');

        // Build the Python command
        const pythonArgs = [
            '-m', 'backend.cli',
            '--query', query
        ];

        if (conversationId) {
            pythonArgs.push('--conversation-id', conversationId);
        }
        if (intent) {
            pythonArgs.push('--intent', intent);
        }

        // Evidence pack is passed via a temp file to avoid CLI quoting/length issues
        let evidenceFile = null;
        if (evidencePack) {
            try {
                evidenceFile = path.join(os.tmpdir(), `cf-evidence-${Date.now()}.txt`);
                fs.writeFileSync(evidenceFile, String(evidencePack), 'utf8');
                pythonArgs.push('--evidence-pack-file', evidenceFile);
            } catch (e) {
                console.log(`[call_council] ⚠️ failed to write evidence pack file: ${e.message}`);
            }
        }

        // Optional: compact search meta can be passed too (JSON string)
        if (searchMeta) {
            try {
                pythonArgs.push('--search-meta', JSON.stringify(searchMeta));
            } catch {
                // ignore
            }
        }

        console.log(`[call_council] 🐍 Spawning Python process...`);
        console.log(`[call_council]   Command: uv run python ${pythonArgs.join(' ')}`);
        console.log(`[call_council]   CWD: ${path.join(__dirname, '..')}`);

        // Spawn Python process using uv run (ensures virtual environment is used)
        const pythonProcess = spawn('uv', ['run', 'python', ...pythonArgs], {
            cwd: path.join(__dirname, '..'),
            env: process.env
        });

        let stdout = '';
        let stderr = '';

        pythonProcess.stdout.on('data', (data) => {
            stdout += data.toString();
            console.log(`[call_council] 📤 stdout chunk (${data.length} bytes)`);
        });

        pythonProcess.stderr.on('data', (data) => {
            const chunk = data.toString();
            stderr += chunk;
            console.log(`[call_council] ⚠️ stderr: ${chunk.trim().substring(0, 200)}`);
        });

        pythonProcess.on('close', (code) => {
            const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
            console.log(`[call_council] 🏁 Python process exited with code ${code} after ${elapsed}s`);
            console.log(`[call_council]   stdout length: ${stdout.length} bytes`);
            console.log(`[call_council]   stderr length: ${stderr.length} bytes`);

            if (code !== 0) {
                console.error(`[call_council] ❌ Non-zero exit code!`);
                console.error(`[call_council]   stderr: ${stderr.substring(0, 500)}`);
                console.error(`[call_council]   stdout: ${stdout.substring(0, 500)}`);
                reject({
                    error: `Python process exited with code ${code}`,
                    stderr: stderr,
                    stdout: stdout
                });
                return;
            }

            try {
                // Parse the JSON output from Python
                const result = JSON.parse(stdout);
                console.log(`[call_council] ✅ JSON parsed successfully`);
                console.log(`[call_council]   success: ${result.success}`);
                console.log(`[call_council]   stage3 response length: ${result?.stage3?.response?.length || 0}`);
                resolve(result);
            } catch (err) {
                console.error(`[call_council] ❌ JSON parse failed: ${err.message}`);
                console.error(`[call_council]   stdout preview: ${stdout.substring(0, 300)}`);
                reject({
                    error: 'Failed to parse Python output as JSON',
                    parseError: err.message,
                    stdout: stdout,
                    stderr: stderr
                });
            }

            // Cleanup evidence temp file
            if (evidenceFile) {
                try { fs.unlinkSync(evidenceFile); } catch { /* ignore */ }
            }
        });

        pythonProcess.on('error', (err) => {
            console.error(`[call_council] ❌ Failed to start Python process: ${err.message}`);
            reject({
                error: 'Failed to start Python process',
                details: err.message
            });
        });
    });
}

/**
 * Format the council response for display
 * 
 * @param {Object} councilResult - The full council result
 * @returns {string} - Formatted text response
 */
function formatCouncilResponse(councilResult) {
    if (councilResult.error) {
        return `❌ Error: ${councilResult.error}`;
    }

    let formatted = '🏛️ **Council Decision**\n\n';

    // Add the final synthesized response
    if (councilResult.stage3 && councilResult.stage3.response) {
        formatted += councilResult.stage3.response + '\n\n';
    }

    // Add aggregate rankings if available
    if (councilResult.metadata && councilResult.metadata.aggregate_rankings) {
        formatted += '📊 **Model Performance:**\n';
        councilResult.metadata.aggregate_rankings.forEach((rank, index) => {
            formatted += `${index + 1}. ${rank.model} (avg rank: ${rank.average_rank})\n`;
        });
    }

    return formatted;
}

module.exports = {
    runCouncil,
    formatCouncilResponse
};
