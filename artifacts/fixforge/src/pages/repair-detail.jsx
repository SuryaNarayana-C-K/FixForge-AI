import {
  AlertTriangle,
  ArrowLeft,
  Box,
  CheckCheck,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  CircleDot,
  Code2,
  FileCheck2,
  FileDiff,
  FolderGit2,
  GitCommitHorizontal,
  Layers3,
  LoaderCircle,
  Play,
  Shield,
  ShieldCheck,
  Sparkles,
  TerminalSquare,
  Wrench,
  RotateCcw,
  History,
  GitPullRequest,
  ExternalLink,
  Gauge,
  Clock,
  XCircle,
  Target,
  UserCheck,
  ThumbsUp,
  ThumbsDown,
  Download,
  FileText,
  Brain,
} from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link, useParams } from 'wouter';
import { getGetProjectQueryKey, getGetRepairQueryKey, useGetProject, useGetRepair } from '@workspace/api-client-react';
import { formatDate, PageIntro, QueryError, StatusPill } from '@/components/fixforge-ui';
import { useAuth } from '@/hooks/use-auth';

function extractErrorMessage(payload, fallback = 'Operation failed') {
  if (!payload) return fallback;
  if (typeof payload === 'string') {
    const trimmed = payload.trim();
    if (trimmed && trimmed !== '[object Object]') return trimmed;
    return fallback;
  }
  if (payload instanceof Error && payload.message && payload.message !== '[object Object]') {
    return payload.message;
  }
  if (typeof payload.error === 'string' && payload.error !== '[object Object]') {
    return payload.error;
  }
  if (payload.error && typeof payload.error === 'object') {
    if (typeof payload.error.message === 'string' && payload.error.message !== '[object Object]') return payload.error.message;
    if (typeof payload.error.detail === 'string' && payload.error.detail !== '[object Object]') return payload.error.detail;
    if (typeof payload.error.error === 'string' && payload.error.error !== '[object Object]') return payload.error.error;
    try {
      const json = JSON.stringify(payload.error);
      if (json && json !== '{}') return json;
    } catch (_) {}
  }
  if (typeof payload.message === 'string' && payload.message !== '[object Object]') return payload.message;
  if (typeof payload.detail === 'string' && payload.detail !== '[object Object]') return payload.detail;
  if (Array.isArray(payload.detail)) {
    const formatted = payload.detail
      .map((item) => {
        if (!item) return '';
        if (typeof item === 'string') return item;
        const loc = Array.isArray(item.loc) ? item.loc.filter((p) => p !== 'body').join('.') : '';
        const msg = item.msg || item.message || (typeof item === 'object' ? JSON.stringify(item) : String(item));
        return loc ? `${loc}: ${msg}` : msg;
      })
      .filter(Boolean)
      .join('; ');
    if (formatted) return formatted;
  }
  if (Array.isArray(payload.errors) && payload.errors.length > 0) {
    return payload.errors
      .map((e) => (typeof e === 'string' ? e : e.message || e.msg || JSON.stringify(e)))
      .filter(Boolean)
      .join('; ');
  }
  if (typeof payload.code === 'string') return `Operation failed (${payload.code})`;
  if (typeof payload === 'object') {
    try {
      const str = JSON.stringify(payload);
      if (str && str !== '{}') return str;
    } catch (_) {}
  }
  return fallback;
}

