#!/usr/bin/env node
require('dotenv').config();
const path = require('path');
const fs = require('fs');
const EmojiGenerator = require('./gemini');

const REFERENCE_DIR = path.join(__dirname, '../examples');
const OUTPUT_DIR = path.join(__dirname, '../generated');

// Ensure output directory exists
if (!fs.existsSync(OUTPUT_DIR)) {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
}

async function main() {
  const args = process.argv.slice(2);

  if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
    console.log(`
Slack Emoji Generator CLI

Usage:
  node cli.js <description>                          Generate emoji with auto-generated name
  node cli.js <name> <description>                   Generate emoji with specific name
  node cli.js --ref <image_path> <description>       Generate emoji resembling a person
  node cli.js --ref <image_path> <name> <description>

Examples:
  node cli.js "happy cat with sunglasses"
  node cli.js meow_cool "happy cat with sunglasses"
  node cli.js --ref photo.jpg "confident leader cat"

Options:
  -h, --help              Show this help message
  -l, --list              List all generated emojis
  --ref <image_path>      Reference photo to base the cat's appearance on
`);
    return;
  }

  if (args[0] === '--list' || args[0] === '-l') {
    const files = fs.readdirSync(OUTPUT_DIR).filter(f => f.endsWith('.png'));
    if (files.length === 0) {
      console.log('No generated emojis yet.');
    } else {
      console.log('Generated emojis:');
      files.forEach(f => console.log(`  - ${f}`));
    }
    return;
  }

  // Parse --ref flag
  let personRefPath = null;
  const filteredArgs = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--ref' && i + 1 < args.length) {
      personRefPath = args[i + 1];
      i++; // skip the path argument
    } else {
      filteredArgs.push(args[i]);
    }
  }

  if (personRefPath && !fs.existsSync(personRefPath)) {
    console.error(`Error: Reference image not found: ${personRefPath}`);
    process.exit(1);
  }

  if (!process.env.GEMINI_API_KEY) {
    console.error('Error: GEMINI_API_KEY environment variable is required');
    console.error('Set it in .env file or export GEMINI_API_KEY=your-key');
    process.exit(1);
  }

  const generator = new EmojiGenerator(process.env.GEMINI_API_KEY);

  let name, description;

  if (filteredArgs.length === 1) {
    // Only description provided, generate name from it
    description = filteredArgs[0];
    name = description
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, '')
      .replace(/\s+/g, '_')
      .substring(0, 20);
  } else {
    // Name and description provided
    name = filteredArgs[0].toLowerCase().replace(/[^a-z0-9_-]/g, '_');
    description = filteredArgs.slice(1).join(' ');
  }

  // Ensure name starts with meow_ if it doesn't
  if (!name.startsWith('meow_') && !name.startsWith('meow-')) {
    name = `meow_${name}`;
  }

  console.log(`\nGenerating emoji: ${name}`);
  console.log(`Description: ${description}`);
  if (personRefPath) {
    console.log(`Person reference: ${personRefPath}`);
  }
  console.log('Using style references from examples...\n');

  try {
    const imageBuffer = await generator.generateWithReferences(
      description,
      REFERENCE_DIR,
      personRefPath
    );

    const outputPath = await generator.saveEmoji(imageBuffer, name.replace(/^meow_/, ''), OUTPUT_DIR);
    console.log(`✅ Emoji saved to: ${outputPath}`);
    console.log(`\nTo add to Slack:`);
    console.log(`1. Go to your Slack workspace settings`);
    console.log(`2. Navigate to "Customize" > "Emoji"`);
    console.log(`3. Click "Add Custom Emoji"`);
    console.log(`4. Upload ${path.basename(outputPath)} and name it "${name}"`);
  } catch (error) {
    console.error(`❌ Failed to generate emoji: ${error.message}`);
    process.exit(1);
  }
}

main().catch(console.error);
