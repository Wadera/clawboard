import React from 'react';
import { Link } from 'react-router-dom';
import './StatsCard.css';

interface StatsCardProps {
  icon: string;
  label: string;
  value: number | string;
  trend?: string;
  description?: string;
  color: 'blue' | 'orange' | 'green' | 'purple' | 'red' | 'gray';
  pulse?: boolean;
  to?: string;
}

export const StatsCard: React.FC<StatsCardProps> = ({
  icon,
  label,
  value,
  trend,
  description,
  color,
  pulse = false,
  to,
}) => {
  const content = (
    <>
      <div className="stats-card-icon">{icon}</div>
      
      <div className="stats-card-content">
        <div className="stats-card-label">{label}</div>
        <div className="stats-card-value">{value}</div>
        
        {trend && (
          <div className="stats-card-trend">{trend}</div>
        )}
        
        {description && (
          <div className="stats-card-description">{description}</div>
        )}
      </div>
    </>
  );

  if (to) {
    return (
      <Link to={to} className={`stats-card stats-card-${color} ${pulse ? 'stats-card-pulse' : ''} stats-card-link`}>
        {content}
      </Link>
    );
  }

  return (
    <div className={`stats-card stats-card-${color} ${pulse ? 'stats-card-pulse' : ''}`}>
      {content}
    </div>
  );
};
