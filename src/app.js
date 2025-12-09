require('dotenv').config();
const { App } = require('@slack/bolt');
const path = require('path');
const fs = require('fs');
const EmojiGenerator = require('./gemini');

// Initialize Slack app with Socket Mode
const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  socketMode: true,
  appToken: process.env.SLACK_APP_TOKEN
});

// Initialize Gemini emoji generator
const emojiGenerator = new EmojiGenerator(process.env.GEMINI_API_KEY);

// Reference directory for style matching (now inside project)
const REFERENCE_DIR = path.join(__dirname, '../slack_emojis');
const OUTPUT_DIR = path.join(__dirname, '../generated');

// Fun response messages for personality
const generatingMessages = [
  ":art: Summoning the meow muse...",
  ":sparkles: Brewing up some emoji magic...",
  ":cat: The cat is in the studio...",
  ":rainbow: Mixing pixels and purrs...",
  ":zap: Generating cuteness at warp speed...",
  ":crystal_ball: Consulting the emoji oracle...",
  ":rocket: Launching into creative space...",
  ":star2: Channeling pure cat energy..."
];

const completionMessages = [
  ":tada: Fresh from the emoji oven!",
  ":star2: A masterpiece is born!",
  ":heart_eyes_cat: Purrfection achieved!",
  ":art: The meow has spoken!",
  ":sparkles: Behold your creation!",
  ":fire: This one's a banger!",
  ":chef_kiss: *Chef's kiss* Magnifique!",
  ":rainbow: Pure emoji gold!"
];

const randomFrom = (arr) => arr[Math.floor(Math.random() * arr.length)];


// Ensure output directory exists
if (!fs.existsSync(OUTPUT_DIR)) {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
}

/**
 * /meow command - Generate a preview of an emoji
 */
app.command('/meow', async ({ command, ack, respond, client }) => {
  await ack();

  const description = command.text.trim();

  if (!description) {
    await respond({
      text: 'Please provide a description for your emoji!\nUsage: `/meow happy cat with sunglasses`'
    });
    return;
  }

  await respond({
    text: `${randomFrom(generatingMessages)}\n\nGenerating: "${description}"`
  });

  try {
    // Generate emoji with style references
    const imageBuffer = await emojiGenerator.generateWithReferences(
      description,
      REFERENCE_DIR
    );

    // Save to file with AI-generated name
    const emojiName = await emojiGenerator.generateEmojiName(description);
    const fileName = `${emojiName}.png`;
    const filePath = path.join(OUTPUT_DIR, fileName);
    await fs.promises.writeFile(filePath, imageBuffer);

    // Upload to Slack as a file
    await client.files.uploadV2({
      channel_id: command.channel_id,
      file: filePath,
      filename: fileName,
      title: emojiName,
      initial_comment: `${randomFrom(completionMessages)}\n\nHere's your emoji for "${description}"!\n:artist: Created by <@${command.user_id}>\n\nTo add it to your workspace, use \`/meow-add\` for instructions.`
    });

    // Clean up temp file after upload
    fs.unlinkSync(filePath);
  } catch (error) {
    console.error('Error generating emoji:', error);
    await respond({
      text: `:x: Failed to generate emoji: ${error.message}`
    });
  }
});

/**
 * /meow-add command - Show instructions for adding emojis to the workspace
 */
app.command('/meow-add', async ({ ack, respond }) => {
  await ack();

  await respond({
    text: `:information_source: *How to add a custom emoji to your workspace:*

1. First, generate an emoji using \`/meow [description]\`
   Example: \`/meow happy cat with sunglasses\`

2. Download the generated image from the chat

3. Go to your Slack workspace settings:
   • Click your workspace name in the top left
   • Select "Tools & settings" > "Customize Workspace"
   • Or visit: \`https://[your-workspace].slack.com/customize/emoji\`

4. Click "Add Custom Emoji"

5. Upload your image and give it a name (e.g., \`meow_cool\`)

6. Use your new emoji! :tada:`
  });
});

/**
 * Handle mentions with emoji requests
 * Any @mention triggers emoji generation - just describe what you want!
 */
app.event('app_mention', async ({ event, client, say }) => {
  // Remove the mention itself and any "emoji" prefix to get the description
  let description = event.text.replace(/<@[^>]+>/g, '').trim();

  // Remove optional "emoji" prefix if present (for backwards compatibility)
  description = description.replace(/^emoji\s*/i, '').trim();

  if (!description) {
    await say({
      text: 'What kind of emoji would you like? Just describe it!\n\nExample: `@Meow Emoji Generator happy cat with sunglasses`',
      thread_ts: event.ts
    });
    return;
  }

  await say({
    text: `${randomFrom(generatingMessages)}\n\nGenerating: "${description}"`,
    thread_ts: event.ts
  });

  try {
    const imageBuffer = await emojiGenerator.generateWithReferences(
      description,
      REFERENCE_DIR
    );

    const emojiName = await emojiGenerator.generateEmojiName(description);
    const fileName = `${emojiName}.png`;
    const filePath = path.join(OUTPUT_DIR, fileName);
    await fs.promises.writeFile(filePath, imageBuffer);

    await client.files.uploadV2({
      channel_id: event.channel,
      thread_ts: event.ts,
      file: filePath,
      filename: fileName,
      title: emojiName,
      initial_comment: `${randomFrom(completionMessages)}\n\nHere's your emoji for "${description}"!`
    });

    fs.unlinkSync(filePath);
  } catch (error) {
    console.error('Error generating emoji:', error);
    await say({
      text: `:x: Sorry, I couldn't generate that emoji: ${error.message}`,
      thread_ts: event.ts
    });
  }
});

// Start the app
(async () => {
  const port = process.env.PORT || 3000;
  await app.start(port);
  console.log(`⚡️ Slack Emoji Generator is running on port ${port}!`);
  console.log(`📁 Reference emojis: ${REFERENCE_DIR}`);
  console.log(`📁 Generated emojis: ${OUTPUT_DIR}`);
})();
