import React, { useState, useEffect } from 'react';
import { Link } from 'wouter';
import {
  Activity,
  AlertTriangle,
  ArrowRight,
  BarChart3,
  CheckCircle2,
  ChevronDown,
  Clock,
  Compass,
  Cpu,
  Database,
  ExternalLink,
  Filter,
  Flame,
  GitBranch,
  GitCompare,
  GitPullRequest,
  HelpCircle,
  Layers3,
  RefreshCw,
  Search,
  Shield,
  ShieldAlert,
  ShieldCheck,
  Split,
  Tag,
  Timer,
  TrendingUp,
  XCircle,
  Zap,
} from 'lucide-react';
import {
  ResponsiveContainer,
  AreaChart,
  Area,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
  Legend,
} from 'recharts';
import { MetricCard, PageIntro, StatusPill, LoadingBlock, QueryError, EmptyState } from '@/components/fixforge-ui';

export default function Observability() {
  const [activeTab, setActiveTab] = useState('intelligence'); // 'intelligence' | 'benchmarks'

  // Intelligence filters
  const [days, setDays] = useState(30);
  const [repositoryFilter, setRepositoryFilter] = useState('');
  const [languageFilter, setLanguageFilter] = useState('ALL');
  const [statusFilter, setStatusFilter] = useState('ALL');
  const [executionMode, setExecutionMode] = useState('live_repair'); // 'live_repair' | 'golden_validation'

  // Intelligence data states
  const [intelligence, setIntelligence] = useState(null);
  const [trends, setTrends] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [showDefinitions, setShowDefinitions] = useState(false);

  // Benchmark comparison and history states
  const [benchmarkRuns, setBenchmarkRuns] = useState([]);
  const [benchmarkView, setBenchmarkView] = useState('history'); // 'history' | 'comparison'
  const [benchmarkModeFilter, setBenchmarkModeFilter] = useState('ALL');
  const [selectedRunId, setSelectedRunId] = useState(null);
  const [runDetails, setRunDetails] = useState(null);
  const [runDetailsLoading, setRunDetailsLoading] = useState(false);
  const [runA, setRunA] = useState('');
  const [runB, setRunB] = useState('');
  const [comparison, setComparison] = useState(null);
  const [benchmarkLoading, setBenchmarkLoading] = useState(false);
  const [benchmarkError, setBenchmarkError] = useState(null);

  const fetchRunDetails = async (id) => {
    setSelectedRunId(id);
    setRunDetailsLoading(true);
    try {
      const res = await fetch(`/api/observability/benchmarks/${id}`);
      if (!res.ok) throw new Error('Failed to load benchmark run details.');
      const data = await res.json();
      setRunDetails(data);
    } catch (err) {
      setBenchmarkError(err.message);
    } finally {
      setRunDetailsLoading(false);
    }
  };

  // Fetch intelligence data
  const fetchIntelligenceData = async (silent = false) => {
    if (!silent) setIsRefreshing(true);
    try {
      const params = new URLSearchParams();
      if (days) params.set('days', days.toString());
      if (repositoryFilter.trim()) params.set('repository', repositoryFilter.trim());
      if (languageFilter !== 'ALL') params.set('language', languageFilter);
      if (statusFilter !== 'ALL') params.set('status', statusFilter);
      if (executionMode) params.set('executionMode', executionMode);

      const [intelRes, trendsRes] = await Promise.all([
        fetch(`/api/observability/intelligence?${params.toString()}`),
        fetch(`/api/observability/intelligence/trends?${params.toString()}`),
      ]);

      if (!intelRes.ok || !trendsRes.ok) {
        throw new Error('Failed to load intelligence metrics from server.');
      }

      const intelData = await intelRes.json();
      const trendsData = await trendsRes.json();

      setIntelligence(intelData);
      setTrends(Array.isArray(trendsData) ? trendsData : []);
      setError(null);
    } catch (err) {
      if (!silent) setError(err.message);
    } finally {
      setLoading(false);
      setIsRefreshing(false);
    }
  };

  // Fetch benchmark runs
  const fetchBenchmarkRuns = async () => {
    setBenchmarkLoading(true);
    try {
      const res = await fetch('/api/observability/benchmarks');
      if (!res.ok) throw new Error('Failed to fetch benchmark runs.');
      const data = await res.json();
      setBenchmarkRuns(Array.isArray(data) ? data : []);
      if (data.length >= 2) {
        setRunA(data[1].run_id);
        setRunB(data[0].run_id);
      } else if (data.length === 1) {
        setRunA(data[0].run_id);
        setRunB(data[0].run_id);
      }
      setBenchmarkError(null);
    } catch (err) {
      setBenchmarkError(err.message);
    } finally {
      setBenchmarkLoading(false);
    }
  };

  // Compare benchmark runs
  const fetchComparison = async (idA, idB) => {
    if (!idA || !idB) return;
    setBenchmarkLoading(true);
    try {
      const res = await fetch(`/api/observability/benchmarks/compare?runA=${idA}&runB=${idB}`);
      if (!res.ok) {
        const errJson = await res.json().catch(() => ({}));
        throw new Error(errJson.error || 'Failed to compare benchmark runs.');
      }
      const data = await res.json();
      setComparison(data);
      setBenchmarkError(null);
    } catch (err) {
      setBenchmarkError(err.message);
    } finally {
      setBenchmarkLoading(false);
    }
  };

  useEffect(() => {
    fetchIntelligenceData();
  }, [days, repositoryFilter, languageFilter, statusFilter, executionMode]);

  useEffect(() => {
    if (activeTab === 'benchmarks' && benchmarkRuns.length === 0) {
      fetchBenchmarkRuns();
    }
  }, [activeTab]);

  useEffect(() => {
    if (runA && runB) {
      fetchComparison(runA, runB);
    }
  }, [runA, runB]);

  const metrics = intelligence?.metrics;
  const sampleSizes = intelligence?.sampleSizes;
  const candidateMetrics = metrics?.candidateMetrics;
  const durationMetrics = metrics?.durationMetrics;
  const telemetryMetrics = metrics?.telemetryMetrics;

  return (
    <div className="mx-auto max-w-[1440px] space-y-8 pb-12">
      {/* Top Header & Navigation Tabs */}
      <div className="flex flex-wrap items-center justify-between gap-4 border-b border-border/80 pb-6">
        <div>
          <div className="ff-mono text-[10px] uppercase tracking-[.25em] text-accent-foreground/80 font-bold">
            M12.4 REPAIR INTELLIGENCE & EVALUATION
          </div>
          <h1 className="mt-1 text-2xl font-bold tracking-tight text-white lg:text-3xl">
            ACCURACY & REPAIR INTELLIGENCE
          </h1>
          <p className="mt-1 text-xs text-muted-foreground max-w-2xl">
            Autonomous verification accuracy, bounded candidate patch evaluation, regression avoidance, and benchmark comparison.
          </p>
        </div>

        {/* View Switcher Tabs */}
        <div className="flex items-center gap-2">
          <div className="flex rounded-lg border border-border bg-card p-1 shadow-sm">
            <button
              type="button"
              onClick={() => setActiveTab('intelligence')}
              className={`flex items-center gap-2 rounded-md px-3.5 py-1.5 text-xs font-semibold transition-all ${
                activeTab === 'intelligence'
                  ? 'bg-accent text-accent-foreground shadow-sm'
                  : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              <Cpu size={14} />
              Repair Intelligence
            </button>
            <button
              type="button"
              onClick={() => setActiveTab('benchmarks')}
              className={`flex items-center gap-2 rounded-md px-3.5 py-1.5 text-xs font-semibold transition-all ${
                activeTab === 'benchmarks'
                  ? 'bg-accent text-accent-foreground shadow-sm'
                  : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              <GitCompare size={14} />
              Benchmark Comparison
            </button>
          </div>

          <button
            type="button"
            onClick={() => (activeTab === 'intelligence' ? fetchIntelligenceData() : fetchBenchmarkRuns())}
            disabled={isRefreshing}
            className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-secondary/80 px-3 py-1.5 text-xs font-medium text-foreground hover:bg-secondary disabled:opacity-50"
            title="Refresh current dataset"
          >
            <RefreshCw size={13} className={isRefreshing ? 'animate-spin' : ''} />
            Refresh
          </button>
        </div>
      </div>

      {activeTab === 'intelligence' ? (
        <>
          {/* Controls & Filter Bar */}
          <div className="rounded-xl border border-border bg-card/80 p-4 backdrop-blur-sm space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-3">
              {/* Execution Mode Selector */}
              <div className="flex items-center gap-2">
                <span className="text-xs font-medium text-muted-foreground">Mode:</span>
                <div className="flex rounded-lg border border-border/70 bg-secondary/40 p-0.5 text-xs">
                  <button
                    type="button"
                    onClick={() => setExecutionMode('live_repair')}
                    className={`rounded px-2.5 py-1 font-medium transition-colors ${
                      executionMode === 'live_repair'
                        ? 'bg-sky-500/20 text-sky-400 border border-sky-500/30'
                        : 'text-muted-foreground hover:text-foreground'
                    }`}
                  >
                    Live Repairs (Production)
                  </button>
                  <button
                    type="button"
                    onClick={() => setExecutionMode('golden_validation')}
                    className={`rounded px-2.5 py-1 font-medium transition-colors ${
                      executionMode === 'golden_validation'
                        ? 'bg-amber-500/20 text-amber-400 border border-amber-500/30'
                        : 'text-muted-foreground hover:text-foreground'
                    }`}
                  >
                    Golden Validation (Fixture)
                  </button>
                </div>
              </div>

              {/* Date Filter */}
              <div className="flex items-center gap-2">
                <span className="text-xs font-medium text-muted-foreground">Window:</span>
                <div className="flex rounded-lg border border-border/70 bg-secondary/40 p-0.5 text-xs">
                  {[7, 14, 30, 90].map((d) => (
                    <button
                      key={d}
                      type="button"
                      onClick={() => setDays(d)}
                      className={`rounded px-2.5 py-1 ff-mono text-[11px] font-medium transition-colors ${
                        days === d ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'
                      }`}
                    >
                      {d}d
                    </button>
                  ))}
                </div>
              </div>

              {/* Language Filter */}
              <div className="flex items-center gap-2">
                <span className="text-xs font-medium text-muted-foreground">Language:</span>
                <select
                  value={languageFilter}
                  onChange={(e) => setLanguageFilter(e.target.value)}
                  className="rounded-lg border border-border bg-secondary/60 px-2.5 py-1 text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-accent"
                >
                  <option value="ALL">All Languages</option>
                  <option value="python">Python</option>
                  <option value="typescript">TypeScript</option>
                  <option value="javascript">JavaScript</option>
                  <option value="go">Go</option>
                </select>
              </div>

              {/* Status Filter */}
              <div className="flex items-center gap-2">
                <span className="text-xs font-medium text-muted-foreground">Status:</span>
                <select
                  value={statusFilter}
                  onChange={(e) => setStatusFilter(e.target.value)}
                  className="rounded-lg border border-border bg-secondary/60 px-2.5 py-1 text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-accent"
                >
                  <option value="ALL">All Statuses</option>
                  <option value="VERIFIED">Verified</option>
                  <option value="FAILED">Failed</option>
                  <option value="REQUIRES_REVIEW">Requires Review</option>
                  <option value="QUEUED">Queued / Active</option>
                </select>
              </div>

              {/* Search Repository */}
              <div className="relative min-w-[200px] flex-1 max-w-xs">
                <Search size={13} className="absolute left-2.5 top-2.5 text-muted-foreground" />
                <input
                  type="text"
                  placeholder="Filter repository..."
                  value={repositoryFilter}
                  onChange={(e) => setRepositoryFilter(e.target.value)}
                  className="w-full rounded-lg border border-border bg-secondary/60 pl-8 pr-3 py-1 text-xs text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-accent"
                />
              </div>

              {/* Toggle Metric Definitions Modal/Drawer */}
              <button
                type="button"
                onClick={() => setShowDefinitions(!showDefinitions)}
                className="flex items-center gap-1.5 rounded-lg border border-border/80 bg-secondary/40 px-2.5 py-1 text-xs text-muted-foreground hover:text-foreground"
              >
                <HelpCircle size={13} />
                <span>{showDefinitions ? 'Hide Formulas' : 'Metric Definitions'}</span>
              </button>
            </div>

            {/* Population & Reporting Window Clarification Alert */}
            <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border/60 pt-2.5 text-[11px] text-muted-foreground">
              <div className="flex items-center gap-2">
                <span className="ff-mono uppercase text-sky-400 font-semibold">
                  {intelligence?.executionMode === 'golden_validation' ? 'Deterministic Fixture Run' : 'Live Repair Telemetry'}
                </span>
                <span>•</span>
                <span>
                  Window: {intelligence?.reportingWindow?.startDate ? new Date(intelligence.reportingWindow.startDate).toLocaleDateString() : 'N/A'} –{' '}
                  {intelligence?.reportingWindow?.endDate ? new Date(intelligence.reportingWindow.endDate).toLocaleDateString() : 'Now'}
                </span>
                <span>•</span>
                <span>
                  Evaluated Population: <strong className="text-foreground">{sampleSizes?.evaluatedJobs ?? 0}</strong> completed jobs (
                  <strong className="text-emerald-400">{sampleSizes?.activeJobs ?? 0}</strong> active/queued excluded from denominator)
                </span>
              </div>
              {executionMode === 'golden_validation' && (
                <span className="rounded bg-amber-500/10 px-2 py-0.5 text-amber-400 border border-amber-500/20 font-medium">
                  Isolated from production repair outcomes
                </span>
              )}
            </div>
          </div>

          {/* Metric Definitions Accordion */}
          {showDefinitions && (
            <div className="rounded-xl border border-sky-500/30 bg-sky-950/20 p-4 text-xs space-y-3">
              <div className="flex items-center justify-between border-b border-sky-500/20 pb-2">
                <span className="font-semibold text-sky-400 uppercase tracking-wider ff-mono">
                  Standardized Metric Definitions & Verification Formulas
                </span>
                <span className="text-[10px] text-sky-300">Audited against FixForge Policy</span>
              </div>
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                <div className="rounded border border-border/60 bg-card/60 p-2.5">
                  <div className="font-semibold text-foreground">Verified Repair Rate</div>
                  <div className="mt-1 ff-mono text-[10px] text-sky-300">
                    verified / (verified + failed + review)
                  </div>
                  <p className="mt-1 text-[11px] text-muted-foreground">
                    Denominator strictly restricted to evaluated repairs. Active repairs in progress are never included to artificially alter rate.
                  </p>
                </div>
                <div className="rounded border border-border/60 bg-card/60 p-2.5">
                  <div className="font-semibold text-foreground">False VERIFIED Count</div>
                  <div className="mt-1 ff-mono text-[10px] text-emerald-300">Evidence Verification Check</div>
                  <p className="mt-1 text-[11px] text-muted-foreground">
                    Count of repairs marked verified with unresolved test failures or regressions. Must strictly be 0.
                  </p>
                </div>
                <div className="rounded border border-border/60 bg-card/60 p-2.5">
                  <div className="font-semibold text-foreground">Regression Rate</div>
                  <div className="mt-1 ff-mono text-[10px] text-amber-300">regressions / evaluated_with_checks</div>
                  <p className="mt-1 text-[11px] text-muted-foreground">
                    Calculated only over repairs where regression testing was performed against baseline test assertions.
                  </p>
                </div>
                <div className="rounded border border-border/60 bg-card/60 p-2.5">
                  <div className="font-semibold text-foreground">Missing Telemetry Rule</div>
                  <div className="mt-1 ff-mono text-[10px] text-purple-300">null ≠ 0</div>
                  <p className="mt-1 text-[11px] text-muted-foreground">
                    Missing model token usage or billing costs are reported as Unavailable (null). They are never assumed or fabricated as zero.
                  </p>
                </div>
              </div>
            </div>
          )}

          {/* Primary Metrics Grid */}
          <div className="grid gap-3 sm:grid-cols-2 md:grid-cols-3 xl:grid-cols-6">
            <MetricCard
              label="Total Repairs"
              value={metrics?.totalRepairs ?? 0}
              detail={`${sampleSizes?.evaluatedJobs ?? 0} evaluated · ${sampleSizes?.activeJobs ?? 0} active`}
              icon={<Zap size={16} className="text-amber-500" />}
            />
            <MetricCard
              label="Verified Rate"
              value={metrics?.verifiedRepairRate != null ? `${metrics.verifiedRepairRate}%` : 'N/A'}
              detail={`${metrics?.verifiedRepairs ?? 0}/${sampleSizes?.evaluatedJobs ?? 0} evaluated`}
              icon={<ShieldCheck size={16} className="text-emerald-400" />}
            />
            <MetricCard
              label="Failed & Review"
              value={`${metrics?.failedRepairs ?? 0} / ${metrics?.requiresReviewCount ?? 0}`}
              detail="Failed / Requires Human Review"
              icon={<XCircle size={16} className="text-red-400" />}
            />
            <MetricCard
              label="False VERIFIED"
              value={metrics?.falseVerifiedCount ?? 0}
              detail="Evidence-verified (Strictly 0)"
              icon={<ShieldAlert size={16} className={metrics?.falseVerifiedCount ? 'text-red-500' : 'text-emerald-500'} />}
            />
            <MetricCard
              label="Regression Rate"
              value={`${metrics?.regressionRate ?? 0}%`}
              detail={`${metrics?.regressionCount ?? 0} regressions detected`}
              icon={<Flame size={16} className="text-orange-400" />}
            />
            <MetricCard
              label="Candidate Accept."
              value={candidateMetrics?.candidateAcceptanceRate != null ? `${candidateMetrics.candidateAcceptanceRate}%` : 'N/A'}
              detail={`${candidateMetrics?.candidatesSelected ?? 0}/${candidateMetrics?.candidatesEvaluated ?? 0} candidates`}
              icon={<Layers3 size={16} className="text-sky-400" />}
            />
          </div>

          {/* Secondary Intelligence Cards */}
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <div className="flex items-center gap-3 rounded-xl border border-border bg-card p-4">
              <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-sky-500/10 text-sky-400">
                <Timer size={20} />
              </div>
              <div className="min-w-0 flex-1">
                <div className="ff-mono text-[10px] uppercase tracking-wider text-muted-foreground">Repair Duration</div>
                <div className="text-base font-bold text-foreground">
                  Median: {durationMetrics?.medianDurationSeconds != null ? `${durationMetrics.medianDurationSeconds}s` : '—'}
                </div>
                <div className="text-[11px] text-muted-foreground">
                  p95: {durationMetrics?.p95DurationSeconds != null ? `${durationMetrics.p95DurationSeconds}s` : '—'} · avg: {durationMetrics?.avgDurationSeconds != null ? `${durationMetrics.avgDurationSeconds}s` : '—'}
                </div>
              </div>
            </div>

            <div className="flex items-center gap-3 rounded-xl border border-border bg-card p-4">
              <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-purple-500/10 text-purple-400">
                <Split size={20} />
              </div>
              <div className="min-w-0 flex-1">
                <div className="ff-mono text-[10px] uppercase tracking-wider text-muted-foreground">Candidates per Job</div>
                <div className="text-base font-bold text-foreground">
                  {candidateMetrics?.avgCandidatesPerJob != null ? candidateMetrics.avgCandidatesPerJob : '1.0'} avg
                </div>
                <div className="text-[11px] text-muted-foreground">
                  Max bounded: 3 · Deduplicated diffs
                </div>
              </div>
            </div>

            <div className="flex items-center gap-3 rounded-xl border border-border bg-card p-4">
              <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-emerald-500/10 text-emerald-400">
                <RefreshCw size={20} />
              </div>
              <div className="min-w-0 flex-1">
                <div className="ff-mono text-[10px] uppercase tracking-wider text-muted-foreground">Average Iterations</div>
                <div className="text-base font-bold text-foreground">
                  {metrics?.retriesMetrics?.avgRetriesPerJob != null ? metrics.retriesMetrics.avgRetriesPerJob : '1.0'} retries
                </div>
                <div className="text-[11px] text-muted-foreground">
                  1-att: {metrics?.retriesMetrics?.attemptsDistribution?.['1'] ?? 0} · 2-att: {metrics?.retriesMetrics?.attemptsDistribution?.['2'] ?? 0} · 3+: {metrics?.retriesMetrics?.attemptsDistribution?.['3+'] ?? 0}
                </div>
              </div>
            </div>

            <div className="flex items-center gap-3 rounded-xl border border-border bg-card p-4">
              <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-accent/15 text-accent-foreground">
                <Cpu size={20} />
              </div>
              <div className="min-w-0 flex-1">
                <div className="ff-mono text-[10px] uppercase tracking-wider text-muted-foreground">Model & Telemetry</div>
                <div className="text-base font-bold text-foreground">
                  {telemetryMetrics?.modelCalls ?? 0} AI calls
                </div>
                <div className="text-[11px] text-muted-foreground">
                  Tokens: {telemetryMetrics?.tokenUsage ?? 'Unavailable'} · Cost: {telemetryMetrics?.costUsd ?? 'Unavailable'}
                </div>
              </div>
            </div>
          </div>

          {/* Time Series Charts Section */}
          <div className="grid gap-6 lg:grid-cols-3">
            {/* Outcomes Trend */}
            <section className="lg:col-span-2 rounded-xl border border-border bg-card p-5">
              <div className="mb-4 flex items-center justify-between">
                <div>
                  <div className="ff-mono text-[10px] uppercase tracking-wider text-muted-foreground">Temporal Signals</div>
                  <h2 className="text-sm font-semibold text-white">REPAIR OUTCOMES OVER TIME</h2>
                </div>
                <span className="ff-mono text-[11px] text-muted-foreground">{days} Days Rolling Window</span>
              </div>

              <div className="h-64 w-full">
                {trends.length === 0 ? (
                  <EmptyState title="No trend data" message="Time-series data will populate as repairs execute." />
                ) : (
                  <ResponsiveContainer width="100%" height="100%">
                    <AreaChart data={trends} margin={{ top: 10, right: 10, left: -20, bottom: 0 }}>
                      <defs>
                        <linearGradient id="verifiedArea" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="5%" stopColor="#10b981" stopOpacity={0.4} />
                          <stop offset="95%" stopColor="#10b981" stopOpacity={0.0} />
                        </linearGradient>
                        <linearGradient id="failedArea" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="5%" stopColor="#ef4444" stopOpacity={0.4} />
                          <stop offset="95%" stopColor="#ef4444" stopOpacity={0.0} />
                        </linearGradient>
                      </defs>
                      <CartesianGrid strokeDasharray="3 3" stroke="#27272a" vertical={false} />
                      <XAxis dataKey="date" stroke="#71717a" fontSize={11} tickLine={false} />
                      <YAxis stroke="#71717a" fontSize={11} tickLine={false} allowDecimals={false} />
                      <Tooltip
                        contentStyle={{ backgroundColor: '#18181b', borderColor: '#27272a', borderRadius: '8px', fontSize: '12px' }}
                        itemStyle={{ color: '#f4f4f5' }}
                      />
                      <Legend verticalAlign="top" height={36} iconSize={10} wrapperStyle={{ fontSize: '11px' }} />
                      <Area
                        type="monotone"
                        dataKey="verified"
                        name="Verified Repairs"
                        stroke="#10b981"
                        strokeWidth={2}
                        fillOpacity={1}
                        fill="url(#verifiedArea)"
                      />
                      <Area
                        type="monotone"
                        dataKey="failed"
                        name="Failed Repairs"
                        stroke="#ef4444"
                        strokeWidth={2}
                        fillOpacity={1}
                        fill="url(#failedArea)"
                      />
                      <Area
                        type="monotone"
                        dataKey="regressions"
                        name="Regressions"
                        stroke="#f97316"
                        strokeWidth={1.5}
                        fill="transparent"
                      />
                    </AreaChart>
                  </ResponsiveContainer>
                )}
              </div>
            </section>

            {/* Candidate Funnel & Rejections Breakdown */}
            <section className="rounded-xl border border-border bg-card p-5 flex flex-col justify-between">
              <div>
                <div className="ff-mono text-[10px] uppercase tracking-wider text-muted-foreground">Candidate Diagnostics</div>
                <h2 className="text-sm font-semibold text-white">REJECTION REASONS</h2>
                <p className="mt-1 text-xs text-muted-foreground">
                  Reasons why patch candidates were rejected before workspace promotion.
                </p>
              </div>

              <div className="my-4 space-y-2.5">
                {candidateMetrics?.candidateRejections && Object.keys(candidateMetrics.candidateRejections).length > 0 ? (
                  Object.entries(candidateMetrics.candidateRejections).map(([reason, cnt]) => (
                    <div key={reason} className="flex items-center justify-between rounded-lg border border-border/70 bg-secondary/30 p-2.5">
                      <div className="flex items-center gap-2">
                        <span className="h-2 w-2 rounded-full bg-red-400" />
                        <span className="ff-mono text-[11px] font-semibold text-foreground truncate max-w-[180px]">
                          {reason}
                        </span>
                      </div>
                      <span className="rounded bg-red-500/10 px-2 py-0.5 ff-mono text-xs font-bold text-red-400 border border-red-500/20">
                        {cnt} rejected
                      </span>
                    </div>
                  ))
                ) : (
                  <div className="py-8 text-center text-xs text-muted-foreground">
                    <CheckCircle2 size={24} className="mx-auto mb-2 text-emerald-400" />
                    Zero candidate rejections recorded.
                  </div>
                )}
              </div>

              <div className="border-t border-border/70 pt-3 flex items-center justify-between text-xs text-muted-foreground">
                <span>Evaluated: <strong className="text-foreground">{candidateMetrics?.candidatesEvaluated ?? 0}</strong></span>
                <span>Selected: <strong className="text-emerald-400">{candidateMetrics?.candidatesSelected ?? 0}</strong></span>
                <span>Acceptance: <strong className="text-foreground">{candidateMetrics?.candidateAcceptanceRate ?? 0}%</strong></span>
              </div>
            </section>
          </div>

          {/* Repository & Language Breakdown Table */}
          <section className="rounded-xl border border-border bg-card p-5">
            <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
              <div>
                <div className="ff-mono text-[10px] uppercase tracking-wider text-muted-foreground">Breakdown</div>
                <h2 className="text-sm font-semibold text-white">REPOSITORY REPAIR PERFORMANCE</h2>
              </div>
              <span className="ff-mono text-[11px] text-muted-foreground">
                {metrics?.repositoryBreakdown?.length ?? 0} Repositories Aggregated
              </span>
            </div>

            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead>
                  <tr className="border-b border-border text-muted-foreground ff-mono text-[10px] uppercase tracking-wider">
                    <th className="py-2.5 px-3">Repository</th>
                    <th className="py-2.5 px-3">Total Repairs</th>
                    <th className="py-2.5 px-3">Verified</th>
                    <th className="py-2.5 px-3">Failed</th>
                    <th className="py-2.5 px-3">Success Rate</th>
                    <th className="py-2.5 px-3 text-right">Avg Duration</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border/60">
                  {metrics?.repositoryBreakdown && metrics.repositoryBreakdown.length > 0 ? (
                    metrics.repositoryBreakdown.map((r) => (
                      <tr key={r.repository} className="hover:bg-secondary/30 transition-colors">
                        <td className="py-3 px-3 font-medium text-foreground truncate max-w-xs">{r.repository}</td>
                        <td className="py-3 px-3 text-muted-foreground">{r.total}</td>
                        <td className="py-3 px-3 text-emerald-400 font-semibold">{r.verified}</td>
                        <td className="py-3 px-3 text-red-400 font-semibold">{r.failed}</td>
                        <td className="py-3 px-3">
                          <span
                            className={`rounded px-1.5 py-0.5 ff-mono text-[11px] font-semibold ${
                              r.successRate >= 80
                                ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20'
                                : r.successRate >= 50
                                ? 'bg-amber-500/10 text-amber-400 border border-amber-500/20'
                                : 'bg-red-500/10 text-red-400 border border-red-500/20'
                            }`}
                          >
                            {r.successRate}%
                          </span>
                        </td>
                        <td className="py-3 px-3 text-right ff-mono text-muted-foreground">
                          {r.avgDurationSeconds != null ? `${r.avgDurationSeconds}s` : '—'}
                        </td>
                      </tr>
                    ))
                  ) : (
                    <tr>
                      <td colSpan={6} className="py-8 text-center text-muted-foreground">
                        No repository repair records found for the selected filter criteria.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </section>
        </>
      ) : (
        /* M12.4 & M12.5 Benchmark Suite & Live Accuracy View */
        <div className="space-y-6">
          {/* Benchmark Sub-Navigation */}
          <div className="flex flex-wrap items-center justify-between gap-4 border-b border-border/70 pb-4">
            <div>
              <div className="ff-mono text-[10px] uppercase tracking-wider text-muted-foreground">Benchmark Suite & Accuracy</div>
              <h2 className="text-base font-bold text-white">REPAIR ACCURACY & BENCHMARK INTELLIGENCE</h2>
              <p className="mt-1 text-xs text-muted-foreground">
                Live Gemini repairs on unseen bugs, held-out verification tests, test-integrity guarantees, and reproducible runs.
              </p>
            </div>

            <div className="flex items-center gap-2">
              <div className="flex rounded-lg border border-border bg-card p-1 shadow-sm">
                <button
                  type="button"
                  onClick={() => { setBenchmarkView('history'); setSelectedRunId(null); setRunDetails(null); }}
                  className={`flex items-center gap-2 rounded-md px-3 py-1.5 text-xs font-semibold transition-all ${
                    benchmarkView === 'history'
                      ? 'bg-accent text-accent-foreground shadow-sm'
                      : 'text-muted-foreground hover:text-foreground'
                  }`}
                >
                  <Activity size={14} />
                  Execution History & Details
                </button>
                <button
                  type="button"
                  onClick={() => setBenchmarkView('comparison')}
                  className={`flex items-center gap-2 rounded-md px-3 py-1.5 text-xs font-semibold transition-all ${
                    benchmarkView === 'comparison'
                      ? 'bg-accent text-accent-foreground shadow-sm'
                      : 'text-muted-foreground hover:text-foreground'
                  }`}
                >
                  <GitCompare size={14} />
                  Side-by-Side Comparison
                </button>
              </div>
            </div>
          </div>

          {/* VIEW 1: EXECUTION HISTORY & PER-RUN DETAILS */}
          {benchmarkView === 'history' && (
            <div className="space-y-6">
              {/* Mode Filters & Summary */}
              <div className="flex flex-wrap items-center justify-between gap-4 rounded-xl border border-border bg-card p-4">
                <div className="flex items-center gap-2 text-xs font-semibold text-muted-foreground">
                  <Filter size={14} />
                  <span>Execution Mode:</span>
                  <div className="flex rounded-md border border-border/80 bg-secondary/50 p-0.5">
                    {['ALL', 'live_repair', 'golden_validation', 'dry_run'].map((m) => (
                      <button
                        key={m}
                        type="button"
                        onClick={() => setBenchmarkModeFilter(m)}
                        className={`rounded px-2.5 py-1 text-xs font-medium transition-colors ${
                          benchmarkModeFilter === m
                            ? 'bg-accent text-accent-foreground font-semibold shadow-xs'
                            : 'text-muted-foreground hover:text-foreground'
                        }`}
                      >
                        {m === 'ALL' ? 'All Runs' : m === 'live_repair' ? 'Live Gemini' : m === 'golden_validation' ? 'Golden Fixtures' : 'Dry Run'}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="ff-mono text-xs text-muted-foreground">
                  Found {benchmarkRuns.filter((r) => benchmarkModeFilter === 'ALL' || r.execution_mode === benchmarkModeFilter).length} recorded runs
                </div>
              </div>

              {/* Selected Run Details Modal / Expanded Card */}
              {selectedRunId && (
                <div className="rounded-xl border border-accent/40 bg-card p-5 space-y-5 shadow-lg">
                  <div className="flex flex-wrap items-start justify-between gap-4 border-b border-border/70 pb-4">
                    <div>
                      <div className="flex items-center gap-2">
                        <span className="ff-mono text-xs uppercase px-2 py-0.5 rounded font-bold bg-accent/20 text-accent-foreground border border-accent/30">
                          {runDetails?.execution_mode || 'benchmark'}
                        </span>
                        <h3 className="text-base font-bold text-white ff-mono">{selectedRunId}</h3>
                      </div>
                      <div className="mt-1 flex flex-wrap items-center gap-4 text-xs text-muted-foreground">
                        <span>Commit: <strong className="text-foreground ff-mono">{runDetails?.git_commit || runDetails?.code_revision || 'unknown'}</strong></span>
                        <span>Model: <strong className="text-foreground ff-mono">{runDetails?.model || runDetails?.environment?.model || 'N/A'}</strong></span>
                        <span>Timestamp: <strong className="text-foreground">{runDetails?.timestamp ? new Date(runDetails.timestamp).toLocaleString() : 'N/A'}</strong></span>
                      </div>
                    </div>

                    <button
                      type="button"
                      onClick={() => { setSelectedRunId(null); setRunDetails(null); }}
                      className="rounded-lg border border-border bg-secondary/50 px-3 py-1.5 text-xs font-semibold text-foreground hover:bg-secondary transition-colors"
                    >
                      Close Details
                    </button>
                  </div>

                  {runDetailsLoading ? (
                    <LoadingBlock message="Loading run evidence and verification details..." />
                  ) : runDetails ? (
                    <>
                      {/* Metric KPI Summary */}
                      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
                        <div className="rounded-lg border border-emerald-500/30 bg-emerald-950/20 p-3">
                          <div className="ff-mono text-[10px] text-emerald-400 uppercase font-semibold">Repair Success</div>
                          <div className="text-xl font-bold text-emerald-300">
                            {runDetails.metrics?.repair_success_rate != null ? `${(runDetails.metrics.repair_success_rate * 100).toFixed(1)}%` : 'N/A'}
                          </div>
                          <div className="text-[10px] text-muted-foreground ff-mono">
                            {runDetails.metrics?.correct_repairs ?? 0} / {runDetails.metrics?.eligible_completed_cases ?? runDetails.metrics?.eligible_repair_cases ?? 0} eligible
                          </div>
                        </div>

                        <div className="rounded-lg border border-border bg-secondary/30 p-3">
                          <div className="ff-mono text-[10px] text-muted-foreground uppercase font-semibold">Regressions</div>
                          <div className="text-xl font-bold text-amber-400">
                            {runDetails.metrics?.regressions_introduced ?? 0}
                          </div>
                          <div className="text-[10px] text-muted-foreground ff-mono">
                            {((runDetails.metrics?.regression_rate ?? 0) * 100).toFixed(1)}% rate
                          </div>
                        </div>

                        <div className="rounded-lg border border-border bg-secondary/30 p-3">
                          <div className="ff-mono text-[10px] text-muted-foreground uppercase font-semibold">Abstentions</div>
                          <div className="text-xl font-bold text-purple-400">
                            {runDetails.metrics?.abstained_cases_count ?? runDetails.metrics?.correct_abstentions ?? 0}
                          </div>
                          <div className="text-[10px] text-muted-foreground ff-mono">
                            {runDetails.metrics?.abstention_rate != null ? `${(runDetails.metrics.abstention_rate * 100).toFixed(1)}%` : 'Safe refusal'}
                          </div>
                        </div>

                        <div className="rounded-lg border border-border bg-secondary/30 p-3">
                          <div className="ff-mono text-[10px] text-muted-foreground uppercase font-semibold">Timeouts</div>
                          <div className="text-xl font-bold text-yellow-400">
                            {runDetails.metrics?.timeout_cases_count ?? 0}
                          </div>
                          <div className="text-[10px] text-muted-foreground ff-mono">
                            {runDetails.metrics?.timeout_rate != null ? `${(runDetails.metrics.timeout_rate * 100).toFixed(1)}%` : '0.0%'}
                          </div>
                        </div>

                        <div className="rounded-lg border border-border bg-secondary/30 p-3">
                          <div className="ff-mono text-[10px] text-muted-foreground uppercase font-semibold">Infra Errors</div>
                          <div className="text-xl font-bold text-red-400">
                            {runDetails.metrics?.infra_error_cases_count ?? 0}
                          </div>
                          <div className="text-[10px] text-muted-foreground ff-mono">
                            {runDetails.metrics?.invalid_cases_count ?? 0} invalid cases
                          </div>
                        </div>

                        <div className="rounded-lg border border-border bg-secondary/30 p-3">
                          <div className="ff-mono text-[10px] text-muted-foreground uppercase font-semibold">Test Integrity</div>
                          <div className={`text-xl font-bold ${runDetails.metrics?.test_integrity_violations === 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                            {runDetails.metrics?.test_integrity_violations === 0 ? 'VERIFIED' : `${runDetails.metrics?.test_integrity_violations} VIOLATION`}
                          </div>
                          <div className="text-[10px] text-muted-foreground ff-mono">
                            SHA-256 hashed tests
                          </div>
                        </div>
                      </div>

                      {/* Per-case Evidence Table */}
                      <div className="overflow-x-auto rounded-lg border border-border/80">
                        <table className="w-full text-left text-xs">
                          <thead>
                            <tr className="border-b border-border bg-secondary/40 text-muted-foreground ff-mono text-[10px] uppercase tracking-wider">
                              <th className="py-2.5 px-3">Case ID</th>
                              <th className="py-2.5 px-3">Status</th>
                              <th className="py-2.5 px-3">Independent Tests</th>
                              <th className="py-2.5 px-3">Test Integrity</th>
                              <th className="py-2.5 px-3">Duration</th>
                              <th className="py-2.5 px-3">Candidate Decision</th>
                              <th className="py-2.5 px-3">Error / Outcome Evidence</th>
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-border/60">
                            {(runDetails.case_results || []).map((c) => {
                              const isRepaired = c.status === 'REPAIRED' || c.status === 'CORRECT_REPAIR';
                              const isRegression = c.status === 'REGRESSION' || c.status === 'REGRESSION_DETECTED';
                              const isAbstained = c.status === 'ABSTAINED' || c.status === 'CORRECT_ABSTENTION';
                              const isInvalid = c.status === 'INVALID_CASE';
                              const isInfra = c.status === 'INFRA_ERROR' || c.status === 'INFRASTRUCTURE_FAILURE';

                              const statusBadgeClass = isRepaired
                                ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20'
                                : isRegression
                                ? 'bg-amber-500/10 text-amber-400 border-amber-500/20'
                                : isAbstained
                                ? 'bg-purple-500/10 text-purple-400 border-purple-500/20'
                                : isInvalid
                                ? 'bg-slate-500/10 text-slate-400 border-slate-500/20'
                                : isInfra
                                ? 'bg-red-500/20 text-red-400 border-red-500/30'
                                : 'bg-red-500/10 text-red-400 border-red-500/20';

                              return (
                                <tr key={c.fixture_id} className="hover:bg-secondary/20 transition-colors">
                                  <td className="py-2.5 px-3 font-semibold ff-mono text-foreground">
                                    {c.fixture_id}
                                    <div className="text-[10px] text-muted-foreground font-normal">{c.name}</div>
                                  </td>
                                  <td className="py-2.5 px-3">
                                    <span className={`rounded px-2 py-0.5 ff-mono text-[10px] font-bold border ${statusBadgeClass}`}>
                                      {c.status}
                                    </span>
                                  </td>
                                  <td className="py-2.5 px-3 ff-mono">
                                    {c.independent_tests_passed === true ? (
                                      <span className="text-emerald-400 flex items-center gap-1 font-semibold">
                                        <CheckCircle2 size={12} /> PASSED
                                      </span>
                                    ) : c.independent_tests_passed === false ? (
                                      <span className="text-red-400 flex items-center gap-1 font-semibold">
                                        <XCircle size={12} /> FAILED
                                      </span>
                                    ) : (
                                      <span className="text-muted-foreground">N/A</span>
                                    )}
                                  </td>
                                  <td className="py-2.5 px-3 ff-mono">
                                    {c.test_integrity_violation ? (
                                      <span className="text-red-400 font-bold flex items-center gap-1">
                                        <ShieldAlert size={12} /> VIOLATION
                                      </span>
                                    ) : (
                                      <span className="text-emerald-400 flex items-center gap-1">
                                        <ShieldCheck size={12} /> PRESERVED
                                      </span>
                                    )}
                                  </td>
                                  <td className="py-2.5 px-3 ff-mono text-muted-foreground">
                                    {c.duration_ms} ms
                                  </td>
                                  <td className="py-2.5 px-3 ff-mono text-xs">
                                    {c.candidate_count > 0 ? (
                                      <div>
                                        <span className="text-foreground font-semibold">{c.candidate_count} evaluated</span>
                                        {c.selected_candidate_id && (
                                          <div className="text-[10px] text-emerald-400">sel: {c.selected_candidate_id}</div>
                                        )}
                                      </div>
                                    ) : (
                                      <span className="text-muted-foreground">—</span>
                                    )}
                                  </td>
                                  <td className="py-2.5 px-3 text-[11px] text-muted-foreground max-w-xs truncate">
                                    {c.error_details || c.selection_rationale || 'Verified with zero regressions.'}
                                  </td>
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                      </div>
                    </>
                  ) : null}
                </div>
              )}

              {/* All Runs Table */}
              <div className="rounded-xl border border-border bg-card p-5">
                <h3 className="text-sm font-semibold text-white mb-4">Benchmark Execution Records</h3>
                <div className="overflow-x-auto">
                  <table className="w-full text-left text-xs">
                    <thead>
                      <tr className="border-b border-border text-muted-foreground ff-mono text-[10px] uppercase tracking-wider">
                        <th className="py-2.5 px-3">Run ID</th>
                        <th className="py-2.5 px-3">Execution Mode</th>
                        <th className="py-2.5 px-3">Model / Revision</th>
                        <th className="py-2.5 px-3">Accuracy / Success</th>
                        <th className="py-2.5 px-3">Regressions</th>
                        <th className="py-2.5 px-3">Abstentions</th>
                        <th className="py-2.5 px-3">Test Integrity</th>
                        <th className="py-2.5 px-3">Timestamp</th>
                        <th className="py-2.5 px-3 text-right">Action</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border/60">
                      {benchmarkRuns
                        .filter((r) => benchmarkModeFilter === 'ALL' || r.execution_mode === benchmarkModeFilter)
                        .map((r) => {
                          const isLive = r.execution_mode === 'live_repair';
                          const isDry = r.execution_mode === 'dry_run' || r.execution_mode === 'offline_test';
                          const modeBadge = isLive
                            ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20'
                            : isDry
                            ? 'bg-blue-500/10 text-blue-400 border-blue-500/20'
                            : 'bg-purple-500/10 text-purple-400 border-purple-500/20';

                          return (
                            <tr key={r.run_id} className="hover:bg-secondary/30 transition-colors">
                              <td className="py-3 px-3 font-semibold ff-mono text-foreground">
                                {r.run_id}
                              </td>
                              <td className="py-3 px-3">
                                <span className={`rounded px-2 py-0.5 ff-mono text-[10px] font-bold border ${modeBadge}`}>
                                  {r.execution_mode}
                                </span>
                              </td>
                              <td className="py-3 px-3 ff-mono text-muted-foreground">
                                <span className="text-foreground font-medium">{r.model || 'canonical'}</span>
                                <div className="text-[10px] text-muted-foreground">{r.git_commit || r.code_revision}</div>
                              </td>
                              <td className="py-3 px-3 ff-mono font-bold text-foreground">
                                {r.metrics?.repair_success_rate != null ? (
                                  <span className="text-emerald-400">
                                    {(r.metrics.repair_success_rate * 100).toFixed(1)}%
                                    <span className="text-muted-foreground font-normal text-[10px] ml-1.5">
                                      ({r.metrics.correct_repairs} / {r.metrics.eligible_completed_cases ?? r.metrics.eligible_repair_cases})
                                    </span>
                                  </span>
                                ) : (
                                  <span className="text-muted-foreground">N/A</span>
                                )}
                              </td>
                              <td className="py-3 px-3 ff-mono">
                                <span className={r.metrics?.regressions_introduced > 0 ? 'text-amber-400 font-bold' : 'text-muted-foreground'}>
                                  {r.metrics?.regressions_introduced ?? 0}
                                </span>
                              </td>
                              <td className="py-3 px-3 ff-mono text-purple-400">
                                {r.metrics?.abstained_cases_count ?? r.metrics?.correct_abstentions ?? 0}
                              </td>
                              <td className="py-3 px-3 ff-mono">
                                {r.metrics?.test_integrity_violations === 0 ? (
                                  <span className="text-emerald-400 font-medium">PASSED</span>
                                ) : (
                                  <span className="text-red-400 font-bold">VIOLATION</span>
                                )}
                              </td>
                              <td className="py-3 px-3 text-muted-foreground text-[11px]">
                                {r.timestamp ? new Date(r.timestamp).toLocaleDateString() : 'N/A'}
                              </td>
                              <td className="py-3 px-3 text-right">
                                <button
                                  type="button"
                                  onClick={() => fetchRunDetails(r.run_id)}
                                  className="rounded bg-accent/20 px-2.5 py-1 text-xs font-semibold text-accent-foreground border border-accent/30 hover:bg-accent/40 transition-colors"
                                >
                                  Inspect Run
                                </button>
                              </td>
                            </tr>
                          );
                        })}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          )}

          {/* VIEW 2: SIDE-BY-SIDE BENCHMARK COMPARISON */}
          {benchmarkView === 'comparison' && (
            <div className="space-y-6">
              <div className="rounded-xl border border-border bg-card p-5 space-y-4">
                <div className="flex flex-wrap items-center justify-between gap-4 border-b border-border/70 pb-4">
                  <div>
                    <div className="ff-mono text-[10px] uppercase tracking-wider text-muted-foreground">Comparative Telemetry</div>
                    <h2 className="text-base font-bold text-white">BENCHMARK RUN COMPARISON</h2>
                    <p className="mt-1 text-xs text-muted-foreground">
                      Compare two benchmark executions to verify repair success rate deltas, regression avoidance, and candidate selectivity.
                    </p>
                  </div>

                  {/* Selectors for Run A and Run B */}
                  <div className="flex flex-wrap items-center gap-3">
                    <div className="flex items-center gap-2">
                      <span className="text-xs font-semibold text-sky-400 ff-mono">Baseline (Run A):</span>
                      <select
                        value={runA}
                        onChange={(e) => setRunA(e.target.value)}
                        className="rounded-lg border border-border bg-secondary/80 px-2.5 py-1.5 text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-accent ff-mono"
                      >
                        {benchmarkRuns.map((r) => (
                          <option key={r.run_id} value={r.run_id}>
                            {r.run_id} [{r.execution_mode}] ({r.timestamp ? new Date(r.timestamp).toLocaleDateString() : 'N/A'})
                          </option>
                        ))}
                      </select>
                    </div>

                    <span className="text-muted-foreground text-xs font-bold">vs</span>

                    <div className="flex items-center gap-2">
                      <span className="text-xs font-semibold text-emerald-400 ff-mono">Candidate (Run B):</span>
                      <select
                        value={runB}
                        onChange={(e) => setRunB(e.target.value)}
                        className="rounded-lg border border-border bg-secondary/80 px-2.5 py-1.5 text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-accent ff-mono"
                      >
                        {benchmarkRuns.map((r) => (
                          <option key={r.run_id} value={r.run_id}>
                            {r.run_id} [{r.execution_mode}] ({r.timestamp ? new Date(r.timestamp).toLocaleDateString() : 'N/A'})
                          </option>
                        ))}
                      </select>
                    </div>
                  </div>
                </div>

                {/* Compatibility Banner */}
                {comparison && (
                  <div
                    className={`rounded-lg p-3 text-xs flex items-center justify-between border ${
                      comparison.isCompatible
                        ? 'border-emerald-500/30 bg-emerald-950/20 text-emerald-300'
                        : 'border-amber-500/30 bg-amber-950/20 text-amber-300'
                    }`}
                  >
                    <div className="flex items-center gap-2">
                      {comparison.isCompatible ? <CheckCircle2 size={16} /> : <AlertTriangle size={16} />}
                      <span>
                        <strong>Compatibility:</strong>{' '}
                        {comparison.isCompatible
                          ? 'Fully compatible benchmark comparison (matching fixture versions & execution modes).'
                          : 'Non-comparable warning: Execution modes or fixture versions differ.'}
                      </span>
                    </div>
                    {comparison.warnings?.length > 0 && (
                      <div className="text-[11px] text-amber-400">
                        {comparison.warnings.join(' ')}
                      </div>
                    )}
                  </div>
                )}
              </div>

              {/* Comparison Delta Table */}
              {comparison && comparison.deltas && (
                <div className="rounded-xl border border-border bg-card p-5">
                  <h3 className="text-sm font-semibold text-white mb-4">Core Benchmark Metrics Delta</h3>
                  <div className="overflow-x-auto">
                    <table className="w-full text-left text-xs">
                      <thead>
                        <tr className="border-b border-border text-muted-foreground ff-mono text-[10px] uppercase tracking-wider">
                          <th className="py-2.5 px-3">Metric</th>
                          <th className="py-2.5 px-3 text-sky-400">Baseline ({comparison.runA?.run_id})</th>
                          <th className="py-2.5 px-3 text-emerald-400">Candidate ({comparison.runB?.run_id})</th>
                          <th className="py-2.5 px-3 text-right">Delta (B - A)</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-border/60">
                        <tr>
                          <td className="py-3 px-3 font-medium">Repair Success Rate</td>
                          <td className="py-3 px-3 ff-mono">{comparison.deltas.repair_success_rate?.a != null ? `${comparison.deltas.repair_success_rate.a}%` : 'N/A'}</td>
                          <td className="py-3 px-3 ff-mono">{comparison.deltas.repair_success_rate?.b != null ? `${comparison.deltas.repair_success_rate.b}%` : 'N/A'}</td>
                          <td className="py-3 px-3 text-right ff-mono font-bold">
                            {comparison.deltas.repair_success_rate?.delta != null
                              ? `${comparison.deltas.repair_success_rate.delta > 0 ? '+' : ''}${comparison.deltas.repair_success_rate.delta}%`
                              : '—'}
                          </td>
                        </tr>
                        <tr>
                          <td className="py-3 px-3 font-medium">Abstention Rate</td>
                          <td className="py-3 px-3 ff-mono">{comparison.deltas.abstention_rate?.a != null ? `${comparison.deltas.abstention_rate.a}%` : 'N/A'}</td>
                          <td className="py-3 px-3 ff-mono">{comparison.deltas.abstention_rate?.b != null ? `${comparison.deltas.abstention_rate.b}%` : 'N/A'}</td>
                          <td className="py-3 px-3 text-right ff-mono font-bold">
                            {comparison.deltas.abstention_rate?.delta != null
                              ? `${comparison.deltas.abstention_rate.delta > 0 ? '+' : ''}${comparison.deltas.abstention_rate.delta}%`
                              : '—'}
                          </td>
                        </tr>
                        <tr>
                          <td className="py-3 px-3 font-medium">Test Integrity Violations</td>
                          <td className="py-3 px-3 ff-mono text-emerald-400">{comparison.deltas.test_integrity_violations?.a ?? 0}</td>
                          <td className="py-3 px-3 ff-mono text-emerald-400">{comparison.deltas.test_integrity_violations?.b ?? 0}</td>
                          <td className="py-3 px-3 text-right ff-mono font-bold">{comparison.deltas.test_integrity_violations?.delta ?? 0}</td>
                        </tr>
                        <tr>
                          <td className="py-3 px-3 font-medium">False VERIFIED Count</td>
                          <td className="py-3 px-3 ff-mono text-emerald-400">{comparison.deltas.false_verified_count?.a ?? 0}</td>
                          <td className="py-3 px-3 ff-mono text-emerald-400">{comparison.deltas.false_verified_count?.b ?? 0}</td>
                          <td className="py-3 px-3 text-right ff-mono font-bold">{comparison.deltas.false_verified_count?.delta ?? 0}</td>
                        </tr>
                        <tr>
                          <td className="py-3 px-3 font-medium">Regressions Introduced</td>
                          <td className="py-3 px-3 ff-mono">{comparison.deltas.regressions_introduced?.a ?? 0}</td>
                          <td className="py-3 px-3 ff-mono">{comparison.deltas.regressions_introduced?.b ?? 0}</td>
                          <td className="py-3 px-3 text-right ff-mono font-bold">{comparison.deltas.regressions_introduced?.delta ?? 0}</td>
                        </tr>
                        <tr>
                          <td className="py-3 px-3 font-medium">Candidates Evaluated</td>
                          <td className="py-3 px-3 ff-mono">{comparison.deltas.total_candidates_evaluated?.a ?? 0}</td>
                          <td className="py-3 px-3 ff-mono">{comparison.deltas.total_candidates_evaluated?.b ?? 0}</td>
                          <td className="py-3 px-3 text-right ff-mono font-bold">{comparison.deltas.total_candidates_evaluated?.delta ?? 0}</td>
                        </tr>
                        <tr>
                          <td className="py-3 px-3 font-medium">Median Duration</td>
                          <td className="py-3 px-3 ff-mono">{comparison.deltas.median_repair_duration_ms?.a != null ? `${comparison.deltas.median_repair_duration_ms.a}ms` : 'N/A'}</td>
                          <td className="py-3 px-3 ff-mono">{comparison.deltas.median_repair_duration_ms?.b != null ? `${comparison.deltas.median_repair_duration_ms.b}ms` : 'N/A'}</td>
                          <td className="py-3 px-3 text-right ff-mono font-bold">
                            {comparison.deltas.median_repair_duration_ms?.delta != null ? `${comparison.deltas.median_repair_duration_ms.delta}ms` : '—'}
                          </td>
                        </tr>
                      </tbody>
                    </table>
                  </div>
                </div>
              )}

              {/* Fixture Results Matrix Table */}
              {comparison && comparison.caseComparisons && (
                <section className="rounded-xl border border-border bg-card p-5">
                  <h3 className="text-sm font-semibold text-white mb-4">Case-by-Case Fixture Outcomes</h3>
                  <div className="overflow-x-auto">
                    <table className="w-full text-left text-xs">
                      <thead>
                        <tr className="border-b border-border text-muted-foreground ff-mono text-[10px] uppercase tracking-wider">
                          <th className="py-2.5 px-3">Fixture ID</th>
                          <th className="py-2.5 px-3">Status (Run A)</th>
                          <th className="py-2.5 px-3">Status (Run B)</th>
                          <th className="py-2.5 px-3">Duration A</th>
                          <th className="py-2.5 px-3">Duration B</th>
                          <th className="py-2.5 px-3">Candidates (B)</th>
                          <th className="py-2.5 px-3 text-right">Outcome Match</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-border/60">
                        {comparison.caseComparisons.map((c) => (
                          <tr key={c.fixture_id} className="hover:bg-secondary/30 transition-colors">
                            <td className="py-3 px-3 font-medium ff-mono text-foreground">{c.fixture_id}</td>
                            <td className="py-3 px-3 ff-mono text-sky-400">{c.statusA}</td>
                            <td className="py-3 px-3 ff-mono text-emerald-400">{c.statusB}</td>
                            <td className="py-3 px-3 ff-mono text-muted-foreground">{c.durationMsA != null ? `${c.durationMsA}ms` : '—'}</td>
                            <td className="py-3 px-3 ff-mono text-muted-foreground">{c.durationMsB != null ? `${c.durationMsB}ms` : '—'}</td>
                            <td className="py-3 px-3 ff-mono text-foreground">
                              {c.candidatesB > 0 ? `${c.candidatesB} (sel: ${c.selectedCandidateB || 'none'})` : '—'}
                            </td>
                            <td className="py-3 px-3 text-right">
                              <span
                                className={`rounded px-1.5 py-0.5 ff-mono text-[10px] font-semibold ${
                                  c.statusMatches
                                    ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20'
                                    : 'bg-amber-500/10 text-amber-400 border border-amber-500/20'
                                }`}
                              >
                                {c.statusMatches ? 'MATCH' : 'DELTA'}
                              </span>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </section>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
