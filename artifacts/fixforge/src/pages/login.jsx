import React, { useState } from 'react';
import { useLocation, Link } from 'wouter';
import { useAuth, DEMO_PERSONAS } from '@/hooks/use-auth';
import {
  Shield,
  Lock,
  Mail,
  UserCheck,
  Code2,
  Eye,
  Building,
  ArrowRight,
  AlertCircle,
  Loader2,
  Wrench,
} from 'lucide-react';

export default function Login() {
  const [, setLocation] = useLocation();
  const { login, switchDemoUser, isLoading, error: authError } = useAuth();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [localError, setLocalError] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setLocalError('');
    if (!email || !password) {
      setLocalError('Please enter both email and password.');
      return;
    }
    setIsSubmitting(true);
    try {
      await login(email, password);
      setLocation('/');
    } catch (err) {
      setLocalError(err.message || 'Login failed');
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleQuickPersona = async (key) => {
    setLocalError('');
    setIsSubmitting(true);
    try {
      await switchDemoUser(key);
      setLocation('/');
    } catch (err) {
      setLocalError(err.message || 'Quick login failed');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="flex min-h-[85vh] flex-col items-center justify-center px-4 py-8">
      <div className="w-full max-w-[480px]">
        {/* Brand Header */}
        <div className="mb-8 text-center">
          <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-2xl bg-accent text-accent-foreground shadow-lg shadow-accent/20">
            <Wrench size={24} strokeWidth={2.5} />
          </div>
          <h1 className="text-2xl font-bold tracking-tight text-white">FixForge Enterprise</h1>
          <p className="mt-1 text-xs text-muted-foreground">
            Role-Based Access Control · Human Review Gates · Multi-Tenant Isolation
          </p>
        </div>

        {/* Demo Personas Card */}
        <div className="mb-6 rounded-2xl border border-border/80 bg-card/60 p-5 backdrop-blur-md">
          <div className="mb-3 flex items-center justify-between">
            <span className="ff-mono text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
              ⚡ Quick Demo Personas
            </span>
            <span className="ff-mono text-[9px] text-muted-foreground/80">Click to sign in instantly</span>
          </div>

          <div className="grid grid-cols-2 gap-2 sm:grid-cols-2">
            {Object.values(DEMO_PERSONAS).map((p) => {
              const Icon =
                p.role === 'ADMIN' && p.key === 'admin'
                  ? Shield
                  : p.role === 'MANAGER'
                  ? UserCheck
                  : p.role === 'DEVELOPER'
                  ? Code2
                  : p.role === 'VIEWER'
                  ? Eye
                  : Building;

              return (
                <button
                  key={p.key}
                  type="button"
                  onClick={() => handleQuickPersona(p.key)}
                  disabled={isSubmitting || isLoading}
                  data-testid={`persona-btn-${p.key}`}
                  className="group flex flex-col items-start rounded-xl border border-border/70 bg-secondary/40 p-3 text-left transition-all hover:-translate-y-0.5 hover:border-accent hover:bg-secondary/70 disabled:opacity-50"
                >
                  <div className="flex w-full items-center justify-between">
                    <span className="flex items-center gap-1.5 text-xs font-semibold text-foreground group-hover:text-accent">
                      <Icon size={14} />
                      {p.role}
                    </span>
                    <span className="ff-mono text-[9px] text-muted-foreground">{p.org.split(' ')[0]}</span>
                  </div>
                  <span className="mt-1 text-[11px] text-muted-foreground line-clamp-1">{p.name}</span>
                </button>
              );
            })}
          </div>
        </div>

        {/* Credentials Login Form */}
        <div className="rounded-2xl border border-border/80 bg-card p-6 shadow-xl">
          <form onSubmit={handleSubmit} className="space-y-4">
            {(localError || authError) && (
              <div className="flex items-center gap-2 rounded-lg border border-red-500/20 bg-red-500/10 p-3 text-xs text-red-400">
                <AlertCircle size={15} className="shrink-0" />
                <span>{localError || authError}</span>
              </div>
            )}

            <div>
              <label className="mb-1.5 block ff-mono text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                Email Address
              </label>
              <div className="relative">
                <Mail size={16} className="absolute left-3 top-3 text-muted-foreground" />
                <input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="admin@fixforge.internal"
                  data-testid="input-login-email"
                  required
                  className="w-full rounded-lg border border-border bg-secondary/50 py-2.5 pl-9 pr-3 text-xs text-foreground placeholder-muted-foreground focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent"
                />
              </div>
            </div>

            <div>
              <div className="mb-1.5 flex items-center justify-between">
                <label className="block ff-mono text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                  Password
                </label>
              </div>
              <div className="relative">
                <Lock size={16} className="absolute left-3 top-3 text-muted-foreground" />
                <input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="••••••••••••"
                  data-testid="input-login-password"
                  required
                  className="w-full rounded-lg border border-border bg-secondary/50 py-2.5 pl-9 pr-3 text-xs text-foreground placeholder-muted-foreground focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent"
                />
              </div>
            </div>

            <button
              type="submit"
              disabled={isSubmitting || isLoading}
              data-testid="button-submit-login"
              className="mt-2 flex w-full items-center justify-center gap-2 rounded-xl bg-accent py-2.5 text-xs font-semibold text-accent-foreground shadow-md transition-all hover:bg-accent/90 disabled:opacity-50"
            >
              {isSubmitting ? (
                <>
                  <Loader2 size={15} className="animate-spin" /> Authenticating...
                </>
              ) : (
                <>
                  Sign In <ArrowRight size={15} />
                </>
              )}
            </button>
          </form>

          <div className="mt-5 border-t border-border/80 pt-4 text-center">
            <p className="text-xs text-muted-foreground">
              New organization?{' '}
              <Link href="/register" className="font-semibold text-accent hover:underline">
                Create an enterprise workspace
              </Link>
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
