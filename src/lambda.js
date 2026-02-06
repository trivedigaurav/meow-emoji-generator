const crypto = require('crypto');
const { WebClient } = require('@slack/web-api');
const { Lambda } = require('@aws-sdk/client-lambda');
const path = require('path');
const fs = require('fs');
const os = require('os');
const EmojiGenerator = require('./gemini');

// Slack client for API calls
const slackClient = new WebClient(process.env.SLACK_BOT_TOKEN);

// Lambda client for async invocation
const lambdaClient = new Lambda({});

// Initialize Gemini emoji generator
const emojiGenerator = new EmojiGenerator(process.env.GEMINI_API_KEY);

// Reference directory - bundled with Lambda
const REFERENCE_DIR = path.join(__dirname, '../examples');
// Use /tmp for Lambda (only writable directory)
const OUTPUT_DIR = path.join(os.tmpdir(), 'generated');

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
 * Verify Slack request signature
 */
function verifySlackRequest(event, rawBody) {
  const signingSecret = process.env.SLACK_SIGNING_SECRET;
  const timestamp = event.headers['x-slack-request-timestamp'];
  const signature = event.headers['x-slack-signature'];

  console.log('Verifying signature:', { timestamp, signature: signature?.substring(0, 20) + '...' });

  if (!timestamp || !signature) {
    console.log('Missing timestamp or signature');
    return false;
  }

  // Check timestamp to prevent replay attacks (5 minutes)
  const currentTime = Math.floor(Date.now() / 1000);
  if (Math.abs(currentTime - timestamp) > 300) {
    console.log('Timestamp too old:', { currentTime, timestamp, diff: Math.abs(currentTime - timestamp) });
    return false;
  }

  const sigBasestring = `v0:${timestamp}:${rawBody}`;
  const mySignature = 'v0=' + crypto
    .createHmac('sha256', signingSecret)
    .update(sigBasestring)
    .digest('hex');

  try {
    const isValid = crypto.timingSafeEqual(
      Buffer.from(mySignature),
      Buffer.from(signature)
    );
    console.log('Signature valid:', isValid);
    return isValid;
  } catch (e) {
    console.log('Signature comparison error:', e.message);
    return false;
  }
}

/**
 * Parse URL-encoded body from Slack
 */
function parseBody(body) {
  const params = new URLSearchParams(body);
  const result = {};
  for (const [key, value] of params) {
    result[key] = value;
  }
  return result;
}

/**
 * Try to parse body as JSON (for Events API)
 */
function tryParseJSON(body) {
  try {
    return JSON.parse(body);
  } catch {
    return null;
  }
}

/**
 * Main Lambda handler - dispatches immediately, processes async
 */
