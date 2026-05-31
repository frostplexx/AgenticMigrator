from pathlib import Path
from openhands.sdk import LLM, Agent, AgentContext, Tool
from openhands.sdk.context.condenser import LLMSummarizingCondenser
from openhands.sdk.skills import load_skills_from_dir
from openhands.sdk.subagent import load_agents_from_dir, register_agent_if_absent, agent_definition_to_factory
from openhands.tools.file_editor import FileEditorTool
from openhands.tools.terminal import TerminalTool
from openhands.tools.task import TaskToolSet

from ..utils.migration_reference import MIGRATION_REFERENCE

# Skills are stored in src/skills and assembled into the container workspace at runtime.
# We also load them locally here to attach to the agent's context (project skills are not
# auto-loaded into a remote conversation).
_SKILLS_DIR = Path(__file__).parent.parent / "skills"

# Subagents that reason about the migration and therefore need the migration reference
# appended to their system prompt (the tester only runs the verify skill).
_MIGRATION_SUBAGENTS = {"extension-transformer"}


class MigratorAgent:
    """Main Migration agents that then spawns other agents to do the actual migration work"""

    def __init__(self):
        # Register subagents from the subagents directory
        subagents_dir = Path(__file__).parent / "subagents"
        if subagents_dir.exists():
            agent_defs = load_agents_from_dir(subagents_dir)
            for agent_def in agent_defs:
                # Inject the single-source migration reference into the migration
                # subagents' system prompt so the knowledge is not duplicated in the
                # subagent .md files.
                if agent_def.name in _MIGRATION_SUBAGENTS:
                    agent_def = agent_def.model_copy(
                        update={
                            "system_prompt": (
                                f"{agent_def.system_prompt}\n\n{MIGRATION_REFERENCE}"
                            )
                        }
                    )
                factory = agent_definition_to_factory(agent_def)
                register_agent_if_absent(
                    name=agent_def.name,
                    factory_func=factory,
                    description=agent_def,
                )
        return


    def _load_skills(self):
        """Load the bundled verify skill so it is surfaced to the agent."""
        if not _SKILLS_DIR.exists():
            return []
        repo_skills, knowledge_skills, agent_skills = load_skills_from_dir(_SKILLS_DIR)
        return [
            *repo_skills.values(),
            *knowledge_skills.values(),
            *agent_skills.values(),
        ]


    def get_agent(self, llm: LLM) -> Agent:
        # The condenser needs its own usage_id so the remote agent server's
        # LLMRegistry doesn't reject it as a duplicate of the main agent LLM.
        condenser_llm = llm.model_copy(update={"usage_id": "condenser"})

        # No browser tool: the agent must not drive a browser directly. Testing is done
        # exclusively through the `verify` skill (run via the terminal).
        #
        # The MV2->MV3 migration reference is attached to the system prompt
        # (system_message_suffix) so the orchestrator and its subagents always carry the
        # domain knowledge, independent of the per-run task instructions.
        return Agent(
            llm=llm,
            tools=[
                Tool(name=TerminalTool.name),
                Tool(name=FileEditorTool.name),
                Tool(name=TaskToolSet.name),
            ],
            agent_context=AgentContext(
                skills=self._load_skills(),
                system_message_suffix=MIGRATION_REFERENCE,
            ),
            condenser=LLMSummarizingCondenser(llm=condenser_llm, max_size=50),
        )

