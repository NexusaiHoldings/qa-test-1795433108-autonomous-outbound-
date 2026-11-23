import { createHash, createHmac, timingSafeEqual } from "crypto";

export type UnsubscribeTokenPayload = {
  organizationId: string;
  email: string;
  messageId?: string;
  exp: number;
};

const TOKEN_VERSION = "v1";

function getSecret(): string {
  const secret = process.env.SDR_UNSUBSCRIBE_SECRET;
  if (!secret) {
    throw new Error("Missing SDR_UNSUBSCRIBE_SECRET environment variable");
  }
  return secret;
}

function toBase64Url(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

function fromBase64Url(value: string): string {
  return Buffer.from(value, "base64url").toString("utf8");
}

function signData(payloadB64: string, secret: string): string {
  return createHmac("sha256", secret).update(payloadB64).digest("base64url");
}

export function createUnsubscribeToken(payload: UnsubscribeTokenPayload): string {
  const secret = getSecret();
  const serialized = JSON.stringify(payload);
  const payloadB64 = toBase64Url(serialized);
  const sig = signData(payloadB64, secret);
  return `${TOKEN_VERSION}.${payloadB64}.${sig}`;
}

export function verifyUnsubscribeToken(token: string): {
  valid: boolean;
  payload: UnsubscribeTokenPayload | null;
  tokenHash: string;
  error?: string;
} {
  const tokenHash = createHash("sha256").update(token).digest("hex");
  const parts = token.split(".");
  if (parts.length !== 3) {
    return { valid: false, payload: null, tokenHash, error: "malformed_token" };
  }

  const [version, payloadB64, sig] = parts;
  if (version !== TOKEN_VERSION || !payloadB64 || !sig) {
    return { valid: false, payload: null, tokenHash, error: "invalid_token_format" };
  }

  const secret = getSecret();
  const expectedSig = signData(payloadB64, secret);

  const sigBuffer = Buffer.from(sig, "utf8");
  const expectedBuffer = Buffer.from(expectedSig, "utf8");
  if (sigBuffer.length !== expectedBuffer.length || !timingSafeEqual(sigBuffer, expectedBuffer)) {
    return { valid: false, payload: null, tokenHash, error: "invalid_signature" };
  }

  try {
    const payloadRaw = fromBase64Url(payloadB64);
    const payload = JSON.parse(payloadRaw) as UnsubscribeTokenPayload;
    if (!payload.organizationId || !payload.email || !payload.exp) {
      return { valid: false, payload: null, tokenHash, error: "invalid_payload" };
    }
    if (Date.now() > payload.exp * 1000) {
      return { valid: false, payload: null, tokenHash, error: "expired_token" };
    }
    return { valid: true, payload, tokenHash };
  } catch {
    return { valid: false, payload: null, tokenHash, error: "invalid_payload_json" };
  }
}