module.exports.handler = async (event, context) => {
  console.log('Event received:', JSON.stringify({
    ...event,
    body: event.body?.substring(0, 100) + '...'
  }));

  // Check if this is an async worker invocation
  if (event.asyncWorker) {
    console.log('Handling async worker');
    return await handleAsyncWork(event);
  }

  // Handle different event sources
  const headers = event.headers || {};

  // Normalize header keys to lowercase
  const normalizedHeaders = {};
  for (const [key, value] of Object.entries(headers)) {
    normalizedHeaders[key.toLowerCase()] = value;
  }
  event.headers = normalizedHeaders;

  // Decode body if base64 encoded
  let rawBody = event.body;
  if (event.isBase64Encoded && rawBody) {
    rawBody = Buffer.from(rawBody, 'base64').toString('utf-8');
    console.log('Decoded base64 body');
  }

  // Verify Slack signature
  if (!verifySlackRequest(event, rawBody)) {
    console.log('Signature verification failed');
    return {
      statusCode: 401,
      body: 'Invalid signature'
    };
  }

  // Check if this is a JSON payload (Events API) or URL-encoded (slash commands)
  const jsonBody = tryParseJSON(rawBody);

  // Handle Events API
  if (jsonBody) {
    console.log('JSON payload detected, type:', jsonBody.type);

    // Handle URL verification challenge
    if (jsonBody.type === 'url_verification') {
      console.log('Responding to URL verification challenge');
      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ challenge: jsonBody.challenge })
      };
    }

    // Handle event callbacks
    if (jsonBody.type === 'event_callback') {
      const slackEvent = jsonBody.event;
      console.log('Event type:', slackEvent?.type);

      // Handle app_mention events
      if (slackEvent?.type === 'app_mention') {
        // Remove the mention itself and any "emoji" prefix to get the description
        let description = slackEvent.text.replace(/<@[^>]+>/g, '').trim();
        description = description.replace(/^emoji\s*/i, '').trim();

        console.log('App mention description:', description);

        if (!description) {
          // Send help message
          await slackClient.chat.postMessage({
            channel: slackEvent.channel,
            thread_ts: slackEvent.ts,
            text: 'What kind of emoji would you like? Just describe it!\n\nExample: `@Meow Emoji Generator happy cat with sunglasses`'
          });
          return { statusCode: 200, body: 'OK' };
        }

        // Send generating message
        await slackClient.chat.postMessage({
          channel: slackEvent.channel,
          thread_ts: slackEvent.ts,
          text: `${randomFrom(generatingMessages)}\n\nGenerating: "${description}"`
        });

        // Invoke worker Lambda asynchronously
        console.log('Invoking async worker for app_mention:', description);
        await lambdaClient.invoke({
          FunctionName: context.functionName,
          InvocationType: 'Event',
          Payload: JSON.stringify({
            asyncWorker: true,
            command: 'app_mention',
            description,
            channelId: slackEvent.channel,
            threadTs: slackEvent.ts,
            userId: slackEvent.user,
            userName: slackEvent.user // Will be user ID, not username
          })
        });

        return { statusCode: 200, body: 'OK' };
      }
    }

    // Unknown JSON event
    console.log('Unknown JSON event:', jsonBody.type);
    return { statusCode: 200, body: 'OK' };
  }

  const body = parseBody(rawBody);
  const command = body.command;
  console.log('Parsed command:', command, 'text:', body.text);

  // Handle /meow command
  if (command === '/meow') {
    const description = (body.text || '').trim();

    if (!description) {
      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          response_type: 'ephemeral',
          text: 'Please provide a description for your emoji!\nUsage: `/meow happy cat with sunglasses`'
        })
      };
    }

    // Invoke worker Lambda asynchronously
    console.log('Invoking async worker for:', description);
    await lambdaClient.invoke({
      FunctionName: context.functionName,
      InvocationType: 'Event', // Async invocation
      Payload: JSON.stringify({
        asyncWorker: true,
        command: 'meow',
        description,
        channelId: body.channel_id,
        userId: body.user_id,
        userName: body.user_name,
        responseUrl: body.response_url
      })
    });

    // Return immediately to Slack
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        response_type: 'ephemeral',
        text: `${randomFrom(generatingMessages)}\n\nGenerating: "${description}"`
      })
    };
  }

  // Handle /meow-add command (just shows instructions)
  if (command === '/meow-add') {
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        response_type: 'ephemeral',
        text: `:information_source: *How to add a custom emoji to your workspace:*

1. First, generate an emoji using \`/meow [description]\`
   Example: \`/meow happy cat with sunglasses\`

2. Download the generated image from the chat

3. Go to your Slack workspace settings:
   • Click your workspace name in the top left
   • Select "Tools & settings" > "Customize Workspace"

4. Click "Add Custom Emoji"

5. Upload your image and give it a name (e.g., \`meow_cool\`)

6. Use your new emoji! :tada:`
      })
    };
  }

  // Unknown command
  console.log('Unknown command:', command);
  return {
    statusCode: 200,
    body: 'Unknown command'
  };
};

/**
 * Handle async work (emoji generation)
 */
async function handleAsyncWork(event) {
  const { command, description, channelId, userId, userName, threadTs } = event;
  console.log('Async work starting:', { command, description, channelId, userName });

  if (command === 'meow' || command === 'app_mention') {
    try {
      // Improve the user's prompt using Gemini
      console.log('Improving prompt for:', description);
      const improvedDescription = await emojiGenerator.improvePrompt(description);
      console.log('Improved description:', improvedDescription);

      console.log('Generating emoji for:', improvedDescription);
      const imageBuffer = await emojiGenerator.generateWithReferences(
        improvedDescription,
        REFERENCE_DIR
      );
      console.log('Emoji generated, size:', imageBuffer.length);

      // Generate a creative emoji name using Gemini
      const emojiName = await emojiGenerator.generateEmojiName(description);
      console.log('Generated emoji name:', emojiName);
      const fileName = `${emojiName}.png`;
      const filePath = path.join(OUTPUT_DIR, fileName);
      await fs.promises.writeFile(filePath, imageBuffer);
      console.log('File written to:', filePath);

      // Upload to Slack
      console.log('Uploading to Slack channel:', channelId);
      const uploadOptions = {
        channel_id: channelId,
        file: filePath,
        filename: fileName,
        title: emojiName,
        initial_comment: `${randomFrom(completionMessages)}\n\nHere's your emoji for "${description}"!\n:artist: Created by <@${userId}>\n\nTo add it to your workspace, download this image and use \`/meow-add\` for instructions.`
      };
      // Add thread_ts for app_mention responses to keep them in the thread
      if (threadTs) {
        uploadOptions.thread_ts = threadTs;
      }
      await slackClient.files.uploadV2(uploadOptions);
      console.log('Upload complete');

      // Clean up temp file
      fs.unlinkSync(filePath);

    } catch (error) {
      console.error('Error generating emoji:', error);

      // Send error message via chat.postEphemeral
      try {
        await slackClient.chat.postEphemeral({
          channel: channelId,
          user: userId,
          text: `:x: Failed to generate emoji: ${error.message}`
        });
      } catch (e) {
        console.error('Failed to send error message:', e);
      }
    }
  }

  return { statusCode: 200, body: 'OK' };
}
