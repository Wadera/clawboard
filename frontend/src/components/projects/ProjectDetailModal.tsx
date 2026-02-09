import { authenticatedFetch } from '../../utils/auth';
import React, { useState, useEffect, useCallback, useRef } from 'react';
import { X, Clock, CheckCircle2, Circle, Cpu, Calendar, Link as LinkIcon, GitBranch, FileText, Globe, Box, Plus, ExternalLink, AlertTriangle, Lightbulb, Archive, Play, Pencil, Clipboard, ScrollText, Settings, Trash2, ArchiveRestore, Wrench, Search, Unlink } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { useFocusTrap } from '../../hooks/useFocusTrap';
import { FileBrowser } from './FileBrowser';
import { TaskDetailModal } from '../tasks/TaskDetailModal';
import { EditTaskModal } from '../tasks/EditTaskModal';
import { ProjectResources } from './ProjectResources';
import { ProjectResourcesEditModal } from './ProjectResourcesEditModal';
import { ContextPreview } from './ContextPreview';
import { ConfirmationModal } from '../ConfirmationModal';
import { Project, ProjectLink, ProjectResources as ProjectResourcesType, ToolInstructions, LinkCategory } from '../../types/project';
import { Tool, ProjectToolLink } from '../../types/tool';
import { Task } from '../../types/task';
import { PROJECT_LINK_TYPES, LINK_CATEGORIES, getLinkTypeLabel, getLinkCategoryLabel } from '../../constants/linkTypes';
import './ProjectDetailModal.css';

interface AgentHistoryRecord {
  name: string;
  label: string;
  sessionKey: string;
  model?: string;
  startedAt: string;
  taskId: string;
  taskTitle?: string;
  completedAt?: string;
  outcome?: 'completed' | 'stuck' | 'error';
  durationMs?: number;
  tokenUsage?: {
    input: number;
    output: number;
    total: number;
  };
}

interface ProjectDetailModalProps {
  project: Project;
  onClose: () => void;
}

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || '/api';

