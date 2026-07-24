# Image generation provider bridge

ClawBoard's `/api/images/generate` endpoint supports two backend providers:

- `litellm` (default): calls an OpenAI-compatible image endpoint and writes the returned `b64_json` to `/clawd-media/generated`.
- `openclaw`: calls the local `openclaw infer image generate` CLI and lets OpenClaw use its existing Codex OAuth/device auth state.

The OpenClaw path is intended for Hermes/OpenAI Codex image generation without copying Codex tokens into ClawBoard. ClawBoard never reads or stores Codex OAuth tokens; it only invokes the CLI available to the backend process user.

## Environment knobs

Set these on the backend container/host:

```bash
# Provider selection
CLAWBOARD_IMAGE_PROVIDER=openclaw              # openclaw | litellm
CLAWBOARD_IMAGE_FALLBACK_PROVIDER=litellm      # optional; omit to fail fast

# Output and timeout
CLAWBOARD_IMAGE_OUTPUT_DIR=/clawd-media/generated
CLAWBOARD_IMAGE_TIMEOUT_MS=180000

# OpenClaw CLI bridge
CLAWBOARD_IMAGE_OPENCLAW_COMMAND=/usr/bin/env
CLAWBOARD_IMAGE_OPENCLAW_ARGS_TEMPLATE='HOME=<openclaw-user-home> PATH=<openclaw-user-home>/.npm-global/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin openclaw infer image generate --prompt {prompt} --model {model} --output {output}'
CLAWBOARD_IMAGE_OPENCLAW_MODEL=openai/gpt-image-2
CLAWBOARD_IMAGE_OPENCLAW_AVATAR_MODEL=openai/gpt-image-2
CLAWBOARD_IMAGE_OPENCLAW_BANNER_MODEL=openai/gpt-image-2

# LiteLLM fallback/default path
CLAWBOARD_IMAGE_LITELLM_URL=https://<your-litellm-host>/v1/images/generations
CLAWBOARD_IMAGE_LITELLM_MODEL=gemini/gemini-3-pro-image-preview
CLAWBOARD_IMAGE_LITELLM_AVATAR_MODEL=gemini/gemini-3-pro-image-preview
CLAWBOARD_IMAGE_LITELLM_BANNER_MODEL=gemini/gemini-3-pro-image-preview
LITELLM_API_KEY=<runtime secret from Vaultwarden/Ansible Vault>
```

If a request passes an explicit `model`, it overrides the use-case mapping. Otherwise `useCase=avatar` and `useCase=banner` resolve to the provider-specific `*_AVATAR_MODEL` / `*_BANNER_MODEL` values, then fall back to the provider default model.

## Operator setup

1. Install/upgrade `openclaw` for the host `clawd` user.
2. Authenticate OpenClaw/Codex as that same OS user. Do not put Codex OAuth tokens in `.env` or code.
3. Mount `~/.npm-global`, `~/.openclaw`, and `~/.codex` into the backend container, as the bundled compose files do. The token/config trees are read-only; `~/.openclaw/state` is overlaid read-write because the OpenClaw CLI updates runtime health state at startup. The default OpenClaw command runs via `/usr/bin/env` with the OpenClaw user home and a PATH that includes `~/.npm-global/bin`.
4. Verify the CLI can generate to a server-writable path:

   ```bash
   openclaw infer image generate \
     --prompt 'tiny blue square smoke test' \
     --model openai/gpt-image-2 \
     --output /clawd-media/generated/openclaw-smoke.png
   ```

5. Set `CLAWBOARD_IMAGE_PROVIDER=openclaw` and the model mapping env vars on the dev backend.
6. Restart/redeploy the dev backend and run the smoke test:

   ```bash
   cd backend
   CLAWBOARD_IMAGE_SMOKE_URL=https://<your-domain>/api \
     CLAWBOARD_IMAGE_SMOKE_BEARER="$DEV_JWT" \
     npm run smoke:image
   ```

   Success prints `MEDIA:/clawd-media/generated/<id>.png` and a JSON summary.

## Fallback behavior

- With `CLAWBOARD_IMAGE_FALLBACK_PROVIDER` unset, the request is marked `failed` if the primary provider fails.
- With `CLAWBOARD_IMAGE_FALLBACK_PROVIDER=litellm`, an OpenClaw failure retries the same prompt/model through LiteLLM. This requires `LITELLM_API_KEY` at runtime.
- The reverse (`litellm` primary, `openclaw` fallback) is also supported, but the normal Codex bridge deployment should use OpenClaw primary.

## API request shape

```json
{
  "prompt": "agent avatar, blue robot, clean icon",
  "useCase": "avatar",
  "model": "openai/gpt-image-2"
}
```

`useCase` is optional and may be `default`, `avatar`, or `banner`. `model` is optional.
