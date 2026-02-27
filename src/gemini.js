const { GoogleGenAI } = require('@google/genai');
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

class EmojiGenerator {
  constructor(apiKey) {
    this.client = new GoogleGenAI({ apiKey });
    this.model = 'gemini-2.5-flash-image';

    // Style prompt based on the meow emoji collection
    // Context: These emojis are for Health Universe (healthuniverse.com) - a healthcare AI company
    // that builds AI-powered clinical workflow automation tools for hospitals and clinics.
    // Their platform "Navigator" helps clinicians with patient care through AI assistance.
    // Key themes: healthcare, AI, clinical workflows, patient care, medical technology, teamwork
    this.stylePrompt = `Create a cute cat emoji in the "meow" style with these characteristics:
- Yellow/golden colored cat face or full body
- Simple, cartoon-like design suitable for a small emoji (128x128 pixels)
- Black outline/whiskers
- Expressive eyes and facial features
- Flat design, no 3D effects or shadows
- TRANSPARENT BACKGROUND (this is critical - no background color at all)
- Cute, friendly, and playful aesthetic
- Similar to Slack/Discord custom emojis
- The cat should be the only element, floating on transparency

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
        model: 'gemini-2.0-flash',
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

      const improvedPrompt = response.candidates[0].content.parts[0].text.trim();
      console.log('Improved prompt:', userPrompt, '->', improvedPrompt);
      return improvedPrompt;
    } catch (error) {
      console.error('Error improving prompt:', error);
      // Fallback to original prompt if enhancement fails
      return userPrompt;
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
        model: 'gemini-2.0-flash',
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

      let name = response.candidates[0].content.parts[0].text.trim();

      // Clean up the response - ensure it starts with meow- and is properly formatted
      name = name.toLowerCase().replace(/[^a-z0-9-]/g, '');
      if (!name.startsWith('meow-')) {
        name = 'meow-' + name.replace(/^meow/, '');
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
   * Generate an emoji image based on description
   * @param {string} description - What the emoji should depict
   * @param {string[]} referenceImages - Optional base64 reference images
   * @returns {Promise<Buffer>} - PNG image buffer
   */
  async generateEmoji(description, referenceImages = []) {
    const prompt = `${this.stylePrompt}

The emoji should show: ${description}

Requirements:
- Output a single emoji-sized image
- Make it instantly recognizable at small sizes
- Keep the meow cat as the main character
- Square aspect ratio (1:1)
- MUST have transparent/clear background with NO solid color behind the cat`;

    const contents = [{ text: prompt }];

    // Add reference images if provided
    for (const refImage of referenceImages) {
      contents.push({
        inlineData: {
          mimeType: 'image/png',
          data: refImage
        }
      });
    }

    try {
      const response = await this.client.models.generateContent({
        model: this.model,
        contents: [{ parts: contents }],
        generationConfig: {
          responseModalities: ['IMAGE'],
          imageConfig: {
            aspectRatio: '1:1',
            imageSize: '1K'
          }
        }
      });

      // Extract image from response
      for (const part of response.candidates[0].content.parts) {
        if (part.inlineData) {
          const imageBuffer = Buffer.from(part.inlineData.data, 'base64');

          // Resize to emoji size (128x128) and ensure PNG format
          const processedImage = await this.processForEmoji(imageBuffer);
          return processedImage;
        }
      }

      throw new Error('No image returned from Gemini');
    } catch (error) {
      console.error('Gemini generation error:', error);
      throw error;
    }
  }

  /**
   * Process image to be Slack emoji compatible with transparent background
   * @param {Buffer} imageBuffer - Raw image buffer
   * @returns {Promise<Buffer>} - Processed PNG buffer with transparency
   */
  async processForEmoji(imageBuffer) {
    // Convert to raw RGBA to detect and remove background
    const image = sharp(imageBuffer);
    const { data, info } = await image
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });

    // Detect background color from corners (sample multiple pixels)
    const bgColor = this.detectBackgroundColor(data, info.width, info.height);

    // Remove background color if detected (make it transparent)
    if (bgColor) {
      const tolerance = 30; // Color matching tolerance
      for (let i = 0; i < data.length; i += 4) {
        const r = data[i];
        const g = data[i + 1];
        const b = data[i + 2];

        // Check if pixel matches background color within tolerance
        if (
          Math.abs(r - bgColor.r) <= tolerance &&
          Math.abs(g - bgColor.g) <= tolerance &&
          Math.abs(b - bgColor.b) <= tolerance
        ) {
          data[i + 3] = 0; // Set alpha to 0 (transparent)
        }
      }
    }

    // Reconstruct image with transparency and resize
    return sharp(data, {
      raw: {
        width: info.width,
        height: info.height,
        channels: 4
      }
    })
      .resize(128, 128, {
        fit: 'contain',
        background: { r: 0, g: 0, b: 0, alpha: 0 }
      })
      .png()
      .toBuffer();
  }

  /**
   * Detect background color by sampling corner pixels
   * @param {Buffer} data - Raw RGBA pixel data
   * @param {number} width - Image width
   * @param {number} height - Image height
   * @returns {Object|null} - Background color {r, g, b} or null
   */
  detectBackgroundColor(data, width, height) {
    const getPixel = (x, y) => {
      const idx = (y * width + x) * 4;
      return { r: data[idx], g: data[idx + 1], b: data[idx + 2], a: data[idx + 3] };
    };

    // Sample corners and edges
    const samples = [
      getPixel(0, 0),
      getPixel(width - 1, 0),
      getPixel(0, height - 1),
      getPixel(width - 1, height - 1),
      getPixel(Math.floor(width / 2), 0),
      getPixel(Math.floor(width / 2), height - 1),
      getPixel(0, Math.floor(height / 2)),
      getPixel(width - 1, Math.floor(height / 2))
    ];

    // Check if corners have similar colors (likely background)
    const tolerance = 30;
    const firstColor = samples[0];
    let matchCount = 0;

    for (const sample of samples) {
      if (
        Math.abs(sample.r - firstColor.r) <= tolerance &&
        Math.abs(sample.g - firstColor.g) <= tolerance &&
        Math.abs(sample.b - firstColor.b) <= tolerance
      ) {
        matchCount++;
      }
    }

    // If at least 6 of 8 corner samples match, it's likely a solid background
    if (matchCount >= 6) {
      return { r: firstColor.r, g: firstColor.g, b: firstColor.b };
    }

    return null;
  }

  /**
   * Generate emoji with style reference from existing emojis
   * @param {string} description - What the emoji should depict
   * @param {string} referenceDir - Directory containing reference emojis
   * @param {string} [personRefPath] - Optional path to a person's photo to base the cat on
   * @returns {Promise<Buffer>} - PNG image buffer
   */
  async generateWithReferences(description, referenceDir, personRefPath = null) {
    const referenceImages = [];

    // Core reference images to guide the style
    const coreReferenceFiles = [
      'meow_happy.png',
      'meow_hearteyes.png',
      'meow_adorable.png',
      'meow_thx.png',
      'meow_huggies.png',
      'meow_thumbsup.png'
    ];

    // If referenceDir is missing or empty, generate without style references
    if (!fs.existsSync(referenceDir) || fs.readdirSync(referenceDir).filter(f => f.endsWith('.png')).length === 0) {
      console.log('No reference images available, generating without style references');
      return this.generateEmoji(description);
    }

    // Get all meow emoji files and select 5 random ones (excluding core references)
    const allFiles = fs.readdirSync(referenceDir).filter(f =>
      f.startsWith('meow') && f.endsWith('.png') && !coreReferenceFiles.includes(f)
    );
    const randomFiles = allFiles.sort(() => Math.random() - 0.5).slice(0, 5);

    // Combine core references with random samples
    const referenceFiles = [...coreReferenceFiles, ...randomFiles];

    for (const file of referenceFiles) {
      const filePath = path.join(referenceDir, file);
      if (fs.existsSync(filePath)) {
        const imageData = fs.readFileSync(filePath);
        referenceImages.push(imageData.toString('base64'));
      }
    }

    let personPrompt = '';
    if (personRefPath) {
      personPrompt = `
I've also included a photo of a real person. Make the cat emoji RESEMBLE this person by incorporating their distinctive features:
- Match their hairstyle/hair color on the cat
- If they have facial hair (beard, mustache), give the cat similar facial hair
- Match their clothing/outfit style (e.g., blazer, shirt color)
- Capture their expression/vibe (e.g., confident, friendly)
- The cat should be clearly recognizable as a cat-version of this person
- Keep it as a cute cat emoji - don't make it too realistic`;
    }

