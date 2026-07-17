---
name: prd-creator
description: Guides creation of comprehensive Product Requirement Documents (PRDs) through structured questioning and validation, then stores the PRD in the project SQLite issue store and generates implementation task lists in JSON format.
license: MIT
metadata:
  author: pageai
  version: '1.0.1'
  tags: prd, product requirements, software development, documentation, task generation
  website: https://pageai.pro/blog/long-running-ai-coding-agents-ralph-loop#step-2-write-your-requirements
---

# PRD Creation Assistant

Transform software ideas into a comprehensive PRD record and actionable implementation tasks through a two-part process.

## Overview

This skill helps beginner-level developers.

1. Receive an implementation description from the user
2. Create a detailed PRD in the project SQLite issue store through structured questioning
3. Verify implementation prerequisites, including access, MCPs, docs, env variables, and test users
4. Generate implementation task lists in JSON format for developers
5. Keep the overall project description in the parent PRD issue body; do not create a separate Markdown artifact

### Part 1: Implementation Description

You will receive a lacking implementation description from the user. The main goal is to comprehend the intent and think about the larger architecture and a robust way to implement it, filling in the gaps.

### Part 2: PRD Creation

**Storage**: Create or update a parent SQLite issue with a title ending in `(PRD)`, `status=backlog`, and the full PRD in its `body`. Use the installed `scripts/issue-store.js` `create`/`get` CLI with JSON on stdin. Do not create `.agent/prd/PRD.md`, `SUMMARY.md`, or any other project Markdown output.

You will need to ask clarifying questions to get a clear understanding of the implementation.

**When to use**: User wants to document a software idea or create feature specifications.

**What it does**:
- Guides structured questioning to gather all requirements
- Verifies project prerequisites and creates/updates `.env.local` placeholders only
- Presents an executive summary inside the PRD issue body for user approval
- Researches competitive landscape
- Generates a comprehensive PRD issue body with app overview, audience, success metrics, competitive analysis, features, flows, technical recommendations, prerequisites, security, assumptions, and dependencies

**Process**:
1. Ask clarifying questions using `AskUserQuestion` tool
2. Verify prerequisites and create/update `.env.local` placeholders
3. Present the executive summary from the draft PRD body for user approval
4. Research competition via WebSearch
5. Publish the complete PRD as the parent SQLite issue
6. Iterate by retrieving the parent issue with `get` and updating its body through the SQLite CLI

Read [PRD.md](PRD.md) for complete content and questioning instructions. That file is a skill-internal instruction resource, not a project PRD output.

---

### Part 3: Implementation Task Generation

**Instructions**: [JSON.md](JSON.md)

After the PRD issue is complete and approved, analyze it and generate a comprehensive task list in JSON format.

**What it does**:
- Analyzes the completed PRD issue
- Generates `TASK-1` as mandatory prerequisite verification
- Generates a complete list of implementation tasks in JSON format
- Keeps tasks small and manageable
- Categorizes tasks by type
- Defines verification (`pass`) steps for each task

**IMPORTANT**:
- Each task should be simple enough to be completed in maximum 10 minutes.
- If a task is too complex, split it into smaller tasks.

Read [JSON.md](JSON.md) for complete instructions.

## Quick Start

**If the user wants to create a PRD:**
1. Read [PRD.md](PRD.md)
2. Follow the PRD creation workflow
3. Verify prerequisites and create/update `.env.local` with placeholder values only
4. Present the executive summary from the draft
5. After approval, publish the parent `(PRD)` issue with the SQLite CLI

**If the user wants implementation tasks for an existing PRD:**
1. Read [JSON.md](JSON.md)
2. Fetch the parent PRD issue with the SQLite `get` or `search` CLI
3. Generate the comprehensive task list, starting with `TASK-1`
4. Save only the requested JSON task artifacts

**If the user wants both:**
1. Complete and publish the PRD issue first
2. Get user approval on the PRD
3. Proceed to generate implementation tasks

**If the user wants to update the PRD:**
1. Read [PRD.md](PRD.md)
2. Fetch the parent `(PRD)` issue with `get`
3. Update the complete body and publish it through the SQLite CLI
4. Ask whether they want implementation tasks regenerated

**If the user wants to update implementation tasks:**
1. Read [JSON.md](JSON.md)
2. Update the JSON task artifacts
3. Ask whether they want to update the PRD issue again

## After completion

Ensure the parent `(PRD)` issue exists in `docs/issues.sqlite` and has the complete PRD body. The optional implementation task index may be saved as `.agent/tasks.json`; no PRD or summary Markdown files are required.

## Important Constraints

- Do not generate code — focus on documentation and task specification
- Use `AskUserQuestion` extensively in Part 1 to clarify requirements
- Never write real secret values to the PRD issue, tasks, chat, logs, or `.env.local`; use placeholder values and tell the user to fill real values manually
- In Part 2, generate comprehensive task lists
- In Part 2, always generate `TASK-1` as prerequisite verification before feature work
- Use available tools: AskUserQuestion, WebSearch, Sequential Thinking, Read
