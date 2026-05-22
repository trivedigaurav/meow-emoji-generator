# Lambda Deployment

Always deploy the **full package**, never a single file:

```bash
# Build
sam build --no-use-container

# Package full directory
cd .aws-sam/build/MeowEmojiFunction
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

# Metrics

Pull 30-day dashboard from CloudWatch Logs:

```bash
bash scripts/metrics.sh
```

Optional flags: `--days N`, `--profile PROFILE`, `--slack-token TOKEN` (resolves unknown Slack user IDs).

To add known users, edit the `KNOWN_USERS` map in `scripts/metrics.sh:43`.
