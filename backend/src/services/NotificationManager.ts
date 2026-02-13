// NotificationManager.ts - Task state change notifications
import fs from 'fs/promises';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';

const SESSIONS_DIR = process.env.OPENCLAW_SESSIONS_PATH 
  ? path.dirname(process.env.OPENCLAW_SESSIONS_PATH) 
  : '/clawdbot/sessions';
const NOTIFICATIONS_FILE = path.join(SESSIONS_DIR, 'task-notifications.json');
const MAX_NOTIFICATIONS = 50;

export interface TaskNotification {
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

export interface NotificationData {
  notifications: TaskNotification[];
  updatedAt: string;
}

export class NotificationManager {
  private writeQueue: Promise<void> = Promise.resolve();

  /**
   * Emit a task status change notification
   */
  async notifyStatusChange(
    taskId: string,
    taskTitle: string,
    fromStatus: string,
    toStatus: string,
    changedBy: 'user' | 'agent' | 'system' = 'user'
  ): Promise<void> {
    const notification: TaskNotification = {
      id: uuidv4(),
      taskId,
      taskTitle,
      event: 'status_changed',
      from: fromStatus,
      to: toStatus,
      changedBy,
      timestamp: new Date().toISOString(),
      read: false
    };

    await this.addNotification(notification);
    console.log(`[NotificationManager] Task ${taskId} status: ${fromStatus} → ${toStatus}`);
  }

  /**
   * Add a notification to the file (serialized writes)
   */
  private async addNotification(notification: TaskNotification): Promise<void> {
    this.writeQueue = this.writeQueue.then(async () => {
      try {
        // Read existing notifications
        let data: NotificationData = {
          notifications: [],
          updatedAt: new Date().toISOString()
        };

        try {
          const content = await fs.readFile(NOTIFICATIONS_FILE, 'utf8');
          data = JSON.parse(content);
        } catch (err: any) {
          if (err.code !== 'ENOENT') {
            console.warn('[NotificationManager] Error reading notifications file:', err.message);
          }
          // File doesn't exist or is corrupted - start fresh
        }

        // Add new notification at the beginning
        data.notifications.unshift(notification);

        // Keep only last MAX_NOTIFICATIONS (FIFO - drop oldest)
        if (data.notifications.length > MAX_NOTIFICATIONS) {
          data.notifications = data.notifications.slice(0, MAX_NOTIFICATIONS);
        }

        data.updatedAt = new Date().toISOString();

        // Ensure directory exists
        await fs.mkdir(SESSIONS_DIR, { recursive: true });

        // Write atomically (temp file + rename)
        const tmpFile = NOTIFICATIONS_FILE + '.tmp';
        await fs.writeFile(tmpFile, JSON.stringify(data, null, 2), 'utf8');
        await fs.rename(tmpFile, NOTIFICATIONS_FILE);

      } catch (err: any) {
        console.error('[NotificationManager] Error writing notification:', err.message);
        // Don't throw - keep server running
      }
    });

    return this.writeQueue;
  }

  /**
   * Get all notifications
   */
  async getNotifications(): Promise<TaskNotification[]> {
    try {
      const content = await fs.readFile(NOTIFICATIONS_FILE, 'utf8');
      const data: NotificationData = JSON.parse(content);
      return data.notifications || [];
    } catch (err: any) {
      if (err.code === 'ENOENT') {
        return []; // File doesn't exist yet
      }
      console.error('[NotificationManager] Error reading notifications:', err.message);
      return [];
    }
  }

  /**
   * Get unread notifications only
   */
  async getUnreadNotifications(): Promise<TaskNotification[]> {
    const all = await this.getNotifications();
    return all.filter(n => !n.read);
  }

  /**
   * Mark a notification as read
   */
  async markAsRead(notificationId: string): Promise<boolean> {
    return new Promise((resolve) => {
      this.writeQueue = this.writeQueue.then(async () => {
        try {
          const content = await fs.readFile(NOTIFICATIONS_FILE, 'utf8');
          const data: NotificationData = JSON.parse(content);

          const notification = data.notifications.find(n => n.id === notificationId);
          if (!notification) {
            resolve(false);
            return;
          }

          notification.read = true;
          data.updatedAt = new Date().toISOString();

          const tmpFile = NOTIFICATIONS_FILE + '.tmp';
          await fs.writeFile(tmpFile, JSON.stringify(data, null, 2), 'utf8');
          await fs.rename(tmpFile, NOTIFICATIONS_FILE);

          console.log(`[NotificationManager] Marked notification ${notificationId} as read`);
          resolve(true);
        } catch (err: any) {
          console.error('[NotificationManager] Error marking notification as read:', err.message);
          resolve(false);
        }
      });
    });
  }

  /**
   * Mark all notifications as read
   */
  async markAllAsRead(): Promise<number> {
    return new Promise((resolve) => {
      this.writeQueue = this.writeQueue.then(async () => {
        try {
          const content = await fs.readFile(NOTIFICATIONS_FILE, 'utf8');
          const data: NotificationData = JSON.parse(content);

          let count = 0;
          for (const notification of data.notifications) {
            if (!notification.read) {
              notification.read = true;
              count++;
            }
          }

          if (count > 0) {
            data.updatedAt = new Date().toISOString();
            const tmpFile = NOTIFICATIONS_FILE + '.tmp';
            await fs.writeFile(tmpFile, JSON.stringify(data, null, 2), 'utf8');
            await fs.rename(tmpFile, NOTIFICATIONS_FILE);
            console.log(`[NotificationManager] Marked ${count} notifications as read`);
          }

          resolve(count);
        } catch (err: any) {
          if (err.code === 'ENOENT') {
            resolve(0); // No file = no notifications
            return;
          }
          console.error('[NotificationManager] Error marking all as read:', err.message);
          resolve(0);
        }
      });
    });
  }
}

// Singleton instance
export const notificationManager = new NotificationManager();
