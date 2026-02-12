/**
 * Test script for the ConsensusForge council bridge
 * 
 * This script tests the Node.js -> Python bridge without requiring
 * a full OpenClaw setup.
 */

const { runCouncil, formatCouncilResponse } = require('./call_council');

async function testCouncil() {
    console.log('🧪 Testing ConsensusForge Council Bridge\n');
    console.log('='.repeat(60));

    // Test query
    const testQuery = "What are the benefits of renewable energy?";

    console.log(`\n📝 Query: ${testQuery}`);
    console.log('\n🏛️  Consulting the council...\n');

    try {
        const startTime = Date.now();
        const result = await runCouncil(testQuery, 'test-conversation-001');
        const duration = ((Date.now() - startTime) / 1000).toFixed(2);

        console.log(`✅ Council responded in ${duration} seconds\n`);
        console.log('='.repeat(60));

        if (result.success) {
            console.log('\n📊 RESULTS:\n');

            // Show individual model responses
            if (result.stage1 && result.stage1.length > 0) {
                console.log('Stage 1 - Individual Responses:');
                result.stage1.forEach((resp, index) => {
                    console.log(`\n  ${index + 1}. ${resp.model}:`);
                    console.log(`     ${resp.response.substring(0, 150)}...`);
                });
            }

            // Show rankings
            if (result.metadata && result.metadata.aggregate_rankings) {
                console.log('\n\nStage 2 - Aggregate Rankings:');
                result.metadata.aggregate_rankings.forEach((rank, index) => {
                    console.log(`  ${index + 1}. ${rank.model} (avg rank: ${rank.average_rank})`);
                });
            }

            // Show final synthesis
            if (result.stage3) {
                console.log('\n\nStage 3 - Final Synthesis:');
                console.log(`  Model: ${result.stage3.model}`);
                console.log(`  Response: ${result.stage3.response.substring(0, 300)}...`);
            }

            console.log('\n' + '='.repeat(60));
            console.log('\n🎨 FORMATTED OUTPUT:\n');
            console.log(formatCouncilResponse(result));

            console.log('\n✅ Test completed successfully!');

        } else {
            console.log('❌ Council returned an error:');
            console.log(JSON.stringify(result, null, 2));
        }

    } catch (error) {
        console.error('❌ Test failed with error:');
        console.error(error);
        process.exit(1);
    }
}

// Run the test
if (require.main === module) {
    testCouncil()
        .then(() => process.exit(0))
        .catch((err) => {
            console.error('Fatal error:', err);
            process.exit(1);
        });
}

module.exports = { testCouncil };
