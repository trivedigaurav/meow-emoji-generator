# Lambda Deployment

Always deploy the **full package**, never a single file:

```bash
# Build
sam build --no-use-container

# Add the Linux arm64 sharp binaries. `sam build --no-use-container` on a Mac only installs
# darwin binaries, and the Lambda (nodejs20 / arm64) fails with "Could not load the sharp module" without these.
cd .aws-sam/build/MeowEmojiFunction
npm install --os=linux --cpu=arm64 --no-save --no-audit --no-fund sharp
ls node_modules/@img | grep -q sharp-linux-arm64 || echo "MISSING linux-arm64 sharp — do not deploy"

# Package full directory
zip -r /tmp/meow-emoji-lambda.zip .

# Deploy via S3 (direct upload times out for 38MB zip — always use S3)
aws s3 cp /tmp/meow-emoji-lambda.zip s3://aws-sam-cli-managed-default-samclisourcebucket-hir6chde4guw/meow-emoji-generator/deploy.zip \
  --region us-east-1 \
  --profile Production

aws lambda update-function-code \
  --function-name meow-emoji-generator \
  --s3-bucket aws-sam-cli-managed-default-samclisourcebucket-hir6chde4guw \
  --s3-key meow-emoji-generator/deploy.zip \
  --region us-east-1 \
  --profile Production

aws lambda wait function-updated \
  --function-name meow-emoji-generator \
  --region us-east-1 \
  --profile Production
```

**Never** do `zip /tmp/meow-emoji-lambda.zip src/gemini.js` — this replaces the archive with a single file (~6KB), wiping node_modules and all other source files. The Lambda will fail with `Cannot find module` on every invocation.

`sam deploy` is broken locally — it requires Docker even with `use_container = false`. Use `aws lambda update-function-code` directly instead.

Note: `use_container = true` in samconfig.toml is intentional (for CI/correct linux-arm64 sharp binaries). Don't change it.

# Thread tweaks (how follow-up edits work)

One Slack thread = one emoji's editing session. State lives only in Slack message metadata, nothing in S3/DynamoDB.

- Every posted version is a bot message with `metadata.event_type = meow_version` and payload `{ v, iid, name, prompt, improved, instruction, parent_v }`. `iid` is the Gemini Interactions API id.
- `@mention` inside a thread → `readThreadState()` in `src/lambda.js` calls `conversations.replies` (needs `channels:history` / `groups:history`), rebuilds versions from metadata, and dispatches a `tweak` worker. Edits call `interactions.create` with `previous_interaction_id`, so the model edits the previous image in place without us resending it.
- `meow_generating` placeholder = per-thread lock (ignored after 5 min). It is deleted on success and rewritten as `meow_failed` on error. Never leave one behind with the `meow_generating` type.
- `meow_pointer` ("back to vN") redirects which version the next tweak chains from.
- Expired/unknown `iid` (55 days on paid Gemini tier, 1 day on free) → `PreviousInteractionUnavailableError` → regenerate from `improved` + accumulated `tweaks`.
- Images are posted as `files.uploadV2` (no channel, private) + `chat.postMessage` with an `image` block using `slack_file: { id }` plus the metadata. If that message is rejected, the fallback shares the file into the thread and puts the metadata on the caption/placeholder instead.

Gemini models: `gemini-nano-banana-2.1` for images (Interactions API, JPEG output, 1:1, 1K), `gemini-3.5-flash-lite` for prompt improvement/naming. `gemini-2.0-flash` was shut down 2026-06-01. The `@google/genai` SDK takes `config`, not `generationConfig`.

The six `meow_*.png` core style references must exist in `examples/` (copied from `slack_emojis/`, which is gitignored).

`src/app.js` (Socket Mode, local dev) only does fresh generation; the tweak flow is implemented in `src/lambda.js`.

# Metrics

Pull 30-day dashboard from CloudWatch Logs:

```bash
bash scripts/metrics.sh
```

Optional flags: `--days N`, `--profile PROFILE`, `--slack-token TOKEN` (resolves unknown Slack user IDs).

To add known users, edit the `KNOWN_USERS` map in `scripts/metrics.sh:43`.
