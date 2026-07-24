import React from 'react';
import { useNavigate } from 'react-router-dom';
import { Bot } from 'lucide-react';
import { getAgentTypeColor } from '../types/agentType';
import './AgentTypeBadge.css';

interface AgentTypeBadgeProps {
  agentType: {
    id: string;
    slug?: string | null;
    name: string;
    color?: string | null;
    category?: string | null;
  } | null | undefined;
  /** If true, clicking navigates to the agent type detail page */
  clickable?: boolean;
  size?: 'sm' | 'md';
}

export const AgentTypeBadge: React.FC<AgentTypeBadgeProps> = ({
  agentType,
  clickable = true,
  size = 'sm',
}) => {
  const navigate = useNavigate();

  if (!agentType) return null;

  const color = getAgentTypeColor(agentType.color ?? null);

  const handleClick = (e: React.MouseEvent) => {
    if (!clickable) return;
    e.stopPropagation();
    e.preventDefault();
    navigate(`/agent-types/${agentType.id}`);
  };

  return (
    <span
      className={`agent-type-badge agent-type-badge--${size} ${clickable ? 'agent-type-badge--clickable' : ''}`}
      style={{ '--badge-color': color } as React.CSSProperties}
      onClick={handleClick}
      title={`Agent type: ${agentType.name}${agentType.category ? ` (${agentType.category})` : ''}`}
    >
      <Bot size={size === 'sm' ? 10 : 13} />
      <span className="badge-label">{agentType.name}</span>
    </span>
  );
};