    const prompt = `${this.stylePrompt}

I've included reference images showing the exact style to match. Create a new emoji in this EXACT same style.
${personPrompt}
The new emoji should show: ${description}

IMPORTANT: Match the reference images' style exactly:
- Same yellow/golden cat color
- Same line thickness and style
- Same level of detail and simplicity
- Same cute aesthetic
- TRANSPARENT BACKGROUND - no solid color behind the cat, just the cat floating on transparency`;

    const contents = [{ text: prompt }];

    // Add person reference photo first if provided
    if (personRefPath) {
      const personData = fs.readFileSync(personRefPath);
      const ext = path.extname(personRefPath).toLowerCase();
      const mimeType = ext === '.png' ? 'image/png' : 'image/jpeg';
      contents.push({
        inlineData: {
          mimeType,
          data: personData.toString('base64')
        }
      });
    }

    // Add style reference images
    for (const refImage of referenceImages) {
      contents.push({
        inlineData: {
          mimeType: 'image/png',
          data: refImage
        }
      });
    }

    try {
      const response = await this.client.models.generateContent({
        model: this.model,
        contents: [{ parts: contents }],
        generationConfig: {
          responseModalities: ['IMAGE'],
          imageConfig: {
            aspectRatio: '1:1',
            imageSize: '1K'
          }
        }
      });

      for (const part of response.candidates[0].content.parts) {
        if (part.inlineData) {
          const imageBuffer = Buffer.from(part.inlineData.data, 'base64');
          return this.processForEmoji(imageBuffer);
        }
      }

      throw new Error('No image returned from Gemini');
    } catch (error) {
      console.error('Gemini generation error:', error);
      throw error;
    }
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
