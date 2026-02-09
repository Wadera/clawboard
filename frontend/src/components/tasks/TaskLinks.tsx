import React from 'react';
import { TaskLink } from '../../types/task';
import { useFileViewer } from '../../contexts/FileViewerContext';
import { Folder, Wrench, GitBranch, FileText, Brain, MessageSquare } from 'lucide-react';
import './TaskLinks.css';

interface TaskLinksProps {
  links: TaskLink[];
  compact?: boolean;
}

const LINK_ICONS: Record<string, React.ReactNode> = {
  project: <Folder size={12} />,
  tool: <Wrench size={12} />,
  git: <GitBranch size={12} />,
  doc: <FileText size={12} />,
  memory: <Brain size={12} />,
  session: <MessageSquare size={12} />,
};

const LINK_LABELS: Record<string, string> = {
  project: 'Project',
  tool: 'Tool',
  git: 'Git',
  doc: 'Doc',
  memory: 'Memory',
  session: 'Session',
};

function isExternalUrl(url: string): boolean {
  return url.startsWith('http://') || url.startsWith('https://');
}

export const TaskLinks: React.FC<TaskLinksProps> = ({ links, compact = false }) => {
  const { openFileByPath } = useFileViewer();

  if (!links || links.length === 0) return null;

  const displayLinks = compact ? links.slice(0, 3) : links;

  const handleLinkClick = (e: React.MouseEvent, link: TaskLink) => {
    e.stopPropagation();
    e.preventDefault();

    if (isExternalUrl(link.url)) {
      window.open(link.url, '_blank', 'noopener,noreferrer');
    } else {
      // Treat as a file path — open in file viewer
      openFileByPath(link.url);
    }
  };

  return (
    <div className={`task-links ${compact ? 'task-links-compact' : ''}`}>
      <div className="task-links-header">
        🔗 Links
      </div>
      <div className="task-links-list">
        {displayLinks.map((link, i) => (
          <a
            key={i}
            href={isExternalUrl(link.url) ? link.url : '#'}
            className="task-link-item"
            title={link.title}
            onClick={(e) => handleLinkClick(e, link)}
          >
            <span className="task-link-icon">
              {link.icon || LINK_ICONS[link.type] || <FileText size={12} />}
            </span>
            <span className="task-link-title">{link.title}</span>
            <span className="task-link-type">{LINK_LABELS[link.type] || link.type}</span>
          </a>
        ))}
        {compact && links.length > 3 && (
          <span className="task-links-more">+{links.length - 3} more</span>
        )}
      </div>
    </div>
  );
};
