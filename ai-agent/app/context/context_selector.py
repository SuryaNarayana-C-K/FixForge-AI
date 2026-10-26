"""
Smart context selection for root-cause analysis and patch generation.
Selects only the minimal relevant files and lines needed for debugging.
"""

import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from app.context.code_context import FileContext, load_file_context, is_test_path
from app.context.config import ContextBudget, DEFAULT_BUDGET


@dataclass
class SelectedContext:
    focal_test_file: str | None = None
    focal_source_files: list[str] = field(default_factory=list)
    file_contexts: dict[str, FileContext] = field(default_factory=dict)
    traceback_snippets: list[str] = field(default_factory=list)
    total_characters: int = 0

    def format_prompt_context(self) -> str:
        """Format the selected context into a compact markdown representation for the model."""
        sections: list[str] = []

        if self.traceback_snippets:
            sections.append("### Relevant Failure Tracebacks:\n```text\n" + "\n---\n".join(self.traceback_snippets) + "\n```")

        sections.append("### Relevant Code Files:")
        for rel_path, fc in self.file_contexts.items():
            role = "TEST FILE (READ-ONLY)" if fc.is_test_file else "SOURCE FILE (TARGET FOR FIX)"
            if rel_path.endswith((".js", ".jsx", ".mjs", ".cjs")):
                lang_fence = "javascript"
            elif rel_path.endswith((".ts", ".tsx", ".mts", ".cts")):
                lang_fence = "typescript"
            elif rel_path.endswith(".java"):
                lang_fence = "java"
            else:
                lang_fence = "python"
            sections.append(
                f"#### File: `{rel_path}` [{role}]\n```{lang_fence}\n"
                f"{fc.format_with_line_numbers()}\n```"
            )

        return "\n\n".join(sections)


