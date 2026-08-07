import { readFileSync } from 'fs';
import { createPublicKey, createPrivateKey, createHash, verify, randomBytes } from 'crypto';
import type { Request, Response } from 'express';
import { ConfidentialClientApplication } from '@azure/msal-node';
import { config } from '../config';

export interface AzureAdClaims {
  aud?: string;
  iss?: string;
  exp?: number;
  nbf?: number;
  tid?: string;
  oid?: string;
  sub?: string;
  name?: string;
  email?: string;
  preferred_username?: string;
  upn?: string;
  [key: string]: unknown;
}

export interface AzureAdUser {
  email: string;
  name: string;
  oid?: string;
  tid?: string;
  claims: AzureAdClaims;
}

type OpenIdMetadata = {
  issuer: string;
  jwks_uri: string;
};

type JsonWebKey = {
  kid?: string;
  kty?: string;
  use?: string;
  alg?: string;
  n?: string;
  e?: string;
  x5t?: string;
};

export const TOKEN_COOKIE = 'aibot_token';
export const STATE_COOKIE = 'aibot_auth_state';

let metadataCache: { value: OpenIdMetadata; fetchedAt: number } | null = null;
let jwksCache: { value: JsonWebKey[]; fetchedAt: number } | null = null;
let msalClient: ConfidentialClientApplication | null = null;

function base64UrlDecode(input: string): Buffer {
  const normalized = input.replace(/-/g, '+').replace(/_/g, '/');
  const padLength = (4 - (normalized.length % 4)) % 4;
  return Buffer.from(normalized + '='.repeat(padLength), 'base64');
}

function parseJwt(token: string): { header: Record<string, unknown>; payload: AzureAdClaims; signedPart: string; signature: Buffer } {
  const parts = token.split('.');
  if (parts.length !== 3) {
    throw new Error('Invalid Azure AD token format');
  }

  const [headerPart, payloadPart, signaturePart] = parts;
  const header = JSON.parse(base64UrlDecode(headerPart).toString('utf8')) as Record<string, unknown>;
  const payload = JSON.parse(base64UrlDecode(payloadPart).toString('utf8')) as AzureAdClaims;

  return {
    header,
    payload,
    signedPart: `${headerPart}.${payloadPart}`,
    signature: base64UrlDecode(signaturePart),
  };
}

function getAzureAdEnabled(): boolean {
  return Boolean(config.azureAd.clientId && config.azureAd.tenantId);
}

