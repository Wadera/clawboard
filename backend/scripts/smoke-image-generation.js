#!/usr/bin/env node
/*
 * Smoke-test ClawBoard image generation against a running API.
 *
 * Usage:
 *   CLAWBOARD_IMAGE_SMOKE_URL=https://your-dashboard.example.com/api \
 *     node backend/scripts/smoke-image-generation.js
 *
 * Prints MEDIA:<server-file-path> on success so gateway/Hermes operators can
 * copy the generated image path into a message/attachment flow.
 */

const apiBase = (process.env.CLAWBOARD_IMAGE_SMOKE_URL || 'http://localhost:3000/api').replace(/\/$/, '');
const prompt = process.env.CLAWBOARD_IMAGE_SMOKE_PROMPT || 'tiny 64x64 blue square icon, minimal smoke test';
const model = process.env.CLAWBOARD_IMAGE_SMOKE_MODEL || undefined;
const useCase = process.env.CLAWBOARD_IMAGE_SMOKE_USE_CASE || 'avatar';
const timeoutMs = Number.parseInt(process.env.CLAWBOARD_IMAGE_SMOKE_TIMEOUT_MS || '240000', 10);
const pollMs = Number.parseInt(process.env.CLAWBOARD_IMAGE_SMOKE_POLL_MS || '5000', 10);
const bearer = process.env.CLAWBOARD_IMAGE_SMOKE_BEARER || '';
const apiKey = process.env.CLAWBOARD_IMAGE_SMOKE_API_KEY || '';

function authHeaders() {
  return {
    ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
    ...(apiKey ? { 'x-api-key': apiKey } : {}),
  };
}

async function readJson(response) {
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new Error(`Expected JSON from ${response.url}, got ${response.status}: ${text.slice(0, 300)}`);
  }
}

async function main() {
  const createResponse = await fetch(`${apiBase}/images/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify({ prompt, model, useCase }),
  });
  const createBody = await readJson(createResponse);
  if (!createResponse.ok || !createBody.success || !createBody.generation?.id) {
    throw new Error(`Image generation create failed (${createResponse.status}): ${JSON.stringify(createBody)}`);
  }

  const generationId = createBody.generation.id;
  const started = Date.now();

  while (Date.now() - started < timeoutMs) {
    const statusResponse = await fetch(`${apiBase}/images/${generationId}`, {
      headers: authHeaders(),
    });
    const statusBody = await readJson(statusResponse);
    if (!statusResponse.ok || !statusBody.success) {
      throw new Error(`Image generation status failed (${statusResponse.status}): ${JSON.stringify(statusBody)}`);
    }

    const generation = statusBody.generation;
    if (generation.status === 'completed') {
      const mediaPath = generation.file_path;
      console.log(`MEDIA:${mediaPath}`);
      console.log(JSON.stringify({ id: generation.id, model: generation.model, mediaPath }, null, 2));
      return;
    }

    if (generation.status === 'failed') {
      throw new Error(`Image generation failed: ${generation.error_message || 'unknown error'}`);
    }

    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }

  throw new Error(`Timed out waiting for image generation ${generationId} after ${timeoutMs}ms`);
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