class ContextSelector:
    """Selects files and context relevant to test failures while enforcing budget limits."""

    def __init__(self, budget: ContextBudget = DEFAULT_BUDGET):
        self.budget = budget

    def extract_file_references_from_traceback(self, traceback_str: str) -> list[tuple[str, int]]:
        """
        Find (file_path, line_number) references in a stack trace.
        Supports Python tracebacks, JavaScript (Node/Jest/file:// URLs) stack traces, and Java.
        """
        import urllib.parse
        refs: list[tuple[str, int]] = []
        if not traceback_str:
            return refs

        # 0. Node.js native test runner format: test at path/file.js:12:34
        node_test_pattern = re.compile(r'test at\s+([^\r\n:]+):(\d+)(?::\d+)?', re.IGNORECASE)
        for match in node_test_pattern.finditer(traceback_str):
            f_path = match.group(1).replace("\\", "/").strip()
            l_num = int(match.group(2))
            refs.append((f_path, l_num))

        # 1. Python traceback format: File "path/file.py", line 123
        py_pattern = re.compile(r'File\s+["\']([^"\']+\.[a-zA-Z0-9]+)["\'],\s+line\s+(\d+)', re.IGNORECASE)
        for match in py_pattern.finditer(traceback_str):
            file_path = match.group(1).replace("\\", "/")
            line_no = int(match.group(2))
            refs.append((file_path, line_no))

        # 2. File URL format: file:///C:/path/file.js:12:34 or file:///path/file.js:12:34
        file_url_pattern = re.compile(r'file:\/\/\/([a-zA-Z]:[^\):\r\n]+|[^\):\r\n]+):(\d+)(?::\d+)?', re.IGNORECASE)
        for match in file_url_pattern.finditer(traceback_str):
            raw_url_path = urllib.parse.unquote(match.group(1)).replace("\\", "/")
            line_no = int(match.group(2))
            refs.append((raw_url_path, line_no))

        # 3. JavaScript (Jest/Node/V8) stack traces: at ... (path/file.js:12:34) or at path/file.js:12:34
        js_pattern = re.compile(r'(?:at\s+.*?\s+\(|\bat\s+)([a-zA-Z0-9_\-\.\/\\\:]+\.[a-zA-Z0-9]+):(\d+)(?::\d+)?', re.IGNORECASE)
        for match in js_pattern.finditer(traceback_str):
            file_path = match.group(1).replace("\\", "/")
            line_no = int(match.group(2))
            # Ignore internal node modules
            if not file_path.startswith("node:") and "node_modules" not in file_path:
                refs.append((file_path, line_no))

        return refs

    def select_context(
        self,
        workspace_root: Path,
        failures: list[dict[str, Any]],
        project_structure: dict[str, Any] | None = None,
    ) -> SelectedContext:
        selected = SelectedContext()
        if not failures:
            return selected

        # 1. Inspect first failure (M4 primary target)
        primary_failure = failures[0]
        test_file = primary_failure.get("file", "")
        traceback_str = primary_failure.get("traceback", "")

        # Truncate traceback to budget
        if len(traceback_str) > self.budget.max_traceback_size:
            traceback_str = traceback_str[: self.budget.max_traceback_size] + "\n[traceback truncated by FixForge]"
        if traceback_str:
            selected.traceback_snippets.append(traceback_str)

        files_to_load: dict[str, list[int]] = {}

        # 2. Add the failing test file
        if test_file:
            norm_test = test_file.replace("\\", "/")
            selected.focal_test_file = norm_test
            files_to_load[norm_test] = []

        # 3. Extract source files cited in traceback
        raw_refs = self.extract_file_references_from_traceback(traceback_str)
        for ref_file, line_no in raw_refs:
            # Check if this file lives inside the workspace
            p = Path(ref_file)
            rel_candidate = None
            if p.is_absolute():
                try:
                    rel_candidate = str(p.relative_to(workspace_root)).replace("\\", "/")
                except ValueError:
                    # External library / standard library file
                    continue
            else:
                rel_candidate = ref_file.replace("\\", "/")

            if rel_candidate:
                if rel_candidate not in files_to_load:
                    files_to_load[rel_candidate] = []
                if line_no not in files_to_load[rel_candidate]:
                    files_to_load[rel_candidate].append(line_no)
                if not is_test_path(rel_candidate) and rel_candidate not in selected.focal_source_files:
                    selected.focal_source_files.append(rel_candidate)

        # 4. If no source files found from traceback, infer from test file naming, imports, or project structure
        if not selected.focal_source_files:
            # 4a. Check test file naming convention
            if test_file:
                test_p = Path(test_file)
                base_name = test_p.name
                stem_name = test_p.stem
                candidate_names: list[str] = []
                if base_name.startswith("test_"):
                    candidate_names.append(base_name[5:])
                elif stem_name.endswith("_test"):
                    candidate_names.append(stem_name[:-5] + test_p.suffix)
                elif ".test." in base_name:
                    candidate_names.append(base_name.replace(".test.", "."))
                elif ".spec." in base_name:
                    candidate_names.append(base_name.replace(".spec.", "."))

                for c_name in candidate_names:
                    for search_dir in ["", "src", "lib", "app"]:
                        cand_rel = f"{search_dir}/{c_name}".lstrip("/")
                        if (workspace_root / cand_rel).is_file() and not is_test_path(cand_rel):
                            norm_cand = cand_rel.replace("\\", "/")
                            if norm_cand not in selected.focal_source_files:
                                selected.focal_source_files.append(norm_cand)
                            if norm_cand not in files_to_load:
                                files_to_load[norm_cand] = []

            # 4b. Parse imports or requires from failing test file
            if test_file and (workspace_root / test_file).is_file():
                try:
                    test_content = (workspace_root / test_file).read_text(encoding="utf-8", errors="replace")
                    # Python imports
                    import_matches = re.findall(r"^(?:from|import)\s+([a-zA-Z0-9_\.]+)", test_content, flags=re.MULTILINE)
                    for mod in import_matches:
                        root_mod = mod.split(".")[0]
                        for search_dir in ["", "src", "lib", "app"]:
                            cand_rel = f"{search_dir}/{root_mod}.py".lstrip("/")
                            if (workspace_root / cand_rel).is_file() and not is_test_path(cand_rel):
                                norm_cand = cand_rel.replace("\\", "/")
                                if norm_cand not in selected.focal_source_files:
                                    selected.focal_source_files.append(norm_cand)
                                if norm_cand not in files_to_load:
                                    files_to_load[norm_cand] = []

                    # JavaScript requires / imports: require('./calculator') or from './calculator' or from '../stats.mjs'
                    js_reqs = re.findall(r"(?:require\(|from\s+)['\"](?:\.\/|\.\.\/)?([a-zA-Z0-9_\-\/\.]+)['\"]", test_content)
                    test_dir = (workspace_root / test_file).parent
                    for mod in js_reqs:
                        # Try direct relative resolution from test file dir
                        try:
                            rel_to_test = (test_dir / mod).resolve()
                            if rel_to_test.is_file() and rel_to_test.is_relative_to(workspace_root):
                                norm_cand = str(rel_to_test.relative_to(workspace_root)).replace("\\", "/")
                                if not is_test_path(norm_cand):
                                    if norm_cand not in selected.focal_source_files:
                                        selected.focal_source_files.append(norm_cand)
                                    if norm_cand not in files_to_load:
                                        files_to_load[norm_cand] = []
                        except Exception:
                            pass

                        root_mod = Path(mod).stem
                        for ext in [".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx"]:
                            for search_dir in ["", "src", "lib", "app"]:
                                cand_rel = f"{search_dir}/{root_mod}{ext}".lstrip("/")
                                if (workspace_root / cand_rel).is_file() and not is_test_path(cand_rel):
                                    norm_cand = cand_rel.replace("\\", "/")
                                    if norm_cand not in selected.focal_source_files:
                                        selected.focal_source_files.append(norm_cand)
                                    if norm_cand not in files_to_load:
                                        files_to_load[norm_cand] = []
                except Exception:
                    pass

            # 4c. Check source paths from project structure
            src_paths: list[str] = []
            if project_structure:
                if isinstance(project_structure, dict):
                    src_paths = project_structure.get("source_paths", [])
                elif hasattr(project_structure, "source_paths"):
                    src_paths = getattr(project_structure, "source_paths", [])

            for sp in src_paths:
                sp_norm = str(sp).replace("\\", "/").rstrip("/")
                target_p = workspace_root / sp_norm
                if target_p.is_file() and not is_test_path(sp_norm):
                    if sp_norm not in selected.focal_source_files:
                        selected.focal_source_files.append(sp_norm)
                    if sp_norm not in files_to_load:
                        files_to_load[sp_norm] = []
                elif target_p.is_dir():
                    for pattern in ("*.py", "*.js", "*.mjs", "*.ts"):
                        for py_file in target_p.glob(pattern):
                            try:
                                rel_cand = str(py_file.relative_to(workspace_root)).replace("\\", "/")
                                if not is_test_path(rel_cand):
                                    if rel_cand not in selected.focal_source_files:
                                        selected.focal_source_files.append(rel_cand)
                                    if rel_cand not in files_to_load:
                                        files_to_load[rel_cand] = []
                            except ValueError:
                                pass

            # 4d. Fallback: discover any root level or src/ level non-test python/javascript/typescript files
            if not selected.focal_source_files:
                for pattern in ("*.py", "*.js", "*.mjs", "*.ts", "src/**/*.py", "src/**/*.js", "src/**/*.mjs", "src/**/*.ts"):
                    for candidate_file in workspace_root.glob(pattern):
                        try:
                            rel_cand = str(candidate_file.relative_to(workspace_root)).replace("\\", "/")
                            if not is_test_path(rel_cand):
                                if rel_cand not in selected.focal_source_files:
                                    selected.focal_source_files.append(rel_cand)
                                if rel_cand not in files_to_load:
                                    files_to_load[rel_cand] = []
                        except ValueError:
                            pass

        # 5. Load file contents while enforcing budget
        loaded_count = 0
        current_chars = len(traceback_str)

        # Order: source files first (primary repair targets), then test file
        ordered_files = list(selected.focal_source_files)
        if selected.focal_test_file and selected.focal_test_file not in ordered_files:
            ordered_files.append(selected.focal_test_file)

        # Add any other references
        for f in files_to_load:
            if f not in ordered_files:
                ordered_files.append(f)

        for rel_file in ordered_files:
            if loaded_count >= self.budget.max_context_files:
                break

            focal_lines = files_to_load.get(rel_file, [])
            fc = load_file_context(
                workspace_root=workspace_root,
                rel_path=rel_file,
                max_file_size=self.budget.max_file_size,
                focal_lines=focal_lines,
            )
            if fc is not None:
                if current_chars + len(fc.content) > self.budget.max_context_chars:
                    # Budget reached
                    break
                selected.file_contexts[rel_file] = fc
                current_chars += len(fc.content)
                loaded_count += 1

        selected.total_characters = current_chars
        return selected
