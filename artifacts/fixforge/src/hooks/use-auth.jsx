import React, { createContext, useContext, useState, useEffect, useCallback } from 'react';
import { setAuthTokenGetter } from '@workspace/api-client-react';

const TOKEN_KEY = 'fixforge_auth_token';

export const DEMO_PERSONAS = {
  admin: {
    key: 'admin',
    name: 'Admin User',
    email: 'admin@fixforge.local',
    password: 'DemoAdmin123!',
    role: 'ADMIN',
    org: 'FixForge Labs',
    description: 'Full system & org management, approval, policy editing',
    color: 'border-red-500/30 bg-red-500/10 text-red-400',
  },
  manager: {
    key: 'manager',
    name: 'Repair Manager',
    email: 'manager@fixforge.local',
    password: 'DemoManager123!',
    role: 'MANAGER',
    org: 'FixForge Labs',
    description: 'Repair approvals, member management, PR governance',
    color: 'border-purple-500/30 bg-purple-500/10 text-purple-400',
  },
  dev: {
    key: 'dev',
    name: 'Core Developer',
    email: 'developer@fixforge.local',
    password: 'DemoDeveloper123!',
    role: 'DEVELOPER',
    org: 'FixForge Labs',
    description: 'Repair generation, patch creation, code fixes',
    color: 'border-sky-500/30 bg-sky-500/10 text-sky-400',
  },
  viewer: {
    key: 'viewer',
    name: 'Auditor Viewer',
    email: 'viewer@fixforge.local',
    password: 'DemoViewer123!',
    role: 'VIEWER',
    org: 'FixForge Labs',
    description: 'Read-only access to repairs and dashboards (cannot approve or PR)',
    color: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-400',
  },
  acme: {
    key: 'acme',
    name: 'Acme Developer',
    email: 'acme-dev@acme.local',
    password: 'AcmeDev123!',
    role: 'DEVELOPER',
    org: 'Acme Corporation',
    description: 'Isolated enterprise org (proves multi-tenant data boundaries)',
    color: 'border-amber-500/30 bg-amber-500/10 text-amber-400',
  },
};

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [token, setToken] = useState(() => localStorage.getItem(TOKEN_KEY));
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState(null);

  // Register the auth token getter with the OpenAPI React query client
  useEffect(() => {
    setAuthTokenGetter(() => localStorage.getItem(TOKEN_KEY));
  }, []);

  const fetchCurrentUser = useCallback(async (authToken) => {
    const t = authToken || localStorage.getItem(TOKEN_KEY);
    if (!t) {
      setUser(null);
      setIsLoading(false);
      return null;
    }
    try {
      setIsLoading(true);
      const res = await fetch('/api/auth/me', {
        headers: {
          Authorization: `Bearer ${t}`,
        },
      });
      if (res.ok) {
        const data = await res.json();
        setUser(data.user);
        setError(null);
        return data.user;
      } else {
        // Token invalid or expired
        localStorage.removeItem(TOKEN_KEY);
        setToken(null);
        setUser(null);
        return null;
      }
    } catch (err) {
      console.error('Failed to fetch user:', err);
      setError(err.message);
      return null;
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchCurrentUser(token);
  }, [fetchCurrentUser, token]);

  const login = async (email, password) => {
    setIsLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || 'Login failed');
      }
      localStorage.setItem(TOKEN_KEY, data.token);
      setToken(data.token);
      setUser(data.user);
      return data.user;
    } catch (err) {
      setError(err.message);
      throw err;
    } finally {
      setIsLoading(false);
    }
  };

  const register = async ({ email, password, name, organizationName }) => {
    setIsLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/auth/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password, name, organizationName }),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || 'Registration failed');
      }
      localStorage.setItem(TOKEN_KEY, data.token);
      setToken(data.token);
      setUser(data.user);
      return data.user;
    } catch (err) {
      setError(err.message);
      throw err;
    } finally {
      setIsLoading(false);
    }
  };

  const logout = async () => {
    try {
      if (token) {
        await fetch('/api/auth/logout', {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}` },
        }).catch(() => {});
      }
    } finally {
      localStorage.removeItem(TOKEN_KEY);
      setToken(null);
      setUser(null);
    }
  };

  const switchDemoUser = async (personaKey) => {
    const persona = DEMO_PERSONAS[personaKey];
    if (!persona) return;
    return await login(persona.email, persona.password);
  };

  const role = user?.role || 'VIEWER';
  const organization = user?.organization || null;

  const value = {
    user,
    token,
    role,
    organization,
    isLoading,
    error,
    login,
    register,
    logout,
    switchDemoUser,
    refreshUser: () => fetchCurrentUser(token),
    isAdmin: role === 'ADMIN',
    isManager: role === 'MANAGER',
    isDeveloper: role === 'DEVELOPER',
    isViewer: role === 'VIEWER',
    canApprove: role === 'ADMIN' || role === 'MANAGER',
    canManagePolicy: role === 'ADMIN',
    canManageMembers: role === 'ADMIN' || role === 'MANAGER',
    canCreatePR: role !== 'VIEWER',
    canExecuteRepair: role !== 'VIEWER',
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
}
