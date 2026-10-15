export class StateTransitionError extends Error {
  constructor(message) {
    super(message);
    this.name = 'StateTransitionError';
  }
}

const ORIGINAL_STATE = 'stateMachineOriginal';
const FORBIDDEN_OPERATORS = [
  '$unset',
  '$rename',
  '$inc',
  '$push',
  '$addToSet',
  '$pull',
  '$min',
  '$max',
];

function sourcesFromFilter(value) {
  if (typeof value === 'string') return [value];
  if (value && typeof value === 'object') {
    const filter = value;
    if (typeof filter.$eq === 'string') return [filter.$eq];
    if (Array.isArray(filter.$in) && filter.$in.every((item) => typeof item === 'string')) {
      return filter.$in;
    }
  }
  return null;
}

/**
 * Enforces a state machine on `path`:
 * - new documents must start in an initial state;
 * - `save()` may only perform an allowed transition;
 * - update queries that set the state must constrain the current state in their filter to
 *   states that may transition to the target (e.g. `{ status: { $in: machine.sourcesFor(to) } }`),
 *   which makes every transition an atomic compare-and-set.
 */
export function stateMachinePlugin(schema, { path, machine }) {
  schema.post('init', function (doc) {
    const state = doc.get(path);
    doc.$locals[ORIGINAL_STATE] = state;
  });

  schema.pre('validate', function () {
    const next = this.get(path);
    if (this.isNew) {
      if (!machine.initial.includes(next)) {
        throw new StateTransitionError(`A new record cannot start in ${machine.name} "${next}"`);
      }
      return;
    }
    if (!this.isModified(path)) return;
    const previous = this.$locals[ORIGINAL_STATE];
    if (typeof previous !== 'string' || !machine.canTransition(previous, next)) {
      throw new StateTransitionError(
        `Invalid ${machine.name} transition from "${String(previous)}" to "${next}"`,
      );
    }
  });

  schema.post('save', function (doc) {
    const state = doc.get(path);
    doc.$locals[ORIGINAL_STATE] = state;
  });

  function guardUpdate() {
    const update = this.getUpdate();
    if (!update) return;
    if (Array.isArray(update)) {
      throw new StateTransitionError(`Pipeline updates are not allowed for ${machine.name}`);
    }
    const operations = update;
    for (const operator of FORBIDDEN_OPERATORS) {
      if (operations[operator] && path in operations[operator]) {
        throw new StateTransitionError(`${operator} cannot change ${machine.name}`);
      }
    }
    const inserted = operations.$setOnInsert?.[path];
    if (inserted !== undefined && !machine.initial.includes(inserted)) {
      throw new StateTransitionError(
        `An upsert cannot start in ${machine.name} ${JSON.stringify(inserted)}`,
      );
    }

    const target = operations.$set?.[path] ?? update[path];
    if (target === undefined) return;
    if (!machine.isState(target)) {
      throw new StateTransitionError(`${JSON.stringify(target)} is not a valid ${machine.name}`);
    }
    const sources = sourcesFromFilter(this.getFilter()[path]);
    if (!sources || sources.length === 0) {
      throw new StateTransitionError(
        `Updates to ${machine.name} must filter on the current state (use machine.sourcesFor())`,
      );
    }
    const invalid = sources.filter((source) => !machine.canTransition(source, target));
    if (invalid.length > 0) {
      throw new StateTransitionError(
        `Invalid ${machine.name} transition from "${invalid.join('", "')}" to "${target}"`,
      );
    }
  }

  schema.pre(['updateOne', 'updateMany', 'findOneAndUpdate'], guardUpdate);
  schema.pre(['replaceOne', 'findOneAndReplace'], function () {
    throw new StateTransitionError(`Replacing documents bypasses ${machine.name} rules`);
  });
}
