// Determine environment from base path to avoid token conflicts between dev and prod
const getEnvironment = (): 'prod' | 'dev' => {
  const basePath = import.meta.env.BASE_URL || '/';
  return basePath.includes('/dashboard-dev/') ? 'dev' : 'prod';
};

const TOKEN_KEY = `nim_auth_token_${getEnvironment()}`;
const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || '/api';

export const auth = {
  // Get token from localStorage
  getToken(): string | null {
    return localStorage.getItem(TOKEN_KEY);
  },

  // Save token to localStorage
  setToken(token: string): void {
    localStorage.setItem(TOKEN_KEY, token);
  },

  // Remove token from localStorage
  clearToken(): void {
    localStorage.removeItem(TOKEN_KEY);
  },

  // Check if user is authenticated (has valid token)
  isAuthenticated(): boolean {
    return !!this.getToken();
  },

  // Login with password
  async login(password: string): Promise<{ success: boolean; error?: string }> {
    try {
      const response = await fetch(`${API_BASE_URL}/auth/login`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ password }),
      });

      const data = await response.json();

      if (response.ok && data.token) {
        this.setToken(data.token);
        return { success: true };
      }

      return { success: false, error: data.message || 'Login failed' };
    } catch (error) {
      return { success: false, error: 'Network error' };
    }
  },

  // Logout
  logout(): void {
    this.clearToken();
    window.location.reload();
  },
};

// Fetch wrapper that adds auth token to all requests
export async function authenticatedFetch(url: string, options: RequestInit = {}): Promise<Response> {
  const token = auth.getToken();
  
  const headers = {
    ...options.headers,
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };

  const response = await fetch(url, { ...options, headers });

  // If 401, reload to show login page
  if (response.status === 401) {
    auth.clearToken();
    window.location.reload();
  }

  return response;
}
