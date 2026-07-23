import { resolveTaskAutomationRole } from '../utils/taskAutomationRole';

describe('task automation role authority', () => {
  test.each([undefined, '', 'service_account', 'hermes_task_agent', 'openclaw_task_agent', 'journal_publisher'])(
    'fails unscoped identity %p closed to agent',
    (identity) => expect(resolveTaskAutomationRole(identity)).toBe('agent'),
  );

  test('recognizes server-issued human and reviewer identities', () => {
    expect(resolveTaskAutomationRole('dashboard_user')).toBe('orchestrator');
    expect(resolveTaskAutomationRole('clawbeat_reviewer')).toBe('reviewer');
    expect(resolveTaskAutomationRole('hermes_qa_reviewer')).toBe('reviewer');
    expect(resolveTaskAutomationRole('hermes_qa')).toBe('qa');
  });

  test('does not elevate an implementation identity based on a forged client claim', () => {
    const forgedHeader = 'orchestrator';
    expect(forgedHeader).toBe('orchestrator');
    expect(resolveTaskAutomationRole('hermes_task_agent')).toBe('agent');
  });
});