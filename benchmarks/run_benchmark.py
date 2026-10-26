"""
CLI entry point to execute the FixForge M12.1 Reproducible Repair Benchmark Engine.
Outputs JSON report and a formatted markdown summary.
"""

import asyncio
import json
from pathlib import Path
import sys

# Ensure ai-agent is in python path
WORKSPACE_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(WORKSPACE_ROOT / "ai-agent"))

from app.benchmark import BenchmarkRunner, list_fixtures


async def main():
    print("=" * 70)
    print("FixForge M12.1 — Reproducible Repair Benchmark Engine")
    print("=" * 70)

    fixtures = list_fixtures()
    print(f"Loaded {len(fixtures)} canonical fixtures:")
    for f in fixtures:
        print(f"  [{f.id}] {f.name} ({f.category}) - Eligible: {f.eligible_for_repair}")

    print("\nExecuting benchmark matrix across isolated workspaces...")
    runner = BenchmarkRunner(timeout_seconds=30.0, cleanup_after_run=True)
    report = await runner.run_all(fixtures=fixtures, save_report=True)

    m = report.metrics
    print("\n" + "=" * 70)
    print(f"BENCHMARK RUN REPORT: {report.run_id}")
    print("=" * 70)
    print(f"Total Cases Evaluated:       {m.total_cases}")
    print(f"Completed Cases:            {m.completed_cases}")
    print(f"Eligible Repair Cases:      {m.eligible_repair_cases}")
    print(f"Correct Repairs:            {m.correct_repairs}")
    print(f"Repair Success Rate:        {m.repair_success_rate:.1%}" if m.repair_success_rate is not None else "Repair Success Rate:        N/A")
    print(f"Failed Repairs:             {m.failed_repairs}")
    print(f"False VERIFIED Count:       {m.false_verified_count} (must be strictly 0)")
    print(f"False VERIFIED Rate:        {m.false_verified_rate:.1%}")
    print(f"Regressions Introduced:     {m.regressions_introduced}")
    print(f"Regression Rate:            {m.regression_rate:.1%}")
    print(f"Invalid Patches Accepted:   {m.invalid_patches_accepted} (must be strictly 0)")
    print(f"Patch Rejection Rate:       {m.patch_rejection_rate:.1%}" if m.patch_rejection_rate is not None else "Patch Rejection Rate:       N/A")
    print(f"Unnecessary Files Modified: {m.unnecessary_files_modified}")
    print(f"Diagnosis Cases Evaluated:  {m.diagnosis_cases}")
    print(f"Correct Diagnoses:          {m.correct_diagnoses}")
    print(f"Diagnosis Accuracy:         {m.diagnosis_accuracy:.1%}" if m.diagnosis_accuracy is not None else "Diagnosis Accuracy:        N/A")
    print(f"Abstention Cases:           {m.abstention_cases}")
    print(f"Correct Abstentions:        {m.correct_abstentions}")
    print(f"Abstention Accuracy:        {m.abstention_accuracy:.1%}" if m.abstention_accuracy is not None else "Abstention Accuracy:       N/A")
    print(f"Unintended Abstentions:     {m.unintended_abstentions} (must be 0 on repairable bugs)")
    print(f"Candidates Evaluated:       {m.total_candidates_evaluated}")
    print(f"Avg Candidates per Case:    {m.avg_candidates_per_case:.2f}" if m.avg_candidates_per_case is not None else "Avg Candidates per Case: N/A")
    print(f"Selected Candidates:        {m.selected_candidates_count}")
    print(f"Execution Mode:             {m.execution_mode} (Golden-validation fixtures only; does not claim live repair accuracy)")
    print(f"Median Repair Duration:     {m.median_repair_duration_ms:.1f} ms" if m.median_repair_duration_ms is not None else "Median Duration: N/A")
    print(f"P95 Repair Duration:        {m.p95_repair_duration_ms:.1f} ms" if m.p95_repair_duration_ms is not None else "P95 Duration: N/A")
    print(f"Avg Model Calls per Case:   {m.avg_model_calls_per_case:.2f}" if m.avg_model_calls_per_case is not None else "Avg Model Calls: N/A")
    print(f"Token Usage & Cost:         Unavailable (reported as null)")
    print("=" * 70)

    print("\nIndividual Case Outcomes:")
    for c in report.case_results:
        cand_str = f" [cand={c.candidate_count}, sel={c.selected_candidate_id}]" if c.candidate_count > 0 else ""
        print(f"  • {c.fixture_id:<28} -> {c.status:<26} (verified={c.is_verified}, duration={c.duration_ms}ms){cand_str}")


    # Save canonical baseline report
    baseline_out = WORKSPACE_ROOT / "benchmarks" / "reports" / "baseline_report.json"
    baseline_out.write_text(json.dumps(report.model_dump(), indent=2), encoding="utf-8")
    print(f"\nSaved baseline report to {baseline_out}")


if __name__ == "__main__":
    asyncio.run(main())
