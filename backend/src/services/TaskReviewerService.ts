import { randomUUID } from 'crypto';
import { promisify } from 'util';
import { execFile } from 'child_process';
import {
  type ReviewFinding,
  type ReviewHistoryEntry,
  type ReviewWorkspaceEvidence,
  type Task,
  type TaskStatus,
  taskManagerDB,
} from './TaskManagerDB';
import { reportManager, type ReviewerReportSummary } from './ReportManager';
import { notificationManager } from './NotificationManager';
import { taskNotificationService } from './TaskNotificationService';
import { discordThreadService } from './DiscordThreadService';
import { projectService } from './ProjectService';
import { resolveWritableRuntimePath } from './HermesRuntime';
import {
  taskReviewAttemptService,
  type ReviewAttemptIdentity,
  type TaskReviewAttemptService,
} from './TaskReviewAttemptService';

const execFileAsync = promisify(execFile);
const DEFAULT_MAX_RETRIES = 3;
const REVIEW_HISTORY_LIMIT = 20;
const TEST_SIGNAL_PATTERN = /(pytest|jest|vitest|npm test|pnpm test|bun test|cargo test|go test|passed|failing|build succeeded|lint passed)/i;

export interface ReviewerDependencies {
  getTask(taskId: string): Promise<Task | undefined>;
  updateTask(taskId: string, updates: Partial<Task>): Promise<Task>;
  getReportsForTask(taskId: string): Promise<ReviewerReportSummary[]>;
  collectWorkspaceEvidence(task: Task): Promise<ReviewWorkspaceEvidence | undefined>;
  notifyEscalation(task: Task, summary: string): Promise<void>;
}

export interface ReviewOutcome {
  decision: 'pass' | 'reject' | 'escalate';
  summary: string;
  findings: ReviewFinding[];
  evidence: ReviewHistoryEntry['evidence'];
  applied: {
    status: TaskStatus;
    attemptCount: number;
    maxRetries: number;
    reviewHistoryLength: number;
    mutated: boolean;
  };
  historyEntry: ReviewHistoryEntry;
}

interface RunReviewOptions {
  dryRun?: boolean;
  triggeredBy?: 'user' | 'agent' | 'system';
}

