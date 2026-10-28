import React, { useState } from 'react';
import { useLocation, Link } from 'wouter';
import { useAuth } from '@/hooks/use-auth';
import {
  Shield,
  Lock,
  Mail,
  User,
  Building,
  ArrowRight,
  AlertCircle,
  Loader2,
  Wrench,
  CheckCircle2,
} from 'lucide-react';

export default function Register() {
  const [, setLocation] = useLocation();
  const { register, isLoading, error: authError } = useAuth();

  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [organizationName, setOrganizationName] = useState('');
  const [localError, setLocalError] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setLocalError('');
    if (!name || !email || !password) {
      setLocalError('Please fill out all required fields.');
      return;
    }
    if (password.length < 8) {
      setLocalError('Password must be at least 8 characters long.');
      return;
    }
    setIsSubmitting(true);
    try {
      await register({
        name,
        email,
        password,
        organizationName: organizationName || `${name.split(' ')[0]}'s Org`,
      });
      setLocation('/');
    } catch (err) {
      setLocalError(err.message || 'Registration failed');
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
          <h1 className="text-2xl font-bold tracking-tight text-white">Register Organization</h1>
          <p className="mt-1 text-xs text-muted-foreground">
            Deploy an isolated autonomous software repair workspace with enterprise governance
          </p>
        </div>

        {/* Form Card */}
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
                Organization / Workspace Name
              </label>
              <div className="relative">
                <Building size={16} className="absolute left-3 top-3 text-muted-foreground" />
                <input
                  type="text"
                  value={organizationName}
                  onChange={(e) => setOrganizationName(e.target.value)}
                  placeholder="e.g. Acme Software"
                  data-testid="input-register-org"
                  className="w-full rounded-lg border border-border bg-secondary/50 py-2.5 pl-9 pr-3 text-xs text-foreground placeholder-muted-foreground focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent"
                />
              </div>
            </div>

            <div>
              <label className="mb-1.5 block ff-mono text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                Administrator Full Name
              </label>
              <div className="relative">
                <User size={16} className="absolute left-3 top-3 text-muted-foreground" />
                <input
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Jane Doe"
                  data-testid="input-register-name"
                  required
                  className="w-full rounded-lg border border-border bg-secondary/50 py-2.5 pl-9 pr-3 text-xs text-foreground placeholder-muted-foreground focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent"
                />
              </div>
            </div>

            <div>
              <label className="mb-1.5 block ff-mono text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                Work Email Address
              </label>
              <div className="relative">
                <Mail size={16} className="absolute left-3 top-3 text-muted-foreground" />
                <input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="admin@company.com"
                  data-testid="input-register-email"
                  required
                  className="w-full rounded-lg border border-border bg-secondary/50 py-2.5 pl-9 pr-3 text-xs text-foreground placeholder-muted-foreground focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent"
                />
              </div>
            </div>

            <div>
              <label className="mb-1.5 block ff-mono text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                Master Password (min. 8 characters)
              </label>
              <div className="relative">
                <Lock size={16} className="absolute left-3 top-3 text-muted-foreground" />
                <input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="••••••••••••"
                  data-testid="input-register-password"
                  required
                  className="w-full rounded-lg border border-border bg-secondary/50 py-2.5 pl-9 pr-3 text-xs text-foreground placeholder-muted-foreground focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent"
                />
              </div>
            </div>

            <div className="rounded-xl border border-border/60 bg-secondary/30 p-3 text-[11px] text-muted-foreground">
              <div className="flex items-center gap-2 font-medium text-foreground">
                <CheckCircle2 size={14} className="text-emerald-400" /> Enterprise Isolation Included
              </div>
              <p className="mt-1">
                Your workspace is assigned an isolated tenant ID, default approval policies, and cryptographic RBAC security.
              </p>
            </div>

            <button
              type="submit"
              disabled={isSubmitting || isLoading}
              data-testid="button-submit-register"
              className="mt-2 flex w-full items-center justify-center gap-2 rounded-xl bg-accent py-2.5 text-xs font-semibold text-accent-foreground shadow-md transition-all hover:bg-accent/90 disabled:opacity-50"
            >
              {isSubmitting ? (
                <>
                  <Loader2 size={15} className="animate-spin" /> Creating Organization...
                </>
              ) : (
                <>
                  Create Workspace & Sign In <ArrowRight size={15} />
                </>
              )}
            </button>
          </form>

          <div className="mt-5 border-t border-border/80 pt-4 text-center">
            <p className="text-xs text-muted-foreground">
              Already have an enterprise account?{' '}
              <Link href="/login" className="font-semibold text-accent hover:underline">
                Sign in
              </Link>
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
