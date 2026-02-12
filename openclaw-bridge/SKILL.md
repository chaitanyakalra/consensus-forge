# ConsensusForge Skill

**Description**: Run multi-LLM consensus for important decisions, analyses, and verifications

**Version**: 1.0.0

**Trigger Conditions**:
- User asks to "analyze" something
- User wants to "verify" information
- User mentions "council" in their message
- User wants to "decide", "evaluate", or "review" something
- User asks "what do you think" or "your opinion"
- User needs help making a decision

## What This Skill Does

This skill invokes the ConsensusForge consensus council - a multi-stage process where:

1. **Stage 1**: Multiple AI models provide individual responses
2. **Stage 2**: Models rank and evaluate each other's responses
3. **Stage 3**: A chairman model synthesizes the best final answer

This dramatically reduces hallucinations and provides more reliable responses for important decisions.

## Usage Examples

**User**: "Analyze the current state of renewable energy in India"
**Agent**: *Invokes the council and returns consensus response*

**User**: "Council, should I invest in electric vehicle stocks?"
**Agent**: *Invokes the council for a multi-perspective analysis*

**User**: "Verify if this claim is accurate: Solar energy is cheaper than coal in 2026"
**Agent**: *Uses council to fact-check and provide evidence-based response*

## Technical Implementation

This skill is implemented via:
- Node.js bridge (`call_council.js`)
- Python CLI interface (`backend/cli.py`)
- Multi-LLM orchestration (`backend/council.py`)

## Configuration

The council uses the following models (configurable in `backend/config.py`):
- Multiple free models via OpenRouter
- Chairman model for final synthesis

## Performance

- Average response time: 15-30 seconds (3 stages with multiple models)
- Success rate: High (fallback mechanisms in place)
- Cost: Minimal (uses free-tier models via OpenRouter)

## Notes

For simple, quick questions that don't need deep analysis, the agent may respond directly without invoking the full council to save time and resources.
