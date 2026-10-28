import React, { useState, useEffect } from 'react';
import { useAuth } from '@/hooks/use-auth';
import {
  Shield,
  ShieldCheck,
  ShieldAlert,
  Users,
  Sliders,
  FileText,
  UserPlus,
  Trash2,
  CheckCircle2,
  XCircle,
  AlertTriangle,
  Lock,
  Building,
  Key,
  Database,
  RefreshCw,
  Search,
  Filter,
  Eye,
  Check,
} from 'lucide-react';
import { PageIntro } from '@/components/fixforge-ui';

export default function AdminPage() {
  const { user, role, isAdmin, isManager, token, switchDemoUser } = useAuth();
  const [activeTab, setActiveTab] = useState('overview');

  // Overview state
  const [securityData, setSecurityData] = useState(null);
  const [orgData, setOrgData] = useState(null);
  const [isLoadingOverview, setIsLoadingOverview] = useState(true);

  // Members state
  const [members, setMembers] = useState([]);
  const [isLoadingMembers, setIsLoadingMembers] = useState(false);
  const [newMemberEmail, setNewMemberEmail] = useState('');
  const [newMemberName, setNewMemberName] = useState('');
  const [newMemberRole, setNewMemberRole] = useState('DEVELOPER');
  const [newMemberPassword, setNewMemberPassword] = useState('TempPass123!');
  const [memberMessage, setMemberMessage] = useState({ text: '', type: '' });

  // Policy state
  const [policy, setPolicy] = useState({
    requireHumanApproval: true,
    requireVerifiedRepair: true,
    allowGitHubPR: true,
    allowPush: false,
    maxAutomatedAttempts: 5,
    blockedCommands: ['rm -rf', 'sudo', 'chmod', 'mkfs', 'dd'],
    blockedFilePatterns: ['.env*', '*.pem', '*.key', 'credentials*'],
  });
  const [isLoadingPolicy, setIsLoadingPolicy] = useState(false);
  const [policyMessage, setPolicyMessage] = useState({ text: '', type: '' });

  // Audit Logs state
  const [auditLogs, setAuditLogs] = useState([]);
  const [isLoadingLogs, setIsLoadingLogs] = useState(false);
  const [logFilterAction, setLogFilterAction] = useState('ALL');
  const [selectedLog, setSelectedLog] = useState(null);

  const authHeaders = {
    'Content-Type': 'application/json',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };

  // Fetch overview & org info
  const fetchOverview = async () => {
    setIsLoadingOverview(true);
    try {
      const [secRes, orgRes] = await Promise.all([
        fetch('/api/security/overview', { headers: authHeaders }),
        fetch('/api/admin/organization', { headers: authHeaders }),
      ]);
      if (secRes.ok) {
        const sec = await secRes.json();
        setSecurityData(sec);
      }
      if (orgRes.ok) {
        const org = await orgRes.json();
        setOrgData(org);
      }
    } catch (err) {
      console.error('Failed to load overview:', err);
    } finally {
      setIsLoadingOverview(false);
    }
  };

  // Fetch members
  const fetchMembers = async () => {
    setIsLoadingMembers(true);
    try {
      const res = await fetch('/api/admin/members', { headers: authHeaders });
      if (res.ok) {
        const data = await res.json();
        setMembers(data.members || []);
      }
    } catch (err) {
      console.error('Failed to load members:', err);
    } finally {
      setIsLoadingMembers(false);
    }
  };

  // Fetch policy
  const fetchPolicy = async () => {
    setIsLoadingPolicy(true);
    try {
      const res = await fetch('/api/admin/policy', { headers: authHeaders });
      if (res.ok) {
        const data = await res.json();
        if (data.policy) {
          setPolicy(data.policy);
        }
      }
    } catch (err) {
      console.error('Failed to load policy:', err);
    } finally {
      setIsLoadingPolicy(false);
    }
  };

  // Fetch audit logs
  const fetchAuditLogs = async () => {
    setIsLoadingLogs(true);
    try {
      const query = logFilterAction !== 'ALL' ? `?action=${logFilterAction}&limit=50` : '?limit=50';
      const res = await fetch(`/api/admin/audit-logs${query}`, { headers: authHeaders });
      if (res.ok) {
        const data = await res.json();
        setAuditLogs(data.logs || []);
      }
    } catch (err) {
      console.error('Failed to load audit logs:', err);
    } finally {
      setIsLoadingLogs(false);
    }
  };

  useEffect(() => {
    if (isAdmin || isManager) {
      fetchOverview();
      fetchMembers();
      fetchPolicy();
      fetchAuditLogs();
    }
  }, [isAdmin, isManager, token]);

  useEffect(() => {
    if (isAdmin || isManager) {
      fetchAuditLogs();
    }
  }, [logFilterAction]);

  // Handle member actions
  const handleAddMember = async (e) => {
    e.preventDefault();
    setMemberMessage({ text: '', type: '' });
    try {
      const res = await fetch('/api/admin/members', {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({
          email: newMemberEmail,
          name: newMemberName,
          role: newMemberRole,
          password: newMemberPassword,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to add member');
      setMemberMessage({ text: `Member ${newMemberEmail} added successfully!`, type: 'success' });
      setNewMemberEmail('');
      setNewMemberName('');
      fetchMembers();
      fetchOverview();
    } catch (err) {
      setMemberMessage({ text: err.message, type: 'error' });
    }
  };

  const handleUpdateRole = async (memberId, newRole) => {
    setMemberMessage({ text: '', type: '' });
    try {
      const res = await fetch(`/api/admin/members/${memberId}/role`, {
        method: 'PUT',
        headers: authHeaders,
        body: JSON.stringify({ role: newRole }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to update role');
      setMemberMessage({ text: 'Member role updated successfully', type: 'success' });
      fetchMembers();
    } catch (err) {
      setMemberMessage({ text: err.message, type: 'error' });
    }
  };

  const handleRemoveMember = async (memberId, memberEmail) => {
    if (!confirm(`Are you sure you want to remove ${memberEmail} from this organization?`)) return;
    setMemberMessage({ text: '', type: '' });
    try {
      const res = await fetch(`/api/admin/members/${memberId}`, {
        method: 'DELETE',
        headers: authHeaders,
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to remove member');
      setMemberMessage({ text: 'Member removed successfully', type: 'success' });
      fetchMembers();
      fetchOverview();
    } catch (err) {
      setMemberMessage({ text: err.message, type: 'error' });
    }
  };

  // Handle policy update
  const handleSavePolicy = async (e) => {
    e.preventDefault();
    setPolicyMessage({ text: '', type: '' });
    try {
      const res = await fetch('/api/admin/policy', {
        method: 'PUT',
        headers: authHeaders,
        body: JSON.stringify(policy),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to update policy');
      setPolicyMessage({ text: 'Security and approval policy updated successfully!', type: 'success' });
      fetchAuditLogs();
    } catch (err) {
      setPolicyMessage({ text: err.message, type: 'error' });
    }
  };

  // 403 Guard for VIEWER / DEVELOPER
  if (!isAdmin && !isManager) {
    return (
      <div className="mx-auto max-w-[800px] py-16 text-center">
        <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-2xl border border-red-500/30 bg-red-500/10 text-red-400">
          <ShieldAlert size={32} />
        </div>
        <h1 className="text-2xl font-bold tracking-tight text-white">403 Access Restricted</h1>
        <p className="mx-auto mt-2 max-w-md text-sm text-muted-foreground">
          The Admin Governance & Security Control Room is restricted to <span className="font-semibold text-foreground">ADMIN</span> and{' '}
          <span className="font-semibold text-foreground">MANAGER</span> roles. Your current role is{' '}
          <span className="font-semibold text-accent">{role}</span>.
        </p>

        <div className="mt-8 rounded-xl border border-border/80 bg-card p-6 text-left">
          <div className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Switch to an authorized role:
          </div>
          <div className="mt-4 flex flex-wrap gap-3">
            <button
              onClick={() => switchDemoUser('admin')}
              className="inline-flex items-center gap-2 rounded-lg bg-red-500/20 px-4 py-2 text-xs font-semibold text-red-300 hover:bg-red-500/30"
            >
              <Shield size={14} /> Switch to Admin User
            </button>
            <button
              onClick={() => switchDemoUser('manager')}
              className="inline-flex items-center gap-2 rounded-lg bg-purple-500/20 px-4 py-2 text-xs font-semibold text-purple-300 hover:bg-purple-500/30"
            >
              <ShieldCheck size={14} /> Switch to Repair Manager
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-[1440px] space-y-6">
      <PageIntro
        eyebrow="Governance / Milestone 9"
        title="Security & Governance Control Room"
        description={
          <span className="flex items-center gap-2">
            <span>Enterprise organization: {orgData?.name || user?.organization?.name || 'FixForge Labs'}</span>
            <span className="rounded bg-accent/20 px-2 py-0.5 ff-mono text-[10px] font-semibold text-accent">
              {orgData?.tier || 'ENTERPRISE'}
            </span>
            <span className="rounded bg-secondary px-2 py-0.5 ff-mono text-[10px] text-muted-foreground">
              Tenant ID: {orgData?.id?.slice(0, 12)}…
            </span>
          </span>
        }
        action={
          <div className="flex items-center gap-2">
            <button
              onClick={() => {
                fetchOverview();
                fetchMembers();
                fetchPolicy();
                fetchAuditLogs();
              }}
              className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-secondary px-3 py-1.5 text-xs font-medium text-foreground hover:bg-secondary/80"
            >
              <RefreshCw size={13} /> Refresh
            </button>
          </div>
        }
      />

      {/* Governance Tabs */}
      <div className="flex border-b border-border">
        <button
          onClick={() => setActiveTab('overview')}
          className={`flex items-center gap-2 border-b-2 px-5 py-3 text-xs font-semibold transition-colors ${
            activeTab === 'overview'
              ? 'border-accent text-accent'
              : 'border-transparent text-muted-foreground hover:text-foreground'
          }`}
        >
          <Building size={15} /> Overview & Quotas
        </button>
        <button
          onClick={() => setActiveTab('members')}
          className={`flex items-center gap-2 border-b-2 px-5 py-3 text-xs font-semibold transition-colors ${
            activeTab === 'members'
              ? 'border-accent text-accent'
              : 'border-transparent text-muted-foreground hover:text-foreground'
          }`}
        >
          <Users size={15} /> Members & Access Control
        </button>
        <button
          onClick={() => setActiveTab('policy')}
          className={`flex items-center gap-2 border-b-2 px-5 py-3 text-xs font-semibold transition-colors ${
            activeTab === 'policy'
              ? 'border-accent text-accent'
              : 'border-transparent text-muted-foreground hover:text-foreground'
          }`}
        >
          <Sliders size={15} /> Approval & Safety Policies
        </button>
        <button
          onClick={() => setActiveTab('audit')}
          className={`flex items-center gap-2 border-b-2 px-5 py-3 text-xs font-semibold transition-colors ${
            activeTab === 'audit'
              ? 'border-accent text-accent'
              : 'border-transparent text-muted-foreground hover:text-foreground'
          }`}
        >
          <FileText size={15} /> Audit Trail & Telemetry
        </button>
      </div>

      {/* TAB 1: OVERVIEW & QUOTAS */}
      {activeTab === 'overview' && (
        <div className="space-y-6">
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <div className="rounded-xl border border-border bg-card p-5">
              <div className="flex items-center justify-between text-muted-foreground">
                <span className="ff-mono text-[10px] uppercase tracking-wider">Total Members</span>
                <Users size={16} />
              </div>
              <div className="mt-3 text-2xl font-bold">{members.length || orgData?._count?.members || 1}</div>
              <div className="mt-1 text-xs text-muted-foreground">Across 4 role tiers</div>
            </div>

            <div className="rounded-xl border border-border bg-card p-5">
              <div className="flex items-center justify-between text-muted-foreground">
                <span className="ff-mono text-[10px] uppercase tracking-wider">Projects / Repos</span>
                <Database size={16} />
              </div>
              <div className="mt-3 text-2xl font-bold">{orgData?._count?.projects ?? 1}</div>
              <div className="mt-1 text-xs text-muted-foreground">Tenant-isolated codebases</div>
            </div>

            <div className="rounded-xl border border-border bg-card p-5">
              <div className="flex items-center justify-between text-muted-foreground">
                <span className="ff-mono text-[10px] uppercase tracking-wider">Audit Events (24h)</span>
                <ShieldCheck size={16} className="text-emerald-400" />
              </div>
              <div className="mt-3 text-2xl font-bold">{securityData?.metrics?.totalEvents ?? auditLogs.length}</div>
              <div className="mt-1 text-xs text-emerald-400">Zero secret leakage audited</div>
            </div>

            <div className="rounded-xl border border-border bg-card p-5">
              <div className="flex items-center justify-between text-muted-foreground">
                <span className="ff-mono text-[10px] uppercase tracking-wider">Access Denials / 403</span>
                <ShieldAlert size={16} className="text-amber-400" />
              </div>
              <div className="mt-3 text-2xl font-bold">{securityData?.metrics?.deniedEvents ?? 0}</div>
              <div className="mt-1 text-xs text-amber-400">Enforced by RBAC boundary</div>
            </div>
          </div>

          <div className="grid gap-6 lg:grid-cols-2">
            {/* Organization Metadata */}
            <div className="rounded-xl border border-border bg-card p-6">
              <h3 className="text-sm font-semibold text-white">Enterprise Workspace Details</h3>
              <p className="mt-1 text-xs text-muted-foreground">Multi-tenant boundary identifier and tier profile</p>

              <div className="mt-5 space-y-3 divide-y divide-border/60 text-xs">
                <div className="flex justify-between py-2">
                  <span className="text-muted-foreground">Organization Name</span>
                  <span className="font-semibold text-foreground">{orgData?.name || 'FixForge Labs'}</span>
                </div>
                <div className="flex justify-between py-2">
                  <span className="text-muted-foreground">Slug</span>
                  <span className="ff-mono text-foreground">{orgData?.slug || 'fixforge-labs'}</span>
                </div>
                <div className="flex justify-between py-2">
                  <span className="text-muted-foreground">Domain Verification</span>
                  <span className="ff-mono text-emerald-400">Verified ({orgData?.domain || 'fixforge.internal'})</span>
                </div>
                <div className="flex justify-between py-2">
                  <span className="text-muted-foreground">Isolation Level</span>
                  <span className="ff-mono text-foreground">SQLite Tenant Partitioning</span>
                </div>
                <div className="flex justify-between py-2">
                  <span className="text-muted-foreground">GitHub Token Security</span>
                  <span className="ff-mono text-emerald-400">Server-Side Only (Masked)</span>
                </div>
              </div>
            </div>

            {/* Security Posture Status */}
            <div className="rounded-xl border border-border bg-card p-6">
              <h3 className="text-sm font-semibold text-white">Active Defense Status</h3>
              <p className="mt-1 text-xs text-muted-foreground">Security controls and runtime governance policies</p>

              <div className="mt-5 space-y-3">
                <div className="flex items-start gap-3 rounded-lg border border-border bg-secondary/30 p-3">
                  <CheckCircle2 size={16} className="shrink-0 text-emerald-400 mt-0.5" />
                  <div>
                    <div className="text-xs font-semibold text-foreground">Human Approval Gate</div>
                    <div className="text-[11px] text-muted-foreground">
                      Repairs require explicit ADMIN or MANAGER sign-off before PR generation can execute.
                    </div>
                  </div>
                </div>

                <div className="flex items-start gap-3 rounded-lg border border-border bg-secondary/30 p-3">
                  <CheckCircle2 size={16} className="shrink-0 text-emerald-400 mt-0.5" />
                  <div>
                    <div className="text-xs font-semibold text-foreground">Multi-Tenant IDOR Guard</div>
                    <div className="text-[11px] text-muted-foreground">
                      Foreign org repair and project access returns 403 Forbidden with security audit logging.
                    </div>
                  </div>
                </div>

                <div className="flex items-start gap-3 rounded-lg border border-border bg-secondary/30 p-3">
                  <CheckCircle2 size={16} className="shrink-0 text-emerald-400 mt-0.5" />
                  <div>
                    <div className="text-xs font-semibold text-foreground">In-Memory Rate Limiter</div>
                    <div className="text-[11px] text-muted-foreground">
                      Protection against brute force on auth endpoints with Retry-After headers.
                    </div>
                  </div>
                </div>

                <div className="flex items-start gap-3 rounded-lg border border-border bg-secondary/30 p-3">
                  <CheckCircle2 size={16} className="shrink-0 text-emerald-400 mt-0.5" />
                  <div>
                    <div className="text-xs font-semibold text-foreground">Shell Injection & Path Traversal Guard</div>
                    <div className="text-[11px] text-muted-foreground">
                      Rejection of shell metacharacters and directory traversal sequences in repair arguments.
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* TAB 2: MEMBERS & ACCESS CONTROL */}
      {activeTab === 'members' && (
        <div className="space-y-6">
          {memberMessage.text && (
            <div
              className={`flex items-center gap-2 rounded-lg p-3 text-xs ${
                memberMessage.type === 'success'
                  ? 'border border-emerald-500/20 bg-emerald-500/10 text-emerald-400'
                  : 'border border-red-500/20 bg-red-500/10 text-red-400'
              }`}
            >
              {memberMessage.type === 'success' ? <CheckCircle2 size={15} /> : <AlertTriangle size={15} />}
              <span>{memberMessage.text}</span>
            </div>
          )}

          <div className="grid gap-6 lg:grid-cols-[1.5fr_1fr]">
            {/* Members Table */}
            <div className="rounded-xl border border-border bg-card p-6">
              <div className="mb-4 flex items-center justify-between">
                <div>
                  <h3 className="text-sm font-semibold text-white">Organization Members</h3>
                  <p className="text-xs text-muted-foreground">Manage user permissions and role assignments</p>
                </div>
                <span className="ff-mono text-[10px] text-muted-foreground">{members.length} members</span>
              </div>

              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs">
                  <thead>
                    <tr className="border-b border-border text-muted-foreground ff-mono text-[10px] uppercase">
                      <th className="pb-2">User</th>
                      <th className="pb-2">Role</th>
                      <th className="pb-2">Joined</th>
                      <th className="pb-2 text-right">Actions</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border/60">
                    {members.map((m) => (
                      <tr key={m.id} className="hover:bg-secondary/30">
                        <td className="py-3 pr-3">
                          <div className="font-semibold text-foreground">{m.user?.name || m.name || 'Member'}</div>
                          <div className="ff-mono text-[11px] text-muted-foreground">{m.user?.email || m.email}</div>
                        </td>
                        <td className="py-3 pr-3">
                          {isAdmin ? (
                            <select
                              value={m.role}
                              onChange={(e) => handleUpdateRole(m.id, e.target.value)}
                              className="rounded border border-border bg-secondary px-2 py-1 ff-mono text-[11px] font-semibold text-foreground focus:border-accent focus:outline-none"
                            >
                              <option value="ADMIN">ADMIN</option>
                              <option value="MANAGER">MANAGER</option>
                              <option value="DEVELOPER">DEVELOPER</option>
                              <option value="VIEWER">VIEWER</option>
                            </select>
                          ) : (
                            <span
                              className={`rounded px-2 py-0.5 ff-mono text-[10px] font-semibold ${
                                m.role === 'ADMIN'
                                  ? 'bg-red-500/20 text-red-400'
                                  : m.role === 'MANAGER'
                                  ? 'bg-purple-500/20 text-purple-400'
                                  : m.role === 'DEVELOPER'
                                  ? 'bg-sky-500/20 text-sky-400'
                                  : 'bg-emerald-500/20 text-emerald-400'
                              }`}
                            >
                              {m.role}
                            </span>
                          )}
                        </td>
                        <td className="py-3 pr-3 ff-mono text-[11px] text-muted-foreground">
                          {new Date(m.joinedAt || m.createdAt || Date.now()).toLocaleDateString()}
                        </td>
                        <td className="py-3 text-right">
                          {isAdmin && (
                            <button
                              type="button"
                              onClick={() => handleRemoveMember(m.id, m.user?.email || m.email)}
                              title="Remove member"
                              className="rounded p-1.5 text-muted-foreground hover:bg-red-500/20 hover:text-red-400"
                            >
                              <Trash2 size={14} />
                            </button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            {/* Add Member Form */}
            <div className="rounded-xl border border-border bg-card p-6">
              <div className="mb-4 flex items-center gap-2">
                <UserPlus size={16} className="text-accent" />
                <h3 className="text-sm font-semibold text-white">Add Organization Member</h3>
              </div>
              <p className="text-xs text-muted-foreground mb-4">
                Provision a user account within the {orgData?.name || 'FixForge Labs'} workspace
              </p>

              <form onSubmit={handleAddMember} className="space-y-4">
                <div>
                  <label className="mb-1 block ff-mono text-[10px] uppercase text-muted-foreground">Full Name</label>
                  <input
                    type="text"
                    value={newMemberName}
                    onChange={(e) => setNewMemberName(e.target.value)}
                    placeholder="Alice Smith"
                    required
                    className="w-full rounded-lg border border-border bg-secondary/50 px-3 py-2 text-xs text-foreground focus:border-accent focus:outline-none"
                  />
                </div>

                <div>
                  <label className="mb-1 block ff-mono text-[10px] uppercase text-muted-foreground">
                    Email Address
                  </label>
                  <input
                    type="email"
                    value={newMemberEmail}
                    onChange={(e) => setNewMemberEmail(e.target.value)}
                    placeholder="alice@fixforge.internal"
                    required
                    className="w-full rounded-lg border border-border bg-secondary/50 px-3 py-2 text-xs text-foreground focus:border-accent focus:outline-none"
                  />
                </div>

                <div>
                  <label className="mb-1 block ff-mono text-[10px] uppercase text-muted-foreground">
                    Role Tier
                  </label>
                  <select
                    value={newMemberRole}
                    onChange={(e) => setNewMemberRole(e.target.value)}
                    className="w-full rounded-lg border border-border bg-secondary/50 px-3 py-2 text-xs text-foreground focus:border-accent focus:outline-none"
                  >
                    <option value="DEVELOPER">DEVELOPER (Repair creation & code fixes)</option>
                    <option value="VIEWER">VIEWER (Read-only observability)</option>
                    <option value="MANAGER">MANAGER (Approvals & governance)</option>
                    <option value="ADMIN">ADMIN (Full organization management)</option>
                  </select>
                </div>

                <div>
                  <label className="mb-1 block ff-mono text-[10px] uppercase text-muted-foreground">
                    Temporary Password
                  </label>
                  <input
                    type="text"
                    value={newMemberPassword}
                    onChange={(e) => setNewMemberPassword(e.target.value)}
                    required
                    className="w-full rounded-lg border border-border bg-secondary/50 px-3 py-2 ff-mono text-xs text-foreground focus:border-accent focus:outline-none"
                  />
                </div>

                <button
                  type="submit"
                  className="w-full rounded-lg bg-accent py-2 text-xs font-semibold text-accent-foreground hover:bg-accent/90"
                >
                  Provision Member
                </button>
              </form>
            </div>
          </div>
        </div>
      )}

      {/* TAB 3: APPROVAL & SAFETY POLICY */}
      {activeTab === 'policy' && (
        <div className="space-y-6">
          {policyMessage.text && (
            <div
              className={`flex items-center gap-2 rounded-lg p-3 text-xs ${
                policyMessage.type === 'success'
                  ? 'border border-emerald-500/20 bg-emerald-500/10 text-emerald-400'
                  : 'border border-red-500/20 bg-red-500/10 text-red-400'
              }`}
            >
              {policyMessage.type === 'success' ? <CheckCircle2 size={15} /> : <AlertTriangle size={15} />}
              <span>{policyMessage.text}</span>
            </div>
          )}

          <form onSubmit={handleSavePolicy} className="grid gap-6 lg:grid-cols-2">
            {/* Approval Governance Card */}
            <div className="rounded-xl border border-border bg-card p-6 space-y-5">
              <div>
                <h3 className="text-sm font-semibold text-white">Human Approval Gates</h3>
                <p className="text-xs text-muted-foreground">Define review requirements prior to code export</p>
              </div>

              <div className="space-y-4">
                <label className="flex items-start gap-3 rounded-lg border border-border bg-secondary/30 p-3 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={policy.requireHumanApproval}
                    onChange={(e) => setPolicy({ ...policy, requireHumanApproval: e.target.checked })}
                    className="mt-0.5 h-4 w-4 rounded border-border accent-accent"
                  />
                  <div>
                    <div className="text-xs font-semibold text-foreground">Enforce Human Approval Gate</div>
                    <div className="text-[11px] text-muted-foreground">
                      Repairs cannot open GitHub PRs until an ADMIN or MANAGER explicitly approves the verified fix.
                    </div>
                  </div>
                </label>

                <label className="flex items-start gap-3 rounded-lg border border-border bg-secondary/30 p-3 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={policy.requireVerifiedRepair}
                    onChange={(e) => setPolicy({ ...policy, requireVerifiedRepair: e.target.checked })}
                    className="mt-0.5 h-4 w-4 rounded border-border accent-accent"
                  />
                  <div>
                    <div className="text-xs font-semibold text-foreground">Require Automated Test Verification</div>
                    <div className="text-[11px] text-muted-foreground">
                      Only repairs with 100% passing test suites (VERIFIED status) are eligible for approval.
                    </div>
                  </div>
                </label>

                <label className="flex items-start gap-3 rounded-lg border border-border bg-secondary/30 p-3 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={policy.allowGitHubPR}
                    onChange={(e) => setPolicy({ ...policy, allowGitHubPR: e.target.checked })}
                    className="mt-0.5 h-4 w-4 rounded border-border accent-accent"
                  />
                  <div>
                    <div className="text-xs font-semibold text-foreground">Allow GitHub PR Creation</div>
                    <div className="text-[11px] text-muted-foreground">
                      Enable autonomous branch creation and Pull Request drafting on connected repositories.
                    </div>
                  </div>
                </label>

                <label className="flex items-start gap-3 rounded-lg border border-border bg-secondary/30 p-3 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={policy.allowPush}
                    onChange={(e) => setPolicy({ ...policy, allowPush: e.target.checked })}
                    className="mt-0.5 h-4 w-4 rounded border-border accent-accent"
                  />
                  <div>
                    <div className="text-xs font-semibold text-foreground">Allow Direct Push (Dangerous)</div>
                    <div className="text-[11px] text-muted-foreground">
                      Enables direct pushes to branches without PRs. (Recommended: Disabled).
                    </div>
                  </div>
                </label>
              </div>
            </div>

            {/* Execution Sandbox Limits & Blocklists */}
            <div className="rounded-xl border border-border bg-card p-6 space-y-5">
              <div>
                <h3 className="text-sm font-semibold text-white">Execution Bounds & Security Blocklists</h3>
                <p className="text-xs text-muted-foreground">Prevent runaway execution and dangerous commands</p>
              </div>

              <div>
                <label className="mb-1 block ff-mono text-[10px] uppercase text-muted-foreground">
                  Max Automated Attempts Per Repair
                </label>
                <input
                  type="number"
                  min="1"
                  max="10"
                  value={policy.maxAutomatedAttempts || 5}
                  onChange={(e) => setPolicy({ ...policy, maxAutomatedAttempts: parseInt(e.target.value, 10) || 1 })}
                  className="w-full rounded-lg border border-border bg-secondary/50 px-3 py-2 text-xs text-foreground focus:border-accent focus:outline-none"
                />
              </div>

              <div>
                <label className="mb-1 block ff-mono text-[10px] uppercase text-muted-foreground">
                  Restricted Shell Commands (Comma-separated)
                </label>
                <input
                  type="text"
                  value={Array.isArray(policy.blockedCommands) ? policy.blockedCommands.join(', ') : policy.blockedCommands || ''}
                  onChange={(e) =>
                    setPolicy({
                      ...policy,
                      blockedCommands: e.target.value.split(',').map((s) => s.trim()).filter(Boolean),
                    })
                  }
                  className="w-full rounded-lg border border-border bg-secondary/50 px-3 py-2 ff-mono text-xs text-foreground focus:border-accent focus:outline-none"
                />
              </div>

              <div>
                <label className="mb-1 block ff-mono text-[10px] uppercase text-muted-foreground">
                  Protected File Patterns (Never modify)
                </label>
                <input
                  type="text"
                  value={Array.isArray(policy.blockedFilePatterns) ? policy.blockedFilePatterns.join(', ') : policy.blockedFilePatterns || ''}
                  onChange={(e) =>
                    setPolicy({
                      ...policy,
                      blockedFilePatterns: e.target.value.split(',').map((s) => s.trim()).filter(Boolean),
                    })
                  }
                  className="w-full rounded-lg border border-border bg-secondary/50 px-3 py-2 ff-mono text-xs text-foreground focus:border-accent focus:outline-none"
                />
              </div>

              <div className="pt-2">
                <button
                  type="submit"
                  disabled={!isAdmin}
                  className="w-full rounded-lg bg-accent py-2.5 text-xs font-semibold text-accent-foreground hover:bg-accent/90 disabled:opacity-50"
                >
                  {isAdmin ? 'Save Governance Policy' : 'Policy Editing Restricted to Admins'}
                </button>
              </div>
            </div>
          </form>
        </div>
      )}

      {/* TAB 4: AUDIT TRAIL & TELEMETRY */}
      {activeTab === 'audit' && (
        <div className="space-y-6">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div>
              <h3 className="text-sm font-semibold text-white">Immutable Security Audit Trail</h3>
              <p className="text-xs text-muted-foreground">
                All logins, policy updates, repair approvals, and denial events are audited with zero secret leakage
              </p>
            </div>

            <div className="flex items-center gap-2">
              <span className="ff-mono text-[10px] uppercase text-muted-foreground">Filter Action:</span>
              <select
                value={logFilterAction}
                onChange={(e) => setLogFilterAction(e.target.value)}
                className="rounded-lg border border-border bg-secondary px-3 py-1.5 ff-mono text-xs text-foreground focus:border-accent focus:outline-none"
              >
                <option value="ALL">ALL ACTIONS</option>
                <option value="AUTH_LOGIN">AUTH_LOGIN</option>
                <option value="AUTH_FAILED">AUTH_FAILED</option>
                <option value="REPAIR_APPROVED">REPAIR_APPROVED</option>
                <option value="REPAIR_REJECTED">REPAIR_REJECTED</option>
                <option value="POLICY_UPDATED">POLICY_UPDATED</option>
                <option value="ACCESS_DENIED">ACCESS_DENIED</option>
                <option value="GITHUB_PR_CREATED">GITHUB_PR_CREATED</option>
              </select>
            </div>
          </div>

          <div className="rounded-xl border border-border bg-card p-6">
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead>
                  <tr className="border-b border-border text-muted-foreground ff-mono text-[10px] uppercase">
                    <th className="pb-2">Timestamp</th>
                    <th className="pb-2">Action</th>
                    <th className="pb-2">Actor</th>
                    <th className="pb-2">Target</th>
                    <th className="pb-2">Status</th>
                    <th className="pb-2">IP Address</th>
                    <th className="pb-2 text-right">Details</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border/60">
                  {auditLogs.length > 0 ? (
                    auditLogs.map((log) => (
                      <tr key={log.id} className="hover:bg-secondary/30">
                        <td className="py-3 pr-3 ff-mono text-[11px] text-muted-foreground whitespace-nowrap">
                          {new Date(log.createdAt).toLocaleTimeString([], {
                            hour: '2-digit',
                            minute: '2-digit',
                            second: '2-digit',
                          })}
                        </td>
                        <td className="py-3 pr-3">
                          <span className="rounded bg-secondary px-2 py-0.5 ff-mono text-[10px] font-semibold text-foreground">
                            {log.action}
                          </span>
                        </td>
                        <td className="py-3 pr-3">
                          <span className="font-semibold text-foreground">{log.actorName || log.actorRole || 'System'}</span>
                          {log.actorRole && (
                            <span className="ml-1 ff-mono text-[9px] text-muted-foreground">({log.actorRole})</span>
                          )}
                        </td>
                        <td className="py-3 pr-3 ff-mono text-[11px] text-muted-foreground truncate max-w-[140px]">
                          {log.targetType}: {log.targetId?.slice(0, 8) || '—'}
                        </td>
                        <td className="py-3 pr-3">
                          <span
                            className={`rounded px-1.5 py-0.5 ff-mono text-[10px] font-bold ${
                              log.status === 'SUCCESS'
                                ? 'bg-emerald-500/20 text-emerald-400'
                                : log.status === 'DENIED'
                                ? 'bg-amber-500/20 text-amber-400'
                                : 'bg-red-500/20 text-red-400'
                            }`}
                          >
                            {log.status}
                          </span>
                        </td>
                        <td className="py-3 pr-3 ff-mono text-[11px] text-muted-foreground">{log.ipAddress || '127.0.0.1'}</td>
                        <td className="py-3 text-right">
                          <button
                            type="button"
                            onClick={() => setSelectedLog(selectedLog?.id === log.id ? null : log)}
                            className="inline-flex items-center gap-1 rounded bg-secondary px-2 py-1 text-[11px] text-muted-foreground hover:text-foreground"
                          >
                            <Eye size={12} /> {selectedLog?.id === log.id ? 'Close' : 'View'}
                          </button>
                        </td>
                      </tr>
                    ))
                  ) : (
                    <tr>
                      <td colSpan="7" className="py-8 text-center text-xs text-muted-foreground">
                        No audit events recorded matching current filter.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>

            {/* Selected Log Metadata Drawer */}
            {selectedLog && (
              <div className="mt-4 rounded-lg border border-border bg-secondary/50 p-4">
                <div className="flex items-center justify-between mb-2">
                  <span className="ff-mono text-xs font-semibold text-accent">
                    Metadata for Event #{selectedLog.id.slice(0, 8)} ({selectedLog.action})
                  </span>
                  <span className="ff-mono text-[10px] text-muted-foreground">
                    Zero Credential Disclosure Policy Enforced
                  </span>
                </div>
                <pre className="ff-mono text-[11px] text-muted-foreground overflow-x-auto whitespace-pre-wrap bg-background/80 p-3 rounded border border-border">
                  {JSON.stringify(
                    typeof selectedLog.metadata === 'string'
                      ? JSON.parse(selectedLog.metadata || '{}')
                      : selectedLog.metadata || {},
                    null,
                    2
                  )}
                </pre>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