function normalizeTextList(value: string | string[] | undefined | null): string[] {
  if (Array.isArray(value)) {
    return value.map((item) => String(item).trim()).filter(Boolean);
  }
  if (typeof value !== 'string') {
    return [];
  }
  return value
    .split(/\n|;/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function truncate(text: string, max = 200): string {
  const compact = text.replace(/\s+/g, ' ').trim();
  if (compact.length <= max) return compact;
  return `${compact.slice(0, max - 3)}...`;
}

export class TaskReviewerService {
  private readonly attemptService?: TaskReviewAttemptService;

  constructor(
    private readonly deps: ReviewerDependencies = defaultDependencies,
    attemptService?: TaskReviewAttemptService,
  ) {
    this.attemptService = attemptService || (deps === defaultDependencies ? taskReviewAttemptService : undefined);
  }

  async runReview(taskId: string, options: RunReviewOptions = {}): Promise<ReviewOutcome> {
    const task = await this.requireTask(taskId);
    const triggeredBy = options.triggeredBy || 'user';
    const maxRetries = task.maxRetries ?? DEFAULT_MAX_RETRIES;
    const successCriteria = normalizeTextList(task.successCriteria ?? task.definitionOfDone);
    const reports = await this.deps.getReportsForTask(task.id);
    const workspace = await this.deps.collectWorkspaceEvidence(task);
    const testSignals = this.extractTestSignals(task, reports, workspace);
    const evidence: ReviewHistoryEntry['evidence'] = {
      successCriteria,
      reports: reports.map((report) => ({ id: report.id, title: report.title, summary: report.summary })),
      sessionRefs: task.sessionRefs || [],
      completedBy: task.completedBy
        ? {
            name: task.completedBy.name,
            sessionKey: task.completedBy.sessionKey,
            harness: task.completedBy.harness,
          }
        : null,
      workspace,
      testSignals,
    };

    let attempt: ReviewAttemptIdentity | undefined;
    if (!options.dryRun && this.attemptService) {
      attempt = await this.attemptService.beginAttempt(task, evidence);
    }

    const findings: ReviewFinding[] = [];
    if (task.status !== 'review') {
      findings.push({
        severity: 'error',
        message: `Task is not currently in review (status=${task.status}).`,
        evidence: [task.status],
      });
    }

    const subtasks = task.subtasks || [];
    const firstReviewIndex = subtasks.findIndex((subtask) => subtask.status === 'review');
    const invalidPrefix = firstReviewIndex < 0
      ? subtasks
      : subtasks.slice(0, firstReviewIndex).filter((subtask) => !['completed', 'skipped'].includes(subtask.status));
    const reviewGap = firstReviewIndex >= 0 && subtasks
      .slice(firstReviewIndex + 1)
      .some((subtask, relativeIndex) => subtask.status === 'review'
        && subtasks[firstReviewIndex + relativeIndex].status !== 'review');
    if (firstReviewIndex < 0 || invalidPrefix.length > 0 || reviewGap) {
      findings.push({
        severity: 'error',
        message: 'Task is not ready for review: review items must form a contiguous slice after a completed/skipped prefix.',
        evidence: invalidPrefix.map((subtask) => `[${subtask.status}] ${subtask.text}`),
      });
    }

    if (successCriteria.length === 0) {
      findings.push({
        severity: 'error',
        message: 'Task has no explicit success criteria for the automated reviewer to evaluate.',
      });
    }

    if ((reports.length + testSignals.length + (workspace?.changedFiles?.length || 0) + (task.sessionRefs?.length || 0)) === 0) {
      findings.push({
        severity: 'error',
        message: 'No review evidence was found from reports, workspace changes, tests, or session metadata.',
      });
    }

    if (reports.length === 0) {
      findings.push({
        severity: 'warning',
        message: 'No linked reports were attached to the task; review relied on task/session/workspace evidence only.',
      });
    }

    let decision: ReviewOutcome['decision'] = 'pass';
    if (findings.some((finding) => finding.severity === 'error')) {
      decision = successCriteria.length === 0 ? 'escalate' : 'reject';
    }
    const countsAsRejection = decision === 'reject';

    let nextStatus: TaskStatus = task.status;
    let nextAttemptCount = task.attemptCount ?? 0;
    if (decision === 'reject') {
      nextAttemptCount += 1;
      if (nextAttemptCount >= maxRetries) {
        decision = 'escalate';
        nextStatus = 'stuck';
        findings.push({
          severity: 'error',
          message: `Automated reviewer retry budget exhausted (${nextAttemptCount}/${maxRetries}).`,
        });
      } else {
        nextStatus = 'in-progress';
      }
    } else if (decision === 'escalate') {
      nextStatus = 'stuck';
    }

    const summary = this.buildSummary(decision, task, findings, nextAttemptCount, maxRetries);
    const historyEntry: ReviewHistoryEntry = {
      id: randomUUID(),
      decision,
      summary,
      triggeredBy,
      createdAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      statusBefore: task.status,
      statusAfter: nextStatus,
      findings,
      evidence,
    };

    const reviewHistory = [...(task.reviewHistory || []), historyEntry].slice(-REVIEW_HISTORY_LIMIT);

    let mutated = false;
    let persistedReviewHistoryLength = reviewHistory.length;
    if (!options.dryRun) {
      let authoritativeVerdictApplied = true;
      if (attempt && this.attemptService) {
        const applied = await this.attemptService.recordVerdict(
          attempt.id,
          decision,
          findings,
          { summary, historyEntryId: historyEntry.id },
          undefined,
          countsAsRejection,
        );
        nextStatus = applied.status as TaskStatus;
        nextAttemptCount = applied.attemptCount;
        historyEntry.statusAfter = nextStatus;
        authoritativeVerdictApplied = applied.applied;
      }
      if (authoritativeVerdictApplied) {
        await this.deps.updateTask(task.id, {
          status: nextStatus,
          attemptCount: nextAttemptCount,
          reviewHistory,
          needsReview: decision === 'escalate',
        });
        mutated = true;
      } else {
        // A competing reviewer already committed this attempt. The attempt row
        // is authoritative; do not append duplicate compatibility history or
        // repeat escalation side effects from this stale outcome.
        const current = await this.requireTask(task.id);
        nextStatus = current.status;
        nextAttemptCount = current.attemptCount ?? nextAttemptCount;
        historyEntry.statusAfter = nextStatus;
        persistedReviewHistoryLength = current.reviewHistory?.length || 0;
      }
      if (decision === 'escalate' && authoritativeVerdictApplied) {
        await this.deps.notifyEscalation(task, summary);
      }
    }

    return {
      decision,
      summary,
      findings,
      evidence,
      applied: {
        status: nextStatus,
        attemptCount: nextAttemptCount,
        maxRetries,
        reviewHistoryLength: persistedReviewHistoryLength,
        mutated,
      },
      historyEntry,
    };
  }

  async rejectTask(taskId: string, reason: string, options: RunReviewOptions = {}): Promise<ReviewOutcome> {
    const task = await this.requireTask(taskId);
    const triggeredBy = options.triggeredBy || 'user';
    const maxRetries = task.maxRetries ?? DEFAULT_MAX_RETRIES;
    let nextAttemptCount = (task.attemptCount ?? 0) + 1;
    const exhausted = nextAttemptCount >= maxRetries;
    const decision: ReviewOutcome['decision'] = exhausted ? 'escalate' : 'reject';
    let nextStatus: TaskStatus = exhausted ? 'stuck' : 'in-progress';
    const findings: ReviewFinding[] = [{ severity: 'error', message: reason }];
    const summary = exhausted
      ? `Reviewer escalation after manual rejection: ${reason}`
      : `Reviewer rejected task: ${reason}`;
    const manualEvidence: ReviewHistoryEntry['evidence'] = {
      successCriteria: normalizeTextList(task.successCriteria ?? task.definitionOfDone),
      reports: [],
      sessionRefs: task.sessionRefs || [],
      completedBy: task.completedBy
        ? {
            name: task.completedBy.name,
            sessionKey: task.completedBy.sessionKey,
            harness: task.completedBy.harness,
          }
        : null,
    };
    const attempt = this.attemptService
      ? await this.attemptService.beginAttempt(task, manualEvidence)
      : undefined;
    const historyEntry: ReviewHistoryEntry = {
      id: randomUUID(),
      decision,
      summary,
      triggeredBy,
      createdAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      statusBefore: task.status,
      statusAfter: nextStatus,
      findings,
      evidence: manualEvidence,
    };
    const reviewHistory = [...(task.reviewHistory || []), historyEntry].slice(-REVIEW_HISTORY_LIMIT);

    let authoritativeVerdictApplied = true;
    let persistedReviewHistoryLength = reviewHistory.length;
    if (attempt && this.attemptService) {
      const applied = await this.attemptService.recordVerdict(
        attempt.id,
        decision,
        findings,
        { summary, historyEntryId: historyEntry.id },
        undefined,
        true,
      );
      nextStatus = applied.status as TaskStatus;
      nextAttemptCount = applied.attemptCount;
      historyEntry.statusAfter = nextStatus;
      authoritativeVerdictApplied = applied.applied;
    }
    if (authoritativeVerdictApplied) {
      await this.deps.updateTask(task.id, {
        status: nextStatus,
        attemptCount: nextAttemptCount,
        reviewHistory,
        needsReview: decision === 'escalate',
      });
    } else {
      const current = await this.requireTask(task.id);
      nextStatus = current.status;
      nextAttemptCount = current.attemptCount ?? nextAttemptCount;
      historyEntry.statusAfter = nextStatus;
      persistedReviewHistoryLength = current.reviewHistory?.length || 0;
    }
    if (decision === 'escalate' && authoritativeVerdictApplied) {
      await this.deps.notifyEscalation(task, summary);
    }

    return {
      decision,
      summary,
      findings,
      evidence: historyEntry.evidence,
      applied: {
        status: nextStatus,
        attemptCount: nextAttemptCount,
        maxRetries,
        reviewHistoryLength: persistedReviewHistoryLength,
        mutated: authoritativeVerdictApplied,
      },
      historyEntry,
    };
  }

  private async requireTask(taskId: string): Promise<Task> {
    const task = await this.deps.getTask(taskId);
    if (!task) {
      throw new Error(`Task not found: ${taskId}`);
    }
    return task;
  }

  private extractTestSignals(task: Task, reports: ReviewerReportSummary[], workspace?: ReviewWorkspaceEvidence): string[] {
    const signals = new Set<string>();
    const candidates = [
      task.description || '',
      ...(reports.map((report) => `${report.title}\n${report.summary || ''}\n${report.content || ''}`)),
      ...((workspace?.commandEvidence || [])),
    ];

    for (const candidate of candidates) {
      for (const line of candidate.split(/\n+/)) {
        const trimmed = line.trim();
        if (trimmed && TEST_SIGNAL_PATTERN.test(trimmed)) {
          signals.add(truncate(trimmed));
        }
      }
    }

    return Array.from(signals).slice(0, 10);
  }

  private buildSummary(
    decision: ReviewOutcome['decision'],
    task: Task,
    findings: ReviewFinding[],
    attemptCount: number,
    maxRetries: number,
  ): string {
    if (decision === 'pass') {
      return `Automated reviewer passed task ${task.id.slice(0, 8)} with ${findings.length} finding(s).`;
    }
    const topFinding = findings.find((finding) => finding.severity === 'error') || findings[0];
    const prefix = decision === 'escalate' ? 'Automated reviewer escalated' : 'Automated reviewer rejected';
    return `${prefix} task ${task.id.slice(0, 8)} (${attemptCount}/${maxRetries} attempts): ${topFinding?.message || 'unspecified issue'}`;
  }
}

async function resolveTaskWorkingDirectory(task: Task): Promise<string | undefined> {
  const fallbackPaths = [
    process.env.AGENT_WORKSPACE_DIR,
    process.env.HERMES_TASK_CWD,
    '/task-projects',
    '/workspace',
  ];

  if (!task.project) {
    try {
      return resolveWritableRuntimePath([], fallbackPaths);
    } catch {
      return undefined;
    }
  }

  try {
    const projects = await projectService.list();
    const project = projects.find((candidate: any) => candidate.name === task.project || candidate.id === task.project);
    return resolveWritableRuntimePath([
      project?.resources?.localPaths?.ssdBuild,
      project?.source_dir,
      project?.resources?.localPaths?.nfsRoot,
      project?.nfs_dir,
    ], fallbackPaths);
  } catch {
    return undefined;
  }
}

async function collectWorkspaceEvidence(task: Task): Promise<ReviewWorkspaceEvidence | undefined> {
  const workingDirectory = await resolveTaskWorkingDirectory(task);
  if (!workingDirectory) {
    return undefined;
  }

  const evidence: ReviewWorkspaceEvidence = { workingDirectory };

  try {
    const [{ stdout: branch }, { stdout: status }, { stdout: diffStat }] = await Promise.all([
      execFileAsync('git', ['-C', workingDirectory, 'branch', '--show-current'], { timeout: 5000 }),
      execFileAsync('git', ['-C', workingDirectory, 'status', '--short'], { timeout: 5000 }),
      execFileAsync('git', ['-C', workingDirectory, 'diff', '--stat'], { timeout: 5000 }),
    ]);

    const changedFiles = status
      .split(/\n+/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => line.slice(3).trim())
      .filter(Boolean);

    evidence.gitBranch = branch.trim() || undefined;
    evidence.changedFiles = changedFiles;
    evidence.diffStat = truncate(diffStat, 400);
  } catch {
    // Non-git workspaces are fine; keep the resolved directory only.
  }

  return evidence;
}

const defaultDependencies: ReviewerDependencies = {
  getTask: (taskId: string) => taskManagerDB.getTask(taskId),
  updateTask: (taskId: string, updates: Partial<Task>) => taskManagerDB.updateTask(taskId, updates),
  getReportsForTask: (taskId: string) => reportManager.getByTaskId(taskId),
  collectWorkspaceEvidence,
  notifyEscalation: async (task: Task, summary: string) => {
    await notificationManager.notifyStatusChange(task.id, task.title, task.status, 'stuck', 'system');
    const notificationDestination = task.discordThreadId || discordThreadService.getSystemNotificationChannelId();
    if (notificationDestination) {
      const result = await taskNotificationService.deliver({
        taskId: task.id,
        kind: 'review-escalation',
        stateVersion: `attempt-${(task.attemptCount ?? 0) + 1}`,
        destination: notificationDestination,
        message: [
          '## 🚨 ClawBoard review escalation',
          `**${task.title}** exhausted its bounded review retry budget and requires independent human/orchestrator attention.`,
          summary,
        ].join('\n\n'),
      });
      if (result.status === 'failed') {
        console.warn(`[TaskReviewerService] Discord escalation delivery for ${task.id} remains retryable`);
      }
    }
    console.warn(`[TaskReviewerService] Escalated task ${task.id}: ${summary}`);
  },
};

export const taskReviewerService = new TaskReviewerService();
