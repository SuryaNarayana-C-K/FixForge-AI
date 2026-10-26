import { useState, useRef, useEffect } from 'react';
import { Link, useLocation } from 'wouter';
import {
  Activity,
  ArrowUpRight,
  ChevronRight,
  ChevronDown,
  CircleDot,
  Command,
  GitBranch,
  History,
  LayoutDashboard,
  Plus,
  Wrench,
  Shield,
  ShieldAlert,
  User,
  Building,
  LogOut,
  UserCheck,
  Code2,
  Eye,
} from 'lucide-react';
import { useAuth, DEMO_PERSONAS } from '@/hooks/use-auth';

export function AppShell({ children }) {
  const [location] = useLocation();
  const { user, role, organization, isAdmin, isManager, switchDemoUser, logout } = useAuth();
  const [isDropdownOpen, setIsDropdownOpen] = useState(false);
  const dropdownRef = useRef(null);

  // Close dropdown on outside click
  useEffect(() => {
    function handleClickOutside(event) {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target)) {
        setIsDropdownOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const navItems = [
    { href: '/', label: 'Overview', icon: LayoutDashboard },
    { href: '/repairs', label: 'Repairs', icon: History },
    { href: '/observability', label: 'Observability', icon: Activity },
    ...(isAdmin || isManager
      ? [{ href: '/admin', label: 'Governance & Admin', icon: Shield }]
      : []),
  ];

  const roleColor =
    role === 'ADMIN'
      ? 'bg-red-500/20 text-red-400 border-red-500/30'
      : role === 'MANAGER'
      ? 'bg-purple-500/20 text-purple-400 border-purple-500/30'
      : role === 'DEVELOPER'
      ? 'bg-sky-500/20 text-sky-400 border-sky-500/30'
      : 'bg-emerald-500/20 text-emerald-400 border-emerald-500/30';

  const userInitials = user?.name
    ? user.name
        .split(' ')
        .map((n) => n[0])
        .join('')
        .toUpperCase()
        .slice(0, 2)
    : 'FM';

  return (
    <div className="ff-noise min-h-[100dvh] bg-background text-foreground">
      {/* Sidebar */}
      <aside className="fixed inset-y-0 left-0 z-40 hidden w-[256px] flex-col border-r border-sidebar-border bg-sidebar text-sidebar-foreground lg:flex">
        <div className="flex h-20 items-center gap-3 border-b border-sidebar-border px-6">
          <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-accent text-accent-foreground shadow-[0_0_0_5px_rgba(231,169,58,.12)]">
            <Wrench size={18} strokeWidth={2.5} />
          </div>
          <div>
            <div className="font-semibold tracking-tight text-white">FixForge</div>
            <div className="ff-mono text-[9px] uppercase tracking-[.22em] text-sidebar-foreground/55">
              repair control room
            </div>
          </div>
        </div>

        <div className="flex-1 px-3 py-6">
          {/* Tenant Org Header */}
          <div className="mb-4 rounded-xl border border-sidebar-border bg-sidebar-accent/50 p-3">
            <div className="flex items-center gap-2 text-xs font-semibold text-white truncate">
              <Building size={14} className="text-accent shrink-0" />
              <span className="truncate">{organization?.name || user?.organization?.name || 'FixForge Labs'}</span>
            </div>
            <div className="mt-1 flex items-center justify-between text-[10px] text-sidebar-foreground/60">
              <span className="ff-mono uppercase">{organization?.tier || 'ENTERPRISE'}</span>
              <span className={`rounded border px-1.5 py-0.2 ff-mono font-semibold ${roleColor}`}>
                {role}
              </span>
            </div>
          </div>

          <div className="mb-2 px-3 ff-mono text-[10px] uppercase tracking-[.24em] text-sidebar-foreground/45">
            Workspace
          </div>
          <nav className="space-y-1">
            {navItems.map(({ href, label, icon: Icon }) => {
              const active =
                href === '/'
                  ? location === '/'
                  : location.startsWith(href === '/projects/demo' ? '/projects' : href);
              return (
                <Link
                  key={href}
                  href={href}
                  data-testid={`link-nav-${label.toLowerCase().replace(/[^a-z0-9]/g, '-')}`}
                  className={`group flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm ${
                    active
                      ? 'bg-sidebar-accent text-white font-medium'
                      : 'text-sidebar-foreground/65 hover:bg-sidebar-accent/70 hover:text-sidebar-foreground'
                  }`}
                >
                  <Icon
                    size={16}
                    className={
                      active
                        ? 'text-accent'
                        : 'text-sidebar-foreground/50 group-hover:text-sidebar-foreground'
                    }
                  />
                  <span className="flex-1">{label}</span>
                  {active && <ChevronRight size={14} className="text-sidebar-foreground/35" />}
                </Link>
              );
            })}
          </nav>

          <div className="mt-8 mb-2 px-3 ff-mono text-[10px] uppercase tracking-[.24em] text-sidebar-foreground/45">
            Security Status
          </div>
          <div className="rounded-xl border border-sidebar-border bg-sidebar-accent/45 p-3">
            <div className="mb-2 flex items-center gap-2 text-xs font-medium text-sidebar-foreground/80">
              <CircleDot size={13} className="text-emerald-400" /> RBAC & Defense Active
            </div>
            <div className="space-y-1.5 text-[11px] text-sidebar-foreground/50">
              <div className="flex items-center justify-between">
                <span>Human Approval</span>
                <span className="text-emerald-400 font-semibold">ENFORCED</span>
              </div>
              <div className="flex items-center justify-between">
                <span>Multi-Tenant</span>
                <span className="text-emerald-400 font-semibold">ISOLATED</span>
              </div>
              <div className="flex items-center justify-between">
                <span>Secret Masking</span>
                <span className="text-emerald-400 font-semibold">ACTIVE</span>
              </div>
            </div>
          </div>
        </div>

        <div className="border-t border-sidebar-border p-4">
          <div className="flex items-center justify-between text-[11px] text-sidebar-foreground/45">
            <span className="ff-mono">M9 Enterprise · v1.9.0</span>
            <Command size={14} />
          </div>
        </div>
      </aside>

      {/* Main Content Area */}
      <div className="lg:pl-[256px]">
        {/* Header */}
        <header className="sticky top-0 z-30 flex h-16 items-center justify-between border-b border-border/80 bg-background/90 px-5 backdrop-blur-md lg:px-10">
          <div className="flex items-center gap-2 lg:hidden">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary text-primary-foreground">
              <Wrench size={15} />
            </div>
            <span className="font-semibold">FixForge</span>
          </div>

          <div className="hidden items-center gap-3 text-xs text-muted-foreground lg:flex">
            <div className="flex items-center gap-1.5">
              <Building size={14} className="text-accent" />
              <span className="font-semibold text-foreground">
                {organization?.name || user?.organization?.name || 'FixForge Labs'}
              </span>
            </div>
            <span className="h-1 w-1 rounded-full bg-muted-foreground/50" />
            <div className="flex items-center gap-1.5">
              <Activity size={13} className="text-emerald-400" />
              <span>Multi-Tenant Enterprise Guard</span>
            </div>
          </div>

          {/* User Controls & Quick Persona Switcher */}
          <div className="flex items-center gap-3">
            <Link
              href="/new-repair"
              data-testid="link-header-new-repair"
              className="inline-flex items-center gap-2 rounded-lg bg-primary px-3.5 py-2 text-xs font-semibold text-primary-foreground shadow-sm hover:-translate-y-px hover:bg-primary/90"
            >
              <Plus size={15} /> New repair
            </Link>

            {/* Persona Switcher / Profile Dropdown */}
            <div className="relative" ref={dropdownRef}>
              <button
                type="button"
                onClick={() => setIsDropdownOpen(!isDropdownOpen)}
                data-testid="button-user-menu"
                className="flex items-center gap-2 rounded-xl border border-border bg-card/80 px-2.5 py-1.5 text-xs transition-colors hover:bg-secondary/60"
              >
                <div
                  className="flex h-7 w-7 items-center justify-center rounded-lg border border-border bg-secondary font-semibold text-foreground"
                  data-testid="text-user-avatar"
                >
                  {userInitials}
                </div>
                <div className="hidden flex-col items-start text-left sm:flex">
                  <span className="text-xs font-semibold text-foreground line-clamp-1">
                    {user?.name || 'Demo Admin'}
                  </span>
                  <span className={`rounded border px-1 py-0 ff-mono text-[9px] font-bold ${roleColor}`}>
                    {role}
                  </span>
                </div>
                <ChevronDown size={14} className="text-muted-foreground" />
              </button>

              {/* Dropdown Menu */}
              {isDropdownOpen && (
                <div className="absolute right-0 mt-2 w-72 rounded-2xl border border-border bg-card p-3 shadow-2xl z-50">
                  <div className="mb-2 border-b border-border/80 pb-2.5 px-1">
                    <div className="font-semibold text-sm text-foreground">{user?.name || 'FixForge User'}</div>
                    <div className="ff-mono text-xs text-muted-foreground truncate">{user?.email || 'admin@fixforge.internal'}</div>
                    <div className="mt-1 flex items-center gap-2">
                      <span className={`rounded border px-1.5 py-0.2 ff-mono text-[10px] font-bold ${roleColor}`}>
                        {role}
                      </span>
                      <span className="ff-mono text-[10px] text-muted-foreground">
                        {organization?.name || 'FixForge Labs'}
                      </span>
                    </div>
                  </div>

                  <div className="my-2 px-1">
                    <div className="ff-mono text-[9px] font-semibold uppercase tracking-wider text-muted-foreground mb-1.5">
                      Switch Demo Persona (M9 RBAC)
                    </div>
                    <div className="space-y-1">
                      {Object.values(DEMO_PERSONAS).map((p) => (
                        <button
                          key={p.key}
                          type="button"
                          onClick={async () => {
                            await switchDemoUser(p.key);
                            setIsDropdownOpen(false);
                          }}
                          className={`flex w-full items-center justify-between rounded-lg px-2.5 py-1.5 text-xs text-left transition-colors ${
                            user?.email === p.email
                              ? 'bg-secondary font-semibold text-foreground'
                              : 'text-muted-foreground hover:bg-secondary/60 hover:text-foreground'
                          }`}
                        >
                          <span className="flex items-center gap-2">
                            <span className="w-1.5 h-1.5 rounded-full bg-accent" />
                            {p.name}
                          </span>
                          <span className="ff-mono text-[10px]">{p.role}</span>
                        </button>
                      ))}
                    </div>
                  </div>

                  <div className="border-t border-border/80 pt-2 px-1">
                    <Link
                      href="/login"
                      onClick={() => setIsDropdownOpen(false)}
                      className="flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-xs text-muted-foreground hover:bg-secondary/60 hover:text-foreground"
                    >
                      <User size={14} /> Go to Login Page
                    </Link>
                    <button
                      type="button"
                      onClick={async () => {
                        await logout();
                        setIsDropdownOpen(false);
                      }}
                      className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-xs text-red-400 hover:bg-red-500/10"
                    >
                      <LogOut size={14} /> Sign Out
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>
        </header>

        {/* Mobile Navigation */}
        <nav className="flex items-center gap-1 border-b border-border/70 bg-background px-4 py-2 lg:hidden overflow-x-auto">
          <Link
            href="/"
            data-testid="link-mobile-overview"
            className={`rounded-md px-3 py-1.5 text-xs font-medium shrink-0 ${
              location === '/' ? 'bg-secondary text-foreground' : 'text-muted-foreground'
            }`}
          >
            Overview
          </Link>
          <Link
            href="/repairs"
            data-testid="link-mobile-repairs"
            className={`rounded-md px-3 py-1.5 text-xs font-medium shrink-0 ${
              location.startsWith('/repairs') ? 'bg-secondary text-foreground' : 'text-muted-foreground'
            }`}
          >
            Repairs
          </Link>
          <Link
            href="/observability"
            data-testid="link-mobile-observability"
            className={`rounded-md px-3 py-1.5 text-xs font-medium shrink-0 ${
              location.startsWith('/observability') ? 'bg-secondary text-foreground' : 'text-muted-foreground'
            }`}
          >
            Observability
          </Link>
          {(isAdmin || isManager) && (
            <Link
              href="/admin"
              data-testid="link-mobile-admin"
              className={`rounded-md px-3 py-1.5 text-xs font-medium shrink-0 ${
                location.startsWith('/admin') ? 'bg-secondary text-foreground' : 'text-muted-foreground'
              }`}
            >
              Governance
            </Link>
          )}
        </nav>

        {/* Main Content */}
        <main className="ff-grid min-h-[calc(100dvh-4rem)] px-5 py-8 lg:px-10 lg:py-10">
          {children}
        </main>
      </div>
    </div>
  );
}

export function RepoMark({ value }) {
  return (
    <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-secondary text-muted-foreground">
      <GitBranch size={15} />
    </div>
  );
}

export function ExternalArrow() {
  return <ArrowUpRight size={14} />;
}
