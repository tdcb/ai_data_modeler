"""AI Companion chat: provider-agnostic conversational modeling over metadata, with reviewable mutations."""

from __future__ import annotations

from typing import Any, Dict, List, Optional

from ..agent.gemini_service import SYSTEM_INSTRUCTION
from ..agent.llm_service import AgentExecutionResponse, execute_agent_prompt
from ..agent.mutation_engine import execute_mutations
from ..metamodel.schema import ProjectMetamodel
from .privacy import catalog_text
from .providers import LLMError, Provider


def chat(
    model: ProjectMetamodel,
    prompt: str,
    provider: Provider,
    history: Optional[List[Dict[str, str]]] = None,
    context_text: str = "",
    allow_mutations: bool = True,
    auto_apply: bool = True,
) -> Dict[str, Any]:
    """Returns {reply, mutations, actions_taken, updated_model, mode_used, mutated}."""
    if provider.is_offline:
        res: AgentExecutionResponse = execute_agent_prompt(
            model.model_copy(deep=True), prompt, mode="builtin-llm", allow_mutations=allow_mutations
        )
        return {**res.model_dump(), "mutations": [], "warnings": []}
    hist = "\n".join(f"{m.get('role', 'user').upper()}: {m.get('content', '')[:2000]}" for m in (history or [])[-8:])
    body = (
        f"CURRENT MODEL (metadata only, no row data):\n{catalog_text(model)}\n\n"
        + (f"PROJECT CONTEXT DOCUMENTS:\n{context_text[:30000]}\n\n" if context_text else "")
        + (f"CONVERSATION SO FAR:\n{hist}\n\n" if hist else "")
        + f"USER REQUEST:\n{prompt}"
    )
    warnings: List[str] = []
    try:
        out = provider.complete_json(body, SYSTEM_INSTRUCTION)
    except LLMError as e:
        res = execute_agent_prompt(
            model.model_copy(deep=True), prompt, mode="builtin-llm", allow_mutations=allow_mutations
        )
        return {
            **res.model_dump(),
            "mutations": [],
            "warnings": [f"{provider.label} failed ({e}); answered with the built-in architect."],
        }
    if not isinstance(out, dict):
        out = {"reply": str(out), "mutations": []}
    mutations = [m for m in (out.get("mutations") or []) if isinstance(m, dict) and m.get("action")]
    updated = model.model_copy(deep=True)
    actions: List[str] = []
    if mutations and not allow_mutations:
        warnings.append("Your role is read-only, so proposed changes were not applied.")
    elif mutations and auto_apply:
        updated, actions = execute_mutations(updated, mutations)
    return {
        "mode_used": provider.label,
        "reply": out.get("reply", ""),
        "mutations": mutations,
        "actions_taken": actions,
        "mutated": bool(actions),
        "updated_model": updated.model_dump(),
        "warnings": warnings,
        "cli_trace": None,
    }
