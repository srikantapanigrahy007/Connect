/**
 * A lifecycle described as "which states may follow which". Anything not listed is not allowed.
 *
 * @typedef {object} StateMachine
 * @property {string} name Human-readable name used in error messages, e.g. "account status".
 * @property {string[]} states Every state.
 * @property {string[]} initial States a record may be created in.
 * @property {Record<string, string[]>} transitions Allowed next states for each state
 *   (terminal states map to an empty list).
 * @property {(from: string, to: string) => boolean} canTransition
 * @property {(to: string) => string[]} sourcesFor Every state from which `to` can be reached in one step.
 * @property {(state: string) => boolean} isTerminal
 * @property {(value: unknown) => boolean} isState
 */

/**
 * Creates a state machine from a transition table.
 *
 * @example
 * const machine = defineStateMachine({
 *   name: 'poll status',
 *   initial: ['open'],
 *   transitions: { open: ['closed'], closed: [] },
 * });
 * machine.canTransition('open', 'closed'); // true
 *
 * @param {{ name: string, initial: string[], transitions: Record<string, string[]> }} definition
 * @returns {StateMachine}
 */
export function defineStateMachine(definition) {
  const states = Object.keys(definition.transitions);
  return {
    name: definition.name,
    states,
    initial: definition.initial,
    transitions: definition.transitions,
    canTransition: (from, to) => definition.transitions[from].includes(to),
    sourcesFor: (to) => states.filter((from) => definition.transitions[from].includes(to)),
    isTerminal: (state) => definition.transitions[state].length === 0,
    isState: (value) => typeof value === 'string' && states.includes(value),
  };
}
