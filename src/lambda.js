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

// Thread state lives in Slack message metadata. One thread = one emoji's editing session.
//   meow_version    - a posted emoji version; payload { v, iid, name, prompt, improved, instruction, parent_v }
//   meow_generating - placeholder while a version is being generated; acts as a per-thread lock
//   meow_pointer    - "back to vN" without an edit; later tweaks chain from that version
//   meow_failed     - a placeholder that was turned into an error message (no longer a lock)
const META = {
  VERSION: 'meow_version',
  GENERATING: 'meow_generating',
  POINTER: 'meow_pointer',
  FAILED: 'meow_failed'
};
// A placeholder older than this no longer counts as a lock (Lambda timeout is 300s).
const LOCK_TTL_MS = 5 * 60 * 1000;

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

const tweakingMessages = [
  ":scissors: Snipping and tweaking...",
  ":art: Touching up the masterpiece...",
  ":cat2: The cat is back in the studio...",
  ":mag: Fine-tuning the whiskers...",
  ":sparkles: A little meow magic..."
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
 * Remove the bot mention and an optional leading "emoji" from a message.
 */
function stripMention(text) {
  return (text || '')
    .replace(/<@[^>]+>/g, '')
    .trim()
    .replace(/^emoji\s*/i, '')
    .trim();
}

/**
 * Interpret a follow-up message inside an emoji thread.
 *
 * @returns {{mode: 'reroll'|'fresh'|'pointer'|'edit', fromVersion?: number, instruction?: string}}
 */
function parseFollowUp(text) {
  const raw = (text || '').trim();
  const lower = raw.toLowerCase().replace(/[.!?\s]+$/, '');

  if (/^(again|another( one)?|re-?roll|regenerate|retry|try again|one more( time)?|redo)$/.test(lower)) {
    return { mode: 'reroll' };
  }
  if (/^(start over|start again|reset|from scratch|fresh|restart)$/.test(lower)) {
    return { mode: 'fresh' };
  }

  // "back to v2", "back to v2, make it wink", "from v3: add a hat", "use v1 and ..."
  let m = raw.match(/^(?:go\s+)?(?:back\s+to|rewind\s+to|from|use)\s+v(\d+)\b[\s,:.\-–—]*(?:and\s+)?(.*)$/i);
  if (!m) {
    // "v2: add a hat", "v2 add a hat"
    m = raw.match(/^v(\d+)\b[\s,:.\-–—]+(.+)$/i);
  }
  if (m) {
    const fromVersion = parseInt(m[1], 10);
    const instruction = (m[2] || '').trim();
    return instruction
      ? { mode: 'edit', fromVersion, instruction }
      : { mode: 'pointer', fromVersion };
  }

  return { mode: 'edit', instruction: raw };
}

/**
 * Rebuild an emoji thread's state from message metadata.
 * Returns null when the thread has no emoji versions (not one of ours, or pre-dates metadata).
 */
async function readThreadState(channel, rootTs, client = slackClient) {
  const res = await client.conversations.replies({
    channel,
    ts: rootTs,
    include_all_metadata: true,
    limit: 200
  });

  const versions = [];
  let latest = null;
  let busy = false;

  for (const m of res.messages || []) {
    const md = m.metadata;
    if (!md || !md.event_type) continue;
    const p = md.event_payload || {};

    if (md.event_type === META.VERSION) {
      const v = {
        v: Number(p.v),
        iid: p.iid,
        name: p.name,
        prompt: p.prompt,
        improved: p.improved || p.prompt,
        instruction: p.instruction || '',
        parentVersion: Number(p.parent_v || 0),
        ts: m.ts
      };
      versions.push(v);
      latest = { v: v.v, iid: v.iid };
    } else if (md.event_type === META.POINTER) {
      latest = { v: Number(p.v), iid: p.iid };
    } else if (md.event_type === META.GENERATING) {
      const ageMs = Date.now() - Number(m.ts) * 1000;
      if (ageMs < LOCK_TTL_MS) busy = true;
    }
  }

  if (versions.length === 0) return null;
  versions.sort((a, b) => a.v - b.v);

  const first = versions[0];
  return {
    originalPrompt: first.prompt,
    improvedPrompt: first.improved,
    baseName: first.name,
    versions,
    latest,
    busy,
    // Edit instructions so far, used to rebuild a prompt when an interaction id has expired.
    tweaks: versions.filter(x => x.v > 1 && x.instruction && !x.instruction.startsWith('(')).map(x => x.instruction)
  };
}

/**
 * Prompt used when we can't chain on a previous interaction (expired id, re-roll, ...).
 */
function mergedPrompt(improvedPrompt, tweaks) {
  if (!tweaks || tweaks.length === 0) return improvedPrompt;
  return `${improvedPrompt}\n\nApply all of these changes as well: ${tweaks.map(t => `"${t}"`).join('; ')}.`;
}

/**
 * Pull the uploaded file id out of a files.uploadV2 result.
 */
function extractFileId(uploadResult) {
  const outer = uploadResult?.files?.[0];
  if (!outer) return null;
  if (outer.id) return outer.id;
  return outer.files?.[0]?.id || null;
}

/**
 * Post an emoji version to Slack and tag the message with version metadata.
 *
 * Primary path: upload the PNG privately, then post one message that embeds it via a
 * slack_file image block and carries the metadata. Fallback (if that message is rejected):
 * turn the placeholder into the caption carrying the metadata, and upload the file into the thread.
 */
async function postVersion({ channelId, threadTs, placeholderTs, fileName, title, buffer, caption, metadataPayload, client = slackClient }) {
  const filePath = path.join(OUTPUT_DIR, `${Date.now()}-${fileName}`);
  await fs.promises.writeFile(filePath, buffer);
  const metadata = { event_type: META.VERSION, event_payload: metadataPayload };

  try {
    try {
      const upload = await client.files.uploadV2({ file: filePath, filename: fileName, title });
      const fileId = extractFileId(upload);
      if (!fileId) throw new Error('files.uploadV2 returned no file id');
      console.log('Uploaded file', fileId);

      const message = {
        channel: channelId,
        text: caption,
        blocks: [
          { type: 'section', text: { type: 'mrkdwn', text: caption } },
          { type: 'image', slack_file: { id: fileId }, alt_text: title, title: { type: 'plain_text', text: title } }
        ],
        metadata,
        unfurl_links: false,
        unfurl_media: false
      };
      if (threadTs) message.thread_ts = threadTs;

      // A freshly uploaded file is not referenceable until Slack finishes processing it (typically 1-3s);
      // referencing it too early fails with invalid_blocks ("invalid slack file"). Retry briefly before giving up.
      let posted;
      const delaysMs = [0, 1000, 1500, 2000, 3000];
      for (let attempt = 0; attempt < delaysMs.length; attempt++) {
        if (delaysMs[attempt]) await new Promise(resolve => setTimeout(resolve, delaysMs[attempt]));
        try {
          posted = await client.chat.postMessage(message);
          break;
        } catch (e) {
          const notReady = e?.data?.error === 'invalid_blocks' && attempt < delaysMs.length - 1;
          if (!notReady) throw e;
          console.log(`File ${fileId} not ready yet (invalid_blocks), retrying in ${delaysMs[attempt + 1]}ms`);
        }
      }
      console.log('Posted version message', posted.ts);

      if (placeholderTs) {
        await client.chat.delete({ channel: channelId, ts: placeholderTs }).catch(e => console.warn('Could not delete placeholder:', e.message));
      }
      return { ts: posted.ts };
    } catch (primaryError) {
      console.warn('Primary post failed, falling back to file share:', primaryError?.data?.error || primaryError.message);

      let captionTs;
      if (placeholderTs) {
        await client.chat.update({ channel: channelId, ts: placeholderTs, text: caption, metadata });
        captionTs = placeholderTs;
      } else {
        const posted = await client.chat.postMessage({
          channel: channelId,
          text: caption,
          metadata,
          ...(threadTs ? { thread_ts: threadTs } : {})
        });
        captionTs = posted.ts;
      }

      await client.files.uploadV2({
        channel_id: channelId,
        thread_ts: threadTs || captionTs,
        file: filePath,
        filename: fileName,
        title
      });
      return { ts: captionTs };
    }
  } finally {
    fs.promises.unlink(filePath).catch(() => {});
  }
}

/**
 * Turn a "generating" placeholder into an error message (and release the lock), or post the error.
 */
async function reportFailure({ channelId, threadTs, placeholderTs, userId, message, client = slackClient }) {
  const text = `:x: ${message}`;
  try {
    if (placeholderTs) {
      await client.chat.update({
        channel: channelId,
        ts: placeholderTs,
        text,
        metadata: { event_type: META.FAILED, event_payload: { at: Date.now() } }
      });
    } else if (threadTs) {
      await client.chat.postMessage({ channel: channelId, thread_ts: threadTs, text });
    } else {
      await client.chat.postEphemeral({ channel: channelId, user: userId, text });
    }
  } catch (e) {
    console.error('Failed to send error message:', e);
  }
}

/**
 * Post a placeholder message that doubles as the per-thread lock.
 */
async function postPlaceholder({ channelId, threadTs, text, version }) {
  const posted = await slackClient.chat.postMessage({
    channel: channelId,
    thread_ts: threadTs,
    text,
    metadata: { event_type: META.GENERATING, event_payload: { v: version, at: Date.now() } }
  });
  return posted.ts;
}

async function invokeWorker(context, payload) {
  await lambdaClient.invoke({
    FunctionName: context.functionName,
    InvocationType: 'Event',
    Payload: JSON.stringify({ asyncWorker: true, ...payload })
  });
}

/**
 * Handle an @mention: either a fresh emoji, or a tweak inside an existing emoji thread.
 */
async function handleAppMention(slackEvent, context) {
  const channelId = slackEvent.channel;
  const userId = slackEvent.user;
  const text = stripMention(slackEvent.text);
  const rootTs = slackEvent.thread_ts || slackEvent.ts;
  const isThreadReply = Boolean(slackEvent.thread_ts) && slackEvent.thread_ts !== slackEvent.ts;

  console.log('App mention:', { text, rootTs, isThreadReply });

  if (!text) {
    await slackClient.chat.postMessage({
      channel: channelId,
      thread_ts: rootTs,
      text: 'What kind of emoji would you like? Just describe it!\n\nExample: `@Meow Emoji Generator happy cat with sunglasses`\n\nInside an emoji thread, describe a tweak instead: `@Meow Emoji Generator add sunglasses`'
    });
    return;
  }

  let state = null;
  if (isThreadReply) {
    try {
      state = await readThreadState(channelId, rootTs);
    } catch (e) {
      // Most likely a missing history scope. Degrade to a fresh generation in the thread.
      console.error('Could not read thread state:', e?.data?.error || e.message);
    }
  }

  if (!state) {
    const placeholderTs = await postPlaceholder({
      channelId,
      threadTs: rootTs,
      text: `${randomFrom(generatingMessages)}\n\nGenerating: "${text}"`,
      version: 1
    });
    await invokeWorker(context, {
      command: 'generate',
      description: text,
      channelId,
      threadTs: rootTs,
      placeholderTs,
      userId
    });
    return;
  }

  // ---- Follow-up inside an emoji thread ----
  if (state.busy) {
    await slackClient.chat.postEphemeral({
      channel: channelId,
      user: userId,
      thread_ts: rootTs,
      text: ':hourglass_flowing_sand: One tweak at a time! Still working on the last one. Try again in a few seconds.'
    });
    return;
  }

  const cmd = parseFollowUp(text);
  console.log('Follow-up command:', cmd);

  let parent = state.latest;
  if (cmd.fromVersion !== undefined) {
    const target = state.versions.find(v => v.v === cmd.fromVersion);
    if (!target) {
      await slackClient.chat.postEphemeral({
        channel: channelId,
        user: userId,
        thread_ts: rootTs,
        text: `:thinking_face: There's no v${cmd.fromVersion} in this thread. Versions so far: ${state.versions.map(v => `v${v.v}`).join(', ')}.`
      });
      return;
    }
    parent = { v: target.v, iid: target.iid };
  }

  if (cmd.mode === 'pointer') {
    await slackClient.chat.postMessage({
      channel: channelId,
      thread_ts: rootTs,
      text: `:rewind: OK, back to *v${parent.v}*. The next tweak builds on it.`,
      metadata: { event_type: META.POINTER, event_payload: { v: parent.v, iid: parent.iid } }
    });
    return;
  }

  const nextVersion = state.versions[state.versions.length - 1].v + 1;
  const label = cmd.mode === 'edit'
    ? `v${parent.v} → v${nextVersion}: "${cmd.instruction}"`
    : cmd.mode === 'reroll'
      ? `re-rolling as v${nextVersion}`
      : `starting over as v${nextVersion}`;

  const placeholderTs = await postPlaceholder({
    channelId,
    threadTs: rootTs,
    text: `${randomFrom(tweakingMessages)}\n\n${label}`,
    version: nextVersion
  });

  await invokeWorker(context, {
    command: 'tweak',
    mode: cmd.mode,
    instruction: cmd.instruction || '',
    parentIid: parent.iid,
    parentVersion: parent.v,
    version: nextVersion,
    baseName: state.baseName,
    originalPrompt: state.originalPrompt,
    improvedPrompt: state.improvedPrompt,
    tweaks: state.tweaks,
    channelId,
    threadTs: rootTs,
    placeholderTs,
    userId
  });
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

  // Slack retries when we don't ack within 3s (cold start + self-invoke can exceed it).
  // The first delivery is already being processed, so acknowledge retries without acting.
  if (normalizedHeaders['x-slack-retry-num']) {
    console.log('Ignoring Slack retry', normalizedHeaders['x-slack-retry-num'], normalizedHeaders['x-slack-retry-reason']);
    return { statusCode: 200, headers: { 'X-Slack-No-Retry': '1' }, body: 'OK' };
  }

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

      if (slackEvent?.type === 'app_mention') {
        try {
          await handleAppMention(slackEvent, context);
        } catch (e) {
          console.error('Error handling app_mention:', e);
        }
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
    await invokeWorker(context, {
      command: 'generate',
      description,
      channelId: body.channel_id,
      userId: body.user_id,
      userName: body.user_name,
      responseUrl: body.response_url
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
 * Fresh generation (from /meow or a top-level @mention).
 */
async function runGenerate(event) {
  const { description, channelId, userId, threadTs, placeholderTs } = event;

  try {
    console.log('Improving prompt for:', description);
    const improvedDescription = await emojiGenerator.improvePrompt(description);

    console.log('Generating emoji for:', improvedDescription);
    const { processed, interactionId } = await emojiGenerator.generate({
      description: improvedDescription,
      referenceDir: REFERENCE_DIR
    });
    console.log('Emoji generated, size:', processed.length, 'interaction:', interactionId);

    const emojiName = await emojiGenerator.generateEmojiName(description);
    console.log('Generated emoji name:', emojiName);

    await postVersion({
      channelId,
      threadTs,
      placeholderTs,
      fileName: `${emojiName}.png`,
      title: emojiName,
      buffer: processed,
      caption: `:artist: Created by <@${userId}>`,
      metadataPayload: {
        v: 1,
        iid: interactionId,
        name: emojiName,
        prompt: description,
        improved: improvedDescription,
        instruction: '',
        parent_v: 0
      }
    });
    console.log('Version 1 posted');
  } catch (error) {
    console.error('Error generating emoji:', error);
    await reportFailure({ channelId, threadTs, placeholderTs, userId, message: `Failed to generate emoji: ${error.message}` });
  }
}

/**
 * Follow-up inside an emoji thread: edit, re-roll, or start over.
 */
async function runTweak(event) {
  const {
    mode, instruction, parentIid, parentVersion, version,
    baseName, originalPrompt, improvedPrompt, tweaks = [],
    channelId, threadTs, placeholderTs, userId
  } = event;

  try {
    let result;
    let note = '';
    let recordedInstruction;

    if (mode === 'edit') {
      recordedInstruction = instruction;
      try {
        result = await emojiGenerator.generate({ previousInteractionId: parentIid, instruction });
      } catch (e) {
        if (e.code !== 'PREVIOUS_INTERACTION_UNAVAILABLE') throw e;
        console.warn('Previous interaction unavailable, regenerating from prompt:', e.message);
        result = await emojiGenerator.generate({
          description: mergedPrompt(improvedPrompt, [...tweaks, instruction]),
          referenceDir: REFERENCE_DIR
        });
        note = `\n_(v${parentVersion} had expired upstream, so this was rebuilt from the prompt.)_`;
      }
    } else if (mode === 'reroll') {
      recordedInstruction = '(re-roll)';
      result = await emojiGenerator.generate({
        description: mergedPrompt(improvedPrompt, tweaks),
        referenceDir: REFERENCE_DIR
      });
    } else if (mode === 'fresh') {
      recordedInstruction = '(start over)';
      result = await emojiGenerator.generate({
        description: improvedPrompt,
        referenceDir: REFERENCE_DIR
      });
    } else {
      throw new Error(`Unknown tweak mode: ${mode}`);
    }

    const name = `${baseName}-v${version}`;
    const what = mode === 'edit' ? `"${instruction}"` : mode === 'reroll' ? 're-roll' : 'start over';
    const from = mode === 'edit' ? ` (from v${parentVersion})` : '';

    await postVersion({
      channelId,
      threadTs,
      placeholderTs,
      fileName: `${name}.png`,
      title: name,
      buffer: result.processed,
      caption: `*v${version}*${from} · ${what} · <@${userId}>${note}`,
      metadataPayload: {
        v: version,
        iid: result.interactionId,
        name: baseName,
        prompt: originalPrompt,
        improved: improvedPrompt,
        instruction: recordedInstruction,
        parent_v: mode === 'edit' ? parentVersion : 0
      }
    });
    console.log(`Version ${version} posted`);
  } catch (error) {
    console.error('Error tweaking emoji:', error);
    await reportFailure({ channelId, threadTs, placeholderTs, userId, message: `Failed to tweak emoji: ${error.message}` });
  }
}

/**
 * Handle async work (emoji generation)
 */
async function handleAsyncWork(event) {
  const { command } = event;
  console.log('Async work starting:', {
    command,
    description: event.description,
    instruction: event.instruction,
    channelId: event.channelId,
    userName: event.userName || event.userId
  });

  // 'meow' / 'app_mention' are the pre-tweak payload names; keep accepting them.
  if (command === 'generate' || command === 'meow' || command === 'app_mention') {
    await runGenerate(event);
  } else if (command === 'tweak') {
    await runTweak(event);
  } else {
    console.warn('Unknown async command:', command);
  }

  return { statusCode: 200, body: 'OK' };
}

// Exposed for tests
module.exports._internal = { parseFollowUp, readThreadState, stripMention, mergedPrompt, extractFileId, META };