async function getOpenIdMetadata(): Promise<OpenIdMetadata> {
  if (!getAzureAdEnabled()) {
    throw new Error('Azure AD configuration is missing');
  }

  const now = Date.now();
  if (metadataCache && now - metadataCache.fetchedAt < 6 * 60 * 60 * 1000) {
    return metadataCache.value;
  }

  const url = `https://login.microsoftonline.com/${config.azureAd.tenantId}/v2.0/.well-known/openid-configuration`;
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to load Azure AD metadata: ${response.status} ${response.statusText}`);
  }

  const data = (await response.json()) as OpenIdMetadata;
  if (!data.issuer || !data.jwks_uri) {
    throw new Error('Azure AD metadata is incomplete');
  }

  metadataCache = { value: data, fetchedAt: now };
  return data;
}

async function getJwks(): Promise<JsonWebKey[]> {
  const metadata = await getOpenIdMetadata();
  const now = Date.now();
  if (jwksCache && now - jwksCache.fetchedAt < 6 * 60 * 60 * 1000) {
    return jwksCache.value;
  }

  const response = await fetch(metadata.jwks_uri);
  if (!response.ok) {
    throw new Error(`Failed to load Azure AD signing keys: ${response.status} ${response.statusText}`);
  }

  const data = (await response.json()) as { keys?: JsonWebKey[] };
  const keys = Array.isArray(data.keys) ? data.keys : [];
  jwksCache = { value: keys, fetchedAt: now };
  return keys;
}

function getClaimString(claims: AzureAdClaims, keys: string[]): string {
  for (const key of keys) {
    const value = claims[key];
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }
  return '';
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function getBearerToken(req: Request): string | null {
  const header = req.headers.authorization;
  if (typeof header === 'string') {
    const match = header.match(/^Bearer\s+(.+)$/i);
    if (match?.[1]?.trim()) {
      return match[1].trim();
    }
  }

  const cookieToken = req.cookies?.[TOKEN_COOKIE];
  if (typeof cookieToken === 'string' && cookieToken.trim()) {
    return cookieToken.trim();
  }

  return null;
}

export async function authenticateAzureAdRequest(req: Request): Promise<AzureAdUser> {
  if (!getAzureAdEnabled()) {
    throw new Error('Azure AD is not configured');
  }

  const token = getBearerToken(req);
  if (!token) {
    throw new Error('Missing Azure AD bearer token');
  }

  const { header, payload, signedPart, signature } = parseJwt(token);
  const metadata = await getOpenIdMetadata();
  const keys = await getJwks();
  const keyId = typeof header.kid === 'string' ? header.kid : undefined;
  const jwk = keys.find((key) => key.kid === keyId) || keys.find((key) => key.x5t && keyId && key.x5t === keyId);
  if (!jwk) {
    throw new Error('Azure AD signing key not found');
  }

  const publicKey = createPublicKey({ key: jwk as any, format: 'jwk' });
  const verified = verify('RSA-SHA256', Buffer.from(signedPart, 'utf8'), publicKey, signature);
  if (!verified) {
    throw new Error('Azure AD token signature verification failed');
  }

  const nowSeconds = Math.floor(Date.now() / 1000);
  if (typeof payload.exp !== 'number' || payload.exp <= nowSeconds) {
    throw new Error('Azure AD token has expired');
  }
  if (typeof payload.nbf === 'number' && payload.nbf > nowSeconds) {
    throw new Error('Azure AD token is not yet valid');
  }
  if (payload.iss !== metadata.issuer) {
    throw new Error('Azure AD token issuer mismatch');
  }
  if (payload.aud !== config.azureAd.clientId) {
    throw new Error('Azure AD token audience mismatch');
  }
  if (payload.tid && payload.tid !== config.azureAd.tenantId) {
    throw new Error('Azure AD token tenant mismatch');
  }

  const email = normalizeEmail(
    getClaimString(payload, ['preferred_username', 'email', 'upn'])
  );
  if (!email) {
    throw new Error('Azure AD token does not contain an email claim');
  }

  return {
    email,
    name: getClaimString(payload, ['name', 'preferred_username', 'email', 'upn']) || email,
    oid: typeof payload.oid === 'string' ? payload.oid : undefined,
    tid: typeof payload.tid === 'string' ? payload.tid : undefined,
    claims: payload,
  };
}

export function isAzureAdConfigured(): boolean {
  return getAzureAdEnabled();
}

function extractDerFromPem(pem: string): Buffer {
  const base64 = pem
    .replace(/-----BEGIN [^\n]+-----/g, '')
    .replace(/-----END [^\n]+-----/g, '')
    .replace(/\r?\n/g, '');
  return Buffer.from(base64, 'base64');
}

function getCertSha256Thumbprint(pem: string): string {
  const der = extractDerFromPem(pem);
  return createHash('sha256').update(der).digest('hex');
}

function getMsalClient(): ConfidentialClientApplication {
  if (msalClient) return msalClient;

  const { clientId, tenantId, certPrivateKeyPath, certPublicPath } = config.azureAd;
  if (!clientId || !tenantId || !certPrivateKeyPath || !certPublicPath) {
    throw new Error('Azure AD certificate configuration is incomplete');
  }

  const privateKeyPem = readFileSync(certPrivateKeyPath, 'utf-8');
  // MSAL Node requires a PKCS#8 PEM.
  const privateKey = createPrivateKey(privateKeyPem).export({ format: 'pem', type: 'pkcs8' }).toString();

  const publicCertPem = readFileSync(certPublicPath, 'utf-8');
  const thumbprintSha256 = getCertSha256Thumbprint(publicCertPem);

  msalClient = new ConfidentialClientApplication({
    auth: {
      clientId,
      authority: `https://login.microsoftonline.com/${tenantId}`,
      clientCertificate: { privateKey, thumbprintSha256, x5c: publicCertPem },
    },
  });

  return msalClient;
}

const CALLBACK_URI = `${config.azureAd.redirectUri}/api/auth/callback`;

export function generateAuthState(): string {
  return randomBytes(32).toString('hex');
}

export async function getAzureAdLoginUrl(state: string): Promise<string> {
  const client = getMsalClient();
  return await client.getAuthCodeUrl({
    scopes: ['openid', 'profile', 'email'],
    redirectUri: CALLBACK_URI,
    state,
    prompt: 'select_account',
    responseMode: 'query' as any,
  });
}

export async function handleAzureAdCallback(req: Request, res: Response): Promise<void> {
  const client = getMsalClient();

  const { code, state, error, error_description } = req.query;
  const cookieState = req.cookies?.[STATE_COOKIE];

  if (error) {
    throw new Error(`Azure AD authorization error: ${error} - ${error_description}`);
  }

  if (typeof code !== 'string' || !code) {
    throw new Error('Azure AD callback did not include an authorization code');
  }

  if (!state || typeof state !== 'string' || state !== cookieState) {
    throw new Error('Azure AD state validation failed');
  }

  const result = await client.acquireTokenByCode({
    code,
    redirectUri: CALLBACK_URI,
    scopes: ['openid', 'profile', 'email'],
  });

  const idToken = result.idToken;
  if (!idToken) {
    throw new Error('Azure AD token response did not include an id token');
  }

  const user = await authenticateAzureAdRequest({
    headers: { authorization: `Bearer ${idToken}` },
    cookies: {},
  } as Request);

  const cookieOptions = {
    httpOnly: true,
    sameSite: 'lax' as const,
    secure: config.nodeEnv === 'production',
    maxAge: 24 * 60 * 60 * 1000,
  };

  res.clearCookie(STATE_COOKIE, cookieOptions);
  res.cookie(TOKEN_COOKIE, idToken, cookieOptions);

  res.redirect('/');
}

export function signOutAzureAd(res: Response): void {
  res.clearCookie(TOKEN_COOKIE, { httpOnly: true, sameSite: 'lax' as const, secure: config.nodeEnv === 'production' });
  res.clearCookie(STATE_COOKIE, { httpOnly: true, sameSite: 'lax' as const, secure: config.nodeEnv === 'production' });
}
