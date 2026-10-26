"""
LangGraph workflow builder for FixForge.
Constructs the analysis pipeline (Milestone 2) and the full M4 repair pipeline:
INIT -> REPOSITORY_ANALYSIS -> BASELINE_TESTING -> FAILURE_DETECTION ->
ROOT_CAUSE_ANALYSIS -> PATCH_PLANNING -> PATCH_GENERATION -> PATCH_VALIDATION -> PATCH_APPLICATION -> END
"""

from langgraph.graph import END, StateGraph

from app.graph.nodes.analysis import (
    baseline_testing_node,
    failure_detection_node,
    init_node,
    repository_analysis_node,
)
from app.graph.nodes.patching import (
    patch_application_node,
    patch_generation_node,
    patch_planning_node,
    patch_validation_node,
)
from app.graph.nodes.root_cause import root_cause_analysis_node
from app.graph.state import AgentState


def build_analysis_graph():
    """Builds and compiles the Milestone 2 LangGraph analysis pipeline."""
    workflow = StateGraph(AgentState)

    workflow.add_node("INIT", init_node)
    workflow.add_node("REPOSITORY_ANALYSIS", repository_analysis_node)
    workflow.add_node("BASELINE_TESTING", baseline_testing_node)
    workflow.add_node("FAILURE_DETECTION", failure_detection_node)

    workflow.set_entry_point("INIT")
    workflow.add_edge("INIT", "REPOSITORY_ANALYSIS")
    workflow.add_edge("REPOSITORY_ANALYSIS", "BASELINE_TESTING")
    workflow.add_edge("BASELINE_TESTING", "FAILURE_DETECTION")
    workflow.add_edge("FAILURE_DETECTION", END)

    return workflow.compile()


def build_repair_graph(auto_apply: bool = False):
    """
    Builds and compiles the Milestone 4 LangGraph repair pipeline:
    INIT -> REPOSITORY_ANALYSIS -> BASELINE_TESTING -> FAILURE_DETECTION ->
    ROOT_CAUSE_ANALYSIS -> PATCH_PLANNING -> PATCH_GENERATION -> PATCH_VALIDATION [-> PATCH_APPLICATION] -> END
    """
    workflow = StateGraph(AgentState)

    workflow.add_node("INIT", init_node)
    workflow.add_node("REPOSITORY_ANALYSIS", repository_analysis_node)
    workflow.add_node("BASELINE_TESTING", baseline_testing_node)
    workflow.add_node("FAILURE_DETECTION", failure_detection_node)
    workflow.add_node("ROOT_CAUSE_ANALYSIS", root_cause_analysis_node)
    workflow.add_node("PATCH_PLANNING", patch_planning_node)
    workflow.add_node("PATCH_GENERATION", patch_generation_node)
    workflow.add_node("PATCH_VALIDATION", patch_validation_node)

    if auto_apply:
        workflow.add_node("PATCH_APPLICATION", patch_application_node)

    workflow.set_entry_point("INIT")
    workflow.add_edge("INIT", "REPOSITORY_ANALYSIS")
    workflow.add_edge("REPOSITORY_ANALYSIS", "BASELINE_TESTING")
    workflow.add_edge("BASELINE_TESTING", "FAILURE_DETECTION")
    workflow.add_edge("FAILURE_DETECTION", "ROOT_CAUSE_ANALYSIS")
    workflow.add_edge("ROOT_CAUSE_ANALYSIS", "PATCH_PLANNING")
    workflow.add_edge("PATCH_PLANNING", "PATCH_GENERATION")
    workflow.add_edge("PATCH_GENERATION", "PATCH_VALIDATION")

    if auto_apply:
        workflow.add_edge("PATCH_VALIDATION", "PATCH_APPLICATION")
        workflow.add_edge("PATCH_APPLICATION", END)
    else:
        workflow.add_edge("PATCH_VALIDATION", END)

    return workflow.compile()


from app.graph.nodes.verification import (
    check_retry_condition,
    failed_node,
    human_review_node,
    rollback_node,
    should_verify_or_rollback,
    verification_analysis_node,
    verification_testing_node,
    verified_node,
)


def _check_baseline_failures(state: AgentState) -> str:
    baseline = state.get("baseline_result", {})
    total = baseline.get("total", 0)
    skipped = baseline.get("skipped", 0)
    passed = baseline.get("passed", 0)
    failed = baseline.get("failed", 0)
    errors = baseline.get("errors", 0)
    exit_code = baseline.get("exit_code", 1)

    executed = total - skipped
    if (
        exit_code == 0
        and total > 0
        and executed > 0
        and passed > 0
        and failed == 0
        and errors == 0
    ):
        return "verified"
    return "root_cause"


