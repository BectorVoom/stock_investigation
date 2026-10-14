/**
 * The two states of an open conversation (ADR-0020). There is no third:
 * `chat` is Chat-first (the conversation dominates, the Notebook is a
 * narrow secondary panel), `notebook` is Notebook-first (the Notebook
 * dominates, Chat is the narrow assistant panel).
 */
export type WorkspaceMode = "chat" | "notebook";
