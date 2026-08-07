export type AzureAdUser = {
  email: string;
  name: string;
};

export async function fetchAzureAdUser(): Promise<AzureAdUser | null> {
  try {
    const response = await fetch('/api/auth/me', { credentials: 'include' });
    if (!response.ok) return null;
    const data = await response.json().catch(() => ({}));
    if (typeof data.email === 'string') {
      return {
        email: data.email,
        name: typeof data.name === 'string' ? data.name : data.email,
      };
    }
    return null;
  } catch {
    return null;
  }
}

export function ensureAzureAdLogin(): void {
  window.location.href = '/api/auth/login';
}

export function signOutAzureAd(): void {
  window.location.href = '/api/auth/logout';
}
