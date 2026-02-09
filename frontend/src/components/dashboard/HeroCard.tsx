import React from 'react';
import { Link } from 'react-router-dom';
import { getHeroNavItems, getNavLabel } from '../../config/navigation';
import './HeroCard.css';

export const HeroCard: React.FC = () => {
  const currentHour = new Date().getHours();
  let greeting = '👋 Good morning';
  
  if (currentHour >= 12 && currentHour < 17) {
    greeting = '☀️ Good afternoon';
  } else if (currentHour >= 17) {
    greeting = '🌙 Good evening';
  }

  const heroNavItems = getHeroNavItems();

  return (
    <div className="hero-card">
      <div className="hero-card-bg-gradient" />
      
      <div className="hero-card-content">
        <h1 className="hero-greeting">{greeting}</h1>
        <p className="hero-tagline">Your personal workspace & command center</p>
        
        <div className="hero-quick-actions">
          {heroNavItems.map((item) => (
            <Link
              key={item.id}
              to={item.path}
              className="hero-action-btn"
            >
              <item.icon size={20} />
              <span>{getNavLabel(item, 'hero')}</span>
            </Link>
          ))}
        </div>
      </div>
    </div>
  );
};