export const ProjectDetailModal: React.FC<ProjectDetailModalProps> = ({ project, onClose }) => {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [sessions, setSessions] = useState<AgentHistoryRecord[]>([]);
  const [links, setLinks] = useState<ProjectLink[]>(project.links || []);
  const [loading, setLoading] = useState(true);
  const [sessionsLoading, setSessionsLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<'overview' | 'resources' | 'tasks' | 'sessions' | 'links' | 'files' | 'context' | 'tools'>('overview');
  const [showAddLink, setShowAddLink] = useState(false);
  const [showCreateTask, setShowCreateTask] = useState(false);
  const [newLink, setNewLink] = useState({ type: 'url' as ProjectLink['type'], title: '', url: '', category: '' as LinkCategory | '' });
  const [newTask, setNewTask] = useState({ title: '', description: '', priority: 'medium' as string });
  const [selectedTask, setSelectedTask] = useState<Task | null>(null);
  const [editingTask, setEditingTask] = useState<Task | null>(null);
  const navigate = useNavigate();
  const modalRef = useRef<HTMLDivElement>(null);
  useFocusTrap(modalRef);
  const [editingLink, setEditingLink] = useState<ProjectLink | null>(null);
  const [editLinkData, setEditLinkData] = useState({ type: 'url' as ProjectLink['type'], title: '', url: '', category: '' as LinkCategory | '' });
  const [toast, setToast] = useState<string | null>(null);
  const [contextData, setContextData] = useState<{ agent: any; orchestrator: any }>({ agent: null, orchestrator: null });
  const [_contextLoading, setContextLoading] = useState(false);
  const [briefModal, setBriefModal] = useState<{ brief: string; taskTitle: string } | null>(null);
  const [briefLoading, setBriefLoading] = useState<string | null>(null);
  const [showResourcesEdit, setShowResourcesEdit] = useState(false);
  const [projectResources, setProjectResources] = useState<ProjectResourcesType | undefined>(project.resources);
  const [projectToolInstructions, setProjectToolInstructions] = useState<ToolInstructions | undefined>(project.toolInstructions);
  
  // Archive/Delete/Status state
  const [showArchiveConfirm, setShowArchiveConfirm] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState<'preview' | 'confirm' | null>(null);
  const [deletePreview, setDeletePreview] = useState<{ tasks: number; sessions: number } | null>(null);
  const [deletePreviewLoading, setDeletePreviewLoading] = useState(false);
  const [currentProjectStatus, setCurrentProjectStatus] = useState(project.status);
  const [isHidden, setIsHidden] = useState(!!project.is_hidden);
  
  // Project tools state
  const [projectTools, setProjectTools] = useState<ProjectToolLink[]>([]);
  const [projectToolsLoading, setProjectToolsLoading] = useState(false);
  const [allTools, setAllTools] = useState<Tool[]>([]);
  const [showToolPicker, setShowToolPicker] = useState(false);
  const [toolSearchQuery, setToolSearchQuery] = useState('');
  const [editingOverride, setEditingOverride] = useState<string | null>(null);
  const [overrideText, setOverrideText] = useState('');
  
  // Description editing state
  const [editingDescription, setEditingDescription] = useState(false);
  const [editedDescription, setEditedDescription] = useState(project.description || '');
  const [savingDescription, setSavingDescription] = useState(false);
  
  // Compute stats from actual task data instead of SQL-based project.stats
  const computedStats = React.useMemo(() => {
    if (tasks.length === 0 && loading) return project.stats; // fallback while loading
    const total_tasks = tasks.length;
    const completed_tasks = tasks.filter(t => t.status === 'completed').length;
    const in_progress_tasks = tasks.filter(t => t.status === 'in-progress').length;
    const active_agents = new Set(tasks.filter(t => t.activeAgent).map(t => typeof t.activeAgent === 'string' ? t.activeAgent : t.activeAgent!.name)).size;
    // Find last activity
    let last_activity: string | null = null;
    for (const t of tasks) {
      const ts = t.completedAt || t.startedAt || t.created;
      if (ts && (!last_activity || ts > last_activity)) last_activity = ts;
    }
    return { total_tasks, completed_tasks, in_progress_tasks, active_agents, last_activity };
  }, [tasks, loading, project.stats]);
  const stats = computedStats;
  
  useEffect(() => {
    fetchProjectTasks();
    fetchProjectLinks();
    fetchProjectSessions();
  }, [project.id]);
  
  const fetchProjectTasks = async () => {
    try {
      setLoading(true);
      const response = await authenticatedFetch(`${API_BASE_URL}/tasks?project=${encodeURIComponent(project.name)}`);
      const data = await response.json();
      if (data.success) {
        setTasks(data.tasks || []);
      }
    } catch (error) {
      console.error('Failed to fetch project tasks:', error);
    } finally {
      setLoading(false);
    }
  };
  
  const fetchProjectSessions = async () => {
    try {
      setSessionsLoading(true);
      // Fetch all agent history, then filter by task IDs belonging to this project
      const [historyRes, tasksRes] = await Promise.all([
        authenticatedFetch(`${API_BASE_URL}/agents/history`),
        authenticatedFetch(`${API_BASE_URL}/tasks?project=${encodeURIComponent(project.name)}`)
      ]);
      const history: AgentHistoryRecord[] = await historyRes.json();
      const tasksData = await tasksRes.json();
      
      if (Array.isArray(history) && tasksData.success) {
        const taskIds = new Set((tasksData.tasks || []).map((t: Task) => t.id));
        const projectSessions = history.filter(h => taskIds.has(h.taskId));
        // Sort by startedAt descending
        projectSessions.sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime());
        setSessions(projectSessions);
      }
    } catch (error) {
      console.error('Failed to fetch sessions:', error);
    } finally {
      setSessionsLoading(false);
    }
  };
  
  const fetchProjectLinks = async () => {
    try {
      const response = await authenticatedFetch(`${API_BASE_URL}/projects/${project.id}`);
      const data = await response.json();
      if (data.success) {
        // Update links
        if (data.project.links) {
          setLinks(data.project.links);
        }
        // Also update resources and tool instructions from the fetched project
        if (data.project.resources) {
          setProjectResources(data.project.resources);
        }
        if (data.project.toolInstructions) {
          setProjectToolInstructions(data.project.toolInstructions);
        }
      }
    } catch (error) {
      console.error('Failed to fetch project links:', error);
    }
  };
  
  const fetchProjectTools = useCallback(async () => {
    try {
      setProjectToolsLoading(true);
      const response = await authenticatedFetch(`${API_BASE_URL}/projects/${project.id}/tools`);
      const data = await response.json();
      if (data.success) {
        setProjectTools(data.tools || []);
      }
    } catch (error) {
      console.error('Failed to fetch project tools:', error);
    } finally {
      setProjectToolsLoading(false);
    }
  }, [project.id]);

  const showToast = useCallback((msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(null), 2500);
  }, []);

  const fetchAllTools = useCallback(async () => {
    try {
      const response = await authenticatedFetch(`${API_BASE_URL}/tools`);
      const data = await response.json();
      if (data.success) {
        setAllTools(data.tools || []);
      }
    } catch (error) {
      console.error('Failed to fetch all tools:', error);
    }
  }, []);

  const handleLinkTool = useCallback(async (toolId: string, overrideInstructions?: string) => {
    const existingTools = projectTools.map(pt => ({
      tool_id: pt.tool_id,
      override_instructions: pt.override_instructions || undefined,
    }));
    const newTools = [...existingTools, { tool_id: toolId, override_instructions: overrideInstructions }];
    try {
      const response = await authenticatedFetch(`${API_BASE_URL}/projects/${project.id}/tools`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tools: newTools }),
      });
      const data = await response.json();
      if (data.success) {
        setProjectTools(data.tools || []);
        setShowToolPicker(false);
        setToolSearchQuery('');
        showToast('Tool linked successfully');
      }
    } catch (error) {
      console.error('Failed to link tool:', error);
      showToast('Failed to link tool');
    }
  }, [project.id, projectTools, showToast]);

  const handleUnlinkTool = useCallback(async (toolId: string) => {
    const updatedTools = projectTools
      .filter(pt => pt.tool_id !== toolId)
      .map(pt => ({
        tool_id: pt.tool_id,
        override_instructions: pt.override_instructions || undefined,
      }));
    try {
      const response = await authenticatedFetch(`${API_BASE_URL}/projects/${project.id}/tools`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tools: updatedTools }),
      });
      const data = await response.json();
      if (data.success) {
        setProjectTools(data.tools || []);
        showToast('Tool unlinked');
      }
    } catch (error) {
      console.error('Failed to unlink tool:', error);
      showToast('Failed to unlink tool');
    }
  }, [project.id, projectTools, showToast]);

  const handleSaveOverride = useCallback(async (toolId: string) => {
    const updatedTools = projectTools.map(pt => ({
      tool_id: pt.tool_id,
      override_instructions: pt.tool_id === toolId ? (overrideText.trim() || undefined) : (pt.override_instructions || undefined),
    }));
    try {
      const response = await authenticatedFetch(`${API_BASE_URL}/projects/${project.id}/tools`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tools: updatedTools }),
      });
      const data = await response.json();
      if (data.success) {
        setProjectTools(data.tools || []);
        setEditingOverride(null);
        showToast('Override saved');
      }
    } catch (error) {
      console.error('Failed to save override:', error);
      showToast('Failed to save override');
    }
  }, [project.id, projectTools, overrideText, showToast]);

  const handleAddLink = async () => {
    if (!newLink.title.trim() || !newLink.url.trim()) return;
    try {
      const linkData = {
        type: newLink.type,
        title: newLink.title,
        url: newLink.url,
        ...(newLink.category && { category: newLink.category })
      };
      const response = await authenticatedFetch(`${API_BASE_URL}/projects/${project.id}/links`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(linkData)
      });
      const data = await response.json();
      if (data.success) {
        setLinks([...links, data.link]);
        setNewLink({ type: 'url', title: '', url: '', category: '' });
        setShowAddLink(false);
      }
    } catch (error) {
      console.error('Failed to add link:', error);
    }
  };
  
  const handleEditLink = async () => {
    if (!editingLink || !editLinkData.title.trim() || !editLinkData.url.trim()) return;
    try {
      const linkData = {
        type: editLinkData.type,
        title: editLinkData.title,
        url: editLinkData.url,
        ...(editLinkData.category && { category: editLinkData.category })
      };
      const response = await authenticatedFetch(`${API_BASE_URL}/projects/${project.id}/links/${editingLink.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(linkData)
      });
      const data = await response.json();
      if (data.success) {
        setLinks(links.map(l => l.id === editingLink.id ? { ...l, ...linkData } : l));
        setEditingLink(null);
      }
    } catch (error) {
      console.error('Failed to edit link:', error);
    }
  };
  
  const handleDeleteLink = async (linkId: string) => {
    try {
      const response = await authenticatedFetch(`${API_BASE_URL}/projects/${project.id}/links/${linkId}`, {
        method: 'DELETE'
      });
      const data = await response.json();
      if (data.success) {
        setLinks(links.filter(l => l.id !== linkId));
      }
    } catch (error) {
      console.error('Failed to delete link:', error);
    }
  };
  
  const handleCreateTask = async () => {
    if (!newTask.title.trim()) return;
    try {
      const response = await authenticatedFetch(`${API_BASE_URL}/tasks`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: newTask.title,
          description: newTask.description,
          priority: newTask.priority,
          project: project.name,
          status: 'todo'
        })
      });
      const data = await response.json();
      if (data.success) {
        setTasks([data.task, ...tasks]);
        setNewTask({ title: '', description: '', priority: 'medium' });
        setShowCreateTask(false);
      }
    } catch (error) {
      console.error('Failed to create task:', error);
    }
  };
  
  const copyToClipboard = useCallback(async (text: string, label: string) => {
    try {
      await navigator.clipboard.writeText(text);
      showToast(`${label} copied to clipboard!`);
    } catch {
      showToast('Failed to copy');
    }
  }, [showToast]);

  const fetchContext = useCallback(async (role: 'agent' | 'orchestrator') => {
    try {
      const res = await authenticatedFetch(`${API_BASE_URL}/projects/${project.id}/context?role=${role}`);
      const data = await res.json();
      if (data.success) {
        setContextData(prev => ({ ...prev, [role]: data.context }));
        return data.context;
      }
    } catch (err) {
      console.error('Failed to fetch context:', err);
    }
    return null;
  }, [project.id]);

  const handleCopyContext = useCallback(async (role: 'agent' | 'orchestrator') => {
    const ctx = contextData[role] || await fetchContext(role);
    if (ctx) {
      copyToClipboard(JSON.stringify(ctx, null, 2), `${role.charAt(0).toUpperCase() + role.slice(1)} context`);
    }
  }, [contextData, fetchContext, copyToClipboard]);

  const handleLoadContextTab = useCallback(async () => {
    setContextLoading(true);
    await Promise.all([fetchContext('agent'), fetchContext('orchestrator')]);
    setContextLoading(false);
  }, [fetchContext]);

  const handleGenerateBrief = useCallback(async (taskId: string, taskTitle: string) => {
    setBriefLoading(taskId);
    try {
      const res = await authenticatedFetch(`${API_BASE_URL}/projects/${project.id}/generate-brief`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ taskId })
      });
      const data = await res.json();
      if (data.success) {
        setBriefModal({ brief: data.brief, taskTitle });
      } else {
        showToast('Failed to generate brief');
      }
    } catch {
      showToast('Failed to generate brief');
    } finally {
      setBriefLoading(null);
    }
  }, [project.id, showToast]);

  const handleSaveResources = useCallback(async (resources: ProjectResourcesType, toolInstructions: ToolInstructions) => {
    // Save resources and tool instructions via their dedicated endpoints
    const [resResources, resTools] = await Promise.all([
      authenticatedFetch(`${API_BASE_URL}/projects/${project.id}/resources`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(resources)
      }),
      authenticatedFetch(`${API_BASE_URL}/projects/${project.id}/tool-instructions`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(toolInstructions)
      })
    ]);
    const dataResources = await resResources.json();
    const dataTools = await resTools.json();
    if (!dataResources.success || !dataTools.success) {
      throw new Error(dataResources.error || dataTools.error || 'Failed to save resources');
    }
    setProjectResources(resources);
    setProjectToolInstructions(toolInstructions);
    showToast('Resources saved successfully');
  }, [project.id, showToast]);

  const handleStatusChange = useCallback(async (newStatus: 'active' | 'completed' | 'archived' | 'paused') => {
    try {
      const response = await authenticatedFetch(`${API_BASE_URL}/projects/${project.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: newStatus })
      });
      const data = await response.json();
      if (data.success) {
        setCurrentProjectStatus(newStatus);
        showToast(`Project status changed to ${newStatus}`);
      } else {
        showToast(data.error || 'Failed to update project status');
      }
    } catch (error) {
      console.error('Failed to update project status:', error);
      showToast('Failed to update project status');
    }
  }, [project.id, showToast]);

  const handleSecretToggle = useCallback(async () => {
    const newHidden = !isHidden;
    try {
      const response = await authenticatedFetch(`${API_BASE_URL}/projects/${project.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ is_hidden: newHidden })
      });
      const data = await response.json();
      if (data.success) {
        setIsHidden(newHidden);
        showToast(newHidden ? 'Project marked as secret 🔒' : 'Project is now visible');
      } else {
        showToast(data.error || 'Failed to toggle secret status');
      }
    } catch (error) {
      console.error('Failed to toggle secret status:', error);
      showToast('Failed to toggle secret status');
    }
  }, [project.id, isHidden, showToast]);

  const handleArchiveToggle = useCallback(async () => {
    const newStatus = currentProjectStatus === 'archived' ? 'active' : 'archived';
    try {
      const response = await authenticatedFetch(`${API_BASE_URL}/projects/${project.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: newStatus })
      });
      const data = await response.json();
      if (data.success) {
        setCurrentProjectStatus(newStatus);
        showToast(`Project ${newStatus === 'archived' ? 'archived' : 'restored'} successfully`);
        setShowArchiveConfirm(false);
        setTimeout(() => onClose(), 1000);
      } else {
        showToast(data.error || 'Failed to update project status');
      }
    } catch (error) {
      console.error('Failed to update project status:', error);
      showToast('Failed to update project status');
    }
  }, [project.id, currentProjectStatus, showToast, onClose]);

  const handleSaveDescription = useCallback(async () => {
    setSavingDescription(true);
    try {
      const response = await authenticatedFetch(`${API_BASE_URL}/projects/${project.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ description: editedDescription })
      });
      const data = await response.json();
      if (data.success) {
        setEditingDescription(false);
        showToast('Description updated');
      } else {
        showToast(data.error || 'Failed to update description');
      }
    } catch (error) {
      console.error('Failed to update description:', error);
      showToast('Failed to update description');
    } finally {
      setSavingDescription(false);
    }
  }, [project.id, editedDescription, showToast]);

  const handleCancelDescription = useCallback(() => {
    setEditedDescription(project.description || '');
    setEditingDescription(false);
  }, [project.description]);

  const handleDeletePreview = useCallback(async () => {
    setDeletePreviewLoading(true);
    try {
      const response = await authenticatedFetch(`${API_BASE_URL}/projects/${project.id}/delete-preview`);
      const data = await response.json();
      if (data.success) {
        setDeletePreview({
          tasks: data.preview.tasks_count || 0,
          sessions: data.preview.sessions_count || 0
        });
        // Only show modal after data loads successfully
        setShowDeleteConfirm('confirm');
      } else {
        showToast(data.error || 'Failed to fetch delete preview');
      }
    } catch (error) {
      console.error('Failed to fetch delete preview:', error);
      showToast('Failed to fetch delete preview');
    } finally {
      setDeletePreviewLoading(false);
    }
  }, [project.id, showToast]);

  const handleDeleteProject = useCallback(async () => {
    try {
      const response = await authenticatedFetch(`${API_BASE_URL}/projects/${project.id}?confirm=true`, {
        method: 'DELETE'
      });
      const data = await response.json();
      if (data.success) {
        showToast('Project deleted successfully');
        setShowDeleteConfirm(null);
        setTimeout(() => onClose(), 1000);
      } else {
        showToast(data.error || 'Failed to delete project');
      }
    } catch (error) {
      console.error('Failed to delete project:', error);
      showToast('Failed to delete project');
    }
  }, [project.id, showToast, onClose]);

  const getStatusColor = (status: string): string => {
    switch (status) {
      case 'active': return 'status-active';
      case 'paused': return 'status-paused';
      case 'completed': return 'status-completed';
      case 'archived': return 'status-archived';
      default: return 'status-active';
    }
  };
  
  const getTaskStatusColor = (status: string): string => {
    switch (status) {
      case 'completed': return '#22c55e';
      case 'in-progress': return '#fbbf24';
      case 'stuck': return '#ef4444';
      case 'todo': return '#06b6d4';
      case 'ideas': return '#8b5cf6';
      case 'archived': return '#64748b';
      default: return '#64748b';
    }
  };
  
  const getTaskStatusIcon = (status: string) => {
    switch (status) {
      case 'completed': return <CheckCircle2 size={14} />;
      case 'in-progress': return <Play size={14} />;
      case 'stuck': return <AlertTriangle size={14} />;
      case 'todo': return <Circle size={14} />;
      case 'ideas': return <Lightbulb size={14} />;
      case 'archived': return <Archive size={14} />;
      default: return <Circle size={14} />;
    }
  };
  
  const getLinkIcon = (type: ProjectLink['type']) => {
    switch (type) {
      case 'git': return <GitBranch size={16} />;
      case 'doc': return <FileText size={16} />;
      case 'api': return <Box size={16} />;
      case 'project': return <LinkIcon size={16} />;
      case 'dashboard': return <Globe size={16} />;
      default: return <Globe size={16} />;
    }
  };
  
  const formatDate = (dateString: string): string => {
    const date = new Date(dateString);
    return date.toLocaleDateString('en-US', { 
      month: 'short', day: 'numeric', year: 'numeric',
      hour: '2-digit', minute: '2-digit'
    });
  };
  
  const formatDuration = (ms: number): string => {
    if (ms < 1000) return '<1s';
    const seconds = Math.floor(ms / 1000);
    if (seconds < 60) return `${seconds}s`;
    const minutes = Math.floor(seconds / 60);
    const remainSec = seconds % 60;
    if (minutes < 60) return `${minutes}m ${remainSec}s`;
    const hours = Math.floor(minutes / 60);
    const remainMin = minutes % 60;
    return `${hours}h ${remainMin}m`;
  };
  
  const formatTokens = (tokens: number): string => {
    if (tokens === 0) return '—';
    if (tokens < 1000) return String(tokens);
    return `${(tokens / 1000).toFixed(1)}k`;
  };
  
  const getOutcomeClass = (outcome?: string): string => {
    switch (outcome) {
      case 'completed': return 'outcome-completed';
      case 'stuck': return 'outcome-stuck';
      case 'error': return 'outcome-error';
      default: return 'outcome-running';
    }
  };
  
  const progressPercent = stats && stats.total_tasks > 0
    ? Math.round((stats.completed_tasks / stats.total_tasks) * 100)
    : 0;
  
  // Compute task breakdown by status
  const taskBreakdown = tasks.reduce((acc, task) => {
    acc[task.status] = (acc[task.status] || 0) + 1;
    return acc;
  }, {} as Record<string, number>);
  
  const statusOrder = ['completed', 'in-progress', 'stuck', 'todo', 'ideas', 'archived'];
  
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="project-detail-modal" ref={modalRef} onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div className="project-detail-header">
          <div className="project-detail-title">
            <h2>{project.name}</h2>
            <div className="project-detail-status-controls">
              <select
                className={`project-status-select ${getStatusColor(currentProjectStatus)}`}
                value={currentProjectStatus}
                onChange={(e) => handleStatusChange(e.target.value as 'active' | 'completed' | 'archived' | 'paused')}
              >
                <option value="active">🟢 Active</option>
                <option value="paused">⏸️ Paused</option>
                <option value="completed">✅ Completed</option>
                <option value="archived">📦 Archived</option>
              </select>
              <button
                className={`btn-secret-toggle ${isHidden ? 'is-secret' : ''}`}
                onClick={handleSecretToggle}
                title={isHidden ? 'Remove secret status' : 'Mark as secret project'}
              >
                {isHidden ? '🔒 Secret' : '👁️ Visible'}
              </button>
            </div>
          </div>
          <div className="project-detail-actions">
            <button className="btn-copy-context" onClick={() => handleCopyContext('agent')} title="Copy Agent Context">
              <Clipboard size={14} /> Agent
            </button>
            <button className="btn-copy-context btn-copy-orchestrator" onClick={() => handleCopyContext('orchestrator')} title="Copy Orchestrator Context">
              <Clipboard size={14} /> Orchestrator
            </button>
            <button 
              className={`btn-archive ${currentProjectStatus === 'archived' ? 'btn-restore' : ''}`}
              onClick={() => setShowArchiveConfirm(true)}
              title={currentProjectStatus === 'archived' ? 'Restore Project' : 'Archive Project'}
            >
              {currentProjectStatus === 'archived' ? <ArchiveRestore size={14} /> : <Archive size={14} />}
              {currentProjectStatus === 'archived' ? 'Restore' : 'Archive'}
            </button>
            <button 
              className="btn-delete-project"
              onClick={handleDeletePreview}
              disabled={deletePreviewLoading}
              title="Delete Project"
            >
              <Trash2 size={14} />
              {deletePreviewLoading ? 'Loading...' : 'Delete'}
            </button>
            <button className="modal-close" onClick={onClose}>
              <X size={24} />
            </button>
          </div>
        </div>
        
        {/* Description Editor */}
        <div className="project-detail-description-wrapper">
          {editingDescription ? (
            <div className="project-description-edit">
              <textarea
                value={editedDescription}
                onChange={(e) => setEditedDescription(e.target.value)}
                className="project-description-textarea"
                placeholder="Add a description for this project..."
                rows={3}
                autoFocus
              />
              <div className="project-description-actions">
                <button
                  onClick={handleCancelDescription}
                  className="btn-description-cancel"
                  disabled={savingDescription}
                >
                  Cancel
                </button>
                <button
                  onClick={handleSaveDescription}
                  className="btn-description-save"
                  disabled={savingDescription}
                >
                  {savingDescription ? 'Saving...' : 'Save'}
                </button>
              </div>
            </div>
          ) : (
            <div className="project-description-display">
              {project.description ? (
                <div className="project-detail-description">
                  {project.description}
                  <button
                    onClick={() => setEditingDescription(true)}
                    className="btn-edit-description"
                    title="Edit description"
                  >
                    <Pencil size={14} />
                  </button>
                </div>
              ) : (
                <div className="project-detail-description-empty" onClick={() => setEditingDescription(true)}>
                  <Pencil size={14} />
                  <span>Add description...</span>
                </div>
              )}
            </div>
          )}
        </div>
        
        {/* Tabs */}
        <div className="project-detail-tabs">
          <button className={`tab ${activeTab === 'overview' ? 'active' : ''}`} onClick={() => setActiveTab('overview')}>
            Overview
          </button>
          <button className={`tab ${activeTab === 'resources' ? 'active' : ''}`} onClick={() => setActiveTab('resources')}>
            <Settings size={14} /> Resources
          </button>
          <button className={`tab ${activeTab === 'tasks' ? 'active' : ''}`} onClick={() => setActiveTab('tasks')}>
            Tasks ({tasks.length})
          </button>
          <button className={`tab ${activeTab === 'sessions' ? 'active' : ''}`} onClick={() => setActiveTab('sessions')}>
            Sessions ({sessions.length})
          </button>
          <button className={`tab ${activeTab === 'links' ? 'active' : ''}`} onClick={() => setActiveTab('links')}>
            Links ({links.length})
          </button>
          <button className={`tab ${activeTab === 'files' ? 'active' : ''}`} onClick={() => setActiveTab('files')}>
            Files
          </button>
          <button className={`tab ${activeTab === 'tools' ? 'active' : ''}`} onClick={() => { setActiveTab('tools'); fetchProjectTools(); fetchAllTools(); }}>
            <Wrench size={14} /> Tools
          </button>
          <button className={`tab ${activeTab === 'context' ? 'active' : ''}`} onClick={() => { setActiveTab('context'); handleLoadContextTab(); }}>
            Context
          </button>
        </div>
        
        {/* Content */}
        <div className="project-detail-content">
          {/* Overview Tab */}
          {activeTab === 'overview' && (
            <div className="overview-tab">
              <div className="stats-grid">
                <div className="stat-card">
                  <div className="stat-icon stat-total"><Circle size={20} /></div>
                  <div className="stat-info">
                    <div className="stat-value">{stats?.total_tasks || 0}</div>
                    <div className="stat-label">Total Tasks</div>
                  </div>
                </div>
                <div className="stat-card">
                  <div className="stat-icon stat-progress"><Clock size={20} /></div>
                  <div className="stat-info">
                    <div className="stat-value">{stats?.in_progress_tasks || 0}</div>
                    <div className="stat-label">In Progress</div>
                  </div>
                </div>
                <div className="stat-card">
                  <div className="stat-icon stat-completed"><CheckCircle2 size={20} /></div>
                  <div className="stat-info">
                    <div className="stat-value">{stats?.completed_tasks || 0}</div>
                    <div className="stat-label">Completed</div>
                  </div>
                </div>
                <div className="stat-card">
                  <div className="stat-icon stat-agents"><Cpu size={20} /></div>
                  <div className="stat-info">
                    <div className="stat-value">{stats?.active_agents || 0}</div>
                    <div className="stat-label">Active Agents</div>
                  </div>
                </div>
              </div>
              
              {/* Progress Bar */}
              {stats && stats.total_tasks > 0 && (
                <div className="overview-progress">
                  <div className="overview-progress-header">
                    <span className="overview-progress-label">Overall Progress</span>
                    <span className="overview-progress-percent">{progressPercent}%</span>
                  </div>
                  <div className="overview-progress-bar">
                    <div className="overview-progress-fill" style={{ width: `${progressPercent}%` }} />
                  </div>
                  <div className="overview-progress-details">
                    <span>{stats.completed_tasks} of {stats.total_tasks} tasks completed</span>
                  </div>
                </div>
              )}
              
              {/* Task Status Breakdown */}
              {tasks.length > 0 && (
                <div className="task-breakdown">
                  <h3 className="breakdown-title">Task Breakdown</h3>
                  <div className="breakdown-bars">
                    {statusOrder.filter(s => taskBreakdown[s]).map(status => (
                      <div key={status} className="breakdown-row">
                        <div className="breakdown-label">
                          <span className="breakdown-status-icon" style={{ color: getTaskStatusColor(status) }}>
                            {getTaskStatusIcon(status)}
                          </span>
                          <span className="breakdown-status-name">{status}</span>
                          <span className="breakdown-count">{taskBreakdown[status]}</span>
                        </div>
                        <div className="breakdown-bar-track">
                          <div
                            className="breakdown-bar-fill"
                            style={{
                              width: `${(taskBreakdown[status] / tasks.length) * 100}%`,
                              backgroundColor: getTaskStatusColor(status)
                            }}
                          />
                        </div>
                      </div>
                    ))}
                  </div>
                  {/* Stacked bar visualization */}
                  <div className="breakdown-stacked">
                    {statusOrder.filter(s => taskBreakdown[s]).map(status => (
                      <div
                        key={status}
                        className="breakdown-stacked-segment"
                        style={{
                          width: `${(taskBreakdown[status] / tasks.length) * 100}%`,
                          backgroundColor: getTaskStatusColor(status)
                        }}
                        title={`${status}: ${taskBreakdown[status]}`}
                      />
                    ))}
                  </div>
                </div>
              )}
              
              {/* Metadata */}
              <div className="project-metadata">
                <div className="metadata-item">
                  <Calendar size={16} />
                  <span>Created: {formatDate(project.created_at)}</span>
                </div>
                <div className="metadata-item">
                  <Clock size={16} />
                  <span>Updated: {formatDate(project.updated_at)}</span>
                </div>
                {stats?.last_activity && (
                  <div className="metadata-item">
                    <Cpu size={16} />
                    <span>Last Activity: {formatDate(stats.last_activity)}</span>
                  </div>
                )}
              </div>
            </div>
          )}
          
          {/* Resources Tab - Phase 3 */}
          {activeTab === 'resources' && (
            <div className="resources-tab">
              {projectResources ? (
                <>
                  <div className="resources-tab-header">
                    <div>
                      <h3 className="resources-tab-title">Project Resources</h3>
                      <p className="resources-tab-subtitle">Repositories, environments, paths, notebooks, and tool instructions</p>
                    </div>
                    <button className="btn-edit-resources" onClick={() => setShowResourcesEdit(true)}>
                      <Settings size={14} /> Configure
                    </button>
                  </div>
                  <ProjectResources resources={projectResources} />
                </>
              ) : (
                <div className="tab-empty">
                  <Settings size={32} className="tab-empty-icon" />
                  <h3>No resources configured</h3>
                  <p>Add repositories, environments, paths, and tool instructions for this project.</p>
                  <button className="btn-edit-resources" onClick={() => setShowResourcesEdit(true)}>
                    <Settings size={14} /> Configure Resources
                  </button>
                </div>
              )}
            </div>
          )}
          
          {/* Tasks Tab */}
          {activeTab === 'tasks' && (
            <div className="tasks-tab">
              <div className="tasks-tab-header">
                <h3 className="tasks-tab-title">Project Tasks</h3>
                <button className="btn-create-task" onClick={() => setShowCreateTask(!showCreateTask)}>
                  <Plus size={16} />
                  Create Task
                </button>
              </div>
              
              {showCreateTask && (
                <div className="create-task-form">
                  <input
                    type="text"
                    placeholder="Task title"
                    value={newTask.title}
                    onChange={(e) => setNewTask({ ...newTask, title: e.target.value })}
                    className="create-task-input"
                    autoFocus
                  />
                  <textarea
                    placeholder="Description (optional)"
                    value={newTask.description}
                    onChange={(e) => setNewTask({ ...newTask, description: e.target.value })}
                    className="create-task-textarea"
                    rows={2}
                  />
                  <div className="create-task-actions">
                    <select
                      value={newTask.priority}
                      onChange={(e) => setNewTask({ ...newTask, priority: e.target.value })}
                      className="create-task-priority"
                    >
                      <option value="low">Low</option>
                      <option value="medium">Medium</option>
                      <option value="high">High</option>
                      <option value="critical">Critical</option>
                    </select>
                    <button className="btn-save-link" onClick={handleCreateTask}>Create</button>
                    <button className="btn-cancel-link" onClick={() => setShowCreateTask(false)}>Cancel</button>
                  </div>
                </div>
              )}
              
              {loading ? (
                <div className="tab-loading">Loading tasks...</div>
              ) : tasks.length === 0 ? (
                <div className="tab-empty">
                  <p>No tasks found for this project</p>
                  <p className="tab-empty-hint">Create a task and assign it to "{project.name}"</p>
                </div>
              ) : (
                <div className="tasks-list">
                  {tasks.map(task => (
                    <div key={task.id} className="task-item task-item-clickable" onClick={() => setSelectedTask(task)}>
                      <div className="task-item-header">
                        <div className="task-status-dot" style={{ backgroundColor: getTaskStatusColor(task.status) }} />
                        <h4 className="task-item-title">{task.title}</h4>
                        <button
                          className="btn-generate-brief"
                          title="Generate agent brief"
                          onClick={(e) => { e.stopPropagation(); handleGenerateBrief(task.id, task.title); }}
                          disabled={briefLoading === task.id}
                        >
                          {briefLoading === task.id ? '⏳' : '📝'} Brief
                        </button>
                        <span className={`task-item-priority priority-${task.priority}`}>
                          {task.priority}
                        </span>
                      </div>
                      {task.description && (
                        <p className="task-item-description">{task.description}</p>
                      )}
                      <div className="task-item-meta">
                        <span className="task-item-status">{task.status}</span>
                        {task.subtasks && task.subtasks.length > 0 && (
                          <span className="task-item-subtasks">
                            {task.subtasks.filter(s => s.completed).length}/{task.subtasks.length} subtasks
                          </span>
                        )}
                        {task.tags && task.tags.length > 0 && (
                          <div className="task-item-tags">
                            {task.tags.map(tag => (
                              <span key={tag} className="task-tag">{tag}</span>
                            ))}
                          </div>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
          
          {/* Sessions Tab */}
          {activeTab === 'sessions' && (
            <div className="sessions-tab">
              <div className="sessions-tab-header">
                <h3 className="sessions-tab-title">Session History</h3>
                <span className="sessions-count">{sessions.length} session{sessions.length !== 1 ? 's' : ''}</span>
              </div>
              
              {sessionsLoading ? (
                <div className="tab-loading">Loading sessions...</div>
              ) : sessions.length === 0 ? (
                <div className="tab-empty">
                  <p>No sessions found for this project</p>
                  <p className="tab-empty-hint">Agent sessions will appear here when tasks are worked on</p>
                </div>
              ) : (
                <div className="sessions-list">
                  {sessions.map((session, idx) => (
                    <div key={`${session.sessionKey}-${idx}`} className="session-item">
                      <div className="session-item-header">
                        <div className="session-name-row">
                          <span className={`session-outcome ${getOutcomeClass(session.outcome)}`}>
                            {session.outcome || 'running'}
                          </span>
                          <h4 className="session-item-name">{session.label || session.name}</h4>
                        </div>
                        {session.model && (
                          <span className="session-model">{session.model}</span>
                        )}
                      </div>
                      
                      {session.taskTitle && (
                        <p className="session-task-title">Task: {session.taskTitle}</p>
                      )}
                      
                      <div className="session-item-meta">
                        <span className="session-meta-item">
                          <Calendar size={13} />
                          {formatDate(session.startedAt)}
                        </span>
                        {session.durationMs && (
                          <span className="session-meta-item">
                            <Clock size={13} />
                            {formatDuration(session.durationMs)}
                          </span>
                        )}
                        {session.tokenUsage && session.tokenUsage.total > 0 && (
                          <span className="session-meta-item session-tokens">
                            <Cpu size={13} />
                            {formatTokens(session.tokenUsage.input)} in / {formatTokens(session.tokenUsage.output)} out
                          </span>
                        )}
                      </div>
                      
                      {/* Session links */}
                      {session.sessionKey && (
                        <div className="session-transcript-link">
                          <a
                            href={`${API_BASE_URL}/agents/${encodeURIComponent(session.sessionKey)}`}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="transcript-link"
                          >
                            <ExternalLink size={13} />
                            View session details
                          </a>
                          <button
                            className="transcript-link session-audit-btn"
                            onClick={() => navigate(`/audit?session=${encodeURIComponent(session.sessionKey)}`)}
                          >
                            <ScrollText size={13} />
                            View Audit Log
                          </button>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
          
          {/* Files Tab */}
          {activeTab === 'files' && (
            <FileBrowser projectId={project.id} projectName={project.source_dir || project.name} />
          )}
          
          {/* Tools Tab */}
          {activeTab === 'tools' && (
            <div className="tools-tab">
              <div className="tools-tab-header">
                <div>
                  <h3 className="tools-tab-title">Project Tools</h3>
                  <p className="tools-tab-subtitle">Tools linked to this project with optional instruction overrides</p>
                </div>
                <button className="btn-link-tool" onClick={() => { setShowToolPicker(true); fetchAllTools(); }}>
                  <Plus size={16} /> Link Tool
                </button>
              </div>

              {/* Global tools (auto-included) */}
              {(() => {
                const globalTools = allTools.filter(t => t.is_global);
                const linkedToolIds = new Set(projectTools.map(pt => pt.tool_id));
                const globalOnlyTools = globalTools.filter(t => !linkedToolIds.has(t.id));
                
                if (globalOnlyTools.length === 0 && projectTools.length === 0 && !projectToolsLoading) {
                  return (
                    <div className="tab-empty">
                      <Wrench size={32} className="tab-empty-icon" />
                      <h3>No tools linked</h3>
                      <p>Link tools to this project to provide agents with tool-specific instructions.</p>
                    </div>
                  );
                }

                return (
                  <>
                    {/* Global tools section */}
                    {globalOnlyTools.length > 0 && (
                      <div className="project-tools-section">
                        <h4 className="project-tools-section-title">
                          <Globe size={14} /> Global Tools <span className="tools-count">(auto-included)</span>
                        </h4>
                        <div className="project-tools-list">
                          {globalOnlyTools.map(tool => {
                            const linkedOverride = projectTools.find(pt => pt.tool_id === tool.id);
                            return (
                              <div key={tool.id} className="project-tool-item project-tool-global">
                                <div className="project-tool-info">
                                  <div className="project-tool-name">
                                    <Wrench size={14} />
                                    <span>{tool.name}</span>
                                    <span className="tool-badge tool-badge-global"><Globe size={10} /> Global</span>
                                  </div>
                                  {tool.category && <span className="project-tool-category">{tool.category}</span>}
                                  {tool.description && <p className="project-tool-description">{tool.description}</p>}
                                </div>
                                {linkedOverride?.override_instructions && (
                                  <div className="project-tool-override-badge">
                                    <Pencil size={12} /> Has Override
                                  </div>
                                )}
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    )}

                    {/* Project-linked tools */}
                    {projectToolsLoading ? (
                      <div className="tab-loading">Loading tools...</div>
                    ) : projectTools.length > 0 && (
                      <div className="project-tools-section">
                        <h4 className="project-tools-section-title">
                          <LinkIcon size={14} /> Linked Tools <span className="tools-count">({projectTools.length})</span>
                        </h4>
                        <div className="project-tools-list">
                          {projectTools.map(pt => (
                            <div key={pt.id} className={`project-tool-item ${pt.tool.is_global ? 'project-tool-global-linked' : ''}`}>
                              <div className="project-tool-info">
                                <div className="project-tool-name">
                                  <Wrench size={14} />
                                  <span>{pt.tool.name}</span>
                                  {pt.tool.is_global && (
                                    <span className="tool-badge tool-badge-global"><Globe size={10} /> Global</span>
                                  )}
                                  {pt.override_instructions && (
                                    <span className="tool-badge tool-badge-override"><Pencil size={10} /> Override</span>
                                  )}
                                </div>
                                {pt.tool.category && <span className="project-tool-category">{pt.tool.category}</span>}
                                {pt.tool.description && <p className="project-tool-description">{pt.tool.description}</p>}
                              </div>
                              <div className="project-tool-actions">
                                <button
                                  className="btn-tool-override"
                                  onClick={() => {
                                    setEditingOverride(pt.tool_id);
                                    setOverrideText(pt.override_instructions || '');
                                  }}
                                  title="Edit override instructions"
                                >
                                  <Pencil size={14} />
                                </button>
                                <button
                                  className="btn-tool-unlink"
                                  onClick={() => handleUnlinkTool(pt.tool_id)}
                                  title="Unlink tool"
                                >
                                  <Unlink size={14} />
                                </button>
                              </div>

                              {/* Override editor */}
                              {editingOverride === pt.tool_id && (
                                <div className="override-editor">
                                  <label>Override Instructions (replaces base instructions for this project)</label>
                                  <textarea
                                    value={overrideText}
                                    onChange={(e) => setOverrideText(e.target.value)}
                                    placeholder="Custom instructions for this project..."
                                    className="override-textarea"
                                    rows={4}
                                  />
                                  <div className="override-editor-actions">
                                    <button className="btn-cancel-link" onClick={() => setEditingOverride(null)}>Cancel</button>
                                    <button className="btn-save-link" onClick={() => handleSaveOverride(pt.tool_id)}>Save Override</button>
                                  </div>
                                </div>
                              )}
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                  </>
                );
              })()}

              {/* Tool Picker Modal */}
              {showToolPicker && (
                <div className="tool-picker-overlay" onClick={() => setShowToolPicker(false)}>
                  <div className="tool-picker" onClick={e => e.stopPropagation()}>
                    <div className="tool-picker-header">
                      <h3>Link Tool to Project</h3>
                      <button className="modal-close" onClick={() => setShowToolPicker(false)}>
                        <X size={20} />
                      </button>
                    </div>
                    <div className="tool-picker-search">
                      <Search size={14} />
                      <input
                        type="text"
                        value={toolSearchQuery}
                        onChange={(e) => setToolSearchQuery(e.target.value)}
                        placeholder="Search tools..."
                        autoFocus
                      />
                    </div>
                    <div className="tool-picker-list">
                      {allTools
                        .filter(t => {
                          // Filter out already linked tools
                          const isLinked = projectTools.some(pt => pt.tool_id === t.id);
                          if (isLinked) return false;
                          // Search filter
                          if (toolSearchQuery) {
                            const q = toolSearchQuery.toLowerCase();
                            return t.name.toLowerCase().includes(q) || 
                                   (t.description || '').toLowerCase().includes(q) ||
                                   (t.category || '').toLowerCase().includes(q);
                          }
                          return true;
                        })
                        .map(tool => (
                          <div
                            key={tool.id}
                            className="tool-picker-item"
                            onClick={() => handleLinkTool(tool.id)}
                          >
                            <div className="tool-picker-item-info">
                              <div className="tool-picker-item-name">
                                <Wrench size={14} />
                                <span>{tool.name}</span>
                                {tool.is_global && (
                                  <span className="tool-badge tool-badge-global"><Globe size={10} /> Global</span>
                                )}
                              </div>
                              {tool.category && <span className="tool-picker-category">{tool.category}</span>}
                              {tool.description && <p className="tool-picker-description">{tool.description}</p>}
                            </div>
                            <Plus size={16} className="tool-picker-add" />
                          </div>
                        ))}
                      {allTools.filter(t => !projectTools.some(pt => pt.tool_id === t.id)).length === 0 && (
                        <div className="tool-picker-empty">All tools are already linked</div>
                      )}
                    </div>
                  </div>
                </div>
              )}
            </div>
          )}
          
          {/* Context Tab - Phase 3: Use new ContextPreview component */}
          {activeTab === 'context' && (
            <div className="context-tab">
              <ContextPreview projectId={project.id} />
            </div>
          )}
          
          {/* Links Tab */}
          {activeTab === 'links' && (
            <div className="links-tab">
              <div className="links-header">
                <h3>Project Resources</h3>
                <button className="btn-add-link" onClick={() => setShowAddLink(!showAddLink)}>
                  <LinkIcon size={16} />
                  Add Link
                </button>
              </div>
              
              {showAddLink && (
                <div className="add-link-form">
                  <div className="form-row">
                    <select
                      value={newLink.type}
                      onChange={(e) => setNewLink({ ...newLink, type: e.target.value as ProjectLink['type'] })}
                      className="link-type-select"
                    >
                      {PROJECT_LINK_TYPES.map(type => (
                        <option key={type} value={type}>
                          {getLinkTypeLabel(type)}
                        </option>
                      ))}
                    </select>
                    <input
                      type="text"
                      placeholder="Link title"
                      value={newLink.title}
                      onChange={(e) => setNewLink({ ...newLink, title: e.target.value })}
                      className="link-title-input"
                    />
                  </div>
                  <div className="form-row">
                    <select
                      value={newLink.category || ''}
                      onChange={(e) => setNewLink({ ...newLink, category: e.target.value as LinkCategory | '' })}
                      className="link-category-select"
                    >
                      <option value="">No Category</option>
                      {LINK_CATEGORIES.map(category => {
                        const emoji = category === 'repository' ? '📁' :
                                     category === 'environment' ? '🌐' :
                                     category === 'documentation' ? '📄' :
                                     category === 'research' ? '🔬' :
                                     category === 'reference' ? '🔖' : '🔧';
                        return (
                          <option key={category} value={category}>
                            {emoji} {getLinkCategoryLabel(category)}
                          </option>
                        );
                      })}
                    </select>
                    <input
                      type="url"
                      placeholder="https://..."
                      value={newLink.url}
                      onChange={(e) => setNewLink({ ...newLink, url: e.target.value })}
                      className="link-url-input"
                    />
                  </div>
                  <div className="form-row form-actions">
                    <button className="btn-save-link" onClick={handleAddLink}>Add</button>
                    <button className="btn-cancel-link" onClick={() => setShowAddLink(false)}>Cancel</button>
                  </div>
                </div>
              )}
              
              {links.length === 0 ? (
                <div className="tab-empty">
                  <p>No links added yet</p>
                  <p className="tab-empty-hint">Add links to repos, docs, or related resources</p>
                </div>
              ) : (
                <div className="links-list">
                  {links.map(link => (
                    <div key={link.id} className="link-item">
                      {editingLink?.id === link.id ? (
                        <div className="edit-link-form">
                          <div className="form-row">
                            <select
                              value={editLinkData.type}
                              onChange={(e) => setEditLinkData({ ...editLinkData, type: e.target.value as ProjectLink['type'] })}
                              className="link-type-select"
                            >
                              <option value="url">External URL</option>
                              <option value="git">Git Repository</option>
                              <option value="doc">Document/File</option>
                              <option value="api">API Endpoint</option>
                              <option value="project">Cross-project</option>
                              <option value="dashboard">Dashboard/UI</option>
                              <option value="notebooklm">NotebookLM</option>
                            </select>
                            <input
                              type="text"
                              value={editLinkData.title}
                              onChange={(e) => setEditLinkData({ ...editLinkData, title: e.target.value })}
                              className="link-title-input"
                            />
                          </div>
                          <div className="form-row">
                            <select
                              value={editLinkData.category || ''}
                              onChange={(e) => setEditLinkData({ ...editLinkData, category: e.target.value as LinkCategory | '' })}
                              className="link-category-select"
                            >
                              <option value="">No Category</option>
                              <option value="repository">📁 Repository</option>
                              <option value="environment">🌐 Environment</option>
                              <option value="documentation">📄 Documentation</option>
                              <option value="research">🔬 Research</option>
                              <option value="reference">🔖 Reference</option>
                              <option value="tool">🔧 Tool</option>
                            </select>
                            <input
                              type="url"
                              value={editLinkData.url}
                              onChange={(e) => setEditLinkData({ ...editLinkData, url: e.target.value })}
                              className="link-url-input"
                            />
                          </div>
                          <div className="form-row form-actions">
                            <button className="btn-save-link" onClick={handleEditLink}>Save</button>
                            <button className="btn-cancel-link" onClick={() => setEditingLink(null)}>Cancel</button>
                          </div>
                        </div>
                      ) : (
                        <>
                          <div className="link-icon">{getLinkIcon(link.type)}</div>
                          <div className="link-info">
                            <div className="link-info-header">
                              <a href={link.url} target="_blank" rel="noopener noreferrer" className="link-title">
                                {link.title}
                              </a>
                              {link.category && (
                                <span className={`link-category-badge category-${link.category}`}>
                                  {link.category}
                                </span>
                              )}
                            </div>
                            <span className="link-url">{link.url}</span>
                          </div>
                          <button className="btn-edit-link" onClick={() => {
                            setEditingLink(link);
                            setEditLinkData({ type: link.type, title: link.title, url: link.url, category: link.category || '' });
                          }} title="Edit link">
                            <Pencil size={14} />
                          </button>
                          <button className="btn-delete-link" onClick={() => handleDeleteLink(link.id)} title="Delete link">
                            <X size={16} />
                          </button>
                        </>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
      
      {/* Toast */}
      {toast && (
        <div className="toast-notification">{toast}</div>
      )}
      
      {/* Brief Modal */}
      {briefModal && (
        <div className="brief-modal-overlay" onClick={() => setBriefModal(null)}>
          <div className="brief-modal" onClick={(e) => e.stopPropagation()}>
            <div className="brief-modal-header">
              <h3>📝 Agent Brief: {briefModal.taskTitle}</h3>
              <div className="brief-modal-actions">
                <button className="btn-copy-context-inline" onClick={() => copyToClipboard(briefModal.brief, 'Brief')}>
                  <Clipboard size={14} /> Copy
                </button>
                <button className="modal-close" onClick={() => setBriefModal(null)}>
                  <X size={20} />
                </button>
              </div>
            </div>
            <pre className="brief-content">{briefModal.brief}</pre>
          </div>
        </div>
      )}
      
      {/* Task Detail Modal */}
      {selectedTask && (
        <TaskDetailModal
          task={selectedTask}
          onClose={() => setSelectedTask(null)}
          onEdit={() => {
            setEditingTask(selectedTask);
            setSelectedTask(null);
          }}
          onSubtaskToggle={() => {}}
        />
      )}
      
      {/* Task Edit Modal */}
      {editingTask && (
        <EditTaskModal
          task={editingTask}
          onClose={() => setEditingTask(null)}
          onSave={async (_taskId, updates) => {
            try {
              await authenticatedFetch(`${API_BASE_URL}/tasks/${editingTask.id}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(updates),
              });
              setTasks(prev => prev.map(t => t.id === editingTask.id ? { ...t, ...updates } : t));
              setEditingTask(null);
            } catch (err) {
              console.error('Failed to update task:', err);
            }
          }}
          onDelete={async (taskId) => {
            try {
              await authenticatedFetch(`${API_BASE_URL}/tasks/${taskId}`, { method: 'DELETE' });
              setTasks(prev => prev.filter(t => t.id !== taskId));
              setEditingTask(null);
            } catch (err) {
              console.error('Failed to delete task:', err);
            }
          }}
        />
      )}
      
      {/* Project Resources Edit Modal */}
      {showResourcesEdit && (
        <ProjectResourcesEditModal
          projectId={project.id}
          projectName={project.name}
          initialResources={projectResources}
          initialToolInstructions={projectToolInstructions}
          onClose={() => setShowResourcesEdit(false)}
          onSave={handleSaveResources}
        />
      )}
      
      {/* Archive Confirmation Modal */}
      {showArchiveConfirm && (
        <ConfirmationModal
          title={currentProjectStatus === 'archived' ? 'Restore Project' : 'Archive Project'}
          message={
            currentProjectStatus === 'archived'
              ? `Are you sure you want to restore "${project.name}"? It will be moved back to active projects.`
              : `Are you sure you want to archive "${project.name}"? Archived projects are hidden from the main view but can be restored later.`
          }
          confirmLabel={currentProjectStatus === 'archived' ? 'Restore' : 'Archive'}
          cancelLabel="Cancel"
          onConfirm={handleArchiveToggle}
          onCancel={() => setShowArchiveConfirm(false)}
        />
      )}
      
      {/* Delete Confirmation Modal */}
      {showDeleteConfirm === 'confirm' && deletePreview && (
        <ConfirmationModal
          title="Delete Project"
          message={
            <div>
              <p>⚠️ <strong>This action cannot be undone!</strong></p>
              <p>Deleting "{project.name}" will permanently remove:</p>
              <ul style={{ marginTop: '12px', marginLeft: '20px', lineHeight: '1.8' }}>
                <li><strong>{deletePreview.tasks}</strong> task{deletePreview.tasks !== 1 ? 's' : ''}</li>
                <li><strong>{deletePreview.sessions}</strong> agent session{deletePreview.sessions !== 1 ? 's' : ''}</li>
                <li>All project links and metadata</li>
              </ul>
              <p style={{ marginTop: '16px', fontWeight: 600 }}>Type <strong>{project.name}</strong> to confirm deletion:</p>
            </div>
          }
          confirmLabel="Delete Forever"
          cancelLabel="Cancel"
          requiresConfirmation
          confirmationValue={project.name}
          confirmationPlaceholder={`Type "${project.name}" to confirm`}
          danger
          onConfirm={handleDeleteProject}
          onCancel={() => {
            setShowDeleteConfirm(null);
            setDeletePreview(null);
          }}
        />
      )}
    </div>
  );
};
