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
  node cli.js <description>           Generate emoji with auto-generated name
  node cli.js <name> <description>    Generate emoji with specific name

Examples:
  node cli.js "happy cat with sunglasses"
  node cli.js meow_cool "happy cat with sunglasses"
  node cli.js meow_pizza "cat eating pizza"

Options:
  -h, --help    Show this help message
  -l, --list    List all generated emojis
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

  if (!process.env.GEMINI_API_KEY) {
    console.error('Error: GEMINI_API_KEY environment variable is required');
    console.error('Set it in .env file or export GEMINI_API_KEY=your-key');
    process.exit(1);
  }

  const generator = new EmojiGenerator(process.env.GEMINI_API_KEY);

  let name, description;

  if (args.length === 1) {
    // Only description provided, generate name from it
    description = args[0];
    name = description
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, '')
      .replace(/\s+/g, '_')
      .substring(0, 20);
  } else {
    // Name and description provided
    name = args[0].toLowerCase().replace(/[^a-z0-9_-]/g, '_');
    description = args.slice(1).join(' ');
  }

  // Ensure name starts with meow_ if it doesn't
  if (!name.startsWith('meow_') && !name.startsWith('meow-')) {
    name = `meow_${name}`;
  }

  console.log(`\nGenerating emoji: ${name}`);
  console.log(`Description: ${description}`);
  console.log('Using style references from examples...\n');

  try {
    const imageBuffer = await generator.generateWithReferences(
      description,
      REFERENCE_DIR
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
