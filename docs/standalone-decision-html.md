# Standalone HTML for complex choices

When a comparison, chart, or editable assumptions would help the user decide, GPT may create one self-contained HTML file and give it to the user as an ordinary artifact. The file is independent of Codex MCP Bridge for ChatGPT. Simple choices stay in the ChatGPT conversation.

The file should distinguish confirmed facts, assumptions, and open questions; show alternatives and meaningful units; work at a full-window and printable size; and produce a copyable plain-text or Markdown summary of the user's selection, conditions, and unresolved concerns. It may use inline CSS, SVG, and JavaScript for local calculation and interaction. Keep all assets embedded and do not make network requests or load third-party scripts. Do not put credentials, private Bridge state, or unrelated sensitive data in the file.

The user reviews the file and explicitly sends the chosen summary back to the current ChatGPT conversation. Copying is a manual user action: the file does not call MCP tools, send a message to ChatGPT, start a Codex Job, answer a Codex question, or grant an approval. If the host cannot create or open an HTML artifact, GPT can present the same comparison in the conversation and ask for the decision there.

For a live ordinary Codex question, GPT reads `codex_status` with `query.kind: "input"` again after the user deliberates. It may call `codex_answer` only when the exact `questionRef` is still current and the user explicitly wants that answer sent. Original Codex approvals remain in their existing authorization flow. A decision summary never changes project or execution policy.

The Bridge Decision Card tools and resource were retired in [#141](https://github.com/menaje/codex-mcp-bridge-for-chatgpt/issues/141). Refresh the ChatGPT connector after deploying this version. Previously opened cards may remain visible in a cached conversation, but their submit and result calls no longer work. Restate any needed choice in the conversation; do not treat an old card receipt as execution authority.