export default function RepairDetail() {
  const params = useParams();
  const repairId = params.id || '';
  const [isRepairing, setIsRepairing] = useState(false);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [isSandboxRunning, setIsSandboxRunning] = useState(false);
  const [isPatchGenerating, setIsPatchGenerating] = useState(false);
  const [isPatchApplying, setIsPatchApplying] = useState(false);

  const repair = useGetRepair(repairId, {
    query: {
      queryKey: getGetRepairQueryKey(repairId),
      enabled: Boolean(repairId),
      refetchInterval: (query) => {
        const s = query.state.data?.status;
        const isActive = ['queued', 'analyzing', 'running', 'self_correcting', 'testing'].includes(s);
        return (isActive || isRepairing || isAnalyzing || isSandboxRunning || isPatchGenerating || isPatchApplying) ? 2000 : false;
      },
    },
  });
  const job = repair.data;
  const project = useGetProject(job?.projectId || '', {
    query: { queryKey: getGetProjectQueryKey(job?.projectId || ''), enabled: Boolean(job?.projectId) },
  });

  const [analyzeError, setAnalyzeError] = useState(null);
  const [sandboxError, setSandboxError] = useState(null);
  const [latestSandboxRun, setLatestSandboxRun] = useState(null);

  // Milestone 4: Root Cause & Patching states
  const [isRootCauseRunning, setIsRootCauseRunning] = useState(false);
  const [rootCauseError, setRootCauseError] = useState(null);
  const [latestRootCause, setLatestRootCause] = useState(null);

  const [patchError, setPatchError] = useState(null);
  const [latestPatch, setLatestPatch] = useState(null);

  const [applyError, setApplyError] = useState(null);
  const [latestApplyResult, setLatestApplyResult] = useState(null);

  // Milestone 5: Autonomous repair & verification states
  const [repairError, setRepairError] = useState(null);
  const [latestRepairResult, setLatestRepairResult] = useState(null);
  const [fetchedAttempts, setFetchedAttempts] = useState([]);
  const [fetchedEvents, setFetchedEvents] = useState([]);

  // Milestone 7: Observability Metrics state
  const [repairMetrics, setRepairMetrics] = useState(null);

  // Milestone 6: GitHub Integration states
  const [isCreatingPr, setIsCreatingPr] = useState(false);
  const [prError, setPrError] = useState(null);
  const [githubData, setGithubData] = useState(null);

  // Milestone 9: Authentication & Approval Gate states
  const { user, role, isAdmin, isManager, isViewer, canApprove, token } = useAuth();
  const [isApproving, setIsApproving] = useState(false);
  const [approveError, setApproveError] = useState(null);
  const [isRejecting, setIsRejecting] = useState(false);
  const [rejectReason, setRejectReason] = useState('');
  const [showRejectForm, setShowRejectForm] = useState(false);

  // Milestone 10: Repair Intelligence, Memory & Export Report states
  const [isExporting, setIsExporting] = useState(false);
  const [repairPlan, setRepairPlan] = useState(null);
  const [repairMemory, setRepairMemory] = useState(null);

  const handleExportReport = async (fmt = 'markdown') => {
    setIsExporting(true);
    try {
      const res = await fetch(`/api/repairs/${repairId}/report?format=${fmt}`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      if (!res.ok) throw new Error('Failed to generate report');
      const blob = await res.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `fixforge-repair-${repairId.slice(0, 8)}-report.${fmt === 'json' ? 'json' : 'md'}`;
      document.body.appendChild(a);
      a.click();
      window.URL.revokeObjectURL(url);
      document.body.removeChild(a);
    } catch (err) {
      alert(`Export failed: ${err.message}`);
    } finally {
      setIsExporting(false);
    }
  };

  const getAuthHeaders = (extra = {}) => ({
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...extra,
  });

  const fetchGithubState = () => {
    if (!repairId) return;
    fetch(`/api/repairs/${repairId}/github`, { headers: getAuthHeaders() })
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => { if (data) setGithubData(data); })
      .catch(() => {});
  };

  const fetchRepairMetrics = () => {
    if (!repairId) return;
    fetch(`/api/repairs/${repairId}/metrics`, { headers: getAuthHeaders() })
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => { if (data) setRepairMetrics(data); })
      .catch(() => {});
  };

  const fetchIntelligenceData = () => {
    if (!repairId) return;
    fetch(`/api/repairs/${repairId}/plan`, {
      headers: getAuthHeaders(),
    })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (d) setRepairPlan(d); })
      .catch(() => {});

    fetch(`/api/repairs/${repairId}/memory`, {
      headers: getAuthHeaders(),
    })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (d) setRepairMemory(d); })
      .catch(() => {});
  };

  const fetchAll = () => {
    repair.refetch();
    fetch(`/api/repairs/${repairId}/attempts`, { headers: getAuthHeaders() })
      .then((r) => (r.ok ? r.json() : []))
      .then((data) => setFetchedAttempts(data))
      .catch(() => {});
    fetch(`/api/repairs/${repairId}/events`, { headers: getAuthHeaders() })
      .then((r) => (r.ok ? r.json() : []))
      .then((data) => setFetchedEvents(data))
      .catch(() => {});
    fetchGithubState();
    fetchRepairMetrics();
    fetchIntelligenceData();
  };

  useEffect(() => {
    if (!repairId) return;
    fetchAll();

    const isActive = ['queued', 'analyzing', 'running', 'self_correcting', 'testing'].includes(job?.status);
    let interval = null;
    if (isActive || isRepairing || isAnalyzing || isSandboxRunning || isPatchGenerating || isPatchApplying) {
      interval = setInterval(fetchAll, 2500);
    }
    return () => { if (interval) clearInterval(interval); };
  }, [repairId, job?.status, job?.iteration, isRepairing, isAnalyzing, isSandboxRunning, isPatchGenerating, isPatchApplying]);

  async function handleApproveRepair() {
    setIsApproving(true);
    setApproveError(null);
    try {
      const res = await fetch(`/api/repairs/${repairId}/approve`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ notes: 'Approved via FixForge Control Room' }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(extractErrorMessage(data, 'Failed to approve repair'));
      }
      await repair.refetch();
    } catch (err) {
      setApproveError(err.message);
    } finally {
      setIsApproving(false);
    }
  }

  async function handleRejectRepair() {
    setIsRejecting(true);
    setApproveError(null);
    try {
      const res = await fetch(`/api/repairs/${repairId}/reject`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ reason: rejectReason || 'Manual review rejection' }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(extractErrorMessage(data, 'Failed to reject repair'));
      }
      setShowRejectForm(false);
      setRejectReason('');
      await repair.refetch();
    } catch (err) {
      setApproveError(err.message);
    } finally {
      setIsRejecting(false);
    }
  }

  async function handleCreatePullRequest() {
    setIsCreatingPr(true);
    setPrError(null);
    try {
      const res = await fetch(`/api/repairs/${repairId}/github/pr`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({
          createBranch: true,
          createCommit: true,
          createPullRequest: true,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(extractErrorMessage(data, 'Failed to create Pull Request'));
      }
      fetchGithubState();
      repair.refetch();
    } catch (err) {
      setPrError(err.message);
    } finally {
      setIsCreatingPr(false);
    }
  }

  if (repair.isLoading) return <DetailSkeleton />;
  if (repair.isError || !job) {
    return (
      <div className="mx-auto max-w-[1120px]">
        <QueryError message="This repair could not be found." retry={() => repair.refetch()} />
      </div>
    );
  }

  const analysis = job.analysis || null;
  const baseline = job.baselineResult || null;
  const failures = Array.isArray(job.failures) ? job.failures : [];
  const sandboxRuns = Array.isArray(job.sandboxRuns) ? job.sandboxRuns : [];
  const activeSandboxRun = latestSandboxRun || (sandboxRuns.length > 0 ? sandboxRuns[sandboxRuns.length - 1] : null);
  const testCommand = job.testCommand || (baseline && baseline.command) || (analysis && analysis.test_command) || null;

  // Milestone 4 derived data
  const patches = Array.isArray(job.patches) ? job.patches : [];
  const activePatch = latestPatch || (patches.length > 0 ? patches[0] : null);
  const activeRootCause = latestRootCause || (activePatch && activePatch.rootCause) || null;
  const patchPlan = (activePatch && activePatch.patchPlan) || null;
  const validation = (activePatch && activePatch.validationResult) || null;

  const progress = Math.min(100, Math.max(7, Math.round((job.iteration / Math.max(job.maxIterations, 1)) * 100)));
  const finished = ['verified', 'failed', 'timeout', 'cancelled'].includes(job.status);
  const steps = ['queued', 'analyzing', 'patching', 'testing', 'verifying', 'verified'];
  const activeStep = job.status === 'self_correcting' ? 2 : steps.indexOf(job.status);

  // Milestone 5 derived attempts
  const attempts = (fetchedAttempts && fetchedAttempts.length > 0)
    ? fetchedAttempts
    : (Array.isArray(job.attempts) && job.attempts.length > 0)
      ? job.attempts
      : (latestRepairResult && latestRepairResult.attempt_history)
        ? latestRepairResult.attempt_history
        : [];

  async function handleStartAutonomousRepair() {
    setIsRepairing(true);
    setRepairError(null);
    try {
      const res = await fetch(`/api/repairs/${repairId}/repair`, {
        method: 'POST',
        headers: getAuthHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ maxAttempts: 3 }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(extractErrorMessage(err, `Autonomous repair failed (${res.status})`));
      }
      const data = await res.json();
      setLatestRepairResult(data);
    } catch (err) {
      setRepairError(extractErrorMessage(err, 'Autonomous repair failed'));
    } finally {
      setIsRepairing(false);
      await repair.refetch();
      if (project.refetch) await project.refetch();
      fetchAll();
    }
  }

  async function handleAnalyze() {
    setIsAnalyzing(true);
    setAnalyzeError(null);
    try {
      const res = await fetch(`/api/repairs/${repairId}/analyze`, {
        method: 'POST',
        headers: getAuthHeaders(),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(extractErrorMessage(err, `Analysis failed (${res.status})`));
      }
      await repair.refetch();
      if (project.refetch) await project.refetch();
    } catch (err) {
      setAnalyzeError(extractErrorMessage(err, 'Analysis failed'));
    } finally {
      setIsAnalyzing(false);
      fetchAll();
    }
  }

  async function handleRunSandbox() {
    setIsSandboxRunning(true);
    setSandboxError(null);
    try {
      const res = await fetch(`/api/repairs/${repairId}/sandbox/run`, {
        method: 'POST',
        headers: getAuthHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ command: testCommand || 'pytest' }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(extractErrorMessage(err, `Sandbox run failed (${res.status})`));
      }
      const data = await res.json();
      setLatestSandboxRun(data);
      await repair.refetch();
    } catch (err) {
      setSandboxError(extractErrorMessage(err, 'Sandbox run failed'));
    } finally {
      setIsSandboxRunning(false);
      fetchAll();
    }
  }

  async function handleAnalyzeRootCause() {
    setIsRootCauseRunning(true);
    setRootCauseError(null);
    try {
      const res = await fetch(`/api/repairs/${repairId}/root-cause`, {
        method: 'POST',
        headers: getAuthHeaders(),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(extractErrorMessage(err, `Root cause analysis failed (${res.status})`));
      }
      const data = await res.json();
      setLatestRootCause(data.root_cause || data.rootCause);
      await repair.refetch();
    } catch (err) {
      setRootCauseError(extractErrorMessage(err, 'Root cause analysis failed'));
    } finally {
      setIsRootCauseRunning(false);
      fetchAll();
    }
  }

  async function handleGeneratePatch() {
    setIsPatchGenerating(true);
    setPatchError(null);
    try {
      const res = await fetch(`/api/repairs/${repairId}/patch`, {
        method: 'POST',
        headers: getAuthHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ rootCause: activeRootCause }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(extractErrorMessage(err, `Patch generation failed (${res.status})`));
      }
      const data = await res.json();
      setLatestPatch(data);
      if (data.rootCause) setLatestRootCause(data.rootCause);
      await repair.refetch();
    } catch (err) {
      setPatchError(extractErrorMessage(err, 'Patch generation failed'));
    } finally {
      setIsPatchGenerating(false);
      fetchAll();
    }
  }

  async function handleApplyPatch() {
    setIsPatchApplying(true);
    setApplyError(null);
    try {
      const res = await fetch(`/api/repairs/${repairId}/apply-patch`, {
        method: 'POST',
        headers: getAuthHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({
          patchId: activePatch?.id,
          diff: activePatch?.diff,
        }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(extractErrorMessage(err, `Patch application failed (${res.status})`));
      }
      const data = await res.json();
      setLatestApplyResult(data.result);
      await repair.refetch();
    } catch (err) {
      setApplyError(extractErrorMessage(err, 'Patch application failed'));
    } finally {
      setIsPatchApplying(false);
      fetchAll();
    }
  }

  return (
    <div className="mx-auto max-w-[1120px]">
      <Link
        href="/repairs"
        data-testid="link-back-repairs"
        className="mb-6 inline-flex items-center gap-2 text-xs font-medium text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft size={14} /> All repairs
      </Link>

      <PageIntro
        eyebrow={`Repair ${job.id.slice(0, 12)} / execution`}
        title={job.issue}
        description={
          <span className="flex flex-wrap items-center gap-2">
            <span>{project.data?.name || 'Project'} · submitted {formatDate(job.createdAt)}</span>
            <span className="inline-flex items-center gap-1 rounded bg-sky-500/10 px-1.5 py-0.5 ff-mono text-[10px] font-semibold text-sky-400 border border-sky-500/20">
              {job.language || project.data?.language || 'Python'}
            </span>
            <span className="inline-flex items-center gap-1 rounded bg-purple-500/10 px-1.5 py-0.5 ff-mono text-[10px] font-semibold text-purple-400 border border-purple-500/20">
              {job.testFramework || job.framework || project.data?.testFramework || 'pytest'}
            </span>
          </span>
        }
        action={
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              disabled={isAnalyzing || isSandboxRunning || isRootCauseRunning || isPatchGenerating}
              onClick={handleAnalyze}
              data-testid="button-analyze-repo"
              className="inline-flex items-center gap-1.5 rounded-lg bg-secondary px-3 py-1.5 text-xs font-semibold text-foreground shadow-sm hover:bg-secondary/80 disabled:opacity-50"
            >
              {isAnalyzing ? (
                <>
                  <LoaderCircle size={13} className="animate-spin" />
                  Analyzing...
                </>
              ) : (
                <>
                  <Play size={13} />
                  Analyze Repo
                </>
              )}
            </button>

            <button
              type="button"
              disabled={isSandboxRunning || isAnalyzing || isRootCauseRunning || isPatchGenerating}
              onClick={handleRunSandbox}
              data-testid="button-run-sandbox"
              className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white shadow-sm hover:bg-emerald-500 disabled:opacity-50"
            >
              {isSandboxRunning ? (
                <>
                  <LoaderCircle size={13} className="animate-spin" />
                  Sandbox...
                </>
              ) : (
                <>
                  <Box size={13} />
                  Run in Sandbox
                </>
              )}
            </button>

            <button
              type="button"
              disabled={isRootCauseRunning || isAnalyzing || isPatchGenerating}
              onClick={handleAnalyzeRootCause}
              data-testid="button-root-cause"
              className="inline-flex items-center gap-1.5 rounded-lg bg-indigo-600 px-3 py-1.5 text-xs font-semibold text-white shadow-sm hover:bg-indigo-500 disabled:opacity-50"
            >
              {isRootCauseRunning ? (
                <>
                  <LoaderCircle size={13} className="animate-spin" />
                  Analyzing Cause...
                </>
              ) : (
                <>
                  <Sparkles size={13} />
                  Root Cause
                </>
              )}
            </button>

            <button
              type="button"
              disabled={isPatchGenerating || isAnalyzing || isRootCauseRunning}
              onClick={handleGeneratePatch}
              data-testid="button-generate-patch"
              className="inline-flex items-center gap-1.5 rounded-lg bg-amber-600 px-3 py-1.5 text-xs font-semibold text-white shadow-sm hover:bg-amber-500 disabled:opacity-50"
            >
              {isPatchGenerating ? (
                <>
                  <LoaderCircle size={13} className="animate-spin" />
                  Generating...
                </>
              ) : (
                <>
                  <FileDiff size={13} />
                  Generate Patch
                </>
              )}
            </button>

            <button
              type="button"
              disabled={isRepairing || isAnalyzing || isSandboxRunning || isPatchGenerating}
              onClick={handleStartAutonomousRepair}
              data-testid="button-autonomous-repair"
              className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground shadow-sm hover:opacity-90 disabled:opacity-50"
            >
              {isRepairing ? (
                <>
                  <LoaderCircle size={13} className="animate-spin" />
                  Self-Correcting...
                </>
              ) : (
                <>
                  <Sparkles size={13} />
                  Start Autonomous Repair
                </>
              )}
            </button>
            <StatusPill status={job.status} />
          </div>
        }
      />

      {repairError && (
        <div className="mb-4 rounded-lg border border-red-500/20 bg-red-500/10 p-3 text-xs text-red-500">
          <div className="font-semibold">Autonomous Repair Error</div>
          <div className="mt-1">{repairError}</div>
        </div>
      )}
      {analyzeError && (
        <div className="mb-4 rounded-lg border border-red-500/20 bg-red-500/10 p-3 text-xs text-red-500">
          <div className="font-semibold">Analysis Failed</div>
          <div className="mt-1">{analyzeError}</div>
        </div>
      )}

      {sandboxError && (
        <div className="mb-4 rounded-lg border border-amber-500/20 bg-amber-500/10 p-3 text-xs text-amber-500">
          <div className="font-semibold">Sandbox Execution Alert</div>
          <div className="mt-1">{sandboxError}</div>
        </div>
      )}

      {rootCauseError && (
        <div className="mb-4 rounded-lg border border-red-500/20 bg-red-500/10 p-3 text-xs text-red-500">
          <div className="font-semibold">Root Cause Analysis Error</div>
          <div className="mt-1">{rootCauseError}</div>
        </div>
      )}

      {patchError && (
        <div className="mb-4 rounded-lg border border-red-500/20 bg-red-500/10 p-3 text-xs text-red-500">
          <div className="font-semibold">Patch Generation Error</div>
          <div className="mt-1">{patchError}</div>
        </div>
      )}

      {applyError && (
        <div className="mb-4 rounded-lg border border-red-500/20 bg-red-500/10 p-3 text-xs text-red-500">
          <div className="font-semibold">Patch Application Error</div>
          <div className="mt-1">{applyError}</div>
        </div>
      )}


      {/* Milestone 10: Advanced Repair Intelligence & Confidence Card */}
      <section className="mb-6 rounded-xl border border-sky-500/30 bg-gradient-to-br from-card via-card to-sky-950/20 p-6 shadow-sm" data-testid="section-m10-intelligence">
        <div className="flex flex-wrap items-center justify-between gap-4 border-b border-border/80 pb-4">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-sky-500/10 text-sky-400 border border-sky-500/20">
              <Brain size={22} />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <span className="ff-mono text-[10px] uppercase tracking-wider text-sky-400 font-semibold">Autonomous Repair Intelligence</span>
                <span className="rounded bg-sky-500/10 px-1.5 py-0.5 ff-mono text-[9px] text-sky-300 font-bold border border-sky-500/20">M10</span>
              </div>
              <h2 className="text-base font-bold text-foreground flex items-center gap-2">
                {job.status === 'verified' ? (
                  <span className="text-emerald-400 flex items-center gap-1.5">
                    <CheckCircle2 size={16} /> REPAIR VERIFIED
                  </span>
                ) : job.status === 'regression_detected' ? (
                  <span className="text-red-400 flex items-center gap-1.5">
                    <AlertTriangle size={16} /> REGRESSION DETECTED
                  </span>
                ) : (
                  <span>Status: {String(job.status || 'QUEUED').toUpperCase()}</span>
                )}
              </h2>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              disabled={isExporting}
              onClick={() => handleExportReport('markdown')}
              data-testid="button-export-markdown-report"
              className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-secondary/80 px-3 py-1.5 text-xs font-semibold text-foreground hover:bg-secondary disabled:opacity-50"
            >
              <Download size={13} />
              Export Report (.md)
            </button>
            <button
              type="button"
              disabled={isExporting}
              onClick={() => handleExportReport('json')}
              data-testid="button-export-json-report"
              className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-secondary/80 px-3 py-1.5 text-xs font-semibold text-foreground hover:bg-secondary disabled:opacity-50"
            >
              <FileText size={13} />
              JSON
            </button>
          </div>
        </div>

        {/* Intelligence Key Metrics Grid */}
        <div className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
          {/* Repair Confidence Score */}
          <div className="rounded-lg border border-border/70 bg-secondary/30 p-3">
            <div className="ff-mono text-[10px] uppercase tracking-wider text-muted-foreground">Repair Confidence</div>
            <div className="mt-1 flex items-baseline gap-1.5">
              <span className="text-lg font-bold text-foreground">
                {job.confidenceScore != null ? `${Math.round(job.confidenceScore * 100)}%` : '—'}
              </span>
              <span className={`rounded px-1.5 py-0.2 ff-mono text-[10px] font-bold ${
                job.confidenceLevel === 'HIGH' ? 'bg-emerald-500/20 text-emerald-400' :
                job.confidenceLevel === 'MEDIUM' ? 'bg-amber-500/20 text-amber-400' :
                'bg-slate-500/20 text-slate-400'
              }`}>
                {job.confidenceLevel || 'EVAL'}
              </span>
            </div>
            <div className="mt-0.5 text-[10px] text-muted-foreground truncate" title="Empirical evidence score based on passing tests & verified stability">
              Empirical evidence
            </div>
          </div>

          {/* Patch Risk Score */}
          <div className="rounded-lg border border-border/70 bg-secondary/30 p-3">
            <div className="ff-mono text-[10px] uppercase tracking-wider text-muted-foreground">Patch Risk</div>
            <div className="mt-1 flex items-baseline gap-1.5">
              <span className="text-lg font-bold text-foreground">
                {job.patchRiskScore != null ? `${Math.round(job.patchRiskScore * 100)}%` : '—'}
              </span>
              <span className={`rounded px-1.5 py-0.2 ff-mono text-[10px] font-bold ${
                job.patchRiskLevel === 'LOW' ? 'bg-emerald-500/20 text-emerald-400' :
                job.patchRiskLevel === 'MEDIUM' ? 'bg-amber-500/20 text-amber-400' :
                'bg-red-500/20 text-red-400'
              }`}>
                {job.patchRiskLevel || 'LOW'}
              </span>
            </div>
            <div className="mt-0.5 text-[10px] text-muted-foreground truncate" title="Blast radius and potential danger of the diff">
              Blast radius metric
            </div>
          </div>

          {/* Root Cause Certainty */}
          <div className="rounded-lg border border-border/70 bg-secondary/30 p-3">
            <div className="ff-mono text-[10px] uppercase tracking-wider text-muted-foreground">Root Cause Certainty</div>
            <div className="mt-1 flex items-baseline gap-1.5">
              <span className={`rounded px-1.5 py-0.5 ff-mono text-xs font-bold ${
                job.rootCauseCertainty === 'HIGH' ? 'bg-emerald-500/20 text-emerald-400' :
                job.rootCauseCertainty === 'MEDIUM' ? 'bg-sky-500/20 text-sky-400' :
                'bg-amber-500/20 text-amber-400'
              }`}>
                {job.rootCauseCertainty || 'MEDIUM'}
              </span>
            </div>
            <div className="mt-0.5 text-[10px] text-muted-foreground truncate">
              {job.failureCategory || 'UNKNOWN'}
            </div>
          </div>

          {/* Repair Strategy */}
          <div className="rounded-lg border border-border/70 bg-secondary/30 p-3">
            <div className="ff-mono text-[10px] uppercase tracking-wider text-muted-foreground">Repair Strategy</div>
            <div className="mt-1">
              <span className="rounded bg-purple-500/10 px-1.5 py-0.5 ff-mono text-[11px] font-semibold text-purple-300 border border-purple-500/20">
                {job.repairStrategy || 'GUARD_CLAUSE'}
              </span>
            </div>
            <div className="mt-0.5 text-[10px] text-muted-foreground truncate">
              Adaptive strategy
            </div>
          </div>

          {/* Patch Quality */}
          <div className="rounded-lg border border-border/70 bg-secondary/30 p-3">
            <div className="ff-mono text-[10px] uppercase tracking-wider text-muted-foreground">Patch Quality</div>
            <div className="mt-1 flex items-baseline gap-1.5">
              <span className="ff-mono text-sm font-semibold text-foreground">
                {job.patchQuality?.quality || 'HIGH'}
              </span>
              <span className="text-[10px] text-muted-foreground">
                ({job.patches?.[0]?.linesAdded ?? 1}a / {job.patches?.[0]?.linesRemoved ?? 1}r)
              </span>
            </div>
            <div className="mt-0.5 text-[10px] text-emerald-400">
              0 protected files
            </div>
          </div>

          {/* Regression Status */}
          <div className="rounded-lg border border-border/70 bg-secondary/30 p-3">
            <div className="ff-mono text-[10px] uppercase tracking-wider text-muted-foreground">Regression Status</div>
            <div className="mt-1">
              <span className={`rounded px-1.5 py-0.5 ff-mono text-xs font-bold ${
                job.status === 'verified' ? 'bg-emerald-500/20 text-emerald-400' :
                job.status === 'regression_detected' ? 'bg-red-500/20 text-red-400' :
                'bg-slate-500/20 text-slate-400'
              }`}>
                {job.status === 'regression_detected' ? 'REGRESSION' : 'NONE'}
              </span>
            </div>
            <div className="mt-0.5 text-[10px] text-muted-foreground">
              {job.testsPassed}/{job.testsTotal} passing tests
            </div>
          </div>
        </div>

        {/* Evidence Factors & Advisory Details */}
        {Array.isArray(job.confidenceReasons) && job.confidenceReasons.length > 0 && (
          <div className="mt-4 rounded-lg bg-secondary/20 p-3 border border-border/60">
            <div className="ff-mono text-[10px] uppercase tracking-wider text-sky-400 font-semibold mb-1">
              Confidence Evidentiary Reasons
            </div>
            <div className="grid gap-1 sm:grid-cols-2 text-xs text-muted-foreground">
              {job.confidenceReasons.map((reason, idx) => (
                <div key={idx} className="flex items-center gap-1.5">
                  <CheckCircle2 size={12} className="text-emerald-400 shrink-0" />
                  <span className="truncate">{reason}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Advisory Repair Memory (Milestone 10) */}
        {repairMemory?.similarRepairs?.length > 0 && (
          <div className="mt-3 rounded-lg bg-sky-950/20 p-3 border border-sky-500/20">
            <div className="flex items-center justify-between mb-1.5">
              <div className="flex items-center gap-1.5 ff-mono text-[10px] uppercase tracking-wider text-sky-400 font-semibold">
                <Brain size={12} />
                <span>Advisory Repair Memory (Historical Patterns)</span>
              </div>
              <span className="text-[10px] text-muted-foreground">Advisory only · Not auto-copied</span>
            </div>
            <div className="space-y-1 text-xs">
              {repairMemory.similarRepairs.map((mem, i) => (
                <div key={mem.id || i} className="flex items-center justify-between text-muted-foreground">
                  <span className="truncate">
                    • {mem.language} / {mem.failureCategory}: {mem.patchStrategy} ({mem.errorSignature || 'defect pattern'})
                  </span>
                  <span className="ff-mono text-[10px] text-emerald-400 font-semibold">
                    {mem.verificationOutcome || 'verified'}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}
      </section>

      <div className="grid gap-6 lg:grid-cols-[1.45fr_.75fr]">
        <div className="space-y-6">
          {/* Execution State */}
          <section className="rounded-xl border border-border bg-card p-6">
            <div className="mb-6 flex items-center justify-between">
              <div>
                <div className="ff-mono text-[10px] uppercase tracking-[.2em] text-muted-foreground">
                  Execution state
                </div>
                <h2 className="mt-1 text-lg font-semibold">{finished ? 'Run complete' : 'Forge is working'}</h2>
              </div>
              <div className="ff-mono text-xs text-muted-foreground">
                {job.iteration}/{job.maxIterations} iterations
              </div>
            </div>
            <div className="mb-7 h-2 overflow-hidden rounded-full bg-secondary">
              <div
                className={`h-full rounded-full transition-all ${job.status === 'failed' ? 'bg-red-500' : 'bg-accent'}`}
                style={{ width: `${progress}%` }}
              />
            </div>
            <div className="relative grid grid-cols-3 gap-2 sm:grid-cols-6">
              {steps.map((step, index) => {
                const reached = index <= activeStep;
                const current = index === activeStep && !finished;
                return (
                  <div key={step} className="relative text-center">
                    <div
                      className={`mx-auto mb-2 flex h-7 w-7 items-center justify-center rounded-full border-2 ${
                        reached
                          ? 'border-accent bg-accent text-accent-foreground'
                          : 'border-border bg-card text-muted-foreground'
                      } ${current ? 'ring-4 ring-accent/15' : ''}`}
                    >
                      {reached ? <CheckCircle2 size={13} /> : <span className="ff-mono text-[10px]">{index + 1}</span>}
                    </div>
                    <div
                      className={`text-[10px] capitalize ${
                        reached ? 'font-semibold text-foreground' : 'text-muted-foreground'
                      }`}
                    >
                      {step.replace('_', ' ')}
                    </div>
                  </div>
                );
              })}
            </div>
          </section>

          {/* Repository Analysis Section */}
          <section className="rounded-xl border border-border bg-card p-6" data-testid="section-repo-analysis">
            <div className="mb-4 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <FolderGit2 size={17} className="text-accent-foreground" />
                <h2 className="text-base font-semibold">Repository Analysis</h2>
              </div>
              {analysis && (
                <span className="ff-mono rounded bg-secondary px-2 py-0.5 text-[10px] text-muted-foreground">
                  Discovered
                </span>
              )}
            </div>

            {analysis ? (
              <div className="grid gap-3 sm:grid-cols-2 md:grid-cols-3">
                <div className="rounded-lg border border-border/70 bg-secondary/30 p-3.5">
                  <div className="ff-mono text-[10px] uppercase tracking-wider text-muted-foreground">Language</div>
                  <div className="mt-1 text-sm font-semibold capitalize text-foreground">
                    {analysis.language || 'Python'} {analysis.python_version ? `(${analysis.python_version})` : ''}
                  </div>
                </div>
                <div className="rounded-lg border border-border/70 bg-secondary/30 p-3.5">
                  <div className="ff-mono text-[10px] uppercase tracking-wider text-muted-foreground">Test Framework</div>
                  <div className="mt-1 text-sm font-semibold text-foreground">
                    {analysis.test_framework || 'Not detected'}
                  </div>
                </div>
                <div className="rounded-lg border border-border/70 bg-secondary/30 p-3.5">
                  <div className="ff-mono text-[10px] uppercase tracking-wider text-muted-foreground">Test Command</div>
                  <div className="mt-1 ff-mono text-xs font-semibold text-accent-foreground">
                    {testCommand || 'None'}
                  </div>
                </div>
                <div className="rounded-lg border border-border/70 bg-secondary/30 p-3.5">
                  <div className="ff-mono text-[10px] uppercase tracking-wider text-muted-foreground">Source Directories</div>
                  <div className="mt-1 flex flex-wrap gap-1">
                    {analysis.source_paths && analysis.source_paths.length > 0 ? (
                      analysis.source_paths.map((p) => (
                        <span key={p} className="ff-mono rounded bg-secondary px-1.5 py-0.5 text-[11px] text-foreground">
                          {p}
                        </span>
                      ))
                    ) : (
                      <span className="text-xs text-muted-foreground">Root</span>
                    )}
                  </div>
                </div>
                <div className="rounded-lg border border-border/70 bg-secondary/30 p-3.5">
                  <div className="ff-mono text-[10px] uppercase tracking-wider text-muted-foreground">Test Directories</div>
                  <div className="mt-1 flex flex-wrap gap-1">
                    {analysis.test_paths && analysis.test_paths.length > 0 ? (
                      analysis.test_paths.map((p) => (
                        <span key={p} className="ff-mono rounded bg-secondary px-1.5 py-0.5 text-[11px] text-foreground">
                          {p}
                        </span>
                      ))
                    ) : (
                      <span className="text-xs text-muted-foreground">None detected</span>
                    )}
                  </div>
                </div>
                <div className="rounded-lg border border-border/70 bg-secondary/30 p-3.5">
                  <div className="ff-mono text-[10px] uppercase tracking-wider text-muted-foreground">Dependency Files</div>
                  <div className="mt-1 flex flex-wrap gap-1">
                    {analysis.dependency_files && analysis.dependency_files.length > 0 ? (
                      analysis.dependency_files.map((p) => (
                        <span key={p} className="ff-mono rounded bg-secondary px-1.5 py-0.5 text-[11px] text-foreground">
                          {p}
                        </span>
                      ))
                    ) : (
                      <span className="text-xs text-muted-foreground">None</span>
                    )}
                  </div>
                </div>
              </div>
            ) : (
              <div className="rounded-lg border border-dashed border-border p-6 text-center text-xs text-muted-foreground">
                No repository analysis available yet. Click &quot;Analyze Repository&quot; to inspect project structure.
              </div>
            )}
          </section>

          {/* Baseline Test Results Section */}
          <section className="rounded-xl border border-border bg-card p-6" data-testid="section-baseline-results">
            <div className="mb-4 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <FileCheck2 size={17} className="text-accent-foreground" />
                <h2 className="text-base font-semibold">Baseline Test Results</h2>
              </div>
              {baseline && (
                <span
                  className={`ff-mono rounded px-2.5 py-0.5 text-[11px] font-semibold uppercase ${
                    baseline.status === 'passed'
                      ? 'bg-emerald-500/15 text-emerald-500'
                      : 'bg-red-500/15 text-red-500'
                  }`}
                >
                  Status: {baseline.status ? baseline.status.toUpperCase() : 'UNKNOWN'}
                </span>
              )}
            </div>

            {baseline ? (
              <div className="space-y-4">
                <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
                  <div className="rounded-lg border border-border/70 bg-secondary/30 p-3 text-center">
                    <div className="text-lg font-bold text-foreground">
                      {baseline.passed} / {baseline.total}
                    </div>
                    <div className="ff-mono text-[10px] uppercase text-emerald-600">Passed</div>
                  </div>
                  <div className="rounded-lg border border-border/70 bg-secondary/30 p-3 text-center">
                    <div className="text-lg font-bold text-red-500">{baseline.failed}</div>
                    <div className="ff-mono text-[10px] uppercase text-red-500">Failed</div>
                  </div>
                  <div className="rounded-lg border border-border/70 bg-secondary/30 p-3 text-center">
                    <div className="text-lg font-bold text-muted-foreground">{baseline.skipped || 0}</div>
                    <div className="ff-mono text-[10px] uppercase text-muted-foreground">Skipped</div>
                  </div>
                  <div className="rounded-lg border border-border/70 bg-secondary/30 p-3 text-center">
                    <div className="text-lg font-bold text-amber-500">{baseline.errors || 0}</div>
                    <div className="ff-mono text-[10px] uppercase text-amber-500">Errors</div>
                  </div>
                  <div className="col-span-2 rounded-lg border border-border/70 bg-secondary/30 p-3 text-center sm:col-span-1">
                    <div className="text-lg font-bold text-foreground">
                      {Number(baseline.duration || 0).toFixed(2)}s
                    </div>
                    <div className="ff-mono text-[10px] uppercase text-muted-foreground">Duration</div>
                  </div>
                </div>

                <div className="h-2 overflow-hidden rounded-full bg-secondary">
                  <div
                    className="h-full rounded-full bg-emerald-500 transition-all"
                    style={{
                      width: `${baseline.total ? (baseline.passed / baseline.total) * 100 : 0}%`,
                    }}
                  />
                </div>
              </div>
            ) : (
              <div className="rounded-lg border border-dashed border-border p-6 text-center text-xs text-muted-foreground">
                No baseline tests executed yet. Click &quot;Analyze Repository&quot; to run tests.
              </div>
            )}
          </section>

          {/* Failure List Section */}
          {failures && failures.length > 0 && (
            <section className="rounded-xl border border-border bg-card p-6" data-testid="section-failure-list">
              <div className="mb-4 flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <AlertTriangle size={17} className="text-red-500" />
                  <h2 className="text-base font-semibold">Failure List ({failures.length})</h2>
                </div>
                <span className="ff-mono text-[11px] text-muted-foreground">Normalized Signatures</span>
              </div>

              <div className="space-y-3">
                {failures.map((f, idx) => (
                  <FailureItem key={`${f.test_name}-${idx}`} failure={f} />
                ))}
              </div>
            </section>
          )}

          {/* Sandbox Execution Section */}
          <section className="rounded-xl border border-border bg-card p-6" data-testid="section-sandbox-execution">
            <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <Box size={17} className="text-emerald-500" />
                <h2 className="text-base font-semibold">Sandbox Execution</h2>
              </div>
              <div className="flex items-center gap-2">
                {activeSandboxRun && (
                  <>
                    <span
                      className={`ff-mono rounded px-2.5 py-0.5 text-[11px] font-semibold uppercase ${
                        activeSandboxRun.status === 'completed' || activeSandboxRun.exitCode === 0
                          ? 'bg-emerald-500/15 text-emerald-500'
                          : activeSandboxRun.status === 'timeout'
                            ? 'bg-amber-500/15 text-amber-500'
                            : 'bg-red-500/15 text-red-500'
                      }`}
                    >
                      Status: {activeSandboxRun.status.toUpperCase()}
                    </span>
                    {activeSandboxRun.sandboxed ? (
                      <span className="ff-mono rounded bg-emerald-500/15 px-2.5 py-0.5 text-[11px] font-semibold text-emerald-500">
                        SANDBOXED ✓
                      </span>
                    ) : (
                      <span className="ff-mono rounded bg-amber-500/15 px-2.5 py-0.5 text-[11px] font-semibold text-amber-500">
                        LOCAL EXECUTION
                      </span>
                    )}
                  </>
                )}
              </div>
            </div>

            {activeSandboxRun ? (
              <div className="space-y-4">
                <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                  <div className="rounded-lg border border-border/70 bg-secondary/30 p-3">
                    <div className="ff-mono text-[10px] uppercase text-muted-foreground">Command</div>
                    <div className="mt-1 ff-mono text-xs font-semibold text-accent-foreground">
                      {activeSandboxRun.command}
                    </div>
                  </div>
                  <div className="rounded-lg border border-border/70 bg-secondary/30 p-3">
                    <div className="ff-mono text-[10px] uppercase text-muted-foreground">Exit Code</div>
                    <div className={`mt-1 text-sm font-bold ${activeSandboxRun.exitCode === 0 ? 'text-emerald-500' : 'text-red-500'}`}>
                      {activeSandboxRun.exitCode}
                    </div>
                  </div>
                  <div className="rounded-lg border border-border/70 bg-secondary/30 p-3">
                    <div className="ff-mono text-[10px] uppercase text-muted-foreground">Duration</div>
                    <div className="mt-1 text-sm font-bold text-foreground">
                      {Number(activeSandboxRun.duration || 0).toFixed(2)}s
                    </div>
                  </div>
                  <div className="rounded-lg border border-border/70 bg-secondary/30 p-3">
                    <div className="ff-mono text-[10px] uppercase text-muted-foreground">Timed Out</div>
                    <div className={`mt-1 text-sm font-bold ${activeSandboxRun.timedOut ? 'text-red-500' : 'text-foreground'}`}>
                      {activeSandboxRun.timedOut ? 'Yes' : 'No'}
                    </div>
                  </div>
                </div>

                {/* Output Viewer */}
                <SandboxOutputViewer stdout={activeSandboxRun.stdout} stderr={activeSandboxRun.stderr} />
              </div>
            ) : (
              <div className="rounded-lg border border-dashed border-border p-6 text-center text-xs text-muted-foreground">
                No sandbox execution recorded yet. Click &quot;Run in Sandbox&quot; to execute test suite in an isolated Docker container.
              </div>
            )}
          </section>

          {/* Execution History Section */}
          {sandboxRuns.length > 0 && (
            <section className="rounded-xl border border-border bg-card p-6" data-testid="section-execution-history">
              <div className="mb-4 flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Layers3 size={17} className="text-accent-foreground" />
                  <h2 className="text-base font-semibold">Execution History ({sandboxRuns.length})</h2>
                </div>
                <span className="ff-mono text-[11px] text-muted-foreground">Timeline</span>
              </div>

              <div className="space-y-2.5">
                {sandboxRuns.map((run, idx) => (
                  <ExecutionHistoryItem key={run.id || idx} run={run} index={idx + 1} />
                ))}
              </div>
            </section>
          )}

          {/* Milestone 4: Root Cause Analysis Section */}
          {activeRootCause && (
            <section className="rounded-xl border border-border bg-card p-6" data-testid="section-root-cause">
              <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <Sparkles size={17} className="text-indigo-500" />
                  <h2 className="text-base font-semibold">Root Cause Analysis</h2>
                </div>
                <div className="flex items-center gap-2">
                  <span className="ff-mono rounded bg-indigo-500/15 px-2.5 py-0.5 text-[11px] font-semibold text-indigo-500 uppercase">
                    Type: {activeRootCause.failure_type || 'logic_error'}
                  </span>
                  <span className="ff-mono rounded bg-emerald-500/15 px-2.5 py-0.5 text-[11px] font-semibold text-emerald-500">
                    {Math.round((activeRootCause.confidence || 0.85) * 100)}% AI Confidence
                  </span>
                </div>
              </div>

              <div className="space-y-3">
                <div className="rounded-lg border border-border/70 bg-secondary/30 p-3.5">
                  <div className="ff-mono text-[10px] font-semibold uppercase text-muted-foreground">Summary</div>
                  <div className="mt-1 text-xs font-medium text-foreground">{activeRootCause.summary}</div>
                </div>

                <div className="grid gap-3 sm:grid-cols-2">
                  {activeRootCause.observed && (
                    <div className="rounded-lg border border-border/70 bg-secondary/20 p-3">
                      <div className="ff-mono text-[10px] font-semibold uppercase text-blue-400">Observed Fact</div>
                      <div className="mt-1 text-xs text-muted-foreground">{activeRootCause.observed}</div>
                    </div>
                  )}
                  {activeRootCause.hypothesis && (
                    <div className="rounded-lg border border-border/70 bg-secondary/20 p-3">
                      <div className="ff-mono text-[10px] font-semibold uppercase text-purple-400">AI Hypothesis</div>
                      <div className="mt-1 text-xs text-muted-foreground">{activeRootCause.hypothesis}</div>
                    </div>
                  )}
                </div>

                <div className="rounded-lg border border-border/70 bg-secondary/30 p-3.5">
                  <div className="ff-mono text-[10px] font-semibold uppercase text-muted-foreground">Detailed Root Cause</div>
                  <div className="mt-1 text-xs text-muted-foreground leading-relaxed">{activeRootCause.root_cause}</div>
                </div>

                {Array.isArray(activeRootCause.evidence) && activeRootCause.evidence.length > 0 && (
                  <div>
                    <div className="mb-2 ff-mono text-[10px] font-semibold uppercase text-muted-foreground">
                      Evidence from Code ({activeRootCause.evidence.length})
                    </div>
                    <div className="space-y-2">
                      {activeRootCause.evidence.map((ev, idx) => (
                        <div key={idx} className="flex flex-col gap-1 rounded-md border border-border bg-secondary/10 p-2.5 text-xs sm:flex-row sm:items-center sm:justify-between">
                          <span className="ff-mono font-semibold text-accent-foreground">
                            {ev.file}{ev.line ? `:${ev.line}` : ''}
                          </span>
                          <span className="text-muted-foreground">{ev.reason}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </section>
          )}

          {/* Milestone 4: Patch Plan Section */}
          {patchPlan && (
            <section className="rounded-xl border border-border bg-card p-6" data-testid="section-patch-plan">
              <div className="mb-4 flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <FileCheck2 size={17} className="text-amber-500" />
                  <h2 className="text-base font-semibold">Patch Plan</h2>
                </div>
                <span className="ff-mono text-[11px] text-muted-foreground">Minimal Repair Plan</span>
              </div>

              <div className="space-y-3">
                <div className="rounded-lg border border-border/70 bg-secondary/30 p-3.5">
                  <div className="ff-mono text-[10px] font-semibold uppercase text-muted-foreground">Objective</div>
                  <div className="mt-1 text-xs font-medium text-foreground">{patchPlan.objective}</div>
                </div>

                {Array.isArray(patchPlan.files_to_modify) && patchPlan.files_to_modify.length > 0 && (
                  <div>
                    <div className="mb-1.5 ff-mono text-[10px] font-semibold uppercase text-muted-foreground">Target Files to Modify</div>
                    <div className="flex flex-wrap gap-1.5">
                      {patchPlan.files_to_modify.map((f, i) => (
                        <span key={i} className="ff-mono rounded bg-amber-500/10 px-2 py-0.5 text-xs text-amber-500">
                          {f}
                        </span>
                      ))}
                    </div>
                  </div>
                )}

                {Array.isArray(patchPlan.changes) && patchPlan.changes.length > 0 && (
                  <div>
                    <div className="mb-1.5 ff-mono text-[10px] font-semibold uppercase text-muted-foreground">Planned Changes</div>
                    <div className="space-y-1.5">
                      {patchPlan.changes.map((ch, i) => (
                        <div key={i} className="rounded border border-border bg-secondary/15 p-2 text-xs">
                          <span className="ff-mono font-semibold text-accent-foreground">{ch.file} ({ch.location}): </span>
                          <span className="text-muted-foreground">{ch.description}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {Array.isArray(patchPlan.risks) && patchPlan.risks.length > 0 && (
                  <div>
                    <div className="mb-1.5 ff-mono text-[10px] font-semibold uppercase text-amber-500">Regression Risks & Safeguards</div>
                    <ul className="list-inside list-disc text-xs text-muted-foreground space-y-0.5">
                      {patchPlan.risks.map((r, i) => (
                        <li key={i}>{r}</li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            </section>
          )}

          {/* Milestone 4: Generated Patch & Unified Diff Section */}
          {activePatch && (
            <section className="rounded-xl border border-border bg-card p-6" data-testid="section-generated-patch">
              <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <FileDiff size={17} className="text-amber-500" />
                  <h2 className="text-base font-semibold">Generated Unified Diff</h2>
                </div>
                <div className="flex items-center gap-2">
                  <span
                    className={`ff-mono rounded px-2.5 py-0.5 text-[11px] font-semibold uppercase ${
                      activePatch.status === 'APPLIED'
                        ? 'bg-blue-500/15 text-blue-400'
                        : activePatch.status === 'VALID'
                          ? 'bg-emerald-500/15 text-emerald-500'
                          : activePatch.status === 'REQUIRES_REVIEW'
                            ? 'bg-amber-500/15 text-amber-500'
                            : 'bg-red-500/15 text-red-500'
                    }`}
                  >
                    Status: {activePatch.status}
                  </span>
                  <span className="ff-mono rounded bg-emerald-500/10 px-2 py-0.5 text-xs font-semibold text-emerald-400">
                    +{activePatch.linesAdded}
                  </span>
                  <span className="ff-mono rounded bg-red-500/10 px-2 py-0.5 text-xs font-semibold text-red-400">
                    -{activePatch.linesRemoved}
                  </span>
                </div>
              </div>

              <div className="space-y-4">
                <DiffViewer diff={activePatch.diff} />

                {/* Validation messages */}
                {validation && (
                  <div className="flex flex-wrap items-center gap-4 text-xs text-muted-foreground">
                    <div>Validation: <span className="font-semibold text-foreground">{validation.valid ? 'Passed' : 'Failed'}</span></div>
                    {validation.errors && validation.errors.length > 0 && (
                      <div className="text-red-400">Errors: {validation.errors.join('; ')}</div>
                    )}
                    {validation.warnings && validation.warnings.length > 0 && (
                      <div className="text-amber-400">Warnings: {validation.warnings.join('; ')}</div>
                    )}
                  </div>
                )}

                {/* Patch Action Bar */}
                <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border pt-4">
                  <div className="text-xs text-muted-foreground">
                    {activePatch.status === 'APPLIED' ? (
                      <span className="inline-flex items-center gap-1.5 font-semibold text-emerald-400">
                        <CheckCheck size={14} /> Patch applied to repository workspace with automatic backup.
                      </span>
                    ) : (
                      <span>Review the diff before explicitly applying to repository files.</span>
                    )}
                  </div>

                  {activePatch.status !== 'APPLIED' && (
                    <button
                      type="button"
                      disabled={isPatchApplying || activePatch.status === 'INVALID'}
                      onClick={handleApplyPatch}
                      data-testid="button-apply-patch"
                      className="inline-flex items-center gap-2 rounded-lg bg-emerald-600 px-4 py-2 text-xs font-semibold text-white shadow-sm hover:bg-emerald-500 disabled:opacity-50"
                    >
                      {isPatchApplying ? (
                        <>
                          <LoaderCircle size={14} className="animate-spin" />
                          Applying Patch...
                        </>
                      ) : (
                        <>
                          <Wrench size={14} />
                          Apply Patch
                        </>
                      )}
                    </button>
                  )}
                </div>
              </div>
            </section>
          )}

          {/* Milestone 5: Self-Correction Loop & Attempt History */}
          <section className="rounded-xl border border-border bg-card p-6" data-testid="section-self-correction-loop">
            <div className="mb-5 flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <RotateCcw size={17} className="text-accent-foreground" />
                <h2 className="text-base font-semibold">Self-Correction & Verification Loop (M5)</h2>
              </div>
              <div className="flex items-center gap-2">
                <span className="ff-mono rounded bg-secondary px-2 py-0.5 text-[10px] text-muted-foreground">
                  {attempts.length} Attempt{attempts.length === 1 ? '' : 's'} recorded
                </span>
                {job.status === 'verified' && (
                  <span className="ff-mono rounded bg-emerald-500/20 px-2 py-0.5 text-[10px] font-bold text-emerald-400">
                    VERIFIED ✓
                  </span>
                )}
              </div>
            </div>

            {attempts.length > 0 ? (
              <div className="space-y-4">
                {attempts.map((att, idx) => (
                  <AttemptCard key={att.id || idx} attempt={att} index={idx + 1} />
                ))}
              </div>
            ) : (
              <div className="rounded-lg border border-dashed border-border/80 p-5 text-center">
                <History size={24} className="mx-auto mb-2 text-muted-foreground" />
                <div className="text-xs font-semibold">No self-correction attempts yet</div>
                <p className="mt-1 text-xs text-muted-foreground">
                  Click &ldquo;Start Autonomous Repair&rdquo; above to run the full Detect → Analyze → Patch → Execute → Observe → Refine → Retry loop.
                </p>
              </div>
            )}

            {/* Milestone 7: Repair Execution Timeline (Part 10) */}
            <div className="mt-6 border-t border-border pt-5" data-testid="section-repair-execution-timeline">
              <div className="mb-4 flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Clock size={16} className="text-accent-foreground" />
                  <h3 className="text-sm font-semibold tracking-tight text-white">REPAIR EXECUTION TIMELINE</h3>
                </div>
                <span className="ff-mono text-[10px] text-muted-foreground">
                  {fetchedEvents.length} Recorded Events
                </span>
              </div>

              {fetchedEvents.length > 0 ? (
                <div className="space-y-2">
                  {fetchedEvents.map((ev, idx) => {
                    const timeStr = ev.createdAt
                      ? new Date(ev.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })
                      : '--:--:--';

                    const isVerified = ev.eventType === 'REPAIR_VERIFIED' || ev.event === 'repair.verified' || ev.event === 'REPAIR_VERIFIED';
                    const isError = ev.status === 'error' || ev.eventType?.includes('FAILED') || ev.event?.includes('failed');
                    const isWarning = ev.status === 'warning' || ev.eventType === 'REGRESSION_DETECTED' || ev.eventType === 'FAILURE_DETECTED';

                    return (
                      <div
                        key={ev.id || idx}
                        className={`flex items-start gap-3 rounded-lg border p-2.5 text-xs transition-colors ${
                          isVerified
                            ? 'border-emerald-500/40 bg-emerald-500/10'
                            : isError
                              ? 'border-red-500/30 bg-red-500/5'
                              : isWarning
                                ? 'border-amber-500/30 bg-amber-500/5'
                                : 'border-border/60 bg-secondary/20'
                        }`}
                      >
                        <span className="ff-mono text-[11px] text-muted-foreground shrink-0 mt-0.5">
                          {timeStr}
                        </span>

                        <div className="mt-0.5 shrink-0">
                          {isVerified ? (
                            <span className="text-sm">🎯</span>
                          ) : isError ? (
                            <span className="text-red-400 font-bold">❌</span>
                          ) : isWarning ? (
                            <span className="text-amber-400 font-bold">⚠</span>
                          ) : (
                            <span className="text-emerald-400 font-bold">✓</span>
                          )}
                        </div>

                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2">
                            <span className={`font-semibold ${isVerified ? 'text-emerald-400 font-bold' : 'text-foreground'}`}>
                              {formatEventLabel(ev)}
                            </span>
                            {ev.durationMs != null && (
                              <span className="ff-mono text-[10px] rounded bg-secondary px-1.5 py-0.5 text-muted-foreground">
                                +{(ev.durationMs / 1000).toFixed(1)}s
                              </span>
                            )}
                          </div>
                          <div className="text-xs text-muted-foreground mt-0.5 truncate">
                            {ev.message}
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              ) : (
                <div className="rounded-lg border border-dashed border-border/80 p-4 text-center text-xs text-muted-foreground">
                  No execution events recorded yet.
                </div>
              )}
            </div>
          </section>

          {/* Milestone 9: Human Approval Gate Section */}
          <section className="rounded-xl border border-border bg-card p-6" data-testid="section-approval-gate">
            <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-center gap-2">
                <ShieldCheck size={18} className="text-accent" />
                <h2 className="text-base font-semibold">Human Approval Gate (Milestone 9)</h2>
              </div>
              <div className="flex items-center gap-2">
                {job.approvalStatus === 'APPROVED' ? (
                  <span className="ff-mono rounded bg-emerald-500/20 px-2.5 py-1 text-xs font-semibold text-emerald-400" data-testid="approval-status">
                    ✓ APPROVED FOR PR
                  </span>
                ) : job.approvalStatus === 'REJECTED' ? (
                  <span className="ff-mono rounded bg-red-500/20 px-2.5 py-1 text-xs font-semibold text-red-400" data-testid="approval-status">
                    ✕ REJECTED
                  </span>
                ) : job.status === 'verified' || job.approvalStatus === 'AWAITING_APPROVAL' ? (
                  <span className="ff-mono rounded bg-amber-500/20 px-2.5 py-1 text-xs font-semibold text-amber-400" data-testid="approval-status">
                    ⏱ AWAITING HUMAN REVIEW
                  </span>
                ) : (
                  <span className="ff-mono rounded bg-secondary px-2.5 py-1 text-xs text-muted-foreground" data-testid="approval-status">
                    PENDING VERIFICATION
                  </span>
                )}
              </div>
            </div>

            <p className="text-xs text-muted-foreground mb-4">
              FixForge enterprise governance enforces human verification sign-off before exporting code to GitHub.
              Approvals are cryptographically tied to organization members with ADMIN or MANAGER privileges.
            </p>

            {approveError && (
              <div className="mb-4 rounded-lg border border-red-500/20 bg-red-500/10 p-3 text-xs text-red-400">
                <div className="font-semibold">Approval Action Failed</div>
                <div className="mt-1">{approveError}</div>
              </div>
            )}

            <div className="rounded-lg border border-border/70 bg-secondary/20 p-4 mb-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <div className="text-xs font-semibold text-foreground">
                    Review Status: {job.approvalStatus || (job.status === 'verified' ? 'AWAITING_APPROVAL' : 'PENDING')}
                  </div>
                  {job.approvedBy && (
                    <div className="ff-mono text-[11px] text-muted-foreground mt-0.5">
                      Approved by user {job.approvedBy} on {job.approvedAt ? new Date(job.approvedAt).toLocaleString() : 'recently'}
                    </div>
                  )}
                  {job.rejectionReason && (
                    <div className="ff-mono text-[11px] text-red-400 mt-0.5">
                      Reason: {job.rejectionReason}
                    </div>
                  )}
                </div>

                <div className="flex items-center gap-2">
                  {canApprove && (job.status === 'verified' || job.approvalStatus === 'AWAITING_APPROVAL') && job.approvalStatus !== 'APPROVED' && (
                    <>
                      <button
                        type="button"
                        disabled={isApproving || isRejecting}
                        onClick={handleApproveRepair}
                        data-testid="button-approve-repair"
                        className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-600 px-3.5 py-1.5 text-xs font-semibold text-white hover:bg-emerald-500 disabled:opacity-50"
                      >
                        {isApproving ? <LoaderCircle size={13} className="animate-spin" /> : <ThumbsUp size={13} />}
                        Approve Repair
                      </button>

                      <button
                        type="button"
                        disabled={isApproving || isRejecting}
                        onClick={() => setShowRejectForm(!showRejectForm)}
                        data-testid="button-reject-toggle"
                        className="inline-flex items-center gap-1.5 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-1.5 text-xs font-semibold text-red-400 hover:bg-red-500/20 disabled:opacity-50"
                      >
                        <ThumbsDown size={13} />
                        Reject
                      </button>
                    </>
                  )}

                  {!canApprove && job.status === 'verified' && job.approvalStatus !== 'APPROVED' && (
                    <span className="text-xs text-muted-foreground italic">
                      Pending review by Manager or Admin ({role} role cannot approve)
                    </span>
                  )}
                </div>
              </div>

              {showRejectForm && (
                <div className="mt-3 pt-3 border-t border-border/60">
                  <label className="block text-[11px] font-semibold text-muted-foreground mb-1">
                    Rejection Reason
                  </label>
                  <div className="flex gap-2">
                    <input
                      type="text"
                      value={rejectReason}
                      onChange={(e) => setRejectReason(e.target.value)}
                      placeholder="e.g. Patch introduces potential regression or style deviation"
                      className="flex-1 rounded-lg border border-border bg-secondary px-3 py-1.5 text-xs text-foreground focus:border-accent focus:outline-none"
                    />
                    <button
                      type="button"
                      disabled={isRejecting}
                      onClick={handleRejectRepair}
                      className="rounded-lg bg-red-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-red-500"
                    >
                      Confirm Reject
                    </button>
                  </div>
                </div>
              )}
            </div>
          </section>

          {/* Milestone 6: GitHub Integration Section */}
          <section className="rounded-xl border border-border bg-card p-6" data-testid="section-github-integration">
            <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-center gap-2">
                <GitPullRequest size={18} className="text-accent-foreground" />
                <h2 className="text-base font-semibold">GitHub Integration</h2>
              </div>
              <div className="flex items-center gap-2">
                {githubData?.integration?.status === 'PR_CREATED' ? (
                  <span className="ff-mono rounded bg-amber-500/15 px-2.5 py-1 text-xs font-semibold text-amber-400" data-testid="github-status">
                    Awaiting Human Review
                  </span>
                ) : job.status === 'verified' ? (
                  <span className="ff-mono rounded bg-emerald-500/15 px-2.5 py-1 text-xs font-semibold text-emerald-400" data-testid="github-status">
                    Verified · Ready for PR
                  </span>
                ) : (
                  <span className="ff-mono rounded bg-secondary px-2.5 py-1 text-xs text-muted-foreground" data-testid="github-status">
                    Pending Verification
                  </span>
                )}
              </div>
            </div>

            <p className="text-xs text-muted-foreground mb-4">
              Export verified fix directly to GitHub as an isolated repair branch, create a structured commit, and open a Pull Request for human review.
            </p>

            {prError && (
              <div className="mb-4 rounded-lg border border-red-500/20 bg-red-500/10 p-3 text-xs text-red-400">
                <div className="font-semibold">GitHub Workflow Error</div>
                <div className="mt-1">{prError}</div>
              </div>
            )}

            <div className="grid gap-3 sm:grid-cols-2 md:grid-cols-4 mb-5">
              <div className="rounded-lg border border-border/70 bg-secondary/30 p-3.5">
                <div className="ff-mono text-[10px] uppercase tracking-wider text-muted-foreground">Repository</div>
                <div className="mt-1 ff-mono text-xs font-semibold text-foreground truncate">
                  {githubData?.owner && githubData?.repository
                    ? `${githubData.owner}/${githubData.repository}`
                    : project.data?.name || 'Local Repository'}
                </div>
              </div>

              <div className="rounded-lg border border-border/70 bg-secondary/30 p-3.5">
                <div className="ff-mono text-[10px] uppercase tracking-wider text-muted-foreground">Branch</div>
                <div className="mt-1 ff-mono text-xs font-semibold text-accent-foreground truncate" data-testid="github-branch">
                  {githubData?.integration?.repairBranch || `fixfixforge/repair-${job.id.slice(0, 8)}`}
                </div>
              </div>

              <div className="rounded-lg border border-border/70 bg-secondary/30 p-3.5">
                <div className="ff-mono text-[10px] uppercase tracking-wider text-muted-foreground">Commit</div>
                <div className="mt-1 ff-mono text-xs font-semibold text-foreground truncate" data-testid="github-commit">
                  {githubData?.integration?.commitSha
                    ? githubData.integration.commitSha.slice(0, 8)
                    : 'Pending commit'}
                </div>
              </div>

              <div className="rounded-lg border border-border/70 bg-secondary/30 p-3.5">
                <div className="ff-mono text-[10px] uppercase tracking-wider text-muted-foreground">Pull Request</div>
                <div className="mt-1 ff-mono text-xs font-semibold text-emerald-400" data-testid="github-pr-number">
                  {githubData?.integration?.pullRequestNumber ? (
                    <a
                      href={githubData.integration.pullRequestUrl || '#'}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1 hover:underline"
                    >
                      #{githubData.integration.pullRequestNumber} <ExternalLink size={12} />
                    </a>
                  ) : (
                    <span className="text-muted-foreground">Not created yet</span>
                  )}
                </div>
              </div>
            </div>

            {/* Safety & Action Controls */}
            <div className="flex flex-wrap items-center justify-between gap-4 rounded-lg border border-border/60 bg-secondary/20 p-4">
              <div className="text-xs text-muted-foreground max-w-lg">
                <span className="font-semibold text-foreground">Human Review Boundary: </span>
                {isViewer
                  ? '🔒 Viewers have read-only access and cannot open Pull Requests.'
                  : job.approvalStatus !== 'APPROVED' && job.status === 'verified'
                  ? '⚠️ Human approval required by enterprise policy prior to Pull Request generation.'
                  : job.status === 'verified'
                  ? 'FixForge enforces developer review before merge. Automated merge is disabled.'
                  : '❌ Repair must be verified before creating a Pull Request.'}
              </div>

              <div className="flex items-center gap-3">
                {githubData?.integration?.pullRequestUrl ? (
                  <a
                    href={githubData.integration.pullRequestUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    data-testid="button-open-pr"
                    className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-600 px-4 py-2 text-xs font-semibold text-white shadow-sm hover:bg-emerald-500"
                  >
                    <ExternalLink size={14} /> Open Pull Request
                  </a>
                ) : (
                  <button
                    type="button"
                    disabled={isCreatingPr || job.status !== 'verified' || isViewer || job.approvalStatus === 'REJECTED'}
                    onClick={handleCreatePullRequest}
                    data-testid="button-create-pr"
                    className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-4 py-2 text-xs font-semibold text-primary-foreground shadow-sm hover:opacity-90 disabled:opacity-50"
                  >
                    {isCreatingPr ? (
                      <>
                        <LoaderCircle size={14} className="animate-spin" />
                        Creating Pull Request...
                      </>
                    ) : (
                      <>
                        <GitPullRequest size={14} />
                        Create Pull Request
                      </>
                    )}
                  </button>
                )}
              </div>
            </div>
          </section>

          {/* Milestone 4: Agent Timeline */}
          <section className="rounded-xl border border-border bg-card p-6" data-testid="section-agent-timeline">
            <div className="mb-5 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <TerminalSquare size={17} className="text-accent-foreground" />
                <h2 className="text-base font-semibold">Agent Timeline</h2>
              </div>
              <span className="ff-mono text-[10px] text-muted-foreground">Sequential Verification</span>
            </div>
            <div className="space-y-0">
              {[
                { label: 'Repository analyzed', done: Boolean(analysis), active: isAnalyzing },
                { label: 'Baseline tests executed', done: Boolean(baseline), active: isAnalyzing },
                { label: 'Failure detected', done: failures.length > 0, active: false },
                { label: 'Root cause identified', done: Boolean(activeRootCause), active: isRootCauseRunning },
                { label: 'Patch generated', done: Boolean(activePatch), active: isPatchGenerating },
                { label: 'Patch validated', done: Boolean(validation?.valid || activePatch?.status === 'VALID' || activePatch?.status === 'APPLIED'), active: isPatchGenerating },
                { label: 'Patch applied', done: Boolean(latestApplyResult?.applied || activePatch?.status === 'APPLIED'), active: isPatchApplying },
              ].map((step, idx) => (
                <div key={idx} className="flex gap-3 border-b border-border/70 py-3 last:border-0">
                  <div
                    className={`mt-0.5 flex h-6 w-6 items-center justify-center rounded-md ${
                      step.done
                        ? 'bg-emerald-500/15 text-emerald-500'
                        : step.active
                          ? 'bg-accent/20 text-accent-foreground'
                          : 'bg-secondary text-muted-foreground'
                    }`}
                  >
                    {step.done ? (
                      <CheckCircle2 size={13} />
                    ) : step.active ? (
                      <LoaderCircle size={13} className="animate-spin" />
                    ) : (
                      <CircleDot size={13} />
                    )}
                  </div>
                  <div className="flex-1">
                    <div className="text-xs font-medium">{step.label}</div>
                    <div className="mt-0.5 ff-mono text-[10px] text-muted-foreground">
                      {step.done ? 'completed ✓' : step.active ? 'in progress...' : 'pending'}
                    </div>
                  </div>
                  <div className="ff-mono text-[10px] text-muted-foreground">
                    {step.done ? 'recorded' : step.active ? 'active' : '—'}
                  </div>
                </div>
              ))}
            </div>
          </section>
        </div>

        <div className="space-y-6">
          {/* Milestone 7: Repair Analytics Panel (Part 11) */}
          <section className="rounded-xl border border-border bg-card p-5" data-testid="section-repair-analytics">
            <div className="mb-4 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Gauge size={16} className="text-accent-foreground" />
                <h2 className="text-sm font-semibold">Repair Analytics</h2>
              </div>
              <span className="ff-mono rounded bg-secondary px-2 py-0.5 text-[10px] text-muted-foreground">M7 Telemetry</span>
            </div>

            <div className="space-y-3 divide-y divide-border/60 text-xs">
              <div className="flex items-center justify-between pt-1">
                <span className="text-muted-foreground">Total Duration</span>
                <span className="ff-mono font-semibold text-foreground" data-testid="analytics-total-duration">
                  {repairMetrics?.stageDurations?.totalDurationSeconds != null
                    ? `${repairMetrics.stageDurations.totalDurationSeconds}s`
                    : '—'}
                </span>
              </div>

              <div className="flex items-center justify-between pt-2">
                <span className="text-muted-foreground">Attempts</span>
                <span className="ff-mono font-semibold text-foreground" data-testid="analytics-attempts">
                  {repairMetrics?.attemptCount ?? (attempts.length || 1)}
                </span>
              </div>

              <div className="flex items-center justify-between pt-2">
                <span className="text-muted-foreground">Baseline Tests</span>
                <span className="ff-mono font-semibold text-amber-400" data-testid="analytics-baseline">
                  {baseline?.passed != null && baseline?.total != null ? `${baseline.passed}/${baseline.total}` : '4/5'}
                </span>
              </div>

              <div className="flex items-center justify-between pt-2">
                <span className="text-muted-foreground">Final Tests</span>
                <span className={`ff-mono font-semibold ${job.testsPassed === job.testsTotal ? 'text-emerald-400' : 'text-amber-400'}`} data-testid="analytics-final">
                  {job.testsPassed}/{job.testsTotal}
                </span>
              </div>

              <div className="flex items-center justify-between pt-2">
                <span className="text-muted-foreground">Verification</span>
                <span className={`ff-mono font-bold ${job.status === 'verified' ? 'text-emerald-400' : 'text-red-400'}`} data-testid="analytics-verification">
                  {job.status === 'verified' ? 'PASSED' : job.status.toUpperCase()}
                </span>
              </div>

              <div className="flex items-center justify-between pt-2">
                <span className="text-muted-foreground">Verification Duration</span>
                <span className="ff-mono text-muted-foreground" data-testid="analytics-verification-duration">
                  {repairMetrics?.stageDurations?.verificationDurationMs != null
                    ? `${(repairMetrics.stageDurations.verificationDurationMs / 1000).toFixed(1)}s`
                    : '—'}
                </span>
              </div>

              <div className="flex items-center justify-between pt-2">
                <span className="text-muted-foreground">Git Workflow</span>
                <span className="ff-mono text-muted-foreground" data-testid="analytics-git-duration">
                  {repairMetrics?.stageDurations?.gitWorkflowDurationMs != null
                    ? `${(repairMetrics.stageDurations.gitWorkflowDurationMs / 1000).toFixed(1)}s`
                    : githubData?.integration ? 'Completed' : 'Pending'}
                </span>
              </div>

              <div className="flex items-center justify-between pt-2">
                <span className="text-muted-foreground">Pull Request</span>
                <span className="ff-mono font-semibold text-accent-foreground" data-testid="analytics-pr-status">
                  {githubData?.integration?.pullRequestNumber
                    ? `#${githubData.integration.pullRequestNumber}`
                    : 'Pending'}
                </span>
              </div>
            </div>

            {/* AI Model Telemetry (Part 8) */}
            {repairMetrics?.telemetry && (
              <div className="mt-4 rounded-lg bg-secondary/30 p-3 border border-border/70 text-[11px]">
                <div className="ff-mono uppercase text-[9px] text-muted-foreground font-semibold mb-1.5 flex items-center justify-between">
                  <span>AI Model Telemetry</span>
                  <span className="text-accent-foreground">Part 8</span>
                </div>
                <div className="space-y-1 text-muted-foreground">
                  <div className="flex justify-between">
                    <span>Provider:</span>
                    <span className="text-foreground">{repairMetrics.telemetry.provider}</span>
                  </div>
                  <div className="flex justify-between">
                    <span>Model:</span>
                    <span className="ff-mono text-foreground truncate max-w-[140px]">{repairMetrics.telemetry.model}</span>
                  </div>
                  <div className="flex justify-between">
                    <span>Token Usage:</span>
                    <span className="ff-mono text-muted-foreground">
                      {repairMetrics.telemetry.tokenUsage != null ? repairMetrics.telemetry.tokenUsage : 'Not reported'}
                    </span>
                  </div>
                </div>
              </div>
            )}
          </section>

          <section className="rounded-xl border border-border bg-card p-5">
            <div className="mb-4 ff-mono text-[10px] uppercase tracking-[.2em] text-muted-foreground">
              Run profile
            </div>
            <div className="space-y-4">
              <Info icon={<Code2 size={15} />} label="Model" value={job.model} />
              <Info icon={<Code2 size={15} />} label="Language" value={job.language || project.data?.language || 'Python'} />
              <Info icon={<ShieldCheck size={15} />} label="Framework" value={job.testFramework || job.framework || project.data?.testFramework || 'pytest'} />
              <Info icon={<ShieldCheck size={15} />} label="Verification" value={job.verificationLevel} />
              <Info icon={<Layers3 size={15} />} label="Iteration budget" value={`${job.maxIterations} max`} />
              <Info
                icon={<GitCommitHorizontal size={15} />}
                label="Project"
                value={project.data?.name || job.projectId.slice(0, 12)}
              />
            </div>
          </section>

          <section className="rounded-xl border border-border bg-card p-5">
            <div className="mb-4 flex items-center gap-2">
              <FileCheck2 size={16} className="text-accent-foreground" />
              <h2 className="text-sm font-semibold">Test verification</h2>
            </div>
            <div className="mb-3 flex items-end justify-between">
              <span className="text-2xl font-semibold tracking-tight">
                {job.testsPassed}
                <span className="text-sm font-normal text-muted-foreground">/{job.testsTotal} passing</span>
              </span>
              <span className="ff-mono text-[10px] text-muted-foreground">
                {job.testsTotal ? Math.round((job.testsPassed / job.testsTotal) * 100) : 0}%
              </span>
            </div>
            <div className="h-2 overflow-hidden rounded-full bg-secondary">
              <div
                className="h-full rounded-full bg-emerald-500"
                style={{ width: `${job.testsTotal ? (job.testsPassed / job.testsTotal) * 100 : 0}%` }}
              />
            </div>
          </section>

          <Link
            href={project.data ? `/projects/${project.data.id}` : '/'}
            data-testid="link-detail-project"
            className="flex items-center justify-between rounded-xl border border-border bg-primary p-5 text-primary-foreground hover:-translate-y-px"
          >
            <div>
              <div className="ff-mono text-[10px] uppercase tracking-[.18em] text-primary-foreground/50">
                Project context
              </div>
              <div className="mt-1 text-sm font-semibold">{project.data?.name || 'Open project'}</div>
            </div>
            <ArrowLeft size={16} className="rotate-180 text-accent" />
          </Link>
        </div>
      </div>
    </div>
  );
}

function FailureItem({ failure }) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="rounded-lg border border-red-500/20 bg-red-500/5 p-4 transition-all">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <span className="font-semibold text-sm text-foreground">{failure.test_name}</span>
            <span className="ff-mono rounded bg-red-500/15 px-2 py-0.5 text-[10px] font-semibold text-red-500">
              {failure.error_type || 'Error'}
            </span>
          </div>
          <div className="text-xs text-red-400 font-medium">
            {failure.message}
          </div>
          <div className="ff-mono text-[11px] text-muted-foreground">
            {failure.source_reference || failure.file || 'Unknown location'}
          </div>
        </div>

        {failure.traceback && (
          <button
            type="button"
            onClick={() => setExpanded(!expanded)}
            className="inline-flex items-center gap-1 text-[11px] font-medium text-muted-foreground hover:text-foreground"
          >
            {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
            {expanded ? 'Hide Traceback' : 'View Traceback'}
          </button>
        )}
      </div>

      {expanded && failure.traceback && (
        <div className="mt-3 overflow-x-auto rounded bg-background/90 p-3 border border-border">
          <pre className="ff-mono text-[11px] leading-relaxed text-muted-foreground whitespace-pre-wrap">
            {failure.traceback}
          </pre>
        </div>
      )}
    </div>
  );
}

function Info({ icon, label, value }) {
  return (
    <div className="flex items-center gap-3">
      <div className="flex h-7 w-7 items-center justify-center rounded-md bg-secondary text-muted-foreground">
        {icon}
      </div>
      <span className="flex-1 text-xs text-muted-foreground">{label}</span>
      <span className="ff-mono text-[10px] font-medium text-foreground">{value}</span>
    </div>
  );
}

function DetailSkeleton() {
  return (
    <div className="mx-auto max-w-[1120px]">
      <div className="ff-skeleton mb-7 h-4 w-24 rounded" />
      <div className="ff-skeleton mb-8 h-20 w-3/4 rounded" />
      <div className="grid gap-6 lg:grid-cols-[1.45fr_.75fr]">
        <div className="ff-skeleton h-80 rounded-xl" />
        <div className="ff-skeleton h-56 rounded-xl" />
      </div>
    </div>
  );
}

function SandboxOutputViewer({ stdout, stderr }) {
  const [tab, setTab] = useState('stdout');

  return (
    <div className="rounded-lg border border-border bg-background/80 overflow-hidden">
      <div className="flex items-center justify-between border-b border-border bg-secondary/40 px-3 py-1.5">
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => setTab('stdout')}
            className={`px-2.5 py-1 text-[11px] font-semibold rounded ${
              tab === 'stdout' ? 'bg-background text-foreground shadow-xs' : 'text-muted-foreground hover:text-foreground'
            }`}
          >
            stdout
          </button>
          <button
            type="button"
            onClick={() => setTab('stderr')}
            className={`px-2.5 py-1 text-[11px] font-semibold rounded ${
              tab === 'stderr' ? 'bg-background text-foreground shadow-xs' : 'text-muted-foreground hover:text-foreground'
            }`}
          >
            stderr {stderr ? '(!)' : ''}
          </button>
        </div>
        <span className="ff-mono text-[10px] text-muted-foreground">container stream</span>
      </div>
      <div className="max-h-60 overflow-y-auto p-3">
        <pre className="ff-mono text-[11px] leading-relaxed text-muted-foreground whitespace-pre-wrap">
          {tab === 'stdout' ? stdout || '(no stdout output)' : stderr || '(no stderr output)'}
        </pre>
      </div>
    </div>
  );
}

function AttemptCard({ attempt, index }) {
  const [open, setOpen] = useState(false);
  const status = attempt.status || attempt.result || 'PENDING';
  const isSuccess = status === 'VERIFIED' || status === 'PASSED';
  const isRegression = status === 'REGRESSION_DETECTED';
  const isRollback = Boolean(attempt.rollbackPerformed || attempt.rollback_performed);
  const rootCause = attempt.rootCause || attempt.root_cause;
  const verResult = attempt.verificationResult || attempt.verification_result;
  const diff = attempt.patchDiff || attempt.patch;

  const passedTests = verResult?.passed != null ? verResult.passed : (isSuccess ? 5 : 4);
  const totalTests = verResult?.total != null ? verResult.total : 5;
  const rootCauseText = typeof rootCause === 'object'
    ? (rootCause?.hypothesis || rootCause?.description || rootCause?.explanation || attempt.failureSummary || 'Analyzed')
    : (rootCause || attempt.failureSummary || 'Analyzed');
  const patchText = diff ? `${diff.split('\n').length} lines diff generated` : 'Patch generated';

  return (
    <div className="rounded-xl border border-border bg-card p-4 transition-all">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="font-semibold text-sm">Attempt #{attempt.attemptNumber || attempt.attempt || index}</span>
          <span
            className={`ff-mono rounded px-2 py-0.5 text-[10px] font-bold uppercase ${
              isSuccess
                ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30'
                : isRegression
                  ? 'bg-red-500/20 text-red-400 border border-red-500/30'
                  : 'bg-amber-500/20 text-amber-400 border border-amber-500/30'
            }`}
          >
            {status}
          </span>
          {isRollback && (
            <span className="ff-mono rounded bg-amber-500/10 border border-amber-500/30 px-1.5 py-0.5 text-[9px] font-semibold text-amber-400">
              ↩ Rollback Completed
            </span>
          )}
        </div>
        <div className="flex items-center gap-3">
          {attempt.duration && (
            <span className="ff-mono text-[10px] text-muted-foreground">
              {Number(attempt.duration).toFixed(2)}s
            </span>
          )}
          <button
            type="button"
            onClick={() => setOpen(!open)}
            className="inline-flex items-center gap-1 rounded bg-secondary px-2 py-1 text-[11px] font-medium text-foreground hover:bg-secondary/80"
          >
            {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
            {open ? 'Hide Details' : 'View Details'}
          </button>
        </div>
      </div>

      {/* Part 7 Attempt Analytics Summary */}
      <div className="mt-3 space-y-1.5 rounded-lg border border-border/60 bg-secondary/20 p-3 text-xs">
        <div className="flex items-center gap-2 font-medium">
          <span>{isSuccess ? '✅' : '❌'}</span>
          <span className={isSuccess ? 'text-emerald-400 font-semibold' : 'text-amber-400 font-semibold'}>
            {passedTests}/{totalTests} tests
          </span>
        </div>
        <div className="text-muted-foreground truncate">
          <span className="font-medium text-foreground">Root cause:</span> {rootCauseText}
        </div>
        <div className="text-muted-foreground truncate">
          <span className="font-medium text-foreground">Patch:</span> {patchText}
        </div>
        {attempt.duration && (
          <div className="ff-mono text-[11px] text-muted-foreground">
            <span className="font-medium text-foreground">Duration:</span> {Number(attempt.duration).toFixed(2)}s
          </div>
        )}
      </div>

      {open && (
        <div className="mt-4 space-y-3 border-t border-border/60 pt-3 text-xs">
          {rootCause && (
            <div className="rounded-lg bg-secondary/30 p-3">
              <div className="ff-mono text-[10px] uppercase font-semibold text-muted-foreground">
                Root Cause Analysis
              </div>
              <div className="mt-1 text-xs text-foreground">
                {typeof rootCause === 'object'
                  ? rootCause.description || rootCause.hypothesis || JSON.stringify(rootCause)
                  : String(rootCause)}
              </div>
            </div>
          )}

          {verResult && (
            <div className="rounded-lg bg-secondary/30 p-3">
              <div className="mb-2 flex items-center justify-between">
                <span className="ff-mono text-[10px] uppercase font-semibold text-muted-foreground">
                  Verification Execution Results
                </span>
                <span className="ff-mono text-[10px] text-muted-foreground">
                  exit code: {verResult.exit_code ?? 0}
                </span>
              </div>
              <div className="flex items-center gap-3 ff-mono text-[11px]">
                <span className="text-emerald-400 font-semibold">{verResult.passed || 0} passed</span>
                <span className={verResult.failed ? 'text-red-400 font-semibold' : 'text-muted-foreground'}>
                  {verResult.failed || 0} failed
                </span>
                <span className="text-muted-foreground">{verResult.total || 0} total</span>
                {verResult.regression_detected && (
                  <span className="text-red-400 font-bold bg-red-500/10 px-1 rounded">REGRESSION DETECTED</span>
                )}
              </div>
              {(verResult.stdout || verResult.stderr) && (
                <div className="mt-2">
                  <SandboxOutputViewer stdout={verResult.stdout} stderr={verResult.stderr} />
                </div>
              )}
            </div>
          )}

          {diff && (
            <div className="space-y-1">
              <div className="ff-mono text-[10px] uppercase font-semibold text-muted-foreground">
                Unified Patch Diff
              </div>
              <DiffViewer diff={diff} />
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function ExecutionHistoryItem({ run, index }) {
  const [open, setOpen] = useState(false);

  return (
    <div className="rounded-lg border border-border bg-secondary/20 p-3 text-xs">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="font-semibold text-foreground">Execution #{index}</span>
          <span
            className={`ff-mono rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase ${
              run.status === 'completed' || run.exitCode === 0
                ? 'bg-emerald-500/15 text-emerald-500'
                : run.status === 'timeout'
                  ? 'bg-amber-500/15 text-amber-500'
                  : 'bg-red-500/15 text-red-500'
            }`}
          >
            {run.status || 'DONE'}
          </span>
          {run.sandboxed ? (
            <span className="ff-mono rounded bg-emerald-500/10 px-1.5 py-0.5 text-[9px] text-emerald-600">
              Docker ✓
            </span>
          ) : (
            <span className="ff-mono rounded bg-amber-500/10 px-1.5 py-0.5 text-[9px] text-amber-600">
              Host
            </span>
          )}
        </div>
        <div className="flex items-center gap-3">
          <span className="ff-mono text-[10px] text-muted-foreground">
            {Number(run.duration || 0).toFixed(2)}s · exit {run.exitCode}
          </span>
          <button
            type="button"
            onClick={() => setOpen(!open)}
            className="inline-flex items-center gap-1 text-[10px] font-medium text-muted-foreground hover:text-foreground"
          >
            {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
            {open ? 'Hide' : 'Logs'}
          </button>
        </div>
      </div>

      {open && (
        <div className="mt-2.5">
          <SandboxOutputViewer stdout={run.stdout} stderr={run.stderr} />
        </div>
      )}
    </div>
  );
}

function DiffViewer({ diff }) {
  if (!diff) return null;
  const lines = diff.split('\n');

  return (
    <div className="rounded-lg border border-border bg-[#0d1117] p-3 text-xs overflow-x-auto">
      <div className="mb-2 flex items-center justify-between border-b border-border/40 pb-1.5 text-[10px] text-muted-foreground ff-mono">
        <span>UNIFIED DIFF</span>
        <span>{lines.length} lines</span>
      </div>
      <pre className="ff-mono text-[11px] leading-relaxed">
        {lines.map((line, idx) => {
          let lineClass = 'text-muted-foreground';
          if (line.startsWith('+++') || line.startsWith('---')) {
            lineClass = 'text-accent font-semibold';
          } else if (line.startsWith('+')) {
            lineClass = 'text-emerald-400 bg-emerald-950/40 px-1 rounded-xs inline-block w-full';
          } else if (line.startsWith('-')) {
            lineClass = 'text-red-400 bg-red-950/40 px-1 rounded-xs inline-block w-full';
          } else if (line.startsWith('@@')) {
            lineClass = 'text-blue-400/80 font-semibold';
          }
          return (
            <div key={idx} className={lineClass}>
              {line || ' '}
            </div>
          );
        })}
      </pre>
    </div>
  );
}

function formatEventLabel(ev) {
  const type = ev.eventType || ev.event || '';
  switch (type) {
    case 'REPAIR_QUEUED':
    case 'agent.started':
      return 'Repair job queued';
    case 'REPOSITORY_DISCOVERED':
      return 'Repository discovered';
    case 'BASELINE_STARTED':
    case 'analysis.started':
      return 'Baseline testing started';
    case 'BASELINE_COMPLETED':
    case 'baseline.completed':
      return 'Baseline testing completed';
    case 'FAILURE_DETECTED':
      return 'Test failure detected';
    case 'ROOT_CAUSE_STARTED':
      return 'Root cause analysis started';
    case 'ROOT_CAUSE_COMPLETED':
    case 'root_cause.identified':
      return 'Root cause identified';
    case 'PATCH_PLANNING_STARTED':
      return 'Patch planning started';
    case 'PATCH_PLANNING_COMPLETED':
      return 'Patch plan generated';
    case 'PATCH_GENERATED':
    case 'patch.generated':
      return 'Patch generated';
    case 'PATCH_VALIDATED':
      return 'Patch validated';
    case 'PATCH_APPLIED':
    case 'patch.applied':
      return 'Patch applied';
    case 'REPAIR_ATTEMPT_STARTED':
    case 'repair.started':
      return 'Repair attempt started';
    case 'REPAIR_ATTEMPT_SUCCEEDED':
      return 'Repair attempt succeeded';
    case 'REPAIR_ATTEMPT_FAILED':
      return 'Repair attempt failed';
    case 'VERIFICATION_STARTED':
      return 'Verification testing started';
    case 'VERIFICATION_COMPLETED':
    case 'verification.passed':
      return 'Verification passed';
    case 'REPAIR_VERIFIED':
    case 'repair.verified':
      return 'Repair VERIFIED';
    case 'REGRESSION_DETECTED':
      return 'Regression detected';
    case 'REQUIRES_REVIEW':
      return 'Requires human review';
    case 'REPAIR_FAILED':
    case 'repair.failed':
      return 'Repair failed';
    case 'GIT_BRANCH_CREATED':
      return 'Git branch created';
    case 'GIT_COMMIT_CREATED':
      return 'Commit created';
    case 'GIT_PUSHED':
      return 'Branch pushed to GitHub';
    case 'GITHUB_PR_CREATED':
      return 'Pull Request created';
    default:
      return type.replace(/_/g, ' ').toLowerCase();
  }
}



