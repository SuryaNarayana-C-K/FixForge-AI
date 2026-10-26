"""
FixForge M12.5 — Live Repair Accuracy Benchmark CLI Runner.
Executes real end-to-end AI repair accuracy validation using the actual Gemini-powered
repair pipeline on unseen bugs with independent, held-out test suites.
"""

import argparse
import asyncio
import json
import os
from pathlib import Path
import sys

# Ensure ai-agent is in python path
WORKSPACE_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(WORKSPACE_ROOT / "ai-agent"))

try:
    from dotenv import load_dotenv
    load_dotenv(WORKSPACE_ROOT / ".env")
except Exception:
    pass

from app.benchmark import (
    BenchmarkReport,
    LiveBenchmarkRunner,
    compare_benchmark_reports,
    get_live_case,
    list_live_cases,
)
from app.providers.gemini import GeminiProvider


async def run_cli():
    parser = argparse.ArgumentParser(description="FixForge M12.5 Live Repair Accuracy Benchmark Runner")
    parser.add_argument(
        "--mode",
        choices=["live_repair", "dry_run", "offline_test"],
        default="dry_run",
        help="Benchmark execution mode (default: dry_run)",
    )
    parser.add_argument("--timeout", type=float, default=60.0, help="Per-case timeout in seconds")
    parser.add_argument("--cases", nargs="*", help="Specific case IDs to run")
    parser.add_argument("--no-cleanup", action="store_true", help="Preserve temporary workspaces for debugging")
    parser.add_argument("--save", action="store_true", default=True, help="Save versioned JSON report")
    parser.add_argument("--model", type=str, default=None, help="Gemini model identifier")
    parser.add_argument("--compare", type=str, default=None, help="Prior report ID or JSON path to compare with this run")

    args = parser.parse_args()

    print("=" * 78)
    print("FixForge M12.5 — Live Repair Accuracy Validation Runner")
    print("=" * 78)
    print(f"Execution Mode: {args.mode}")
    print(f"Configured Model: {args.model or os.getenv('LLM_MODEL', 'gemini-2.0-flash')}")

    if args.mode == "live_repair":
        provider = GeminiProvider()
        if not provider.is_configured:
            print("\n" + "!" * 78)
            print("STATUS: BLOCKED")
            print("REASON: GEMINI_API_KEY is not configured in environment variables.")
            print("To run live repairs with Google Gemini, export GEMINI_API_KEY=<your-key>.")
            print("To test the benchmark harness deterministically, use --mode dry_run or --mode offline_test.")
            print("!" * 78 + "\n")
            sys.exit(2)

    all_cases = list_live_cases()
    if args.cases:
        selected_cases = [c for c in all_cases if c.id in args.cases]
    else:
        selected_cases = all_cases

    print(f"\nDiscovered {len(selected_cases)} live benchmark cases:")
    for c in selected_cases:
        print(f"  • [{c.id}] {c.name} ({c.language}, {c.category})")

    print("\nExecuting live accuracy validation across isolated workspaces...")
    runner = LiveBenchmarkRunner(
        timeout_seconds=args.timeout,
        cleanup_after_run=not args.no_cleanup,
        execution_mode=args.mode,
        model=args.model,
    )

    report = await runner.run_all(cases=selected_cases, save_report=args.save)
    m = report.metrics

    print("\n" + "=" * 78)
    print(f"LIVE BENCHMARK EXECUTION REPORT: {report.run_id}")
    print("=" * 78)
    print(f"Execution Mode:              {report.execution_mode}")
    print(f"Model:                       {report.model or 'None'}")
    print(f"Git Commit:                  {report.git_commit or 'unknown'}")
    print(f"Timestamp:                   {report.timestamp}")
    print("-" * 78)
    print(f"Total Cases Attempted:       {m.total_cases}")
    print(f"Completed Cases:             {m.completed_cases} / {m.total_cases}")
    print(f"Eligible Repair Cases:       {m.eligible_repair_cases}")
    print(f"Eligible Completed Cases:    {m.eligible_completed_cases} (excl. infra errors & invalid cases)")
    print(f"Repaired Cases:              {m.correct_repairs}")
    if m.repair_success_rate is not None:
        print(f"Repair Success Rate:         {m.repair_success_rate:.1%} ({m.correct_repairs} / {m.eligible_completed_cases})")
    else:
        print("Repair Success Rate:         N/A (no eligible completed cases)")

    print(f"Regressions Introduced:      {m.regressions_introduced} ({m.regression_rate:.1%})")
    print(f"Abstentions:                 {m.abstained_cases_count}" + (f" ({m.abstention_rate:.1%})" if m.abstention_rate is not None else ""))
    print(f"Timeouts:                    {m.timeout_cases_count}" + (f" ({m.timeout_rate:.1%})" if m.timeout_rate is not None else ""))
    print(f"Infrastructure Errors:       {m.infra_error_cases_count} ({m.infra_error_rate:.1%})")
    print(f"Invalid Cases:               {m.invalid_cases_count}")
    print(f"Test Integrity Violations:   {m.test_integrity_violations} (protected test changes)")
    print(f"False VERIFIED Count:        {m.false_verified_count} (must strictly be 0)")
    print(f"Candidates Evaluated:        {m.total_candidates_evaluated}")
    print(f"Candidates Selected:         {m.selected_candidates_count}")
    print(f"Median Repair Duration:      {f'{m.median_repair_duration_ms:.1f} ms' if m.median_repair_duration_ms else 'N/A'}")
    print(f"P95 Repair Duration:         {f'{m.p95_repair_duration_ms:.1f} ms' if m.p95_repair_duration_ms else 'N/A'}")
    print(f"Model Calls:                 {f'{m.avg_model_calls_per_case:.1f} avg' if m.avg_model_calls_per_case else 'N/A'}")
    print(f"Token Telemetry:             {m.total_tokens if m.total_tokens is not None else 'Unavailable (reported as null)'}")
    print(f"Cost Telemetry:              {f'${m.total_cost_usd:.4f}' if m.total_cost_usd is not None else 'Unavailable (reported as null)'}")
    print("=" * 78)

    print("\nCase Outcomes Breakdown:")
    for c in report.case_results:
        indep_str = "passed" if c.independent_tests_passed is True else ("failed" if c.independent_tests_passed is False else "n/a")
        integ_str = "OK" if not c.test_integrity_violation else "VIOLATION"
        print(f"  • [{c.status:<12}] {c.fixture_id:<28} (time={c.duration_ms}ms, indep={indep_str}, integrity={integ_str})")
        if c.error_details:
            print(f"      Reason: {c.error_details}")

    report_path = WORKSPACE_ROOT / "benchmarks" / "reports" / f"{report.run_id}.json"
    print(f"\nPersisted versioned JSON report to: {report_path}")

    if args.compare:
        compare_path = Path(args.compare)
        if not compare_path.is_file():
            # Try searching in benchmarks/reports
            alt_path = WORKSPACE_ROOT / "benchmarks" / "reports" / f"{args.compare}.json"
            if alt_path.is_file():
                compare_path = alt_path
            else:
                alt_path2 = WORKSPACE_ROOT / "benchmarks" / "reports" / args.compare
                if alt_path2.is_file():
                    compare_path = alt_path2

        if compare_path.is_file():
            try:
                base_data = json.loads(compare_path.read_text(encoding="utf-8"))
                base_report = BenchmarkReport.model_validate(base_data)
                comparison = compare_benchmark_reports(base_report, report)

                print("\n" + "=" * 78)
                print(f"BENCHMARK COMPARISON: {base_report.run_id} (Base) vs {report.run_id} (Current)")
                print("=" * 78)
                print(f"Compatibility Status:        {'COMPATIBLE' if comparison.is_compatible else 'INCOMPATIBLE'}")
                print(f"Compatibility Reason:        {comparison.compatibility_reason}")
                print(f"Overlapping Fixtures:        {len(comparison.common_cases)} common cases")
                print("-" * 78)
                print("Metric Deltas (Current - Base):")
                for metric, delta in comparison.metric_deltas.items():
                    sign = "+" if isinstance(delta, (int, float)) and delta > 0 else ""
                    print(f"  • {metric:<32} {sign}{delta}")

                if comparison.case_diffs:
                    print("-" * 78)
                    print("Outcome Changes by Fixture:")
                    for d in comparison.case_diffs:
                        status_str = f"{d['base_status']} -> {d['target_status']}"
                        flag = "[IMPROVED]" if d.get("improved") else ("[REGRESSED]" if d.get("regressed") else "[CHANGED]")
                        print(f"  • {flag:<12} {d['fixture_id']:<26} {status_str}")
                else:
                    print("-" * 78)
                    print("No fixture status changes detected across common cases.")
                print("=" * 78)
            except Exception as e:
                print(f"\nWarning: Could not complete comparison against '{args.compare}': {e}")
        else:
            print(f"\nWarning: Comparison baseline report not found at: {args.compare}")

    print("=" * 78)
    return report


if __name__ == "__main__":
    asyncio.run(run_cli())
