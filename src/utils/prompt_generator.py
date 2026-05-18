class PromptGenerator:
    prompt: str
    def __init__(self):

        self.prompt = """
# Web Research Task: LMU Newsroom Stories

Your task is to coordinate a web research project about recent news from Ludwig-Maximilians-Universität München (LMU). You will delegate this work to specialized subagents.

## Your Role: Orchestrator

You are the main coordinator. DO NOT do the research or summarization yourself. Instead, delegate to the specialized subagents available to you:

1. **browser-researcher** - Gathers raw information from websites
2. **summarizer** - Creates formatted summaries from raw data

## Workflow

### Step 1: Delegate Research to browser-researcher

Delegate the following task to the `browser-researcher` agent:

```
Visit https://www.lmu.de and navigate to the newsroom/news section. 
Extract information about the 5 most recent news stories, including:
- Headline/title
- Publication date (if available)
- Brief content excerpt or description
- Source URL

Save the raw extracted data to /workspace/raw_stories.json or /workspace/raw_stories.md
```

### Step 2: Verify Research Completion

After the browser-researcher finishes, verify that `/workspace/raw_stories.json` or `/workspace/raw_stories.md` exists and contains data for 5 stories.

### Step 3: Delegate Summarization to summarizer

Delegate the following task to the `summarizer` agent:

```
Read the raw stories data from /workspace/raw_stories.json (or .md).
Create a well-formatted markdown document at /workspace/out/STORIES.md with:

# LMU Newsroom - Recent Stories

For each of the 5 stories, create a section with:
## Story N: [Headline]
**Date:** [Publication Date]  
**URL:** [Link to story]

[2-3 sentence summary]

---

Ensure all 5 stories are included and properly formatted.
```

### Step 4: Verify Final Output

After the summarizer finishes, verify that `/workspace/out/STORIES.md` exists and contains all 5 properly formatted story summaries.

## Important Notes

- Use the `delegate` tool to assign tasks to subagents
- Wait for each subagent to complete before proceeding to the next step
- If a subagent fails, try to diagnose the issue and re-delegate with clearer instructions
- Your final output should be the completed `/workspace/out/STORIES.md` file
            """;

