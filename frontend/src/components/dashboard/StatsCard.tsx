import React from 'react';
import './StatsCard.css';

interface StatsCardProps {
  icon: string;
  label: string;
  value: number | string;
  trend?: string;
  description?: string;
  color: 'blue' | 'orange' | 'green' | 'purple' | 'red' | 'gray';
  pulse?: boolean;
}

export const StatsCard: React.FC<StatsCardProps> = ({
  icon,
  label,
  value,
  trend,
  description,
  color,
  pulse = false,
}) => {
  return (
    <div className={`stats-card stats-card-${color} ${pulse ? 'stats-card-pulse' : ''}`}>
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
    </div>
  );
};
