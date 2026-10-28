import { Component, } from 'react';
function toError(value) {
    if (value instanceof Error) {
        return value;
    }
    if (typeof value === 'string') {
        return new Error(value);
    }
    try {
        return new Error(JSON.stringify(value));
    }
    catch {
        return new Error(String(value));
    }
}
function DefaultFallback({ error, resetError }) {
    return (<div className="ff-noise flex min-h-[100dvh] w-full items-center justify-center bg-background p-6 text-foreground">
      <div className="w-full max-w-lg text-center">
        <div className="ff-mono text-[10px] uppercase tracking-[.25em] text-muted-foreground">Forge exception</div>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight">
          Something went wrong
        </h1>
        <p className="mt-2 text-sm text-muted-foreground">
          This part of the app hit an error. The rest of the app is still
          running.
        </p>
        {/* Dev only: messages can carry API responses and other internals. */}
        {import.meta.env.DEV ? (<pre className="mt-4 overflow-x-auto rounded-lg border border-border bg-card p-3 text-left text-xs text-foreground">
            {error.message || String(error)}
          </pre>) : null}
        <button type="button" onClick={resetError} data-testid="button-error-retry" className="mt-5 rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground hover:bg-primary/90">
          Try again
        </button>
      </div>
    </div>);
}
export class ErrorBoundary extends Component {
    state = { error: null };
    static getDerivedStateFromError(error) {
        return { error: toError(error) };
    }
    componentDidCatch(error, info) {
        console.error('ErrorBoundary caught an error:', toError(error), info.componentStack);
    }
    componentDidUpdate(prevProps) {
        if (this.state.error !== null &&
            prevProps.resetKey !== this.props.resetKey) {
            this.resetError();
        }
    }
    resetError = () => {
        this.setState({ error: null });
    };
    render() {
        const { error } = this.state;
        if (error === null) {
            return this.props.children;
        }
        const Fallback = this.props.FallbackComponent ?? DefaultFallback;
        return <Fallback error={error} resetError={this.resetError}/>;
    }
}
