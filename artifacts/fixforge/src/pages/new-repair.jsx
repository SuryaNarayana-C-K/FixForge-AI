import { ArrowRight, CheckCircle2, CircleHelp, GitBranch, LoaderCircle, Plus, ShieldCheck } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useLocation } from 'wouter';
import { getListProjectsQueryKey, getListRepairsQueryKey, useCreateProject, useCreateRepair, useListProjects } from '@workspace/api-client-react';
import { PageIntro, QueryError, StatusPill } from '@/components/fixforge-ui';
import { useQueryClient } from '@tanstack/react-query';
export default function NewRepair() {
    const [, setLocation] = useLocation();
    const queryClient = useQueryClient();
    const projects = useListProjects({ query: { queryKey: getListProjectsQueryKey() } });
    const createProject = useCreateProject();
    const createRepair = useCreateRepair();
    const [mode, setMode] = useState('existing');
    const [projectId, setProjectId] = useState('');
    const [projectName, setProjectName] = useState('');
    const [repository, setRepository] = useState('');
    const [language, setLanguage] = useState('Auto Detect');
    const [testFramework, setTestFramework] = useState('Auto Detect');
    const [issue, setIssue] = useState('');
    const [model, setModel] = useState('forge-2');
    const [verificationLevel, setVerificationLevel] = useState('standard');
    const [maxIterations, setMaxIterations] = useState(4);
    const [formError, setFormError] = useState('');
    const selectedProject = useMemo(() => (projects.data || []).find((project) => project.id === projectId), [projects.data, projectId]);
    function submit(event) {
        event.preventDefault();
        setFormError('');
        if (!issue.trim())
            return setFormError('Describe the failure before queuing a repair.');
        if (mode === 'existing' && !projectId)
            return setFormError('Choose a project to continue.');
        if (mode === 'new' && (!projectName.trim() || !repository.trim()))
            return setFormError('Project name and repository are required.');
        const queue = (id) => createRepair.mutate({
            data: {
                projectId: id,
                issue: issue.trim(),
                model,
                verificationLevel,
                maxIterations,
                language: language === 'Auto Detect' ? null : language,
                framework: testFramework === 'Auto Detect' ? null : testFramework,
                testFramework: testFramework === 'Auto Detect' ? null : testFramework,
            }
        }, {
            onSuccess: (repair) => {
                queryClient.invalidateQueries({ queryKey: getListRepairsQueryKey() });
                queryClient.invalidateQueries({ queryKey: getListProjectsQueryKey() });
                setLocation(`/repairs/${repair.id}`);
            },
            onError: () => setFormError('The repair could not be queued. Check the project connection and try again.'),
        });
        if (mode === 'new') {
            createProject.mutate({
                data: {
                    name: projectName.trim(),
                    repository: repository.trim(),
                    language: language === 'Auto Detect' ? 'Python' : language,
                    testFramework: testFramework === 'Auto Detect' ? null : testFramework
                }
            }, {
                onSuccess: (project) => queue(project.id),
                onError: () => setFormError('The project could not be created. Check the repository details and try again.'),
            });
        }
        else
            queue(projectId);
    }
    const pending = createProject.isPending || createRepair.isPending;
    return <div className="mx-auto max-w-[1120px]">
    <PageIntro eyebrow="Forge a repair / 03" title="Start a repair" description="Give the forge a failure with enough signal to investigate. The run will produce an auditable execution record."/>
    <form onSubmit={submit} className="grid gap-6 lg:grid-cols-[1.3fr_.7fr]">
      <div className="space-y-6">
        <section className="rounded-xl border border-border bg-card p-6">
          <div className="mb-5 flex items-start justify-between"><div><div className="ff-mono text-[10px] uppercase tracking-[.2em] text-muted-foreground">01 / Target</div><h2 className="mt-1 text-lg font-semibold">Where should we work?</h2></div><GitBranch size={19} className="text-muted-foreground"/></div>
          <div className="mb-5 flex rounded-lg bg-secondary p-1"><button type="button" onClick={() => setMode('existing')} data-testid="button-existing-project" className={`flex-1 rounded-md px-3 py-2 text-xs font-semibold ${mode === 'existing' ? 'bg-card text-foreground shadow-sm' : 'text-muted-foreground'}`}>Existing project</button><button type="button" onClick={() => setMode('new')} data-testid="button-new-project" className={`flex-1 rounded-md px-3 py-2 text-xs font-semibold ${mode === 'new' ? 'bg-card text-foreground shadow-sm' : 'text-muted-foreground'}`}><Plus size={13} className="mr-1 inline"/> New project</button></div>
          {projects.isError && mode === 'existing' ? <QueryError message="Projects could not be loaded." retry={() => projects.refetch()}/> : mode === 'existing' ? <label className="block"><span className="mb-2 block text-xs font-medium">Select project</span><select value={projectId} onChange={(event) => setProjectId(event.target.value)} data-testid="select-project" className="h-11 w-full appearance-none rounded-lg border border-input bg-background px-3 text-sm outline-none focus:border-accent"><option value="">Choose a repository project…</option>{(projects.data || []).map((project) => <option key={project.id} value={project.id}>{project.name} · {project.repository}</option>)}</select>{selectedProject && <div className="mt-3 flex items-center gap-2 rounded-lg border border-border bg-secondary/45 p-3 text-xs"><CheckCircle2 size={15} className="text-emerald-600"/><span className="flex-1">{selectedProject.language} project · {selectedProject.testFramework || 'No test framework'}</span><StatusPill status={selectedProject.status}/></div>}</label> : <div className="grid gap-4 sm:grid-cols-2"><label className="block sm:col-span-2"><span className="mb-2 block text-xs font-medium">Project name</span><input value={projectName} onChange={(event) => setProjectName(event.target.value)} data-testid="input-project-name" placeholder="e.g. billing-api" className="h-11 w-full rounded-lg border border-input bg-background px-3 text-sm outline-none focus:border-accent"/></label><label className="block sm:col-span-2"><span className="mb-2 block text-xs font-medium">Repository path / URL</span><input value={repository} onChange={(event) => setRepository(event.target.value)} data-testid="input-repository" placeholder="examples/buggy-python-project" className="h-11 w-full rounded-lg border border-input bg-background px-3 text-sm outline-none focus:border-accent"/></label></div>}
        </section>
        <section className="rounded-xl border border-border bg-card p-6">
          <div className="mb-5"><div className="ff-mono text-[10px] uppercase tracking-[.2em] text-muted-foreground">02 / Failure signal</div><h2 className="mt-1 text-lg font-semibold">What broke?</h2><p className="mt-1 text-xs leading-5 text-muted-foreground">Include the observed behavior, expected behavior, and any useful file or test references.</p></div>
          <textarea value={issue} onChange={(event) => setIssue(event.target.value)} data-testid="textarea-issue" rows={7} placeholder={'Example: The invoice total rounds down when a discount is applied after tax. Failing test: invoiceTotals > applies discount to tax-inclusive amount.'} className="w-full resize-y rounded-lg border border-input bg-background p-3 text-sm leading-6 outline-none focus:border-accent"/>
          <div className="mt-2 flex items-center gap-2 text-[11px] text-muted-foreground"><CircleHelp size={13}/> Specific failures produce better patches.</div>
        </section>
      </div>
      <div className="space-y-6">
        <section className="rounded-xl border border-border bg-card p-6">
          <div className="mb-5"><div className="ff-mono text-[10px] uppercase tracking-[.2em] text-muted-foreground">03 / Run policy</div><h2 className="mt-1 text-lg font-semibold">Set guardrails</h2></div>
          <div className="space-y-5">
            <div className="grid grid-cols-2 gap-3">
              <label className="block">
                <span className="mb-2 block text-xs font-medium">Language</span>
                <select value={language} onChange={(e) => setLanguage(e.target.value)} data-testid="select-language" className="h-11 w-full rounded-lg border border-input bg-background px-3 text-sm outline-none focus:border-accent">
                  <option>Auto Detect</option>
                  <option>Python</option>
                  <option>JavaScript</option>
                  <option>Java</option>
                </select>
              </label>
              <label className="block">
                <span className="mb-2 block text-xs font-medium">Framework</span>
                <select value={testFramework} onChange={(e) => setTestFramework(e.target.value)} data-testid="select-framework" className="h-11 w-full rounded-lg border border-input bg-background px-3 text-sm outline-none focus:border-accent">
                  <option>Auto Detect</option>
                  <option>pytest</option>
                  <option>unittest</option>
                  <option>Jest</option>
                  <option>Vitest</option>
                  <option>JUnit</option>
                </select>
              </label>
            </div>
            <label className="block"><span className="mb-2 block text-xs font-medium">Repair model</span><select value={model} onChange={(event) => setModel(event.target.value)} data-testid="select-model" className="h-11 w-full rounded-lg border border-input bg-background px-3 text-sm outline-none focus:border-accent"><option value="forge-2">Forge 2 <span>recommended</span></option><option value="forge-2-fast">Forge 2 Fast</option><option value="forge-1">Forge 1</option></select><span className="mt-2 block text-[11px] leading-5 text-muted-foreground">Forge 2 balances patch quality and verification depth.</span></label><div><span className="mb-2 block text-xs font-medium">Verification level</span><div className="grid grid-cols-3 gap-2">{['quick', 'standard', 'full'].map((item) => <button key={item} type="button" onClick={() => setVerificationLevel(item)} data-testid={`button-verification-${item}`} className={`rounded-lg border px-2 py-3 text-center ${verificationLevel === item ? 'border-accent bg-accent/15 text-foreground' : 'border-border hover:bg-secondary'}`}><span className="block text-xs font-semibold capitalize">{item}</span><span className="mt-1 block text-[10px] text-muted-foreground">{item === 'quick' ? 'Fast' : item === 'standard' ? 'Balanced' : 'Deep'}</span></button>)}</div></div><label className="block"><div className="mb-2 flex items-center justify-between"><span className="text-xs font-medium">Maximum iterations</span><span className="ff-mono text-xs text-accent-foreground">{maxIterations}</span></div><input type="range" min="1" max="10" value={maxIterations} onChange={(event) => setMaxIterations(Number(event.target.value))} data-testid="input-max-iterations" className="w-full accent-[hsl(var(--accent))]"/><div className="mt-1 flex justify-between ff-mono text-[9px] text-muted-foreground"><span>1</span><span>10</span></div></label></div>
        </section>
        <div className="rounded-xl border border-primary/15 bg-primary p-5 text-primary-foreground"><div className="mb-3 flex items-center gap-2 text-sm font-semibold"><ShieldCheck size={17} className="text-accent"/> Evidence-first execution</div><p className="text-xs leading-5 text-primary-foreground/65">Every iteration records its status, test results, and verification outcome. You can follow the run in real time.</p></div>
        {formError && <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2.5 text-xs leading-5 text-red-800" data-testid="text-form-error">{formError}</div>}
        <button type="submit" disabled={pending} data-testid="button-submit-repair" className="flex h-12 w-full items-center justify-center gap-2 rounded-lg bg-accent text-sm font-semibold text-accent-foreground shadow-sm hover:-translate-y-px hover:shadow-md disabled:cursor-not-allowed disabled:opacity-60">{pending ? <><LoaderCircle size={16} className="animate-spin"/> Preparing forge…</> : <>Queue repair <ArrowRight size={16}/></>}</button>
      </div>
    </form>
  </div>;
}
