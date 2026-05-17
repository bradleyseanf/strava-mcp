import crypto from "node:crypto";

export interface SessionClaims {
    email: string;
    expiresAt: number;
}

function sign(payload: string, secret: string): string {
    return crypto.createHmac("sha256", secret).update(payload).digest("base64url");
}

export function createSessionCookie(
    email: string,
    secret: string,
    maxAgeSeconds: number,
): string {
    const claims: SessionClaims = {
        email,
        expiresAt: Math.floor(Date.now() / 1000) + maxAgeSeconds,
    };
    const payload = Buffer.from(JSON.stringify(claims), "utf8").toString("base64url");
    const signature = sign(payload, secret);
    return `${payload}.${signature}`;
}

export function verifySessionCookie(
    cookieValue: string | undefined,
    secret: string,
): SessionClaims | null {
    if (!cookieValue) {
        return null;
    }

    const [payload, signature] = cookieValue.split(".");
    if (!payload || !signature) {
        return null;
    }

    const expected = sign(payload, secret);
    const signatureBuf = Buffer.from(signature, "utf8");
    const expectedBuf = Buffer.from(expected, "utf8");
    if (signatureBuf.length !== expectedBuf.length) {
        return null;
    }
    if (!crypto.timingSafeEqual(signatureBuf, expectedBuf)) {
        return null;
    }

    try {
        const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as SessionClaims;
        if (!claims.email || typeof claims.expiresAt !== "number") {
            return null;
        }
        if (claims.expiresAt < Math.floor(Date.now() / 1000)) {
            return null;
        }
        return claims;
    } catch {
        return null;
    }
}
