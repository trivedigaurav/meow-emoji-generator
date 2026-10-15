const { GoogleGenAI } = require('@google/genai');
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

// Image generation + editing. Nano Banana 2.1 via the Interactions API so that
// follow-up edits can chain on a server-side interaction id instead of us
// storing images anywhere.
const DEFAULT_IMAGE_MODEL = 'gemini-nano-banana-2.1';
// Cheap text model for prompt improvement and naming.
// NOTE: gemini-2.0-flash was shut down on 2026-06-01.
const DEFAULT_TEXT_MODEL = 'gemini-3.5-flash-lite';

// Hand-made meow emojis that define the style. Always sent as references.
const CORE_REFERENCE_FILES = [
  'meow_happy.png',
  'meow_hearteyes.png',
  'meow_adorable.png',
  'meow_thx.png',
  'meow_huggies.png',
  'meow_thumbsup.png'
];
// Extra random references on top of the core set. Each input image costs
// ~1,120 tokens on Nano Banana 2.1 regardless of pixel size, so keep this small.
const RANDOM_REFERENCE_COUNT = 2;

const RETRIABLE_STATUSES = new Set([429, 500, 502, 503, 504]);
const MAX_ATTEMPTS = 3;

class PreviousInteractionUnavailableError extends Error {
  constructor(cause) {
    super(`Previous interaction unavailable: ${cause?.message || cause}`);
    this.name = 'PreviousInteractionUnavailableError';
    this.code = 'PREVIOUS_INTERACTION_UNAVAILABLE';
    this.cause = cause;
  }
}

class EmojiGenerator {
  constructor(apiKey, { imageModel = DEFAULT_IMAGE_MODEL, textModel = DEFAULT_TEXT_MODEL } = {}) {
    this.client = new GoogleGenAI({ apiKey });
    this.model = imageModel;
    this.textModel = textModel;

    // Style prompt based on the meow emoji collection
    // Context: These emojis are for Health Universe (healthuniverse.com) - a healthcare AI company
    // that builds AI-powered clinical workflow automation tools for hospitals and clinics.
    // Their platform "Navigator" helps clinicians with patient care through AI assistance.
    // Key themes: healthcare, AI, clinical workflows, patient care, medical technology, teamwork
    //
    // The model outputs JPEG (no alpha channel), so we ask for a flat pure-white
    // background and knock it out in processForEmoji. Asking for "transparent"
    // tends to produce fake checkerboards, which the flood fill can't remove.
    this.stylePrompt = `Create a cute cat emoji in the "meow" style with these characteristics:
- Yellow/golden colored cat face or full body
- Simple, cartoon-like design suitable for a small emoji (128x128 pixels)
- THICK, BOLD black outlines around the entire cat and all elements (minimum 3-4px stroke weight) — this is critical for readability at small sizes
- Black whiskers with the same thick stroke
- Expressive eyes and facial features
- Flat design, no 3D effects, no shadows, no gradients
- PLAIN SOLID PURE WHITE BACKGROUND (#FFFFFF) with nothing else on it — no checkerboard, no border, no drop shadow
- Cute, friendly, and playful aesthetic
- Similar to Slack/Discord custom emojis
- The cat should be the only element, centered, with a little white margin around it

Context: These emojis are for Health Universe, a healthcare AI company. When relevant, the emojis may incorporate:
- Healthcare themes (stethoscopes, medical charts, hospital settings, patient care)
- Technology/AI themes (coding, robots, data, automation)
- Clinical workflow concepts (teamwork, efficiency, helping others)
- Wellness and health-positive imagery
However, only include these themes when they fit naturally with the requested emoji concept.`;
  }

