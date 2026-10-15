import { describe, expect, it } from 'vitest';
import {
  accountStatusMachine,
  attachmentStatusMachine,
  groupInviteStatusMachine,
  membershipStateMachine,
  messageRequestStatusMachine,
  messageStatusMachine,
  pollStatusMachine,
  reportStatusMachine,
} from './enums.js';

const machines = [
  accountStatusMachine,
  membershipStateMachine,
  messageStatusMachine,
  messageRequestStatusMachine,
  groupInviteStatusMachine,
  pollStatusMachine,
  attachmentStatusMachine,
  reportStatusMachine,
];

describe.each(machines.map((machine) => [machine.name, machine]))(
  '%s machine',
  (_name, machine) => {
    it('only references declared states', () => {
      for (const targets of Object.values(machine.transitions)) {
        for (const target of targets) expect(machine.states).toContain(target);
      }
      for (const state of machine.initial) expect(machine.states).toContain(state);
    });

    it('has every state reachable from an initial state', () => {
      const reached = new Set(machine.initial);
      const queue = [...machine.initial];
      while (queue.length > 0) {
        const state = queue.shift();
        if (state === undefined) break;
        for (const next of machine.transitions[state] ?? []) {
          if (!reached.has(next)) {
            reached.add(next);
            queue.push(next);
          }
        }
      }
      expect([...reached].sort()).toEqual([...machine.states].sort());
    });
  },
);

describe('specific product rules', () => {
  it('never revives deleted accounts or messages', () => {
    expect(accountStatusMachine.isTerminal('deleted')).toBe(true);
    expect(messageStatusMachine.isTerminal('deleted')).toBe(true);
    expect(messageStatusMachine.isTerminal('removed')).toBe(true);
  });

  it('allows repeated edits but not editing deleted messages', () => {
    expect(messageStatusMachine.canTransition('edited', 'edited')).toBe(true);
    expect(messageStatusMachine.canTransition('deleted', 'edited')).toBe(false);
  });

  it('only resolves message requests from pending', () => {
    expect(messageRequestStatusMachine.sourcesFor('accepted')).toEqual(['pending']);
    expect(messageRequestStatusMachine.canTransition('rejected', 'accepted')).toBe(false);
    expect(messageRequestStatusMachine.canTransition('cancelled', 'pending')).toBe(false);
  });

  it('lets closed reports be reopened', () => {
    expect(reportStatusMachine.sourcesFor('open').sort()).toEqual([
      'dismissed',
      'resolved',
      'under_review',
    ]);
  });

  it('requires suspended accounts to be reactivated rather than deactivated', () => {
    expect(accountStatusMachine.canTransition('suspended', 'deactivated')).toBe(false);
  });
});
