from openhands.sdk import LLM, Agent, Tool
from openhands.sdk.context.condenser import LLMSummarizingCondenser
from openhands.tools.file_editor import FileEditorTool
from openhands.tools.terminal import TerminalTool
from openhands.tools.delegate import DelegateTool


class MigratorAgent:
    """Main Migration agents that then spawns other agents to do the actual migration work"""

    def __init__(self):
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
                Tool(name=DelegateTool.name),
            ],
            condenser=LLMSummarizingCondenser(llm=condenser_llm, max_size=50),
        )

