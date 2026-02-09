import React from 'react';
import { Project } from '../../types/project';
import { Clock, CheckCircle2, Circle, Cpu, ListTodo, Eye } from 'lucide-react';
import './ProjectCard.css';

interface ProjectCardProps {
  project: Project;
  onClick: () => void;
  onViewTasks?: (projectName: string) => void;
}

export const ProjectCard: React.FC<ProjectCardProps> = ({ project, onClick, onViewTasks }) => {
  const stats = project.stats;
  
  // Calculate progress percentage
  const progressPercent = stats && stats.total_tasks > 0
    ? Math.round((stats.completed_tasks / stats.total_tasks) * 100)
    : 0;
  
  // Get time ago for last activity
  const getTimeAgo = (dateString: string | null): string => {
    if (!dateString) return 'No activity';
    
    const date = new Date(dateString);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffMins = Math.floor(diffMs / 60000);
    
    if (diffMins < 1) return 'just now';
    if (diffMins < 60) return `${diffMins}m ago`;
    
    const diffHours = Math.floor(diffMins / 60);
    if (diffHours < 24) return `${diffHours}h ago`;
    
    const diffDays = Math.floor(diffHours / 24);
    if (diffDays < 30) return `${diffDays}d ago`;
    
    const diffMonths = Math.floor(diffDays / 30);
    return `${diffMonths}mo ago`;
  };
  
  const getStatusColor = (status: string): string => {
    switch (status) {
      case 'active': return 'status-active';
      case 'paused': return 'status-paused';
      case 'completed': return 'status-completed';
      case 'archived': return 'status-archived';
      default: return 'status-active';
    }
  };
  
  return (
    <div className="project-card" onClick={onClick}>
      {/* Header: Name + Status Badge */}
      <div className="project-card-header">
        <h3 className="project-card-name">{project.name}</h3>
        <span className={`project-card-status ${getStatusColor(project.status)}`}>
          {project.status}
        </span>
      </div>
      
      {/* Description */}
      {project.description && (
        <p className="project-card-description">{project.description}</p>
      )}
      
      {/* Progress Bar */}
      {stats && stats.total_tasks > 0 && (
        <div className="project-card-progress">
          <div className="project-card-progress-header">
            <span className="project-card-progress-label">Progress</span>
            <span className="project-card-progress-percent">{progressPercent}%</span>
          </div>
          <div className="project-card-progress-bar">
            <div 
              className="project-card-progress-fill" 
              style={{ width: `${progressPercent}%` }}
            />
          </div>
        </div>
      )}
      
      {/* Task Stats */}
      {stats && (
        <div className="project-card-stats">
          <div className="project-card-stat">
            <Circle size={14} className="stat-icon stat-icon-total" />
            <span className="stat-label">{stats.total_tasks} total</span>
          </div>
          
          <div className="project-card-stat">
            <Clock size={14} className="stat-icon stat-icon-progress" />
            <span className="stat-label">{stats.in_progress_tasks} in progress</span>
          </div>
          
          <div className="project-card-stat">
            <CheckCircle2 size={14} className="stat-icon stat-icon-completed" />
            <span className="stat-label">{stats.completed_tasks} completed</span>
          </div>
        </div>
      )}
      
      {/* Active Agents Indicator */}
      {stats && stats.active_agents > 0 && (
        <div className="project-card-agents">
          <Cpu size={14} className="agents-icon" />
          <span className="agents-label">
            {stats.active_agents} agent{stats.active_agents !== 1 ? 's' : ''} working
          </span>
        </div>
      )}
      
      {/* Quick Actions */}
      <div className="project-card-actions">
        <button
          className="project-card-action-btn"
          onClick={(e) => {
            e.stopPropagation();
            onClick();
          }}
          title="View project details"
        >
          <Eye size={14} />
          <span>Details</span>
        </button>
        
        {stats && stats.total_tasks > 0 && (
          <button
            className="project-card-action-btn"
            onClick={(e) => {
              e.stopPropagation();
              onViewTasks?.(project.name);
            }}
            title="View tasks for this project"
          >
            <ListTodo size={14} />
            <span>Tasks ({stats.total_tasks})</span>
          </button>
        )}
      </div>
      
      {/* Last Activity */}
      <div className="project-card-footer">
        <Clock size={12} />
        <span className="project-card-last-activity">
          {getTimeAgo(stats?.last_activity || null)}
        </span>
      </div>
    </div>
  );
};
