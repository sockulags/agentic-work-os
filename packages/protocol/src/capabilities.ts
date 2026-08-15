/**
 * What each agent's protocol can actually do.
 *
 * These live in the protocol package rather than in the adapters because the UI has to
 * branch on them too. The alternative — hardcoding `if (agent === 'claude')` in a React
 * component — puts knowledge of a wire protocol in the view layer, where it rots quietly
 * the moment a CLI gains a feature.
 *
 * The rule from ARCHITECTURE.md §3 applies here: an adapter never synthesizes an event
 * for a capability the agent lacks. A capability set is how the UI knows to explain the
 * absence rather than show an empty panel.
 */
export interface AgentCapabilities {
  /** Emits incremental stdout/stderr while a command runs. */
  streamingToolOutput: boolean;
  /** Emits token-level deltas for assistant text. */
  streamingText: boolean;
  /** Exposes model reasoning/thinking. */
  reasoning: boolean;
  /** Can surface a structured plan or todo list. */
  plans: boolean;
  /**
   * Reports a cumulative unified diff for the whole turn.
   *
   * Codex does, via `turn/diff/updated`. Claude does not: its file edits arrive as
   * individual tool results with no patch, so a turn-level diff would have to be
   * reconstructed from outside the protocol.
   */
  turnDiff: boolean;
  /** Can gate tool calls through the harness. */
  approvals: boolean;
  /** Can resume a prior native session by id. */
  resumableSessions: boolean;
}
