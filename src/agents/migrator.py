import os
from pathlib import Path
from openhands.sdk import LLM, Agent, Tool
from openhands.sdk.context.condenser import LLMSummarizingCondenser
from openhands.sdk.subagent import load_agents_from_dir, register_agent_if_absent, agent_definition_to_factory
from openhands.tools.file_editor import FileEditorTool
from openhands.tools.terminal import TerminalTool
from openhands.tools.task import TaskToolSet
from openhands.tools.browser_use import BrowserToolSet


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
        return


    def get_agent(self, llm: LLM) -> Agent:
        # The condenser needs its own usage_id so the remote agent server's
        # LLMRegistry doesn't reject it as a duplicate of the main agent LLM.
        condenser_llm = llm.model_copy(update={"usage_id": "condenser"})

        return Agent(
            llm=llm,
            tools=[
                Tool(name=TerminalTool.name),
                Tool(name=FileEditorTool.name),
                Tool(name=TaskToolSet.name),
                Tool(name=BrowserToolSet.name),
            ],
            condenser=LLMSummarizingCondenser(llm=condenser_llm, max_size=50),
        )