  /**
   * Improve/enhance a user's emoji prompt using Gemini
   * @param {string} userPrompt - The original user prompt
   * @returns {Promise<string>} - Improved prompt for better emoji generation
   */
  async improvePrompt(userPrompt) {
    try {
      const response = await this.client.models.generateContent({
        model: this.textModel,
        contents: [{
          parts: [{
            text: `You are an expert at improving prompts for generating cute cat emojis.

Given this user's emoji description: "${userPrompt}"

Enhance it into a detailed, clear prompt that will generate a better emoji. Consider:
- Add specific visual details (expressions, poses, props, accessories)
- Clarify vague concepts into concrete visual elements
- Add emotion/mood descriptors
- Keep it concise but descriptive (2-3 sentences max)
- Maintain the original intent/concept from the user
- Focus on elements that work well at small emoji sizes (128x128)
- If the user mentions healthcare/medical/clinical themes, incorporate them naturally

Examples:
- "happy cat" → "A cheerful yellow cat with a big open-mouth smile, sparkling eyes, and raised paws in celebration"
- "working" → "A focused yellow cat wearing tiny glasses, typing on a laptop with a determined expression"
- "doctor cat" → "A yellow cat wearing a small white doctor's coat and stethoscope, looking caring and professional"

Return ONLY the improved prompt, nothing else. Do not include any explanations or meta-commentary.`
          }]
        }]
      });

      const improvedPrompt = response.text.trim();
      console.log('Improved prompt:', userPrompt, '->', improvedPrompt);
      return improvedPrompt;
    } catch (error) {
      console.error('Error improving prompt:', error);
      // Fallback to original prompt if enhancement fails
      return userPrompt;
    }
  }

  /**
   * Decide whether a thread follow-up wants to edit the current emoji or start a new one.
   * @param {{ text: string, currentDescription: string }} args
   * @returns {Promise<'edit'|'new'|null>} null when the model gave no usable answer
   */
  async classifyFollowUp({ text, currentDescription }) {
    try {
      const response = await this.client.models.generateContent({
        model: this.textModel,
        config: { temperature: 0, responseMimeType: 'application/json' },
        contents: [{
          parts: [{
            text: `You are routing a message in a Slack thread about a custom cat emoji.

The emoji currently in the thread: "${currentDescription}"

Decide what the user wants:
- EDIT: a change to the current emoji. The message only makes sense relative to it: a fragment that adds, removes or alters one detail ("add a scarf", "remove the hat", "bigger smile", "green instead of yellow", "make it cry", "same but sleeping"), or that refers to it ("it", "the hat", "the current one").
- NEW: a self-contained description that would be a complete emoji request on its own, with no prior context ("cat on a bike", "angry cat", "a rocket", "cat eating pizza"). Every emoji here is a cat, so mentioning a cat does NOT make it an edit. A full description is NEW even if it shares a detail with the current emoji.

Test: would the message be a complete request by itself? If yes, NEW. If it only works as a change to the current emoji, EDIT.
A short noun phrase that names an emoji ("tired cat", "cat with a crown", "a taco") is NEW even when it only changes the mood; it would be EDIT only if phrased as a change ("make it tired", "tired instead", "now with a crown").

The user just wrote: "${text}"

Reply with JSON: {"standalone_request": true|false, "verdict": "EDIT"|"NEW"}`
          }]
        }]
      });

      const answer = (response.text || '').trim();
      console.log('Follow-up classification:', JSON.stringify(text), '->', answer);
      let verdict = '';
      try {
        verdict = String(JSON.parse(answer.replace(/^```(?:json)?|```$/g, '').trim()).verdict || '');
      } catch {
        verdict = answer; // not JSON; fall through to the word check
      }
      // The one-word answer was flaky in testing; asking for the intermediate "standalone_request"
      // judgement first made it consistent.
      if (/\bEDIT\b/i.test(verdict) && !/\bNEW\b/i.test(verdict)) return 'edit';
      if (/\bNEW\b/i.test(verdict) && !/\bEDIT\b/i.test(verdict)) return 'new';
      return null;
    } catch (error) {
      console.error('Error classifying follow-up:', error);
      return null;
    }
  }

