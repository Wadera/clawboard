import React, { useState, FormEvent } from 'react';
import { auth } from '../utils/auth';
import { useClawBoardConfig } from '../contexts/ClawBoardConfigContext';
import './LoginPage.css';

interface LoginPageProps {
  onLoginSuccess: () => void;
}

export const LoginPage: React.FC<LoginPageProps> = ({ onLoginSuccess }) => {
  const { config } = useClawBoardConfig();
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [shake, setShake] = useState(false);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);

    const result = await auth.login(password);

    if (result.success) {
      onLoginSuccess();
    } else {
      setError(result.error || 'Invalid password');
      setShake(true);
      setTimeout(() => setShake(false), 500);
      setPassword('');
    }

    setLoading(false);
  };

  return (
    <div className="login-page">
      <div className={`login-container ${shake ? 'shake' : ''}`}>
        <div className="login-logo">
          <span className="login-emoji">{config.bot.emoji}</span>
        </div>
        
        <h1 className="login-title">{config.branding.loginTitle}</h1>
        <p className="login-subtitle">{config.branding.loginSubtitle}</p>

        <form onSubmit={handleSubmit} className="login-form">
          <div className="login-input-group">
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Password"
              className="login-input"
              autoFocus
              disabled={loading}
            />
          </div>

          {error && (
            <div className="login-error">
              <span className="error-icon">⚠️</span>
              <span>{error}</span>
            </div>
          )}

          <button 
            type="submit" 
            className="login-button"
            disabled={loading || !password}
          >
            {loading ? (
              <>
                <span className="login-spinner" />
                <span>Authenticating...</span>
              </>
            ) : (
              <span>Login</span>
            )}
          </button>
        </form>

        <div className="login-footer">
          <span className="login-version">ClawBoard v2.0.0</span>
        </div>
      </div>
    </div>
  );
};