def _check_root_cause_outcome(state: AgentState) -> str:
    if state.get("abstention", False):
        return "human_review"
    return "patch_planning"


def _check_patch_validation(state: AgentState) -> str:
    val = state.get("patch_validation", {})
    if val.get("status") == "REQUIRES_REVIEW":
        return "human_review"
    if state.get("abstention", False):
        return "human_review"
    if state.get("route_to_human_review_on_no_candidates", False) and not state.get("selected_candidate"):
        return "human_review"
    if not val.get("valid", False):
        return "rollback"
    return "apply"



def build_self_correction_graph():
    """
    Builds and compiles the Milestone 5 Self-Correction Loop with conditional edges:
    INIT -> REPOSITORY_ANALYSIS -> BASELINE_TESTING -> FAILURE_DETECTION
    -> ROOT_CAUSE_ANALYSIS -> PATCH_PLANNING -> PATCH_GENERATION -> PATCH_VALIDATION
    -> PATCH_APPLICATION -> VERIFICATION_TESTING -> VERIFICATION_ANALYSIS
    -> (Condition: PASSED? -> VERIFIED -> END; FAILED? -> ROLLBACK -> RETRY? -> ROOT_CAUSE_ANALYSIS or FAILED -> END)
    """
    workflow = StateGraph(AgentState)

    workflow.add_node("INIT", init_node)
    workflow.add_node("REPOSITORY_ANALYSIS", repository_analysis_node)
    workflow.add_node("BASELINE_TESTING", baseline_testing_node)
    workflow.add_node("FAILURE_DETECTION", failure_detection_node)
    workflow.add_node("ROOT_CAUSE_ANALYSIS", root_cause_analysis_node)
    workflow.add_node("PATCH_PLANNING", patch_planning_node)
    workflow.add_node("PATCH_GENERATION", patch_generation_node)
    workflow.add_node("PATCH_VALIDATION", patch_validation_node)
    workflow.add_node("PATCH_APPLICATION", patch_application_node)
    workflow.add_node("VERIFICATION_TESTING", verification_testing_node)
    workflow.add_node("VERIFICATION_ANALYSIS", verification_analysis_node)
    workflow.add_node("ROLLBACK", rollback_node)
    workflow.add_node("VERIFIED", verified_node)
    workflow.add_node("FAILED", failed_node)
    workflow.add_node("HUMAN_REVIEW", human_review_node)

    workflow.set_entry_point("INIT")
    workflow.add_edge("INIT", "REPOSITORY_ANALYSIS")
    workflow.add_edge("REPOSITORY_ANALYSIS", "BASELINE_TESTING")
    workflow.add_edge("BASELINE_TESTING", "FAILURE_DETECTION")

    # If baseline tests passed with 0 failures, skip repair and mark verified
    workflow.add_conditional_edges(
        "FAILURE_DETECTION",
        _check_baseline_failures,
        {
            "verified": "VERIFIED",
            "root_cause": "ROOT_CAUSE_ANALYSIS",
        },
    )

    # If diagnosis recommends abstention due to insufficient evidence, route to HUMAN_REVIEW
    workflow.add_conditional_edges(
        "ROOT_CAUSE_ANALYSIS",
        _check_root_cause_outcome,
        {
            "human_review": "HUMAN_REVIEW",
            "patch_planning": "PATCH_PLANNING",
        },
    )
    workflow.add_edge("PATCH_PLANNING", "PATCH_GENERATION")
    workflow.add_edge("PATCH_GENERATION", "PATCH_VALIDATION")

    # If patch requires review, halt autonomous loop
    workflow.add_conditional_edges(
        "PATCH_VALIDATION",
        _check_patch_validation,
        {
            "human_review": "HUMAN_REVIEW",
            "rollback": "ROLLBACK",
            "apply": "PATCH_APPLICATION",
        },
    )

    workflow.add_edge("PATCH_APPLICATION", "VERIFICATION_TESTING")
    workflow.add_edge("VERIFICATION_TESTING", "VERIFICATION_ANALYSIS")

    # Verification outcome condition: pass or rollback
    workflow.add_conditional_edges(
        "VERIFICATION_ANALYSIS",
        should_verify_or_rollback,
        {
            "verified": "VERIFIED",
            "rollback": "ROLLBACK",
        },
    )

    # Rollback condition: retry loop or failed
    workflow.add_conditional_edges(
        "ROLLBACK",
        check_retry_condition,
        {
            "failed": "FAILED",
            "retry": "ROOT_CAUSE_ANALYSIS",
        },
    )

    workflow.add_edge("VERIFIED", END)
    workflow.add_edge("FAILED", END)
    workflow.add_edge("HUMAN_REVIEW", END)

    return workflow.compile()

