/**
 * ConsensusForge OpenClaw Agent
 * 
 * Main entry point for the persistent AI agent powered by OpenClaw
 * with multi-LLM consensus decision-making.
 */

const { runCouncil, formatCouncilResponse } = require('./call_council');

/**
 * Main agent handler
 * 
 * This function is called by OpenClaw when a user sends a message.
 * 
 * @param {Object} context - OpenClaw context object
 * @param {string} context.message - The user's message
 * @param {string} context.userId - The user's ID
 * @param {string} context.conversationId - The conversation ID
 * @param {Function} context.reply - Function to send a reply
 */
async function handleMessage(context) {
    const { message, userId, conversationId, reply } = context;

    console.log(`[ConsensusForge] Received message: "${message}" from user ${userId}`);

    try {
        // Check if this is a command that should use the council
        const shouldUseCouncil = shouldInvokeCouncil(message);

        if (shouldUseCouncil) {
            // Notify user that we're consulting the council
            await reply("🏛️ Consulting the council of AI models...");

            // Run the consensus council
            console.log(`[ConsensusForge] Invoking council for query: "${message}"`);
            const result = await runCouncil(message, conversationId);

            if (result.success) {
                // Format and send the response
                const formattedResponse = formatCouncilResponse(result);
                await reply(formattedResponse);

                console.log(`[ConsensusForge] Council responded successfully`);
            } else {
                // Handle error
                await reply(`❌ The council encountered an error: ${result.error}`);
                console.error(`[ConsensusForge] Council error:`, result);
            }
        } else {
            // For simple queries, respond directly without the full council
            await reply("For council-based responses, ask me to 'analyze', 'verify', or use the word 'council' in your message.");
        }

    } catch (error) {
        console.error('[ConsensusForge] Error handling message:', error);
        await reply(`❌ An error occurred: ${error.message}`);
    }
}

/**
 * Determine if a message should invoke the full council
 * 
 * @param {string} message - The user's message
 * @returns {boolean} - True if the council should be invoked
 */
function shouldInvokeCouncil(message) {
    const councilKeywords = [
        'council',
        'analyze',
        'verify',
        'decide',
        'evaluate',
        'review',
        'consensus',
        'compare',
        'what do you think',
        'your opinion',
        'explain',
        'should i',
        'help me decide'
    ];

    const lowerMessage = message.toLowerCase();

    // Check if any keyword is present
    return councilKeywords.some(keyword => lowerMessage.includes(keyword));
}

/**
 * Agent initialization
 */
async function initialize() {
    console.log('🏛️ ConsensusForge Agent initialized!');
    console.log('📡 Ready to receive messages via OpenClaw channels');
    console.log('💡 Tip: Use words like "analyze", "verify", or "council" to invoke the full consensus mechanism');
}

module.exports = {
    handleMessage,
    initialize,
    shouldInvokeCouncil
};

// If this file is run directly (for testing)
if (require.main === module) {
    initialize();
    console.log('\n🧪 Test mode - agent initialized but not connected to OpenClaw');
    console.log('Use OpenClaw to start the agent properly.');
}
