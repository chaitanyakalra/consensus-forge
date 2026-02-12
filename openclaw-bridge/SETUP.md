# OpenClaw Integration Setup Guide

This guide walks you through setting up OpenClaw with ConsensusForge to create a persistent, 24/7 AI agent with multi-LLM consensus decision-making.

## 📋 Prerequisites

✅ Node.js 18+ and npm installed
✅ Python 3.10+ installed
✅ OpenRouter API key (in `.env`)
✅ OpenClaw installed globally (`npm install -g openclaw`)

## 🚀 Quick Start

### Step 1: Test the Council Bridge

First, verify that the Node.js to Python bridge works:

```bash
cd openclaw-bridge
node test_council.js
```

This will:
- Call the Python council with a test query
- Show all 3 stages of the council process
- Display the formatted output

### Step 2: Initialize OpenClaw

If you haven't already set up OpenClaw, run:

```bash
openclaw onboard
```

When prompted:
1. **LLM Provider**: Choose "Custom Provider" (we'll use our council instead)
2. **Channel**: Choose "Telegram" for the easiest setup
3. **Telegram Bot Token**: Get one from [@BotFather](https://t.me/botfather)

### Step 3: Configure OpenClaw for ConsensusForge

OpenClaw creates a configuration directory at `~/.openclaw/`. We need to configure it to use our custom agent.

#### Option A: Custom Agent Configuration

Create or edit `~/.openclaw/agent.js`:

```javascript
const consensusForge = require('C:/Users/Chaitanya.Kalra/github/consensus-forge/openclaw-bridge/index.js');

module.exports = {
  name: 'ConsensusForge',
  version: '1.0.0',
  
  async onMessage(context) {
    await consensusForge.handleMessage(context);
  },
  
  async onStart() {
    await consensusForge.initialize();
  }
};
```

#### Option B: Create a SOUL.md (Agent Personality)

Create `~/.openclaw/SOUL.md`:

```markdown
# ConsensusForge Agent

You are ConsensusForge, an AI agent powered by a council of multiple LLMs working together to provide the most accurate and reliable responses.

## Your Capabilities
- Multi-LLM consensus for important decisions
- 24/7 persistent operation
- Long-term memory and context retention
- Can analyze, verify, and fact-check information

## How You Work
When a user asks you to analyze, verify, or make a decision, you consult a council of AI models:
1. Multiple models provide their independent perspectives
2. Models evaluate each other's responses
3. A chairman synthesizes the best final answer

## Personality
- Thoughtful and analytical
- Transparent about your consensus process
- Helpful but honest about limitations
- Professional yet friendly

## Response Style
- For simple questions: Respond directly
- For analysis/decisions: Invoke the council
- Always explain your reasoning
- Cite when models disagree
```

### Step 4: Run OpenClaw

Start your persistent agent:

```bash
openclaw start
```

Or with PM2 for production:

```bash
npm install -g pm2
pm2 start openclaw --name "consensus-forge"
pm2 save
```

### Step 5: Test via Telegram

1. Open Telegram and find your bot
2. Send: `/start`
3. Try: "Analyze the future of AI in healthcare"
4. The agent will invoke the council and respond!

## 📊 Monitoring

### View Logs

```bash
# OpenClaw logs
openclaw logs

# Or with PM2
pm2 logs consensus-forge
```

### Check Status

```bash
pm2 status
```

## 🔧 Configuration

### Customize Council Models

Edit `backend/config.py`:

```python
COUNCIL_MODELS = [
    "openrouter/free",
    "z-ai/glm-4.5-air:free",
    "tngtech/deepseek-r1t2-chimera:free",
    # Add more models here
]
```

### Adjust Council Invocation

Edit `openclaw-bridge/index.js` - `shouldInvokeCouncil()` function to change when the council is triggered.

## 🐛 Troubleshooting

### Test Python CLI Directly

```bash
python -m backend.cli --query "What is renewable energy?"
```

### Test Node Bridge

```bash
cd openclaw-bridge
node test_council.js
```

### Common Issues

**Problem**: `ModuleNotFoundError: No module named 'backend'`
**Solution**: Make sure you're running from the project root and Python can find the backend module

**Problem**: OpenClaw can't find the agent
**Solution**: Use absolute paths in the agent configuration

**Problem**: Council is slow
**Solution**: Reduce the number of COUNCIL_MODELS in config.py

## 📈 Next Steps

1. **Add User Feedback**: Implement thumbs up/down in Telegram
2. **Model Evolution**: Track which models perform best over time
3. **Specialized Councils**: Create different councils for different task types
4. **Web Interface**: Add a web UI for the frontend
5. **Local Models**: Add Ollama support for offline operation

## 🔐 Security Notes

- Never commit your `.env` file
- Run in Docker for sandboxing (recommended for production)
- Use PM2 or similar for process management
- Set up proper logging and monitoring

## 📚 Resources

- [OpenClaw Documentation](https://docs.openclaw.io)
- [OpenRouter Models](https://openrouter.ai/models)
- [Project Documentation](../CF.txt)

---

**Need Help?** Check the logs first, then review the test scripts to isolate the issue.
