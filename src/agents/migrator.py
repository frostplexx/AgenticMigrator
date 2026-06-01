from pathlib import Path
from openhands.sdk import LLM, Agent, AgentContext, Tool
from openhands.sdk.context.condenser import LLMSummarizingCondenser
from openhands.sdk.skills import load_skills_from_dir
from openhands.sdk.subagent import load_agents_from_dir, register_agent_if_absent, agent_definition_to_factory
from openhands.tools.file_editor import FileEditorTool
from openhands.tools.terminal import TerminalTool
from openhands.tools.task import TaskToolSet

# Skills are stored in src/skills and assembled into the container workspace at runtime.
# We also load them locally here to attach to the agent's context (project skills are not
# auto-loaded into a remote conversation). The MV2->MV3 migration knowledge lives in the
# `mv3-migration` skill — it is no longer baked into the system prompt.
_SKILLS_DIR = Path(__file__).parent.parent / "skills"


class MigratorAgent:
    """Main Migration agents that then spawns other agents to do the actual migration work"""

    def __init__(self):
        # Register subagents from the subagents directory
        subagents_dir = Path(__file__).parent / "subagents"
        if subagents_dir.exists():
            agent_defs = load_agents_from_dir(subagents_dir)
            for agent_def in agent_defs:
                factory = agent_definition_to_factory(agent_def)
                register_agent_if_absent(
                    name=agent_def.name,
                    factory_func=factory,
                    description=agent_def,
                )


    def _load_skills(self):
        """Load the bundled skills (verify, mv3-migration) so they are surfaced to the agent."""
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
        # exclusively through the `verify` skill (run via the terminal). The MV2->MV3
        # migration knowledge is the `mv3-migration` skill (surfaced via skills below),
        # not the system prompt.
        return Agent(
            llm=llm,
            tools=[
                Tool(name=TerminalTool.name),
                Tool(name=FileEditorTool.name),
                Tool(name=TaskToolSet.name),
            ],
            agent_context=AgentContext(skills=self._load_skills()),
            # Condense history sooner to keep each request within the model's context
            # window: summarize once history exceeds ~20 events, always keeping the first
            # 2 (the task definition).
            condenser=LLMSummarizingCondenser(
                llm=condenser_llm, max_size=20, keep_first=2
            ),
        )

