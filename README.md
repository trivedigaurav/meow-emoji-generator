# Meow Emoji Generator

Generate custom Slack emojis in the "meow" cat style using Google's Gemini Nano Banana image generation model.

## Features

- Generate emojis via Slack slash commands (`/meow`, `/meow-add`)
- Generate emojis via CLI for batch processing
- Style-matched generation using reference emojis
- Automatic resizing to Slack-compatible 128x128 PNG
- **Deploy to AWS Lambda** for serverless operation

## Prerequisites

- Node.js 18+
- Google Gemini API key ([Get one here](https://aistudio.google.com/apikey))
- Slack workspace with permission to install apps
- (For Lambda) AWS CLI and SAM CLI installed

## Installation

```bash
cd slack-emoji-generator
npm install
```

## Configuration

1. Copy the environment template:
```bash
cp .env.example .env
```

2. Edit `.env` with your credentials:
```
SLACK_BOT_TOKEN=xoxb-your-bot-token
SLACK_SIGNING_SECRET=your-signing-secret
SLACK_APP_TOKEN=xapp-your-app-token
GEMINI_API_KEY=your-gemini-api-key
```

## Slack App Setup

1. Go to [api.slack.com/apps](https://api.slack.com/apps) and click "Create New App"
2. Choose "From an app manifest"
3. Select your workspace
4. Copy the contents of `manifest.json` and paste it
5. Install the app to your workspace
   - Bot scopes required: `commands`, `chat:write`, `files:write`, `app_mentions:read`, `channels:history`, `groups:history` (the history scopes let the bot read an emoji thread's versions when you ask for a tweak)
   - Event subscription: `app_mention`
   - Invite the bot to the channels where it should work (`/invite @Meow Emoji Generator`)
6. Copy the tokens:
   - **Bot Token**: OAuth & Permissions > Bot User OAuth Token
   - **Signing Secret**: Basic Information > Signing Secret
   - **App Token**: Basic Information > App-Level Tokens (create one with `connections:write` scope)

## Usage

### Slack Commands

**Generate an emoji:**
```
/meow happy cat with sunglasses
```

**Mention the bot (replies in a thread):**
```
@Meow Emoji Generator cat eating pizza
```

**Tweak it in the thread.** Every generated emoji starts a thread that acts as its editing session. Reply in that thread with `@Meow Emoji Generator` plus what to change, and the bot edits the previous version in place (same cat, same pose) and posts it as `v2`, `v3`, ...

```
@Meow Emoji Generator add sunglasses
@Meow Emoji Generator make it wink
@Meow Emoji Generator again              # re-roll the current version
@Meow Emoji Generator back to v2         # later tweaks build on v2
@Meow Emoji Generator back to v2, add a scarf
@Meow Emoji Generator start over         # regenerate from the original prompt
```

Anyone in the thread can tweak. One tweak runs at a time per thread. A different *concept* ("dog on a skateboard") should be a new `/meow`, not a tweak.

Edits chain on the Gemini Interactions API (`previous_interaction_id`), so nothing is stored outside Slack: each version message carries its interaction id in Slack message metadata. Interactions expire after 55 days on a paid Gemini tier (1 day on the free tier); after that a tweak is rebuilt from the prompt history instead of edited in place.

**How to add the result to the workspace:**
```
/meow-add
```

### CLI Usage

**Generate with auto-name:**
```bash
node src/cli.js "happy cat with sunglasses"
```

**Generate with specific name:**
```bash
node src/cli.js meow_cool "happy cat with sunglasses"
```

**List generated emojis:**
```bash
node src/cli.js --list
```

### Start the Slack Bot

```bash
# Production
npm start

# Development (with auto-reload)
npm run dev
```

## Reference Emojis

The generator uses existing "meow" style emojis as references to guide the AI's output. A small set of core examples is included in `examples/` and works out of the box.

For better results, add more meow-style `.png` emojis to the `examples/` directory.

## Project Structure

```
slack-emoji-generator/
├── src/
│   ├── app.js          # Slack bot application
│   ├── gemini.js       # Gemini API wrapper for emoji generation
│   ├── lambda.js       # AWS Lambda handler
│   └── cli.js          # Command-line interface
├── examples/           # Reference emoji collection for style matching
├── generated/          # Output directory for generated emojis
├── manifest.json       # Slack app manifest
├── package.json
└── .env.example
```

## How It Works

1. The generator uses existing "meow" style emojis as reference images
2. Sends a prompt to Gemini Nano Banana with style instructions
3. The AI generates a new emoji matching the reference style
4. Image is processed to 128x128 PNG for Slack compatibility
5. Result is uploaded to Slack or saved locally

## Emoji Style

Generated emojis follow the "meow" style:
- Yellow/golden cat character
- Simple, cartoon-like design
- Black outlines and whiskers
- Expressive eyes and facial features
- Flat design, no 3D effects
- Cute, friendly aesthetic

## Troubleshooting

**"Admin emoji API not available"**
- The automatic emoji upload requires Enterprise Grid or admin privileges
- The bot will instead share the image with manual upload instructions

**"No image returned from Gemini"**
- Check your GEMINI_API_KEY is valid
- Ensure you have quota available
- Try a simpler description

**Rate limiting**
- Gemini has usage limits; space out requests if generating many emojis

## AWS Lambda Deployment

### Prerequisites

1. Install [AWS CLI](https://aws.amazon.com/cli/)
2. Install [AWS SAM CLI](https://docs.aws.amazon.com/serverless-application-model/latest/developerguide/install-sam-cli.html)
3. Configure AWS credentials: `aws configure`

### Deploy to Lambda

1. **Build and deploy:**
```bash
sam build
sam deploy --guided
```

2. **When prompted, enter:**
   - Stack Name: `meow-emoji-generator`
   - AWS Region: your preferred region
   - SlackBotToken: your `xoxb-...` token
   - SlackSigningSecret: your signing secret
   - GeminiApiKey: your Gemini API key

3. **After deployment, copy the API endpoint URL** from the outputs

4. **Update your Slack app:**
   - Go to [api.slack.com/apps](https://api.slack.com/apps)
   - Select your app
   - Go to **Slash Commands**
   - Update the Request URL to your Lambda endpoint: `https://your-api-id.execute-api.region.amazonaws.com/Prod/slack/events`
   - Do this for both `/meow` and `/meow-add` commands

5. **Disable Socket Mode** (since we're using HTTP now):
   - Go to **Socket Mode** in your app settings
   - Toggle it OFF

### Lambda Notes

- The Lambda function uses `/tmp` for temporary file storage
- Reference emojis are bundled with the deployment
- Timeout is set to 60 seconds (image generation can take time)
- Memory is set to 512MB (adjust if needed)

### Update Manifest for HTTP Mode

When using Lambda (HTTP mode instead of Socket Mode), update your Slack app:

1. Go to **Interactivity & Shortcuts**
2. Set Request URL to your Lambda endpoint
3. Go to **Slash Commands** and update both command URLs

## License

MIT