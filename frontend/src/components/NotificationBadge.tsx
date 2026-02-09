import { useState, useEffect } from 'react';
import { Bell } from 'lucide-react';
import { authenticatedFetch } from '../utils/auth';
import './NotificationBadge.css';

interface TaskNotification {
  id: string;
  taskId: string;
  taskTitle: string;
  event: 'status_changed';
  from: string;
  to: string;
  changedBy: 'user' | 'agent' | 'system';
  timestamp: string;
  read: boolean;
}

interface NotificationBadgeProps {
  compact?: boolean;
}

export function NotificationBadge({ compact }: NotificationBadgeProps) {
  const [notifications, setNotifications] = useState<TaskNotification[]>([]);
  const [showDropdown, setShowDropdown] = useState(false);
  const [loading, setLoading] = useState(false);
  const API_BASE = import.meta.env.VITE_API_BASE_URL || '/api';

  const fetchNotifications = async () => {
    try {
      const response = await authenticatedFetch(`${API_BASE}/tasks/notifications?unread=true`);
      if (response.ok) {
        const data = await response.json();
        setNotifications(data.notifications || []);
      }
    } catch (err) {
      console.error('Failed to fetch notifications:', err);
    }
  };

  // Fetch notifications on mount and when WebSocket event fires
  useEffect(() => {
    fetchNotifications();

    // Listen for task notification events via WebSocket
    const handler = (event: CustomEvent) => {
      console.log('Received task:notification event', event.detail);
      fetchNotifications();
    };

    window.addEventListener('task:notification' as any, handler);
    return () => window.removeEventListener('task:notification' as any, handler);
  }, []);

  const markAsRead = async (notificationId: string) => {
    try {
      await authenticatedFetch(`${API_BASE}/tasks/notifications/${notificationId}/read`, {
        method: 'POST',
      });
      setNotifications(notifications.filter(n => n.id !== notificationId));
    } catch (err) {
      console.error('Failed to mark notification as read:', err);
    }
  };

  const markAllAsRead = async () => {
    setLoading(true);
    try {
      await authenticatedFetch(`${API_BASE}/tasks/notifications/read-all`, {
        method: 'POST',
      });
      setNotifications([]);
      setShowDropdown(false);
    } catch (err) {
      console.error('Failed to mark all as read:', err);
    } finally {
      setLoading(false);
    }
  };

  const unreadCount = notifications.length;

  const formatTimestamp = (timestamp: string) => {
    const date = new Date(timestamp);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffMins = Math.floor(diffMs / 60000);

    if (diffMins < 1) return 'just now';
    if (diffMins < 60) return `${diffMins}m ago`;
    const diffHours = Math.floor(diffMins / 60);
    if (diffHours < 24) return `${diffHours}h ago`;
    return date.toLocaleDateString();
  };

  const getStatusEmoji = (status: string) => {
    const statusMap: Record<string, string> = {
      ideas: '💡',
      todo: '📝',
      'in-progress': '⚡',
      stuck: '🔴',
      completed: '✅',
      archived: '📦',
    };
    return statusMap[status] || '📋';
  };

  return (
    <div className="notification-badge-container">
      <button
        className={`notification-badge-button ${compact ? 'compact' : ''}`}
        onClick={() => setShowDropdown(!showDropdown)}
        title={compact ? `${unreadCount} notifications` : undefined}
      >
        <Bell size={compact ? 16 : 20} />
        {unreadCount > 0 && (
          <span className="notification-badge-count">{unreadCount > 99 ? '99+' : unreadCount}</span>
        )}
        {!compact && <span className="notification-badge-label">Notifications</span>}
      </button>

      {showDropdown && (
        <>
          <div 
            className="notification-dropdown-backdrop" 
            onClick={() => setShowDropdown(false)}
          />
          <div className="notification-dropdown">
            <div className="notification-dropdown-header">
              <h3>Notifications</h3>
              {unreadCount > 0 && (
                <button 
                  className="notification-mark-all-btn"
                  onClick={markAllAsRead}
                  disabled={loading}
                >
                  Mark all as read
                </button>
              )}
            </div>

            <div className="notification-list">
              {notifications.length === 0 ? (
                <div className="notification-empty">
                  <Bell size={32} opacity={0.3} />
                  <p>No new notifications</p>
                </div>
              ) : (
                notifications.map((notification) => (
                  <div key={notification.id} className="notification-item">
                    <div className="notification-content">
                      <div className="notification-title">
                        <span className="notification-emoji">
                          {getStatusEmoji(notification.from)} → {getStatusEmoji(notification.to)}
                        </span>
                        <span className="notification-task-title">{notification.taskTitle}</span>
                      </div>
                      <div className="notification-details">
                        <span className="notification-status-change">
                          {notification.from} → {notification.to}
                        </span>
                        <span className="notification-by">
                          by {notification.changedBy}
                        </span>
                      </div>
                      <div className="notification-timestamp">
                        {formatTimestamp(notification.timestamp)}
                      </div>
                    </div>
                    <button
                      className="notification-mark-read-btn"
                      onClick={() => markAsRead(notification.id)}
                      title="Mark as read"
                    >
                      ✓
                    </button>
                  </div>
                ))
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