  /**
   * Generate a Slack-friendly emoji name using Gemini
   * @param {string} description - The emoji description
   * @returns {Promise<string>} - Emoji name in format "meow-keyword1-keyword2"
   */
  async generateEmojiName(description) {
    try {
      const response = await this.client.models.generateContent({
        model: this.textModel,
        contents: [{
          parts: [{
            text: `Generate a short, catchy Slack emoji name for a cat emoji described as: "${description}"

Rules:
- Format: meow-keyword1-keyword2 (use hyphens, not underscores)
- Use 1-3 keywords maximum after "meow-"
- Keep total length under 25 characters
- Use only lowercase letters, numbers, and hyphens
- Make it memorable and fun
- No spaces or special characters

Examples:
- "happy cat with sunglasses" → meow-cool
- "cat celebrating with confetti" → meow-party
- "sleepy cat" → meow-zzz
- "cat drinking coffee" → meow-caffeine
- "cat coding on laptop" → meow-dev
- "cat with heart eyes" → meow-love

Return ONLY the emoji name, nothing else.`
          }]
        }]
      });

      let name = response.text.trim();

      // Clean up the response - ensure it starts with meow- and is properly formatted
      name = name.toLowerCase().replace(/[^a-z0-9-]/g, '');
      if (!name.startsWith('meow-')) {
        name = 'meow-' + name.replace(/^meow-?/, '');
      }

      // Limit length
      if (name.length > 25) {
        name = name.substring(0, 25);
      }

      return name;
    } catch (error) {
      console.error('Error generating emoji name:', error);
      // Fallback to simple name generation
      const fallback = 'meow-' + description
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, '')
        .trim()
        .split(/\s+/)
        .slice(0, 2)
        .join('-')
        .substring(0, 20);
      return fallback;
    }
  }

  /**
   * Load style reference images as Interactions API image inputs.
   * Core references always; a few random extras when available.
   * @param {string} referenceDir
   * @returns {Array<{type: 'image', mime_type: string, data: string}>}
   */
  loadStyleReferences(referenceDir) {
    if (!referenceDir || !fs.existsSync(referenceDir)) return [];

    const allPngs = fs.readdirSync(referenceDir).filter(f => f.startsWith('meow') && f.endsWith('.png'));
    if (allPngs.length === 0) return [];

    const core = CORE_REFERENCE_FILES.filter(f => allPngs.includes(f));
    const missingCore = CORE_REFERENCE_FILES.filter(f => !allPngs.includes(f));
    if (missingCore.length) {
      console.warn('Missing core reference files:', missingCore.join(', '));
    }

    const extras = allPngs
      .filter(f => !CORE_REFERENCE_FILES.includes(f))
      .sort(() => Math.random() - 0.5)
      .slice(0, RANDOM_REFERENCE_COUNT);

    return [...core, ...extras].map(file => ({
      type: 'image',
      mime_type: 'image/png',
      data: fs.readFileSync(path.join(referenceDir, file)).toString('base64')
    }));
  }

  buildGenerationPrompt(description, { hasReferences, hasPerson }) {
    const personPrompt = hasPerson ? `
I've also included a photo of a real person. Make the cat emoji RESEMBLE this person by incorporating their distinctive features:
- Match their hairstyle/hair color on the cat
- If they have facial hair (beard, mustache), give the cat similar facial hair
- Match their clothing/outfit style (e.g., blazer, shirt color)
- Capture their expression/vibe (e.g., confident, friendly)
- The cat should be clearly recognizable as a cat-version of this person
- Keep it as a cute cat emoji - don't make it too realistic
` : '';

    const referencePrompt = hasReferences ? `
I've included reference images showing the exact style to match. Create a new emoji in this EXACT same style.

IMPORTANT: Match the reference images' style exactly:
- Same yellow/golden cat color
- Same THICK, BOLD black outlines (3-4px minimum stroke weight) — match exactly how heavy the lines are in the references
- Same level of detail and simplicity
- Same cute aesthetic
` : '';

    return `${this.stylePrompt}
${referencePrompt}${personPrompt}
The new emoji should show: ${description}

Requirements:
- Output a single emoji-sized image, square aspect ratio (1:1)
- Make it instantly recognizable at small sizes
- Keep the meow cat as the main character
- PLAIN SOLID WHITE BACKGROUND, nothing else behind the cat`;
  }

  buildEditPrompt(instruction) {
    return `Edit the emoji from the previous turn. Apply ONLY this change: "${instruction}"

Keep everything the change doesn't mention EXACTLY the same: same cat, same pose, same expression, same colors, same proportions, same thick black outlines, same whiskers, same plain solid white background. Do not restyle or redraw the rest of the emoji. Output a single square image.`;
  }

  /**
   * Generate a new emoji, or edit a previous one by chaining on its interaction id.
   *
   * @param {object} opts
   * @param {string} [opts.description]            - What to draw (fresh generation)
   * @param {string} [opts.referenceDir]            - Directory of meow style references
   * @param {string} [opts.personRefPath]           - Optional photo to base the cat on
   * @param {string} [opts.previousInteractionId]   - Chain an edit on this interaction
   * @param {string} [opts.instruction]             - The edit to apply (with previousInteractionId)
   * @returns {Promise<{raw: Buffer, mimeType: string, interactionId: string, processed: Buffer}>}
   */
  async generate({ description, referenceDir, personRefPath = null, previousInteractionId = null, instruction = null } = {}) {
    const isEdit = Boolean(previousInteractionId);
    if (isEdit && !instruction) throw new Error('instruction is required when editing');
    if (!isEdit && !description) throw new Error('description is required');

    const request = {
      model: this.model,
      response_format: { type: 'image', aspect_ratio: '1:1', image_size: '1K' }
    };

    if (isEdit) {
      request.input = [{ type: 'text', text: this.buildEditPrompt(instruction) }];
      request.previous_interaction_id = previousInteractionId;
      // Edits are tightly constrained; minimal thinking is faster and drifts less.
      request.generation_config = { thinking_level: 'minimal' };
    } else {
      const references = this.loadStyleReferences(referenceDir);
      const input = [{
        type: 'text',
        text: this.buildGenerationPrompt(description, { hasReferences: references.length > 0, hasPerson: Boolean(personRefPath) })
      }];
      if (personRefPath) {
        const ext = path.extname(personRefPath).toLowerCase();
        input.push({
          type: 'image',
          mime_type: ext === '.png' ? 'image/png' : 'image/jpeg',
          data: fs.readFileSync(personRefPath).toString('base64')
        });
      }
      input.push(...references);
      request.input = input;
      console.log(`Generating with ${references.length} style reference(s)${personRefPath ? ' + person photo' : ''}`);
    }

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        const interaction = await this.client.interactions.create(request);
        const image = interaction.output_image;
        if (!image || !image.data) {
          throw new Error(`No image returned from Gemini (status: ${interaction.status})`);
        }
        const raw = Buffer.from(image.data, 'base64');
        const processed = await this.processForEmoji(raw);
        console.log('Gemini interaction', interaction.id, 'status', interaction.status, 'thought tokens', interaction.usage?.total_thought_tokens);
        return { raw, mimeType: image.mime_type, interactionId: interaction.id, processed };
      } catch (error) {
        const status = error?.status;

        // Expired or unknown previous interaction: let the caller fall back to a fresh generation.
        // Verified: a well-formed id that no longer exists returns 404 "Requested entity was not found";
        // a malformed id returns 400 "Invalid JSON payload".
        if (isEdit && (status === 404 || (status === 400 && /interaction|invalid json payload/i.test(error?.message || '')))) {
          throw new PreviousInteractionUnavailableError(error);
        }

        const isLastAttempt = attempt === MAX_ATTEMPTS;
        if (RETRIABLE_STATUSES.has(status) && !isLastAttempt) {
          const backoffMs = 1000 * Math.pow(2, attempt - 1);
          console.warn(`Gemini generation failed (status ${status}), retrying in ${backoffMs}ms (attempt ${attempt}/${MAX_ATTEMPTS})`);
          await new Promise(resolve => setTimeout(resolve, backoffMs));
          continue;
        }

        console.error('Gemini generation error:', error);
        throw error;
      }
    }
  }

  /**
   * Back-compat wrapper: generate with style references, return the processed 128x128 PNG.
   * @param {string} description
   * @param {string} referenceDir
   * @param {string} [personRefPath]
   * @returns {Promise<Buffer>}
   */
  async generateWithReferences(description, referenceDir, personRefPath = null) {
    const { processed } = await this.generate({ description, referenceDir, personRefPath });
    return processed;
  }

  /**
   * Process image to be Slack emoji compatible with transparent background
   * @param {Buffer} imageBuffer - Raw image buffer (PNG or JPEG)
   * @returns {Promise<Buffer>} - Processed PNG buffer with transparency
   */
  async processForEmoji(imageBuffer) {
    const image = sharp(imageBuffer);
    const { data, info } = await image
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });

    const { width, height } = info;
    const bgColor = this.detectBackgroundColor(data, width, height);

    if (bgColor) {
      const tolerance = 40;
      const visited = new Uint8Array(width * height);

      const matchesBg = (idx) => (
        data[idx + 3] > 20 && // skip already-transparent pixels
        Math.abs(data[idx] - bgColor.r) <= tolerance &&
        Math.abs(data[idx + 1] - bgColor.g) <= tolerance &&
        Math.abs(data[idx + 2] - bgColor.b) <= tolerance
      );

      // Seed flood-fill from ALL border pixels that match background
      const queue = [];
      const seed = (pi) => {
        if (!visited[pi] && matchesBg(pi * 4)) {
          visited[pi] = 1;
          queue.push(pi);
        }
      };
      for (let x = 0; x < width; x++) {
        seed(0 * width + x);
        seed((height - 1) * width + x);
      }
      for (let y = 1; y < height - 1; y++) {
        seed(y * width + 0);
        seed(y * width + (width - 1));
      }

      // BFS flood-fill — only spreads through adjacent background-colored pixels
      let head = 0;
      while (head < queue.length) {
        const pi = queue[head++];
        data[pi * 4 + 3] = 0;

        const px = pi % width;
        const py = Math.floor(pi / width);
        for (const [dx, dy] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
          const nx = px + dx;
          const ny = py + dy;
          if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue;
          const ni = ny * width + nx;
          if (!visited[ni] && matchesBg(ni * 4)) {
            visited[ni] = 1;
            queue.push(ni);
          }
        }
      }
    }

    return sharp(data, { raw: { width, height, channels: 4 } })
      .trim()
      .resize(128, 128, {
        fit: 'contain',
        background: { r: 0, g: 0, b: 0, alpha: 0 }
      })
      .png()
      .toBuffer();
  }

  /**
   * Detect background color by sampling the full image border.
   * Returns median color of opaque border pixels, or null if the border
   * is already transparent or too non-uniform to be a solid background.
   */
  detectBackgroundColor(data, width, height) {
    const getPixel = (x, y) => {
      const idx = (y * width + x) * 4;
      return { r: data[idx], g: data[idx + 1], b: data[idx + 2], a: data[idx + 3] };
    };

    // Sample entire perimeter at regular intervals
    const step = Math.max(1, Math.floor(Math.min(width, height) / 30));
    const samples = [];
    for (let x = 0; x < width; x += step) {
      samples.push(getPixel(x, 0));
      samples.push(getPixel(x, height - 1));
    }
    for (let y = step; y < height - step; y += step) {
      samples.push(getPixel(0, y));
      samples.push(getPixel(width - 1, y));
    }

    // If border is already transparent, nothing to remove
    const opaque = samples.filter(s => s.a > 200);
    if (opaque.length < samples.length * 0.4) return null;

    // Median color is robust against outliers (e.g. emoji touching border)
    const median = (arr) => {
      const sorted = [...arr].sort((a, b) => a - b);
      return sorted[Math.floor(sorted.length / 2)];
    };
    const medR = median(opaque.map(s => s.r));
    const medG = median(opaque.map(s => s.g));
    const medB = median(opaque.map(s => s.b));

    // Require that most opaque border pixels are close to the median
    const tolerance = 40;
    const matching = opaque.filter(s =>
      Math.abs(s.r - medR) <= tolerance &&
      Math.abs(s.g - medG) <= tolerance &&
      Math.abs(s.b - medB) <= tolerance
    );
    if (matching.length < opaque.length * 0.6) return null;

    return { r: medR, g: medG, b: medB };
  }

  /**
   * Save generated emoji to file
   * @param {Buffer} imageBuffer - Image buffer
   * @param {string} name - Emoji name
   * @param {string} outputDir - Output directory
   * @returns {Promise<string>} - Path to saved file
   */
  async saveEmoji(imageBuffer, name, outputDir) {
    const fileName = `meow_${name.toLowerCase().replace(/\s+/g, '_')}.png`;
    const filePath = path.join(outputDir, fileName);

    await fs.promises.writeFile(filePath, imageBuffer);
    return filePath;
  }
}

module.exports = EmojiGenerator;
module.exports.PreviousInteractionUnavailableError = PreviousInteractionUnavailableError;
module.exports.CORE_REFERENCE_FILES = CORE_REFERENCE_FILES;
