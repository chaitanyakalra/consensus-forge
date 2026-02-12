/**
 * Simple example of using the ConsensusForge council
 */

const { runCouncil, formatCouncilResponse } = require('./call_council');

async function main() {
    console.log('🏛️ ConsensusForge Council Example\n');

    const query = process.argv[2] || "What is the capital of France?";

    console.log(`Query: ${query}\n`);
    console.log('Consulting the council...\n');

    try {
        const result = await runCouncil(query);

        if (result.success) {
            console.log('✅ Success!\n');
            console.log('Final Answer:');
            console.log('-'.repeat(60));
            console.log(result.stage3.response);
            console.log('-'.repeat(60));

            if (result.metadata && result.metadata.aggregate_rankings) {
                console.log('\nModel Rankings:');
                result.metadata.aggregate_rankings.forEach((r, i) => {
                    console.log(`  ${i + 1}. ${r.model} (avg: ${r.average_rank})`);
                });
            }
        } else {
            console.log('❌ Error:', result.error);
        }

    } catch (error) {
        console.error('❌ Failed:', error);
    }
}

main().catch(console.error);
