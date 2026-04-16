// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * AES-256-GCM encryption for sensitive values persisted to the database.
 * Uses the ENCRYPTION_KEY env var (64-char hex = 32 bytes).
 */

let _key: Awaited<ReturnType<typeof crypto.subtle.importKey>> | null = null;

async function getKey() {
  if (_key) return _key;

  const hex = process.env.ENCRYPTION_KEY;
  if (!hex || hex.length !== 64) {
    throw new Error(
      "ENCRYPTION_KEY env var is required (64-char hex = 32 bytes). Generate with: openssl rand -hex 32",
    );
  }

  const bytes = new Uint8Array(32);
  for (let i = 0; i < 32; i++) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }

  _key = await crypto.subtle.importKey("raw", bytes, "AES-GCM", false, [
    "encrypt",
    "decrypt",
  ]);
  return _key;
}

/**
 * Encrypt a plaintext string with AES-256-GCM.
 * Returns a base64 string of (12-byte IV || ciphertext || 16-byte tag).
 */
export async function encrypt(plaintext: string): Promise<string> {
  const key = await getKey();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encoded = new TextEncoder().encode(plaintext);
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    encoded,
  );

  // Combine IV + ciphertext+tag into a single buffer
  const combined = new Uint8Array(12 + ciphertext.byteLength);
  combined.set(iv, 0);
  combined.set(new Uint8Array(ciphertext), 12);

  return Buffer.from(combined).toString("base64");
}

/**
 * Decrypt a base64 string produced by encrypt().
 */
export async function decrypt(ciphertext: string): Promise<string> {
  const key = await getKey();
  const combined = new Uint8Array(Buffer.from(ciphertext, "base64"));
  const iv = combined.slice(0, 12);
  const data = combined.slice(12);

  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv },
    key,
    data,
  );

  return new TextDecoder().decode(plaintext);
}

/**
 * Return a masked hint for display: first 4 + last 4 chars.
 * "ak_abc123def456" → "ak_a...f456"
 */
export function keyHint(plaintext: string): string {
  if (plaintext.length <= 8) return plaintext;
  return `${plaintext.slice(0, 4)}...${plaintext.slice(-4)}`;
}
