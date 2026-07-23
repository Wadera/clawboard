import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import { marked } from 'marked';
import { X, Pencil, Clock, Tag, Cpu, Calendar, Zap, AlertTriangle, FileText, Bot, Play, CheckCircle, Copy, Check, Lock, Link, ArrowRight, Plus, Trash2, Circle, Eye, ExternalLink, FolderOpen, MessageSquare, History, SendHorizontal, Square, Flag } from 'lucide-react';
import { Task, TaskPriority, TaskStatus, Subtask, SubtaskStatus, TaskLink, TaskLinkType, TaskExecutionMode, TaskTimelineEvent, type TaskAccessProfile, TASK_CAPABILITY_TAGS } from '../../types/task';
import { AgentTypeSummary } from '../../types/agentType';
import { TASK_LINK_TYPES, getLinkTypeLabel } from '../../constants/linkTypes';
import { TASK_ACCESS_PROFILE_LABELS, TASK_ACCESS_PROFILE_OPTIONS, TASK_CAPABILITY_OPTIONS, TASK_EXECUTION_MODE_OPTIONS, TASK_PROFILE_CAPABILITIES, getExtraTaskCapabilities } from '../../constants/taskExecution';
import { useTaskModelOptions } from '../../hooks/useTaskModelOptions';
import { authenticatedFetch } from '../../utils/auth';
import { filterDependencyTasks } from '../../utils/dependencySearch';
import { useFileViewer } from '../../contexts/FileViewerContext';
import { parseTaskDetailSections, isBrowserNavigableUrl } from './taskDetailSections';
import { SubtaskList } from './SubtaskList';
import { TaskLinks } from './TaskLinks';
import { TaskResourcesSection } from './TaskResourcesSection';
import { LiveSessionPanel } from './LiveSessionPanel';
import { useFocusTrap } from '../../hooks/useFocusTrap';
import './TaskDetailModal.css';
import { formatDateTimeLong } from '../../utils/dateFormat';
import { buildDiscordThreadUrl } from '../../utils/discordLinks';

const parseMultilineList = (value: string): string[] => value.split(/\n|;/).map(item => item.replace(/^[-*]\s*/, '').trim()).filter(Boolean);

// Helper to get effective status (handles legacy boolean completed field)
const getSubtaskStatus = (subtask: { status?: SubtaskStatus; completed?: boolean }): SubtaskStatus => {
  if (subtask.status) return subtask.status;
  if (subtask.completed) return 'completed';
  return 'empty';
};

const generateId = () => crypto.randomUUID?.() || Math.random().toString(36).substring(2, 15);
const CAPABILITY_TAGS = TASK_CAPABILITY_TAGS;
const DASHBOARD_BASE = (import.meta.env.BASE_URL || '/dashboard/').replace(/\/$/, '');

function buildDashboardHref(path: string): string {
  if (!path) return DASHBOARD_BASE || '/dashboard';
  if (/^(?:https?:)?\/\//.test(path)) return path;
  if (path.startsWith('/')) return `${DASHBOARD_BASE}${path}`;
  return `${DASHBOARD_BASE}/${path}`;
}


function formatTimelineTimestamp(value: string): string {
  return formatDateTimeLong(value, value);
}

function getTimelineIcon(eventType: string) {
  if (eventType.startsWith('session.spawned')) return Play;
  if (eventType.startsWith('session.steered')) return SendHorizontal;
  if (eventType.startsWith('session.cancelled')) return Square;
  if (eventType.startsWith('session.finished')) return CheckCircle;
  if (eventType.startsWith('review.escalate')) return AlertTriangle;
  if (eventType.startsWith('review.reject')) return Flag;
  if (eventType.startsWith('review.pass')) return CheckCircle;
  return History;
}

function getTimelineTone(eventType: string): string {
  if (eventType.startsWith('session.spawned')) return 'spawn';
  if (eventType.startsWith('session.steered')) return 'steer';
  if (eventType.startsWith('session.cancelled')) return 'cancel';
  if (eventType.startsWith('session.finished')) return 'finish';
  if (eventType.startsWith('review.escalate')) return 'escalate';
  if (eventType.startsWith('review.reject')) return 'reject';
  if (eventType.startsWith('review.pass')) return 'pass';
  return 'neutral';
}

function renderTimelineMeta(event: TaskTimelineEvent): string[] {
  const items: string[] = [];
  if (event.actor) items.push(event.actor);
  if (event.harness) items.push(String(event.harness));
  if (event.metadata?.outcome) items.push(String(event.metadata.outcome));
  if (event.metadata?.model) items.push(String(event.metadata.model));
  if (event.source && event.source !== 'timeline') items.push(event.source);
  return items;
}

function renderTaskMarkdown(markdown: string): string {
  if (!markdown) return '';
  const html = marked.parse(markdown, { breaks: true, gfm: true }) as string;
  return html.replace(/<a\s+href="([^"]+)"([^>]*)>/g, (_match, href: string, attrs: string) => {
    if (isBrowserNavigableUrl(href)) {
      const resolvedHref = buildDashboardHref(href);
      return `<a href="${resolvedHref}"${attrs}>`;
    }
    return `<a href="#" data-file-link="${href}"${attrs}>`;
  });
}

const LINK_TYPE_ICONS: Record<TaskLinkType, string> = {
  project: '📁',
  doc: '📄',
  git: '🔀',
  memory: '🧠',
  session: '💬',
  tool: '🔧',
  report: '📋'
};

const LINK_TYPE_OPTIONS: { value: TaskLinkType; label: string; icon: string }[] =
  TASK_LINK_TYPES.map(type => ({
    value: type,
    label: getLinkTypeLabel(type),
    icon: LINK_TYPE_ICONS[type]
  }));

interface TaskDetailModalProps {
  task: Task;
  onClose: () => void;
  onEdit?: () => void; // Legacy — ignored if onSave provided
  onSubtaskToggle: (subtaskId: string) => void;
  onSubtaskStatusChange?: (subtaskId: string, status: SubtaskStatus) => void;
  onSubtaskEdit?: (subtaskId: string, newText: string) => void;
  onSubtaskReorder?: (subtaskId: string, direction: 'up' | 'down') => void;
  // Edit mode props (when provided, enables inline editing)
  onSave?: (taskId: string, updates: Partial<Task>) => void;
  onDelete?: (taskId: string) => void;
  initialEditMode?: boolean;
}

