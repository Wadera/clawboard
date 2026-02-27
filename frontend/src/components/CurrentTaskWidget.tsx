import { authenticatedFetch } from '../utils/auth';
import React, { useState, useEffect } from 'react';
import { Zap, Clock, AlertCircle, Sparkles, TrendingUp } from 'lucide-react';
import { Task } from '../types/task';
import './CurrentTaskWidget.css';

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || '/api';

interface CurrentTaskResponse {
  success: boolean;
  task: Task | null;
  taskId: string | null;
  hasCurrentTask: boolean;
}

export const CurrentTaskWidget: React.FC = () => {
  const [currentTask, setCurrentTask] = useState<Task | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lastCheck, setLastCheck] = useState<Date>(new Date());
  const [secondsAgo, setSecondsAgo] = useState(0);

  // Fetch current task
  const fetchCurrentTask = async () => {
    try {
      const response = await authenticatedFetch(`${API_BASE_URL}/tasks/current`);
      const data: CurrentTaskResponse = await response.json();
      
      if (data.success) {
        setCurrentTask(data.task);
        setLastCheck(new Date());
        setError(null);
      } else {
        setError('Failed to fetch current task');
      }
    } catch (err) {
      setError('Failed to fetch current task');
      console.error('Current task fetch error:', err);
    } finally {
      setLoading(false);
    }
  };

  // Initial load
  useEffect(() => {
    fetchCurrentTask();
  }, []);

  // Auto-refresh every 10 seconds
  useEffect(() => {
    const interval = setInterval(() => {
      fetchCurrentTask();
    }, 10000);

    return () => clearInterval(interval);
  }, []);

  // Update "seconds ago" counter
  useEffect(() => {
    const interval = setInterval(() => {
      const now = new Date();
      const diff = Math.floor((now.getTime() - lastCheck.getTime()) / 1000);
      setSecondsAgo(diff);
    }, 1000);

    return () => clearInterval(interval);
  }, [lastCheck]);

  const getPriorityClass = (priority: string) => {
    switch (priority) {
      case 'urgent': return 'priority-urgent';
      case 'high': return 'priority-high';
      case 'normal': return 'priority-normal';
      case 'low': return 'priority-low';
      default: return 'priority-normal';
    }
  };

  if (loading) {
    return (
      <div className="current-task-loading">
        <div className="current-task-loading-content">
          <Zap size={20} style={{ color: '#3b82f6' }} className="pulse" />
          <span>Detecting current work...</span>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="current-task-error">
        <div className="current-task-error-content">
          <AlertCircle size={20} />
          <span>{error}</span>
        </div>
      </div>
    );
  }

  if (!currentTask) {
    return (
      <div className="current-task-idle">
        <div className="current-task-idle-content">
          <div className="current-task-idle-left">
            <Sparkles className="current-task-idle-icon" size={20} />
            <div>
              <span className="current-task-idle-text">✨ Idle State</span>
              <div className="current-task-idle-subtext">Not focused on a specific task</div>
            </div>
          </div>
          
          <div className="current-task-idle-time">
            <Clock size={12} />
            <span>{secondsAgo}s ago</span>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="current-task-widget">
      {/* Animated background effect */}
      <div className="current-task-bg-effect" />
      
      <div className="current-task-content">
        <div className="current-task-header">
          <div className="current-task-title-section">
            <div className="current-task-icon-wrapper">
              <TrendingUp className="current-task-icon" size={24} />
              <div className="current-task-ping" />
            </div>
            <div>
              <h3 className="current-task-title">⚡ Active Work</h3>
              <div className="current-task-subtitle">In progress right now</div>
            </div>
          </div>
          
          <div className="current-task-badges">
            <span className={`current-task-priority ${getPriorityClass(currentTask.priority)}`}>
              {currentTask.priority}
            </span>
            <div className="current-task-time">
              <Clock size={12} className={secondsAgo < 3 ? 'current-task-time-icon spin' : ''} />
              <span>{secondsAgo}s</span>
            </div>
          </div>
        </div>

        <div className="current-task-details">
          <h4 className="current-task-name">{currentTask.title}</h4>
          {currentTask.description && (
            <p className="current-task-description">
              {currentTask.description}
            </p>
          )}
          
          {currentTask.tags.length > 0 && (
            <div className="current-task-tags">
              {currentTask.tags.map(tag => (
                <span key={tag} className="current-task-tag">
                  #{tag}
                </span>
              ))}
            </div>
          )}
        </div>
        
        <div className="current-task-footer">
          <span className="current-task-started">
            Started: {new Date(currentTask.updated).toLocaleTimeString()}
          </span>
          {currentTask.project && (
            <span className="current-task-project">
              📁 {currentTask.project}
            </span>
          )}
        </div>
      </div>
    </div>
  );
};
