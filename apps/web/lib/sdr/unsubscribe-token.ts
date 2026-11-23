import crypto from "node:crypto";

export type UnsubscribeTokenPayload = {
  orgId: string;
  email: string;
  messageId?: string;
  exp: number;
};

const DEFAULT_TTL_SECONDS = 60 * 60 * 24 * 365;
const SECRET = process.env.SDR_UNSUBSCRIBE_SECRET || process.env.NEXTAUTH_SECRET || "";

function base64urlEncode(input: Buffer | string): string {
  return Buffer.from(input)
    .toString("base64")
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

function base64urlDecode(input: string): Buffer {
  const normalized = input.replaceAll("-", "+").replaceAll("_", "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  return Buffer.from(padded, "base64");
}

function ensureSecret(): void {
  if (!SECRET) {
    throw new Error("Missing SDR_UNSUBSCRIBE_SECRET or NEXTAUTH_SECRET");
  }
}

export function signUnsubscribeToken(
  payload: Omit<UnsubscribeTokenPayload, "exp"> & { exp?: number },
): string {
  ensureSecret();
  const fullPayload: UnsubscribeTokenPayload = {
    ...payload,
    exp: payload.exp ?? Math.floor(Date.now() / 1000) + DEFAULT_TTL_SECONDS,
  };
  const payloadJson = JSON.stringify(fullPayload);
  const payloadB64 = base64urlEncode(payloadJson);
  const signature = crypto.createHmac("sha256", SECRET).update(payloadB64).digest();
  const signatureB64 = base64urlEncode(signature);
  return `${payloadB64}.${signatureB64}`;
}

export function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

export function verifyUnsubscribeToken(token: string): UnsubscribeTokenPayload {
  ensureSecret();
  const [payloadB64, signatureB64] = token.split(".");
  if (!payloadB64 || !signatureB64) {
    throw new Error("Invalid token format");
  }

  const expectedSig = crypto.createHmac("sha256", SECRET).update(payloadB64).digest();
  const actualSig = base64urlDecode(signatureB64);

  if (expectedSig.length !== actualSig.length || !crypto.timingSafeEqual(expectedSig, actualSig)) {
    throw new Error("Invalid token signature");
  }

  const payloadRaw = base64urlDecode(payloadB64).toString("utf8");
  const payload = JSON.parse(payloadRaw) as UnsubscribeTokenPayload;

  if (!payload.orgId || !payload.email || !payload.exp) {
    throw new Error("Invalid token payload");
  }

  if (Math.floor(Date.now() / 1000) > payload.exp) {
    throw new Error("Token expired");
  }

  return payload;
}