export const TaskDetailModal: React.FC<TaskDetailModalProps> = ({
  task,
  onClose,
  onEdit,
  onSubtaskToggle,
  onSubtaskStatusChange,
  onSubtaskEdit,
  onSubtaskReorder,
  onSave,
  onDelete,
  initialEditMode = false,
}) => {
  const navigate = useNavigate();
  const { openFileByPath } = useFileViewer();
  const modalRef = useRef<HTMLDivElement>(null);
  useFocusTrap(modalRef);

  const [copied, setCopied] = useState(false);
  const [isEditing, setIsEditing] = useState(initialEditMode);

  // Edit state
  const [title, setTitle] = useState(task.title);
  const [description, setDescription] = useState(task.description || '');
  const [notes, setNotes] = useState(task.notes || '');
  const [project, setProject] = useState(task.project || '');
  const [priority, setPriority] = useState<TaskPriority>(task.priority);
  const [status, setStatus] = useState<TaskStatus>(task.status);
  const [tags, setTags] = useState(task.tags?.join(', ') || '');
  const initialAccessProfile = (task.executionProfile?.accessProfile || 'dev') as TaskAccessProfile;
  const initialRequiredCapabilities = (task.executionProfile?.requiredCapabilities || task.tags?.filter(t => CAPABILITY_TAGS.includes(t as typeof CAPABILITY_TAGS[number])) || []) as string[];
  // Lifecycle gate: auto-pickup is opt-in — missing field means OFF, not on.
  const [autoStart, setAutoStart] = useState(task.autoStart === true);
  const [model, setModel] = useState(task.model || '');
  const [executionMode, setExecutionMode] = useState<TaskExecutionMode>(task.executionMode || task.executionProfile?.mode || 'interactive');
  const [accessProfile, setAccessProfile] = useState<TaskAccessProfile>(initialAccessProfile);
  const [requiredCapabilities, setRequiredCapabilities] = useState<string[]>(() => initialRequiredCapabilities.filter(cap => !(TASK_PROFILE_CAPABILITIES[initialAccessProfile] || []).includes(cap as any)));
  const [allowOverrideAtSpawn, setAllowOverrideAtSpawn] = useState(task.executionProfile?.allowOverrideAtSpawn ?? true);
  const [successCriteria, setSuccessCriteria] = useState(Array.isArray(task.successCriteria) ? task.successCriteria.join('\n') : (task.successCriteria || ''));
  const [maxRetries, setMaxRetries] = useState(String(task.maxRetries ?? 3));
  const [definitionOfDone, setDefinitionOfDone] = useState(Array.isArray(task.definitionOfDone) ? task.definitionOfDone.join('\n') : (task.definitionOfDone || ''));
  const [constraints, setConstraints] = useState(Array.isArray(task.constraints) ? task.constraints.join('\n') : (task.constraints || ''));
  const [agentTypeId, setAgentTypeId] = useState(task.agentTypeId || '');
  const [agentTypes, setAgentTypes] = useState<AgentTypeSummary[]>([]);
  const [subtasks, setSubtasks] = useState<Subtask[]>(task.subtasks || []);
  const [links, setLinks] = useState<TaskLink[]>(task.links || []);
  const [thinking, setThinking] = useState<'low' | 'medium' | 'high' | ''>(task.thinking || '');
  const [blockedReason, setBlockedReason] = useState(task.blockedReason || '');
  const [newSubtask, setNewSubtask] = useState('');
  const [newLinkTitle, setNewLinkTitle] = useState('');
  const [newLinkUrl, setNewLinkUrl] = useState('');
  const [newLinkType, setNewLinkType] = useState<TaskLinkType>('doc');
  const [dependsOn, setDependsOn] = useState<string[]>(task.dependsOn || []);
  const [availableTasks, setAvailableTasks] = useState<Task[]>([]);
  const [selectedDependencyTasks, setSelectedDependencyTasks] = useState<Task[]>([]);
  const [dependencySearch, setDependencySearch] = useState('');
  const [debouncedDependencySearch, setDebouncedDependencySearch] = useState('');
  const [dependencyLoading, setDependencyLoading] = useState(false);
  const [dependencyFetchError, setDependencyFetchError] = useState('');
  const [dependencyPickerOpen, setDependencyPickerOpen] = useState(false);
  const [error, setError] = useState('');
  const { modelOptions } = useTaskModelOptions(task.model || undefined);

  const canEdit = !!onSave;
  const shortId = task.id.substring(0, 8);
  const parsedDescription = useMemo(() => parseTaskDetailSections(task.description || ''), [task.description]);
  const renderedOverviewHtml = useMemo(() => renderTaskMarkdown(parsedDescription.overviewMarkdown), [parsedDescription.overviewMarkdown]);
  const renderedAdditionalSections = useMemo(
    () => parsedDescription.additionalSections.map((section) => ({
      ...section,
      html: renderTaskMarkdown(section.markdown),
    })),
    [parsedDescription.additionalSections]
  );
  const activeAgentDetails = typeof task.activeAgent === 'object' && task.activeAgent ? task.activeAgent : null;
  const activeSessionKey = activeAgentDetails?.sessionKey || (typeof task.activeAgent === 'string' ? task.activeAgent : null);
  const backendSessionKey = task.acpSessionKey || null;
  const activeSessionHref = activeSessionKey ? buildDashboardHref(`/sessions?focus=${encodeURIComponent(activeSessionKey)}`) : null;
  const backendSessionHref = backendSessionKey ? buildDashboardHref(`/sessions?focus=${encodeURIComponent(backendSessionKey)}`) : null;
  const discordThreadHref = buildDiscordThreadUrl(task.discordThreadId, task.discordThreadUrl);
  const reviewCriteria = Array.isArray(task.successCriteria)
    ? task.successCriteria
    : typeof task.successCriteria === 'string' && task.successCriteria.trim()
      ? [task.successCriteria.trim()]
      : [];
  const definitionOfDoneList = Array.isArray(task.definitionOfDone)
    ? task.definitionOfDone
    : typeof task.definitionOfDone === 'string' && task.definitionOfDone.trim()
      ? [task.definitionOfDone.trim()]
      : [];
  const constraintsList = Array.isArray(task.constraints)
    ? task.constraints
    : typeof task.constraints === 'string' && task.constraints.trim()
      ? [task.constraints.trim()]
      : [];
  const latestReviewEntry = task.reviewHistory?.length ? task.reviewHistory[task.reviewHistory.length - 1] : null;
  const [timelineEvents, setTimelineEvents] = useState<TaskTimelineEvent[]>([]);
  const [timelineLoading, setTimelineLoading] = useState(false);
  const [timelineError, setTimelineError] = useState('');

  // Fetch agent types for dropdown
  useEffect(() => {
    const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || '/api';
    authenticatedFetch(`${API_BASE_URL}/agent-types`)
      .then(r => r.json())
      .then(data => {
        if (data.success && data.agentTypes) setAgentTypes(data.agentTypes);
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || '/api';
    let cancelled = false;
    setTimelineLoading(true);
    setTimelineError('');

    authenticatedFetch(`${API_BASE_URL}/tasks/${task.id}/timeline`)
      .then(async (response) => {
        if (!response.ok) {
          throw new Error(`Timeline request failed (${response.status})`);
        }
        return response.json();
      })
      .then((data) => {
        if (cancelled) return;
        setTimelineEvents(Array.isArray(data?.events) ? data.events : []);
      })
      .catch((err) => {
        if (cancelled) return;
        console.error('Failed to load task timeline:', err);
        setTimelineEvents([]);
        setTimelineError('Task timeline is unavailable right now.');
      })
      .finally(() => {
        if (!cancelled) setTimelineLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [task.id]);

  useEffect(() => {
    const nextValue = dependencySearch.trim();
    const timeout = window.setTimeout(() => setDebouncedDependencySearch(nextValue), 180);
    return () => window.clearTimeout(timeout);
  }, [dependencySearch]);

  // Fetch available tasks for dependency picker when in edit mode
  useEffect(() => {
    if (!isEditing || !canEdit) return;

    const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || '/api';
    let cancelled = false;

    const fetchTasks = async () => {
      setDependencyLoading(true);
      setDependencyFetchError('');
      try {
        const params = new URLSearchParams({
          excludeTaskId: task.id,
          limit: debouncedDependencySearch ? '12' : '20',
        });
        if (debouncedDependencySearch) {
          params.set('q', debouncedDependencySearch);
        }

        const response = await authenticatedFetch(`${API_BASE_URL}/tasks?${params.toString()}`);
        if (!response.ok) {
          throw new Error(`Search failed with ${response.status}`);
        }

        const data = await response.json();
        if (cancelled) return;
        setAvailableTasks(data.tasks || []);
      } catch (err) {
        if (cancelled) return;
        console.error('Failed to fetch tasks for dependency picker:', err);
        setDependencyFetchError('Task search is unavailable right now.');
        setAvailableTasks([]);
      } finally {
        if (!cancelled) {
          setDependencyLoading(false);
        }
      }
    };

    fetchTasks();

    return () => {
      cancelled = true;
    };
  }, [isEditing, canEdit, task.id, debouncedDependencySearch]);

  useEffect(() => {
    if (!isEditing || !canEdit) return;

    const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || '/api';
    let cancelled = false;

    const fetchSelectedDependencies = async () => {
      try {
        const response = await authenticatedFetch(`${API_BASE_URL}/tasks/${task.id}/dependencies`);
        if (!response.ok) return;
        const data = await response.json();
        if (!cancelled) {
          setSelectedDependencyTasks(data.dependsOn || []);
        }
      } catch (err) {
        if (!cancelled) {
          console.error('Failed to load current dependencies:', err);
        }
      }
    };

    fetchSelectedDependencies();

    return () => {
      cancelled = true;
    };
  }, [isEditing, canEdit, task.id]);

  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (isEditing) {
          setIsEditing(false);
          // Reset form state
          resetEditState();
        } else {
          onClose();
        }
      }
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [onClose, isEditing]);

  const resetEditState = () => {
    setTitle(task.title);
    setDescription(task.description || '');
    setNotes(task.notes || '');
    setProject(task.project || '');
    setPriority(task.priority);
    setStatus(task.status);
    setTags(task.tags?.join(', ') || '');
    setAutoStart(task.autoStart === true);
    setModel(task.model || '');
    setExecutionMode(task.executionMode || task.executionProfile?.mode || 'interactive');
    setAccessProfile((task.executionProfile?.accessProfile || 'dev') as TaskAccessProfile);
    setRequiredCapabilities(((task.executionProfile?.requiredCapabilities || task.tags?.filter(t => CAPABILITY_TAGS.includes(t as typeof CAPABILITY_TAGS[number])) || []) as string[]).filter(cap => !((TASK_PROFILE_CAPABILITIES[(task.executionProfile?.accessProfile || 'dev') as TaskAccessProfile] || []) as string[]).includes(cap)));
    setAllowOverrideAtSpawn(task.executionProfile?.allowOverrideAtSpawn ?? true);
    setSuccessCriteria(Array.isArray(task.successCriteria) ? task.successCriteria.join('\n') : (task.successCriteria || ''));
    setMaxRetries(String(task.maxRetries ?? 3));
    setDefinitionOfDone(Array.isArray(task.definitionOfDone) ? task.definitionOfDone.join('\n') : (task.definitionOfDone || ''));
    setConstraints(Array.isArray(task.constraints) ? task.constraints.join('\n') : (task.constraints || ''));
    setAgentTypeId(task.agentTypeId || '');
    setSubtasks(task.subtasks || []);
    setLinks(task.links || []);
    setThinking(task.thinking || '');
    setBlockedReason(task.blockedReason || '');
    setDependsOn(task.dependsOn || []);
    setDependencySearch('');
    setDebouncedDependencySearch('');
    setDependencyFetchError('');
    setDependencyPickerOpen(false);
    setError('');
  };

  const handleCopyId = async () => {
    try {
      await navigator.clipboard.writeText(shortId);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      console.error('Failed to copy task ID:', err);
    }
  };

  const handleMarkdownLinkClick = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
    const anchor = (event.target as HTMLElement).closest('a[data-file-link]') as HTMLAnchorElement | null;
    if (!anchor) return;
    event.preventDefault();
    event.stopPropagation();
    const filePath = anchor.dataset.fileLink;
    if (filePath) {
      openFileByPath(filePath);
    }
  }, [openFileByPath]);

  const handleProjectClick = useCallback((event: React.MouseEvent<HTMLAnchorElement>) => {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) {
      return;
    }
    event.preventDefault();
    if (task.project) {
      navigate(`/projects?open=${encodeURIComponent(task.project)}`);
    }
  }, [navigate, task.project]);

  const getPriorityLabel = (p?: TaskPriority): string => {
    const val = p || task.priority;
    switch (val) {
      case 'urgent': return '🔴 Urgent';
      case 'high': return '🟠 High';
      case 'normal': return '🔵 Normal';
      case 'low': return '⚪ Low';
      case 'someday': return '🟣 Someday';
      default: return 'Normal';
    }
  };

  const getStatusLabel = (s?: TaskStatus): string => {
    const val = s || task.status;
    switch (val) {
      case 'ideas': return '💡 Ideas / Plans';
      case 'todo': return '📋 To Do';
      case 'in-progress': return '⚡ In Progress';
      case 'review': return '🔍 Review';
      case 'stuck': return '🤔 Stuck';
      case 'completed': return '✅ Completed';
      case 'archived': return '📦 Archived';
      default: return val;
    }
  };

  const getThinkingLabel = (t?: string): string => {
    switch (t) {
      case 'low': return '🟢 Low';
      case 'medium': return '🟡 Medium';
      case 'high': return '🔴 High';
      default: return 'Not set';
    }
  };

  const getExecutionModeLabel = (m?: string): string => {
    const value = (m || task.executionMode || task.executionProfile?.mode) as TaskExecutionMode | undefined;
    switch (value) {
      case 'main': return '🖥️ Main session';
      case 'interactive': return '💬 Interactive steering';
      case 'subagent': return '🤖 One-shot spawned agent';
      default: return value || 'Not set';
    }
  };

  const viewAccessProfile = (task.executionProfile?.accessProfile || 'dev') as TaskAccessProfile;
  const viewEffectiveCapabilities = ((task.executionProfile?.requiredCapabilities || task.tags?.filter(tag => CAPABILITY_TAGS.includes(tag as typeof CAPABILITY_TAGS[number])) || []) as string[]);
  const viewExtraCapabilities = getExtraTaskCapabilities(viewAccessProfile, viewEffectiveCapabilities);
  const editDerivedCapabilities = TASK_PROFILE_CAPABILITIES[accessProfile] || [];

  const getAccessProfileLabel = (profile: TaskAccessProfile = viewAccessProfile): string => {
    return TASK_ACCESS_PROFILE_LABELS[profile] || 'Not set';
  };

  const currentModelLabel = modelOptions.find(option => option.value === (task.model || ''))?.label || task.model;

  const formatDate = (dateString: string): string => {
    const date = new Date(dateString);
    return date.toLocaleString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  };

  const handleBackdropClick = (e: React.MouseEvent) => {
    if (e.target === e.currentTarget) onClose();
  };

  const handleEditToggle = () => {
    if (canEdit) {
      setIsEditing(true);
    } else if (onEdit) {
      onEdit();
    }
  };

  const handleSave = () => {
    if (!onSave) return;
    if (!title.trim()) {
      setError('Title is required');
      return;
    }

    const parsedTags = Array.from(new Set([
      ...tags
        .split(',')
        .map(t => t.trim())
        .filter(Boolean)
        .filter(t => !CAPABILITY_TAGS.includes(t as typeof CAPABILITY_TAGS[number])),
      ...editDerivedCapabilities,
      ...requiredCapabilities,
    ]));

    onSave(task.id, {
      title: title.trim(),
      description: description.trim(),
      notes: notes.trim() || undefined,
      project: project.trim() || undefined,
      priority,
      status,
      tags: parsedTags,
      autoStart,
      model: model || undefined,
      executionMode,
      executionProfile: {
        mode: executionMode,
        accessProfile,
        requiredCapabilities: parsedTags.filter(t => CAPABILITY_TAGS.includes(t as any)) as any,
        allowOverrideAtSpawn,
      },
      successCriteria: parseMultilineList(successCriteria),
      maxRetries: maxRetries.trim() ? Math.max(1, Number(maxRetries) || 3) : 3,
      definitionOfDone: parseMultilineList(definitionOfDone),
      constraints: parseMultilineList(constraints),
      agentTypeId: agentTypeId || undefined,
      thinking: thinking || undefined,
      thinkingAutoEstimated: thinking ? false : undefined,
      subtasks,
      links,
      dependsOn,
      blockedReason: status === 'stuck' ? blockedReason.trim() : undefined,
    });
    setIsEditing(false);
  };

  // Edit mode subtask handlers
  const handleAddSubtask = () => {
    if (!newSubtask.trim()) return;
    setSubtasks([...subtasks, {
      id: generateId(),
      text: newSubtask.trim(),
      status: 'empty' as SubtaskStatus,
      completed: false,
    }]);
    setNewSubtask('');
  };

  const handleRemoveSubtask = (id: string) => {
    setSubtasks(subtasks.filter(s => s.id !== id));
  };

  const handleEditSubtaskToggle = (id: string) => {
    setSubtasks(subtasks.map(s => {
      if (s.id !== id) return s;
      const currentStatus = getSubtaskStatus(s);
      const nextStatus: SubtaskStatus =
        currentStatus === 'empty' ? 'review' :
        currentStatus === 'review' ? 'completed' : 'empty';
      return {
        ...s,
        status: nextStatus,
        completed: nextStatus === 'completed',
        completedAt: nextStatus === 'completed' ? new Date().toISOString() : undefined
      };
    }));
  };

  const handleAddLink = () => {
    if (!newLinkTitle.trim() || !newLinkUrl.trim()) return;
    setLinks([...links, {
      type: newLinkType,
      title: newLinkTitle.trim(),
      url: newLinkUrl.trim(),
    }]);
    setNewLinkTitle('');
    setNewLinkUrl('');
  };

  const handleRemoveLink = (index: number) => {
    setLinks(links.filter((_, i) => i !== index));
  };

  const handleAddDependency = (taskId: string) => {
    if (!taskId || dependsOn.includes(taskId)) return;
    const dependencyTask = availableTasks.find(t => t.id === taskId);
    setDependsOn([...dependsOn, taskId]);
    if (dependencyTask) {
      setSelectedDependencyTasks(prev => prev.some(t => t.id === taskId) ? prev : [...prev, dependencyTask]);
    }
    setDependencySearch('');
    setDependencyPickerOpen(false);
  };

  const handleRemoveDependency = (taskId: string) => {
    setDependsOn(dependsOn.filter(id => id !== taskId));
    setSelectedDependencyTasks(prev => prev.filter(task => task.id !== taskId));
  };

  const dependencyTaskMap = useMemo(() => {
    const allTasks = [...selectedDependencyTasks, ...availableTasks];
    return new Map(allTasks.map(task => [task.id, task]));
  }, [selectedDependencyTasks, availableTasks]);

  const dependencyResults = useMemo(
    () => filterDependencyTasks(availableTasks, debouncedDependencySearch, dependsOn, task.id, 10),
    [availableTasks, debouncedDependencySearch, dependsOn, task.id]
  );

  const hasSubtasks = isEditing ? subtasks.length > 0 : task.subtasks && task.subtasks.length > 0;
  const hasLinks = isEditing ? links.length > 0 : task.links && task.links.length > 0;
  const hasTags = isEditing ? !!tags.trim() : task.tags && task.tags.length > 0;

  // Phase 3: Count by status
  const displaySubtasks = isEditing ? subtasks : task.subtasks || [];
  const subtaskCounts = displaySubtasks.reduce((acc, s) => {
    const st = getSubtaskStatus(s);
    acc[st] = (acc[st] || 0) + 1;
    return acc;
  }, {} as Record<SubtaskStatus, number>);
  const completedSubtasks = subtaskCounts.completed || 0;
  const inReviewSubtasks = subtaskCounts.review || 0;

  return createPortal(
    <div className="task-detail-overlay" onClick={handleBackdropClick}>
      <div className="task-detail-modal" ref={modalRef} role="dialog" aria-modal="true" aria-label="Task details">
        {/* Header */}
        <div className="task-detail-header">
          {isEditing ? (
            <input
              type="text"
              value={title}
              onChange={(e) => { setTitle(e.target.value); setError(''); }}
              className="task-detail-title-input"
              placeholder="Task title..."
              autoFocus
            />
          ) : (
            <h2 className="task-detail-title">{task.title}</h2>
          )}
          <div className="task-detail-header-actions">
            {isEditing ? (
              <>
                <button
                  onClick={() => { setIsEditing(false); resetEditState(); }}
                  className="task-detail-btn task-detail-btn-cancel"
                  aria-label="Cancel editing"
                >
                  <Eye size={16} />
                  View
                </button>
                <button
                  onClick={handleSave}
                  className="task-detail-btn task-detail-btn-save"
                  aria-label="Save changes"
                >
                  <Check size={16} />
                  Save
                </button>
              </>
            ) : (
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  handleEditToggle();
                }}
                className="task-detail-btn task-detail-btn-edit"
                aria-label="Edit task"
              >
                <Pencil size={16} />
                Edit
              </button>
            )}
            <button onClick={onClose} className="task-detail-close-btn" aria-label="Close">
              <X size={22} />
            </button>
          </div>
        </div>

        {error && <div className="task-detail-error">{error}</div>}

        {/* Content */}
        <div className="task-detail-content">
          {/* Metadata Row: Priority + Status + ID */}
          <div className="task-detail-metadata">
            <div className="task-detail-meta-item">
              <span className="task-detail-meta-label">Priority:</span>
              {isEditing ? (
                <select
                  value={priority}
                  onChange={(e) => setPriority(e.target.value as TaskPriority)}
                  className="task-detail-inline-select"
                >
                  <option value="urgent">🔴 Urgent</option>
                  <option value="high">🟠 High</option>
                  <option value="normal">🔵 Normal</option>
                  <option value="low">⚪ Low</option>
                  <option value="someday">🟣 Someday</option>
                </select>
              ) : (
                <span className={`task-detail-priority priority-${task.priority}`}>
                  {getPriorityLabel()}
                </span>
              )}
            </div>
            <div className="task-detail-meta-item">
              <span className="task-detail-meta-label">Status:</span>
              {isEditing ? (
                <select
                  value={status}
                  onChange={(e) => setStatus(e.target.value as TaskStatus)}
                  className="task-detail-inline-select"
                >
                  <option value="ideas">💡 Ideas / Plans</option>
                  <option value="todo">📋 To Do</option>
                  <option value="in-progress">⚡ In Progress</option>
                  <option value="review">🔍 Review</option>
                  <option value="stuck">🤔 Stuck</option>
                  <option value="completed">✅ Completed</option>
                  <option value="archived">📦 Archived</option>
                </select>
              ) : (
                <span className="task-detail-status">{getStatusLabel()}</span>
              )}
            </div>
            <div className="task-detail-meta-item task-detail-id-container">
              <span className="task-detail-meta-label">ID:</span>
              <code className="task-detail-id">{shortId}</code>
              <button
                onClick={handleCopyId}
                className="task-detail-copy-btn"
                aria-label={copied ? 'Copied!' : 'Copy task ID'}
                title={copied ? 'Copied!' : 'Copy task ID'}
              >
                {copied ? <Check size={14} /> : <Copy size={14} />}
              </button>
            </div>
          </div>

          {/* Project */}
          <div className="task-detail-section">
            <div className="task-detail-field-row">
              <div className="task-detail-field-group">
                <span className="task-detail-field-label">Project:</span>
                {isEditing ? (
                  <input
                    type="text"
                    value={project}
                    onChange={(e) => setProject(e.target.value)}
                    className="task-detail-inline-input"
                    placeholder="e.g., clawboard"
                  />
                ) : (
                  <span className="task-detail-field-value">
                    {task.project ? (
                      <a
                        href={buildDashboardHref(`/projects?open=${encodeURIComponent(task.project)}`)}
                        className="task-detail-inline-link task-detail-project-link"
                        onClick={handleProjectClick}
                        title={`Open project ${task.project}`}
                      >
                        <FolderOpen size={13} /> #{task.project}
                      </a>
                    ) : <span className="task-detail-field-empty">—</span>}
                  </span>
                )}
              </div>
            </div>
          </div>

          {/* Tags — full width row */}
          <div className="task-detail-section">
            <div className="task-detail-field-row">
              <div className="task-detail-field-group" style={{ flex: '1 1 100%' }}>
                <span className="task-detail-field-label"><Tag size={14} /> Tags:</span>
                {isEditing ? (
                  <input
                    type="text"
                    value={tags}
                    onChange={(e) => setTags(e.target.value)}
                    className="task-detail-inline-input"
                    style={{ flex: 1 }}
                    placeholder="phase-4, frontend, ux"
                  />
                ) : (
                  <span className="task-detail-field-value" style={{ flexWrap: 'wrap' }}>
                    {hasTags ? task.tags.map((tag, i) => (
                      <span key={i} className="task-detail-tag">{tag}</span>
                    )) : <span className="task-detail-field-empty">—</span>}
                  </span>
                )}
              </div>
            </div>
          </div>

          {/* AI Execution: Model + Execution Mode + Access Profile + Thinking Level */}
          <div className="task-detail-section">
            <h3 className="task-detail-section-title">AI Execution</h3>
            <div className="task-detail-field-row task-detail-field-row-3">
              <div className="task-detail-field-group">
                <span className="task-detail-field-label"><Bot size={14} /> Model:</span>
                {isEditing ? (
                  <select
                    value={model}
                    onChange={(e) => setModel(e.target.value)}
                    className="task-detail-inline-select"
                  >
                    {modelOptions.map(opt => (
                      <option key={opt.value} value={opt.value}>{opt.label}</option>
                    ))}
                  </select>
                ) : (
                  <span className="task-detail-field-value">
                    {task.model ? (
                      <span className="task-detail-model-badge">{currentModelLabel}</span>
                    ) : <span className="task-detail-field-empty">Default</span>}
                  </span>
                )}
              </div>
              <div className="task-detail-field-group">
                <span className="task-detail-field-label"><Play size={14} /> Mode:</span>
                {isEditing ? (
                  <select
                    value={executionMode}
                    onChange={(e) => setExecutionMode(e.target.value as TaskExecutionMode)}
                    className="task-detail-inline-select"
                  >
                    {TASK_EXECUTION_MODE_OPTIONS.map(opt => (
                      <option key={opt.value} value={opt.value}>{opt.label}</option>
                    ))}
                  </select>
                ) : (
                  <span className="task-detail-field-value">
                    {getExecutionModeLabel(task.executionMode)}
                  </span>
                )}
              </div>
              <div className="task-detail-field-group">
                <span className="task-detail-field-label"><Lock size={14} /> Access:</span>
                {isEditing ? (
                  <select
                    value={accessProfile}
                    onChange={(e) => setAccessProfile(e.target.value as TaskAccessProfile)}
                    className="task-detail-inline-select"
                  >
                    {TASK_ACCESS_PROFILE_OPTIONS.map(opt => (
                      <option key={opt.value} value={opt.value}>{opt.label}</option>
                    ))}
                  </select>
                ) : (
                  <span className="task-detail-field-value">
                    {getAccessProfileLabel()}
                  </span>
                )}
              </div>
              <div className="task-detail-field-group">
                <span className="task-detail-field-label">🧠 Thinking:</span>
                {isEditing ? (
                  <select
                    value={thinking}
                    onChange={(e) => setThinking(e.target.value as 'low' | 'medium' | 'high' | '')}
                    className="task-detail-inline-select"
                  >
                    <option value="">Not set</option>
                    <option value="low">🟢 Low</option>
                    <option value="medium">🟡 Medium</option>
                    <option value="high">🔴 High</option>
                  </select>
                ) : (
                  <span className="task-detail-field-value">
                    {getThinkingLabel(task.thinking)}
                    {task.thinkingAutoEstimated && <span className="task-detail-auto-badge">auto</span>}
                  </span>
                )}
              </div>
            </div>

            {/* Agent Persona */}
            <div className="task-detail-ai-row-full" style={{ marginTop: '0.5rem' }}>
              <span className="task-detail-field-label">🎭 Agent Persona:</span>
              {isEditing ? (
                <select
                  value={agentTypeId}
                  onChange={(e) => setAgentTypeId(e.target.value)}
                  className="task-detail-inline-select"
                  style={{ flex: 1, maxWidth: '300px' }}
                >
                  <option value="">— Select agent persona —</option>
                  {agentTypes.map(at => (
                    <option key={at.id} value={at.id}>{at.name} ({at.category})</option>
                  ))}
                </select>
              ) : (
                <span className="task-detail-field-value">
                  {task.agentTypeId
                    ? (agentTypes.find(at => at.id === task.agentTypeId)?.name
                      || (typeof task.agentType === 'object' ? (task.agentType as any)?.name : task.agentType)
                      || task.agentTypeId.substring(0, 8))
                    : 'Not set'}
                </span>
              )}
            </div>

            {isEditing ? (
              <div className="task-detail-ai-edit-stack">
                <div className="task-detail-ai-row-full">
                  <span className="task-detail-field-label">ℹ️ Access profile:</span>
                  <span className="task-detail-field-value">
                    {TASK_ACCESS_PROFILE_OPTIONS.find(opt => opt.value === accessProfile)?.hint || 'Choose the minimum access the task needs.'}
                  </span>
                </div>
                <fieldset className="task-detail-ai-row-full task-capabilities-fieldset task-detail-capabilities-fieldset">
                  <legend className="task-detail-field-label">🧩 Extra required capabilities:</legend>
                  <div className="task-capabilities-grid" role="group" aria-label="Extra required capabilities">
                    {TASK_CAPABILITY_OPTIONS.map(capability => {
                      const derived = editDerivedCapabilities.includes(capability);
                      const checked = derived || requiredCapabilities.includes(capability);

                      return (
                        <label key={capability} className={`task-capability-option${derived ? ' task-capability-option-derived' : ''}`}>
                          <input
                            type="checkbox"
                            className="task-capability-checkbox"
                            checked={checked}
                            disabled={derived}
                            onChange={(e) => setRequiredCapabilities(prev => e.target.checked ? [...prev, capability] : prev.filter(value => value !== capability))}
                          />
                          <span className="task-capability-meta">
                            <span className="task-capability-name">{capability}</span>
                            <span className="task-capability-hint">
                              {derived ? 'Included by the selected access profile' : 'Request this capability in addition to the access profile'}
                            </span>
                          </span>
                        </label>
                      );
                    })}
                  </div>
                </fieldset>
                <label className="task-detail-toggle-label">
                  <input
                    type="checkbox"
                    checked={allowOverrideAtSpawn}
                    onChange={(e) => setAllowOverrideAtSpawn(e.target.checked)}
                    className="task-detail-checkbox"
                  />
                  <span className="task-detail-toggle-text">
                    🔓 Allow spawn-time overrides
                    <span className="task-detail-toggle-hint">Let the orchestrator override mode, access profile, model, and extra capabilities when spawning.</span>
                  </span>
                </label>
              </div>
            ) : (
              <>
                <div className="task-detail-ai-row-full" style={{ marginTop: '0.5rem' }}>
                  <span className="task-detail-field-label">🧩 Capabilities:</span>
                  <span className="task-detail-field-value" style={{ flexWrap: 'wrap', gap: '0.35rem' }}>
                    {viewEffectiveCapabilities.length > 0
                      ? viewEffectiveCapabilities.map(capability => (
                          <span key={capability} className="task-detail-tag">{capability}</span>
                        ))
                      : <span className="task-detail-field-empty">None</span>}
                  </span>
                </div>
                <div className="task-detail-ai-row-full" style={{ marginTop: '0.5rem' }}>
                  <span className="task-detail-field-label">➕ Extra capabilities:</span>
                  <span className="task-detail-field-value" style={{ flexWrap: 'wrap', gap: '0.35rem' }}>
                    {viewExtraCapabilities.length > 0
                      ? viewExtraCapabilities.map(capability => (
                          <span key={capability} className="task-detail-tag">{capability}</span>
                        ))
                      : <span className="task-detail-field-empty">None beyond access profile</span>}
                  </span>
                </div>
                <div className="task-detail-ai-row-full" style={{ marginTop: '0.5rem' }}>
                  <span className="task-detail-field-label">🔓 Spawn overrides:</span>
                  <span className="task-detail-field-value">
                    {task.executionProfile?.allowOverrideAtSpawn === false ? 'Locked to task defaults' : 'Allowed at spawn time'}
                  </span>
                </div>
              </>
            )}

            {/* Active Agent / Completed By (view only) */}
            {!isEditing && (task.activeAgent || task.completedBy) && (
              <div className="task-detail-ai-agents">
                {task.activeAgent && (
                  <div className="task-detail-ai-block">
                    <div className="task-detail-ai-row task-detail-ai-row-heading">
                      <Cpu size={14} />
                      <span className="task-detail-ai-label">Active Agent</span>
                    </div>
                    <div className="task-detail-ai-links">
                      <div className="task-detail-ai-value task-detail-agent-badge">
                        {typeof task.activeAgent === 'string'
                          ? task.activeAgent
                          : <><span className="task-detail-agent-name">{task.activeAgent.name}</span> <span className="task-detail-agent-session">{task.activeAgent.sessionKey}</span></>
                        }
                      </div>
                      {activeSessionHref && activeSessionKey && (
                        <a
                          href={activeSessionHref}
                          className="task-detail-inline-link task-detail-ai-link"
                          target="_blank"
                          rel="noopener noreferrer"
                          title={`Open active session ${activeSessionKey}`}
                        >
                          <span className="task-detail-ai-link-main">
                            <ExternalLink size={13} />
                            <span>ClawBoard session</span>
                          </span>
                          <code className="task-detail-ai-link-detail">{activeSessionKey}</code>
                        </a>
                      )}
                      {backendSessionHref && backendSessionKey && backendSessionKey !== activeSessionKey && (
                        <a
                          href={backendSessionHref}
                          className="task-detail-inline-link task-detail-ai-link"
                          target="_blank"
                          rel="noopener noreferrer"
                          title={`Open backend session ${backendSessionKey}`}
                        >
                          <span className="task-detail-ai-link-main">
                            <ExternalLink size={13} />
                            <span>Backend session</span>
                          </span>
                          <code className="task-detail-ai-link-detail">{backendSessionKey}</code>
                        </a>
                      )}
                      {discordThreadHref && task.discordThreadId && (
                        <a
                          href={discordThreadHref}
                          className="task-detail-inline-link task-detail-ai-link"
                          target="_blank"
                          rel="noopener noreferrer"
                          title={`Open Discord thread ${task.discordThreadId}`}
                        >
                          <span className="task-detail-ai-link-main">
                            <MessageSquare size={13} />
                            <span>Discord thread</span>
                          </span>
                          <code className="task-detail-ai-link-detail">{task.discordThreadId}</code>
                        </a>
                      )}
                    </div>
                  </div>
                )}
                {task.completedBy && (
                  <div className="task-detail-ai-row">
                    <CheckCircle size={14} />
                    <span className="task-detail-ai-label">Completed By:</span>
                    <span className="task-detail-ai-value">
                      {typeof task.completedBy === 'string'
                        ? task.completedBy
                        : <><span className="task-detail-agent-name">{task.completedBy.name}</span> <span className="task-detail-agent-session">{task.completedBy.sessionKey}</span></>
                      }
                    </span>
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Live Interactive Session Panel */}
          {!isEditing && task.executionMode === 'interactive' && (
            <div className="task-detail-section">
              <LiveSessionPanel
                task={task}
                onTaskUpdate={(updates) => onSave?.(task.id, updates)}
              />
            </div>
          )}

          {/* Flags / Toggles */}
          <div className="task-detail-section">
            {isEditing ? (
              <label className="task-detail-toggle-label">
                <input
                  type="checkbox"
                  checked={autoStart}
                  onChange={(e) => setAutoStart(e.target.checked)}
                  className="task-detail-checkbox"
                />
                <span className="task-detail-toggle-text">
                  {autoStart ? '⚡ Auto-pickup enabled' : 'Auto-pickup disabled'}
                  <span className="task-detail-toggle-hint">{autoStart ? 'bot can pick this up during heartbeats' : 'bot will NOT pick this up on its own'}</span>
                </span>
              </label>
            ) : (
              (task.autoStart === true || task.autoCreated || task.needsReview) && (
                <div className="task-detail-flags">
                  {task.autoStart === true && (
                    <span className="task-detail-flag task-detail-flag-autostart">
                      <Zap size={12} /> Auto-start
                    </span>
                  )}
                  {task.autoCreated && (
                    <span className="task-detail-flag task-detail-flag-autocreated">
                      <Bot size={12} /> Auto-created
                    </span>
                  )}
                  {task.needsReview && (
                    <span className="task-detail-flag task-detail-flag-review">
                      <AlertTriangle size={12} /> Needs Review
                    </span>
                  )}
                </div>
              )
            )}
          </div>

          {/* Blocked Reason (when stuck) */}
          {(isEditing ? status === 'stuck' : task.blockedReason) && (
            <div className="task-detail-section">
              <h3 className="task-detail-section-title">Blocked Reason</h3>
              {isEditing ? (
                <input
                  type="text"
                  value={blockedReason}
                  onChange={(e) => setBlockedReason(e.target.value)}
                  className="task-detail-inline-input task-detail-inline-input-full"
                  placeholder="Why is this stuck?"
                />
              ) : (
                <div className="task-detail-blocked">
                  {task.blockedReason}
                </div>
              )}
            </div>
          )}

          {/* Agent Instructions */}
          <div className="task-detail-section">
            <h3 className="task-detail-section-title">Agent Instructions</h3>
            {isEditing ? (
              <textarea
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                className="task-detail-textarea"
                placeholder="Instructions for the agent (supports markdown)..."
                rows={6}
              />
            ) : (
              task.description ? (
                <div className="task-detail-markdown-stack">
                  {parsedDescription.overviewMarkdown && (
                    <div
                      className="task-detail-description task-detail-markdown"
                      onClick={handleMarkdownLinkClick}
                      dangerouslySetInnerHTML={{ __html: renderedOverviewHtml }}
                    />
                  )}
                  {(reviewCriteria.length > 0 || definitionOfDoneList.length > 0 || constraintsList.length > 0 || parsedDescription.definitionOfDone.length > 0 || parsedDescription.constraints.length > 0) && (
                    <div className="task-detail-callout-grid">
                      {reviewCriteria.length > 0 && (
                        <div className="task-detail-callout-card">
                          <h4 className="task-detail-callout-title">Automated Review Success Criteria</h4>
                          <div className="task-detail-callout-table" role="list">
                            {reviewCriteria.map((item, index) => (
                              <div key={`review-criteria-${index}`} className="task-detail-callout-row" role="listitem">
                                <span className="task-detail-callout-key">{index + 1}</span>
                                <span className="task-detail-callout-value">{item}</span>
                              </div>
                            ))}
                          </div>
                        </div>
                      )}
                      {(definitionOfDoneList.length > 0 || parsedDescription.definitionOfDone.length > 0) && (
                        <div className="task-detail-callout-card">
                          <h4 className="task-detail-callout-title">Definition of Done</h4>
                          <div className="task-detail-callout-table" role="list">
                            {(parsedDescription.definitionOfDone.length > 0 ? parsedDescription.definitionOfDone : definitionOfDoneList).map((item, index) => (
                              <div key={`dod-${index}`} className="task-detail-callout-row" role="listitem">
                                <span className="task-detail-callout-key">{index + 1}</span>
                                <span className="task-detail-callout-value">{item}</span>
                              </div>
                            ))}
                          </div>
                        </div>
                      )}
                      {(constraintsList.length > 0 || parsedDescription.constraints.length > 0) && (
                        <div className="task-detail-callout-card">
                          <h4 className="task-detail-callout-title">Constraints</h4>
                          <div className="task-detail-callout-table" role="list">
                            {(parsedDescription.constraints.length > 0 ? parsedDescription.constraints : constraintsList).map((item, index) => (
                              <div key={`constraint-${index}`} className="task-detail-callout-row" role="listitem">
                                <span className="task-detail-callout-key">{index + 1}</span>
                                <span className="task-detail-callout-value">{item}</span>
                              </div>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                  )}
                  {renderedAdditionalSections.map((section) => (
                    <div key={section.title} className="task-detail-additional-section">
                      <h4 className="task-detail-subsection-title">{section.title}</h4>
                      <div
                        className="task-detail-description task-detail-markdown"
                        onClick={handleMarkdownLinkClick}
                        dangerouslySetInnerHTML={{ __html: section.html }}
                      />
                    </div>
                  ))}
                </div>
              ) : (
                <div className="task-detail-field-empty">No instructions</div>
              )
            )}
          </div>

          {/* Notes */}
          <div className="task-detail-section">
            <h3 className="task-detail-section-title">Notes</h3>
            {isEditing ? (
              <textarea
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                className="task-detail-textarea"
                placeholder="Working notes, findings, blockers..."
                rows={4}
              />
            ) : (
              task.notes ? (
                <div className="task-detail-notes">
                  <FileText size={14} />
                  <span>{task.notes}</span>
                </div>
              ) : (
                <div className="task-detail-field-empty">No notes</div>
              )
            )}
          </div>

          <div className="task-detail-section">
            <h3 className="task-detail-section-title">Reviewer Settings</h3>
            {isEditing ? (
              <div className="task-detail-callout-grid">
                <div className="task-detail-callout-card">
                  <h4 className="task-detail-callout-title">Success Criteria</h4>
                  <textarea
                    value={successCriteria}
                    onChange={(e) => setSuccessCriteria(e.target.value)}
                    className="task-detail-textarea"
                    placeholder="One item per line or separated by semicolons"
                    rows={4}
                  />
                </div>
                <div className="task-detail-callout-card">
                  <h4 className="task-detail-callout-title">Retry Budget</h4>
                  <input
                    type="number"
                    min={1}
                    max={10}
                    value={maxRetries}
                    onChange={(e) => setMaxRetries(e.target.value)}
                    className="task-detail-inline-input"
                  />
                  <div className="task-detail-field-empty">Automated reviewer escalates after this many failed attempts.</div>
                </div>
              </div>
            ) : reviewCriteria.length > 0 || task.reviewHistory?.length || task.maxRetries !== undefined ? (
              <div className="task-detail-callout-grid">
                <div className="task-detail-callout-card">
                  <h4 className="task-detail-callout-title">Success Criteria</h4>
                  <div className="task-detail-callout-table" role="list">
                    {reviewCriteria.length > 0 ? reviewCriteria.map((item, index) => (
                      <div key={`review-setting-${index}`} className="task-detail-callout-row" role="listitem">
                        <span className="task-detail-callout-key">{index + 1}</span>
                        <span className="task-detail-callout-value">{item}</span>
                      </div>
                    )) : (
                      <div className="task-detail-callout-row" role="listitem">
                        <span className="task-detail-callout-key">—</span>
                        <span className="task-detail-callout-value">No explicit automated review criteria</span>
                      </div>
                    )}
                  </div>
                </div>
                <div className="task-detail-callout-card">
                  <h4 className="task-detail-callout-title">Review State</h4>
                  <div className="task-detail-callout-table" role="list">
                    <div className="task-detail-callout-row" role="listitem">
                      <span className="task-detail-callout-key">Status</span>
                      <span className="task-detail-callout-value">
                        {task.status === 'review' ? '🟡 Review in progress' : task.needsReview ? '🔴 Needs human review' : latestReviewEntry ? `✅ Last decision: ${latestReviewEntry.decision}` : '—'}
                      </span>
                    </div>
                    <div className="task-detail-callout-row" role="listitem">
                      <span className="task-detail-callout-key">Attempts</span>
                      <span className="task-detail-callout-value">{task.attemptCount ?? 0} / {task.maxRetries ?? 3}</span>
                    </div>
                  </div>
                </div>
              </div>
            ) : (
              <div className="task-detail-field-empty">No automated reviewer settings configured</div>
            )}
          </div>

          {/* Subtasks */}
          {(hasSubtasks || isEditing) && (
            <div className="task-detail-section">
              <h3 className="task-detail-section-title">
                Subtasks (
                  {completedSubtasks > 0 && <span className="subtask-count-completed">✅{completedSubtasks}</span>}
                  {inReviewSubtasks > 0 && <span className="subtask-count-review">🔄{inReviewSubtasks}</span>}
                  {(subtaskCounts.empty || 0) > 0 && <span className="subtask-count-new">⬜{subtaskCounts.empty}</span>}
                )
              </h3>
              {isEditing ? (
                <div className="task-detail-edit-subtasks">
                  {subtasks.map((subtask, idx) => {
                    const st = getSubtaskStatus(subtask);
                    const statusIcon = st === 'completed' ? <Check size={12} />
                      : st === 'review' ? <Clock size={12} />
                      : <Circle size={10} />;
                    return (
                      <div key={subtask.id} className={`task-detail-edit-subtask-item status-${st}`}>
                        <span className="task-detail-subtask-index">{idx}</span>
                        <button
                          type="button"
                          className={`task-detail-subtask-check status-${st}`}
                          onClick={() => handleEditSubtaskToggle(subtask.id)}
                          title={`Status: ${st} (click to cycle)`}
                        >
                          {statusIcon}
                        </button>
                        <span className={`task-detail-subtask-text status-${st}`}>
                          {subtask.text}
                        </span>
                        {subtask.reviewNote && (
                          <span className="task-detail-review-note" title={subtask.reviewNote}>💬</span>
                        )}
                        <button
                          type="button"
                          className="task-detail-subtask-remove"
                          onClick={() => handleRemoveSubtask(subtask.id)}
                        >
                          <Trash2 size={14} />
                        </button>
                      </div>
                    );
                  })}
                  <div className="task-detail-subtask-add">
                    <input
                      type="text"
                      value={newSubtask}
                      onChange={(e) => setNewSubtask(e.target.value)}
                      onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); handleAddSubtask(); } }}
                      className="task-detail-inline-input"
                      placeholder="Add subtask... (Enter to add)"
                    />
                    <button type="button" className="task-detail-add-btn" onClick={handleAddSubtask}>
                      <Plus size={16} />
                    </button>
                  </div>
                </div>
              ) : (
                <SubtaskList
                  subtasks={task.subtasks}
                  onToggle={onSubtaskToggle}
                  onStatusChange={onSubtaskStatusChange}
                  onEditText={onSubtaskEdit}
                  onReorder={onSubtaskReorder}
                />
              )}
            </div>
          )}

          {/* Links */}
          {(hasLinks || isEditing) && (
            <div className="task-detail-section">
              <h3 className="task-detail-section-title">Links ({(isEditing ? links : task.links || []).length})</h3>
              {isEditing ? (
                <div className="task-detail-edit-links">
                  {links.map((link, i) => (
                    <div key={i} className="task-detail-edit-link-item">
                      <span className="task-detail-link-icon">
                        {LINK_TYPE_OPTIONS.find(o => o.value === link.type)?.icon || '📄'}
                      </span>
                      <span className="task-detail-link-title-text">{link.title}</span>
                      <span className="task-detail-link-url-text" title={link.url}>
                        {link.url.length > 40 ? link.url.substring(0, 40) + '...' : link.url}
                      </span>
                      <button
                        type="button"
                        className="task-detail-subtask-remove"
                        onClick={() => handleRemoveLink(i)}
                      >
                        <Trash2 size={14} />
                      </button>
                    </div>
                  ))}
                  <div className="task-detail-link-add">
                    <select
                      value={newLinkType}
                      onChange={(e) => setNewLinkType(e.target.value as TaskLinkType)}
                      className="task-detail-inline-select task-detail-link-type-select"
                    >
                      {LINK_TYPE_OPTIONS.map(opt => (
                        <option key={opt.value} value={opt.value}>{opt.icon} {opt.label}</option>
                      ))}
                    </select>
                    <input
                      type="text"
                      value={newLinkTitle}
                      onChange={(e) => setNewLinkTitle(e.target.value)}
                      className="task-detail-inline-input"
                      placeholder="Link title"
                    />
                    <input
                      type="text"
                      value={newLinkUrl}
                      onChange={(e) => setNewLinkUrl(e.target.value)}
                      onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); handleAddLink(); } }}
                      className="task-detail-inline-input"
                      placeholder="URL or path"
                    />
                    <button type="button" className="task-detail-add-btn" onClick={handleAddLink}>
                      <Plus size={16} />
                    </button>
                  </div>
                </div>
              ) : (
                <TaskLinks links={task.links} />
              )}
            </div>
          )}

          {/* Task Resources (Phase 3 — view only) */}
          {!isEditing && task.taskResources && (
            <div className="task-detail-section">
              <h3 className="task-detail-section-title">Task Resources</h3>
              <TaskResourcesSection resources={task.taskResources} />
            </div>
          )}

          {/* Task Dependencies */}
          {(isEditing || ((task.blockingTasks && task.blockingTasks.length > 0) || (task.dependentTasks && task.dependentTasks.length > 0) || (task.dependsOn && task.dependsOn.length > 0))) && (
            <div className="task-detail-section">
              <h3 className="task-detail-section-title">
                <Link size={16} /> Dependencies
                {!isEditing && task.blocked && <span className="task-detail-dep-blocked-badge">🔒 BLOCKED</span>}
              </h3>
              {isEditing ? (
                <div className="task-detail-edit-dependencies">
                  {dependsOn.map((depId) => {
                    const depTask = dependencyTaskMap.get(depId);
                    return (
                      <div key={depId} className="task-detail-edit-dep-item">
                        <span className="task-detail-edit-dep-title">
                          {depTask ? `${depTask.title} (${depTask.status})` : `Task ${depId.substring(0, 8)}`}
                        </span>
                        <button
                          type="button"
                          className="task-detail-subtask-remove"
                          onClick={() => handleRemoveDependency(depId)}
                          title="Remove dependency"
                        >
                          <Trash2 size={14} />
                        </button>
                      </div>
                    );
                  })}
                  <div className="task-detail-dep-add">
                    <input
                      type="text"
                      value={dependencySearch}
                      onChange={(e) => {
                        setDependencySearch(e.target.value);
                        setDependencyPickerOpen(true);
                      }}
                      onFocus={() => setDependencyPickerOpen(true)}
                      onBlur={() => window.setTimeout(() => setDependencyPickerOpen(false), 150)}
                      className="task-detail-inline-input task-detail-inline-input-full"
                      placeholder="Search by title or task ID"
                      aria-label="Search tasks to add as dependency"
                    />
                    {dependencyPickerOpen && (
                      <div className="task-detail-dep-dropdown">
                        {dependencyLoading && (
                          <div className="task-detail-dep-empty">
                            {debouncedDependencySearch ? 'Searching tasks...' : 'Loading recent tasks...'}
                          </div>
                        )}
                        {!dependencyLoading && dependencyResults.map(t => (
                          <button
                            key={t.id}
                            type="button"
                            className="task-detail-dep-option"
                            onMouseDown={(e) => e.preventDefault()}
                            onClick={() => handleAddDependency(t.id)}
                          >
                            <span className="task-detail-dep-option-title">{t.title}</span>
                            <span className="task-detail-dep-option-meta">
                              {t.status} • {t.project || 'No project'} • {t.id.substring(0, 8)}
                            </span>
                          </button>
                        ))}
                        {!dependencyLoading && dependencyFetchError && (
                          <div className="task-detail-dep-empty">{dependencyFetchError}</div>
                        )}
                        {!dependencyLoading && !dependencyFetchError && dependencyResults.length === 0 && (
                          <div className="task-detail-dep-empty">
                            {debouncedDependencySearch
                              ? 'No tasks match that title or ID yet'
                              : 'No recent tasks available to suggest'}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              ) : (
                <div className="task-detail-dependencies">
                  {task.blockingTasks && task.blockingTasks.length > 0 && (
                    <div className="task-detail-dep-group">
                      <div className="task-detail-dep-group-label">
                        <Lock size={14} /> Depends on ({task.blockingTasks.length} incomplete)
                      </div>
                      {task.blockingTasks.map((dep) => (
                        <div key={dep.id} className="task-detail-dep-item task-detail-dep-blocking">
                          <ArrowRight size={12} />
                          <span className="task-detail-dep-title">{dep.title}</span>
                          <code className="task-detail-dep-id">{dep.id.substring(0, 8)}</code>
                        </div>
                      ))}
                    </div>
                  )}
                  {task.dependsOn && task.dependsOn.length > 0 && task.blockingTasks && (
                    (() => {
                      const blockingIds = new Set(task.blockingTasks.map(t => t.id));
                      const completedDeps = task.dependsOn!.filter(id => !blockingIds.has(id));
                      if (completedDeps.length === 0) return null;
                      return (
                        <div className="task-detail-dep-group">
                          <div className="task-detail-dep-group-label task-detail-dep-completed-label">
                            <CheckCircle size={14} /> Completed dependencies ({completedDeps.length})
                          </div>
                          {completedDeps.map((depId) => (
                            <div key={depId} className="task-detail-dep-item task-detail-dep-completed">
                              <CheckCircle size={12} />
                              <code className="task-detail-dep-id">{depId.substring(0, 8)}</code>
                            </div>
                          ))}
                        </div>
                      );
                    })()
                  )}
                  {task.dependentTasks && task.dependentTasks.length > 0 && (
                    <div className="task-detail-dep-group">
                      <div className="task-detail-dep-group-label task-detail-dep-blocks-label">
                        <Link size={14} /> Blocks ({task.dependentTasks.length})
                      </div>
                      {task.dependentTasks.map((dep) => (
                        <div key={dep.id} className="task-detail-dep-item task-detail-dep-dependent">
                          <ArrowRight size={12} />
                          <span className="task-detail-dep-title">{dep.title}</span>
                          <code className="task-detail-dep-id">{dep.id.substring(0, 8)}</code>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          {/* Blocked By (legacy manual blockers — view only) */}
          {!isEditing && task.blockedBy && task.blockedBy.length > 0 && (
            <div className="task-detail-section">
              <h3 className="task-detail-section-title">Blocked By</h3>
              <div className="task-detail-blocked-by">
                {task.blockedBy.map((id, i) => (
                  <span key={i} className="task-detail-blocked-id">{id}</span>
                ))}
              </div>
            </div>
          )}

          {/* Timeline */}
          <div className="task-detail-section">
            <h3 className="task-detail-section-title">Timeline</h3>
            <div className="task-detail-timestamps">
              <div className="task-detail-timestamp">
                <Calendar size={14} />
                <span className="task-detail-timestamp-label">Created:</span>
                <span className="task-detail-timestamp-value">{formatDate(task.created)}</span>
              </div>
              <div className="task-detail-timestamp">
                <Clock size={14} />
                <span className="task-detail-timestamp-label">Updated:</span>
                <span className="task-detail-timestamp-value">{formatDate(task.updated)}</span>
              </div>
              {task.startedAt && (
                <div className="task-detail-timestamp">
                  <Clock size={14} />
                  <span className="task-detail-timestamp-label">Started:</span>
                  <span className="task-detail-timestamp-value">{formatDate(task.startedAt)}</span>
                </div>
              )}
              {task.completedAt && (
                <div className="task-detail-timestamp">
                  <Clock size={14} />
                  <span className="task-detail-timestamp-label">Completed:</span>
                  <span className="task-detail-timestamp-value">{formatDate(task.completedAt)}</span>
                </div>
              )}
              {task.archivedAt && (
                <div className="task-detail-timestamp">
                  <Clock size={14} />
                  <span className="task-detail-timestamp-label">Archived:</span>
                  <span className="task-detail-timestamp-value">{formatDate(task.archivedAt)}</span>
                </div>
              )}
              {task.lastChecked && (
                <div className="task-detail-timestamp">
                  <Clock size={14} />
                  <span className="task-detail-timestamp-label">Last Checked:</span>
                  <span className="task-detail-timestamp-value">{formatDate(task.lastChecked)}</span>
                </div>
              )}
              {(task.attemptCount ?? 0) > 0 && (
                <div className="task-detail-timestamp">
                  <span className="task-detail-timestamp-label">🔁 Attempt:</span>
                  <span className="task-detail-timestamp-value">
                    #{task.attemptCount} {task.attemptCount! > 1 ? '(previously rejected)' : ''}
                  </span>
                </div>
              )}
            </div>
          </div>

          {task.reviewHistory && task.reviewHistory.length > 0 && (
            <div className="task-detail-section">
              <h3 className="task-detail-section-title">Review History ({task.reviewHistory.length})</h3>
              <div className="task-detail-callout-grid">
                {[...task.reviewHistory].slice().reverse().map((entry) => (
                  <div key={entry.id} className="task-detail-callout-card">
                    <h4 className="task-detail-callout-title">{entry.decision.toUpperCase()} · {formatDateTimeLong(entry.createdAt, entry.createdAt)}</h4>
                    <div className="task-detail-callout-table" role="list">
                      <div className="task-detail-callout-row" role="listitem">
                        <span className="task-detail-callout-key">Summary</span>
                        <span className="task-detail-callout-value">{entry.summary}</span>
                      </div>
                      <div className="task-detail-callout-row" role="listitem">
                        <span className="task-detail-callout-key">Transition</span>
                        <span className="task-detail-callout-value">{entry.statusBefore || '—'} → {entry.statusAfter || '—'}</span>
                      </div>
                      <div className="task-detail-callout-row" role="listitem">
                        <span className="task-detail-callout-key">Triggered By</span>
                        <span className="task-detail-callout-value">{entry.triggeredBy}</span>
                      </div>
                      {entry.findings.map((finding, index) => (
                        <div key={`${entry.id}-finding-${index}`} className="task-detail-callout-row" role="listitem">
                          <span className="task-detail-callout-key">{finding.severity}</span>
                          <span className="task-detail-callout-value">{finding.message}</span>
                        </div>
                      ))}
                      {entry.evidence?.reports?.length > 0 && (
                        <div className="task-detail-callout-row" role="listitem">
                          <span className="task-detail-callout-key">Reports</span>
                          <span className="task-detail-callout-value">{entry.evidence.reports.map(report => report.title).join(', ')}</span>
                        </div>
                      )}
                      {((entry.evidence?.testSignals?.length || 0) > 0) && (
                        <div className="task-detail-callout-row" role="listitem">
                          <span className="task-detail-callout-key">Test Signals</span>
                          <span className="task-detail-callout-value">{(entry.evidence?.testSignals || []).join(' | ')}</span>
                        </div>
                      )}
                      {((entry.evidence?.workspace?.changedFiles?.length || 0) > 0) && (
                        <div className="task-detail-callout-row" role="listitem">
                          <span className="task-detail-callout-key">Changed Files</span>
                          <span className="task-detail-callout-value">{(entry.evidence?.workspace?.changedFiles || []).join(', ')}</span>
                        </div>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Durable Task / Session Timeline */}
          {(timelineLoading || timelineError || timelineEvents.length > 0) && (
            <div className="task-detail-section">
              <h3 className="task-detail-section-title">Task Timeline {timelineEvents.length > 0 ? `(${timelineEvents.length})` : ''}</h3>
              {timelineLoading && <div className="task-detail-inline-status">Loading timeline…</div>}
              {timelineError && <div className="task-detail-inline-status task-detail-inline-status-error">{timelineError}</div>}
              {timelineEvents.length > 0 && (
                <div className="task-timeline-list">
                  {timelineEvents.map((event) => {
                    const Icon = getTimelineIcon(event.eventType);
                    const meta = renderTimelineMeta(event);
                    const sessionHref = event.sessionKey ? buildDashboardHref(`/sessions?focus=${encodeURIComponent(event.sessionKey)}`) : null;
                    return (
                      <div key={event.id} className={`task-timeline-item task-timeline-item-${getTimelineTone(event.eventType)}`}>
                        <div className="task-timeline-icon"><Icon size={14} /></div>
                        <div className="task-timeline-body">
                          <div className="task-timeline-header">
                            <div>
                              <div className="task-timeline-title">{event.title}</div>
                              <div className="task-timeline-time">{formatTimelineTimestamp(event.createdAt)}</div>
                            </div>
                            {sessionHref && event.sessionKey && (
                              <a
                                href={sessionHref}
                                className="task-detail-inline-link task-detail-ai-link"
                                target="_blank"
                                rel="noopener noreferrer"
                                title={`Open session ${event.sessionKey}`}
                              >
                                <span className="task-detail-ai-link-main">
                                  <ExternalLink size={13} />
                                  <span>Session</span>
                                </span>
                                <code className="task-detail-ai-link-detail">{event.sessionKey}</code>
                              </a>
                            )}
                          </div>
                          {event.description && <div className="task-timeline-description">{event.description}</div>}
                          {meta.length > 0 && (
                            <div className="task-timeline-meta">
                              {meta.map((item, index) => (
                                <span key={`${event.id}-meta-${index}`} className="task-timeline-chip">{item}</span>
                              ))}
                            </div>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}

          {/* Session References */}
          {task.sessionRefs && task.sessionRefs.length > 0 && timelineEvents.length === 0 && (
            <div className="task-detail-section">
              <h3 className="task-detail-section-title">Session History ({task.sessionRefs.length})</h3>
              <div className="task-detail-sessions">
                {task.sessionRefs.map((ref, i) => (
                  <div key={i} className="task-detail-session-ref">
                    💬 {ref}
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Delete button (edit mode only) */}
          {isEditing && onDelete && (
            <div className="task-detail-section task-detail-danger-zone">
              <button
                type="button"
                onClick={() => { if (confirm('Delete this task?')) { onDelete(task.id); onClose(); } }}
                className="task-detail-btn task-detail-btn-delete"
              >
                <Trash2 size={16} /> Delete Task
              </button>
            </div>
          )}
        </div>
      </div>
    </div>,
    document.body
  );
};
