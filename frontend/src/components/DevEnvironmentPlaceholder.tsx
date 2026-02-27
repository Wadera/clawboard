import React from 'react';
import './DevEnvironmentPlaceholder.css';

export const DevEnvironmentPlaceholder: React.FC = () => {
  return (
    <div className="dev-placeholder-container">
      <div className="dev-placeholder-card">
        <div className="dev-placeholder-icon">
          🚧
        </div>
        <h2>Development Environment Not Configured</h2>
        <p className="dev-placeholder-description">
          The development environment allows you to test changes without affecting your production setup.
        </p>
        
        <div className="dev-placeholder-section">
          <h3>What is the Dev Environment?</h3>
          <ul>
            <li>Separate database for testing</li>
            <li>Different port configuration</li>
            <li>Isolated from production data</li>
            <li>Safe space for experimentation</li>
          </ul>
        </div>

        <div className="dev-placeholder-section">
          <h3>How to Set It Up</h3>
          <ol>
            <li>Create a <code>docker-compose.dev.yml</code> file with dev-specific configuration</li>
            <li>Use different ports (e.g., 8083 for frontend, 3002 for backend)</li>
            <li>Point to a separate database (<code>clawboard_dev</code>)</li>
            <li>Start with: <code>docker compose -f docker-compose.dev.yml up -d</code></li>
          </ol>
        </div>

        <div className="dev-placeholder-section">
          <h3>Why Use a Dev Environment?</h3>
          <ul>
            <li>Test new features without breaking production</li>
            <li>Experiment with configuration changes safely</li>
            <li>Debug issues in isolation</li>
            <li>Recommended for active development</li>
          </ul>
        </div>

        <div className="dev-placeholder-footer">
          <p>
            <strong>Tip:</strong> Copy your <code>docker-compose.yml</code> to <code>docker-compose.dev.yml</code> 
            and adjust ports and database names to get started.
          </p>
        </div>
      </div>
    </div>
  );
};
