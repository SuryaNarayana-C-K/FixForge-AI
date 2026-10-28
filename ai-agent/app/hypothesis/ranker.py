"""
FixForge M12.2 — Deterministic Evidence-Based Hypothesis Ranker.
Ranks candidate diagnosis hypotheses using explicit, inspectable criteria grounded in
failing tests, stack traces, repository source code, and consistency checks.
"""

from pathlib import Path
import re
from typing import Any

from app.context.code_context import is_test_path
from app.patch_schemas import DiagnosisHypothesis


class HypothesisRanker:
    """
    Deterministically scores and ranks candidate root-cause hypotheses against observed
    test execution facts, traceback frames, and repository source code.
    """

    def __init__(self, repo_path: Path):
        self.repo_path = repo_path

    def _parse_file_and_line(self, file_ref: str) -> tuple[str, int | None]:
        """Extracts relative file path and optional line number from file:line references."""
        clean_ref = file_ref.strip()
        if ":" in clean_ref:
            parts = clean_ref.split(":", 1)
            f_path = parts[0].strip()
            line_str = parts[1].strip()
            # handle line ranges like 15-20
            match = re.search(r"(\d+)", line_str)
            line_num = int(match.group(1)) if match else None
            return f_path, line_num
        return clean_ref, None

    def _extract_traceback_frames(self, failures: list[dict[str, Any]]) -> list[dict[str, Any]]:
        """Extracts (file, line, function) tuples from failure tracebacks and signatures."""
        frames = []
        for fail in failures:
            tb = fail.get("traceback", "") or fail.get("message", "") or ""
            # Regex for python traceback lines: File "...", line 123, in func
            matches = re.finditer(r'File "(?:[A-Za-z]:[\\/])?([^"]+)", line (\d+)(?:, in (\w+))?', tb)
            for m in matches:
                p = m.group(1).replace("\\", "/").strip()
                l = int(m.group(2))
                fn = m.group(3) if m.group(3) else ""
                frames.append({"file": p, "line": l, "func": fn, "test": fail.get("test_name", "")})

            # Also check direct failure attributes
            if fail.get("file_path"):
                p = str(fail["file_path"]).replace("\\", "/").strip()
                l = fail.get("line_number")
                frames.append({"file": p, "line": l, "func": fail.get("test_name", ""), "test": fail.get("test_name", "")})

        return frames

    def score_hypothesis(
        self,
        hypothesis: DiagnosisHypothesis,
        failures: list[dict[str, Any]],
        traceback_frames: list[dict[str, Any]],
        test_output: str = "",
    ) -> tuple[float, list[str]]:
        """
        Computes a deterministic quantitative score and inspectable reasoning list
        for a single candidate hypothesis.
        """
        score = 0.0
        reasons: list[str] = []

        # 1. Direct support from failing tests (+25 pts for primary, +10 for multi-failure coverage)
        explained_tests: set[str] = set()
        hyp_text = f"{hypothesis.root_cause_statement} {hypothesis.observed_behavior} {hypothesis.causal_explanation} {' '.join(hypothesis.supporting_evidence)}".lower()

        for fail in failures:
            t_name = fail.get("test_name", "").strip()
            if t_name and (t_name.lower() in hyp_text or any(t_name.lower() in ev.lower() for ev in hypothesis.supporting_evidence)):
                explained_tests.add(t_name)

        if explained_tests:
            score += 25.0
            reasons.append(f"Directly supports {len(explained_tests)} failing test(s) ({', '.join(sorted(explained_tests))}) (+25.0)")
            if len(explained_tests) > 1:
                multi_bonus = (len(explained_tests) - 1) * 10.0
                score += multi_bonus
                reasons.append(f"Explains multiple interacting/shared failures (+{multi_bonus})")
        elif failures:
            reasons.append("Does not explicitly reference observed failing test names (+0.0)")

        # 2. Traceback and stack-frame relevance (+15 for matching file, +15 for matching line ±5)
        matched_tb_frames = 0
        exact_line_matches = 0
        for f_ref in hypothesis.relevant_files:
            p, l = self._parse_file_and_line(f_ref)
            norm_p = p.replace("\\", "/").strip()
            for frame in traceback_frames:
                frame_p = frame["file"].replace("\\", "/").strip()
                if frame_p.endswith(norm_p) or norm_p.endswith(frame_p) or Path(frame_p).name == Path(norm_p).name:
                    matched_tb_frames += 1
                    if l is not None and frame.get("line") is not None:
                        if abs(l - frame["line"]) <= 5:
                            exact_line_matches += 1
                    break

        if matched_tb_frames > 0:
            tb_score = 15.0 + (15.0 if exact_line_matches > 0 else 0.0)
            score += tb_score
            reasons.append(f"Relevant files align with execution traceback frames ({matched_tb_frames} file matches, {exact_line_matches} line matches) (+{tb_score})")

        # 3. Source-code evidence (file existence and symbol presence)
        all_files_exist = True
        missing_files = []
        target_files = []
        for f_ref in hypothesis.relevant_files:
            p, _ = self._parse_file_and_line(f_ref)
            if not p:
                continue
            target_files.append(p)
            disk_path = (self.repo_path / p).resolve()
            if disk_path.is_file() and disk_path.is_relative_to(self.repo_path):
                # File exists on disk
                pass
            else:
                all_files_exist = False
                missing_files.append(p)

        if hypothesis.relevant_files:
            if all_files_exist:
                score += 15.0
                reasons.append(f"All cited files verified to exist in repository ({len(target_files)} files) (+15.0)")
            else:
                score -= 30.0
                reasons.append(f"Cites non-existent or inaccessible repository files: {missing_files} (-30.0)")
        else:
            reasons.append("No specific source files cited in hypothesis (+0.0)")

        # 4. Consistency with test protection and API expectations
        proposes_test_modification = False
        for f in target_files:
            if is_test_path(f):
                proposes_test_modification = True
                break

        if proposes_test_modification:
            score -= 60.0
            reasons.append("CRITICAL: Hypothesis targets protected test files for modification (-60.0)")
        else:
            if hypothesis.expected_behavior:
                score += 10.0
                reasons.append("Grounded expected behavior aligns with test assertions (+10.0)")

        # 5. Simplicity / Occam's razor preference (minimal surface area)
        if 0 < len(target_files) <= 2:
            score += 10.0
            reasons.append("Locally bounded repair scope (1-2 files) satisfies Occam's razor (+10.0)")
        elif len(target_files) > 4:
            score -= 10.0
            reasons.append("Overly broad multi-file repair scope (>4 files) (-10.0)")

        # 6. Penalties for unverified assumptions and contradictory evidence
        if hypothesis.missing_evidence_or_assumptions:
            assumption_penalty = min(30.0, len(hypothesis.missing_evidence_or_assumptions) * 10.0)
            score -= assumption_penalty
            reasons.append(f"Relies on unverified assumptions / missing evidence ({len(hypothesis.missing_evidence_or_assumptions)} items) (-{assumption_penalty})")

        # 7. Model self-confidence minor weighting (0-5 pts max, deterministic)
        conf_pts = round(hypothesis.confidence_score * 5.0, 2)
        score += conf_pts
        reasons.append(f"Self-assessed confidence weight ({hypothesis.confidence_score:.2f} * 5.0 = +{conf_pts})")

        return round(score, 2), reasons

    def rank(
        self,
        hypotheses: list[DiagnosisHypothesis],
        failures: list[dict[str, Any]],
        test_output: str = "",
    ) -> list[DiagnosisHypothesis]:
        """
        Ranks all candidate hypotheses deterministically, populates rank/score/reasons,
        and returns the list sorted from rank 1 (best) to N.
        """
        if not hypotheses:
            return []

        tb_frames = self._extract_traceback_frames(failures)

        scored_items: list[tuple[float, int, DiagnosisHypothesis]] = []
        for hyp in hypotheses:
            score, reasons = self.score_hypothesis(hyp, failures, tb_frames, test_output)
            hyp.ranking_score = score
            hyp.ranking_reasons = reasons

            # Tie-breaking metadata: count of verified files that are not test paths
            clean_files_count = len([f for f in hyp.relevant_files if not is_test_path(f)])
            scored_items.append((score, clean_files_count, hyp))

        # Sort deterministically:
        # 1. Ranking score descending
        # 2. Number of clean relevant files ascending (Occam's razor)
        # 3. Hypothesis ID ascending (stable tie-breaker)
        scored_items.sort(key=lambda item: (-item[0], item[1], item[2].hypothesis_id))

        ranked: list[DiagnosisHypothesis] = []
        for i, (_, _, hyp) in enumerate(scored_items, start=1):
            hyp.rank = i
            ranked.append(hyp)

        return ranked


def rank_hypotheses(
    hypotheses: list[DiagnosisHypothesis],
    failures: list[dict[str, Any]],
    repo_path: Path,
    test_output: str = "",
) -> list[DiagnosisHypothesis]:
    """Convenience helper to rank hypotheses deterministically."""
    ranker = HypothesisRanker(repo_path)
    return ranker.rank(hypotheses, failures, test_output=test_output)
