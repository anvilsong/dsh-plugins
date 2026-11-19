# dsh-plugin-explainer

A per-session output style for DeepSeek Harness that picks the lowest clear explanation form.

## What it does

`/output-style explainer` adds a short style rule to the system prompt for the current session. While the rule is on, a request to explain something, or to understand, compare or walk through it, is answered in the lowest form that serves:

1. **Short prose** for a definition, a procedure or a warning of about three paragraphs or fewer. Sentences stay within 20 words for procedures and 25 for descriptions, in active voice, with one instruction per sentence and a numbered list for steps. These limits apply to this form only.
2. **Text diagram** when the point is structure, flow, state, dependencies or sequence. The diagram uses plain text or box-drawing characters in the chat. Mermaid and SVG source is never pasted into the chat.
3. **One-file HTML page** for a topic with more than about five interacting parts, or one the user would want to explore or compare. The agent offers it in one line, and builds it without asking only when the user asked for a page, a visual or an interactive explanation. The page is one self-contained file under `~/explainers/YYYY-MM-DD-<slug>/index.html`, never in the project repository. The agent opens the page with the system opener if one exists, gives its path, and confirms that the file exists. If it cannot write the file, it says so and explains in the chat.

A video is never made on the agent's own initiative. If the user asks for one, the agent states the cost and confirms first.

The style applies to explanations only, not to code edits, tool output, status reports, plans, reviews or final reports. The style never makes an answer longer and overrides the page rules; rules that require a section in a status report or final report still apply.

The full wording is the exported `POLICY` constant in [`src/index.host.js`](src/index.host.js); tests pin it exactly.

## Use

```text
/output-style explainer
/output-style on
/output-style off
/output-style status
```

`on` is an alias of `explainer`. A call with no argument behaves like `status`. Any other argument returns `Usage: /output-style explainer|off|status`. A repeated `explainer` or `off` succeeds and changes nothing. `status` reports `Output style: explainer.` or `Output style: off.`, or that an update is pending.

## Per-session behaviour

The setting is per session, and a new session starts off. It is derived from the session's `command/run` and `command/done` log entries: a successful `explainer`, `on` or `off` changes it, and a failed or rejected command leaves it unchanged. Resume recovers the same value from the log, without a settings file. While the style is off, the plugin adds no prompt text.

## What it does not do

- The plugin generates no files, runs no tools, and makes no model calls. The style only asks the agent to follow the rule; any page the agent writes is the agent's own work.
- It adds no tool and does not guard or change tool use.
- It does not make videos.
- It is the Host half only for now: there is no client file and no menu cell. Use the command.

## Install

```sh
dsh plugin --profile web add "$PWD/packages/explainer"
```

Run it from the repository root and replace `web` with your profile name when
needed (a wrong name creates a new profile). Restart the host after installing
and refresh the page. Then run `/output-style status`: it should answer
`Output style: off.`

## Limits

- The rule is guidance in the prompt. The agent can still ignore it, and nothing checks its answers.
- A command sent while another update is pending is rejected until the pending one finishes or expires after five minutes.
