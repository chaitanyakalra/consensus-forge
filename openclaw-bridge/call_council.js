/**
 * OpenClaw Bridge to Python Council
 * 
 * This module provides a bridge between OpenClaw (Node.js) and 
 * the Python-based consensus council.
 */

const { spawn } = require('child_process');
const path = require('path');

/**
 * Execute the Python council with a user query
 * 
 * @param {string} query - The user's question to send to the council
 * @param {string} conversationId - Optional conversation ID for tracking
 * @returns {Promise<Object>} - The council's response
 */
async function runCouncil(query, conversationId = null) {
    return new Promise((resolve, reject) => {
        // Path to the backend directory
        const backendPath = path.join(__dirname, '..', 'backend');

        // Build the Python command
        // We'll create a CLI wrapper script in Python
        const pythonArgs = [
            '-m', 'backend.cli',
            '--query', query
        ];

        if (conversationId) {
            pythonArgs.push('--conversation-id', conversationId);
        }

        // Spawn Python process using uv run (ensures virtual environment is used)
        const pythonProcess = spawn('uv', ['run', 'python', ...pythonArgs], {
            cwd: path.join(__dirname, '..'),
            env: process.env
        });

        let stdout = '';
        let stderr = '';

        pythonProcess.stdout.on('data', (data) => {
            stdout += data.toString();
        });

        pythonProcess.stderr.on('data', (data) => {
            stderr += data.toString();
        });

        pythonProcess.on('close', (code) => {
            if (code !== 0) {
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
                resolve(result);
            } catch (err) {
                reject({
                    error: 'Failed to parse Python output as JSON',
                    parseError: err.message,
                    stdout: stdout,
                    stderr: stderr
                });
            }
        });

        pythonProcess.on('error', (err) => {
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
