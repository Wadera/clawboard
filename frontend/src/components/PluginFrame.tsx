import { useState, useRef, useEffect } from 'react';
import { AlertTriangle, RefreshCw, Loader2 } from 'lucide-react';
import { usePlugins } from '../contexts/PluginContext';
import './PluginFrame.css';

interface PluginFrameProps {
  /** Plugin name (e.g., "claw-journal") */
  pluginName: string;
  /** Plugin's internal proxy path (e.g., "/ui/") */
  proxyPath: string;
  /** API base URL */
  apiBase: string;
}

/**
 * PluginFrame renders a plugin's UI in an iframe
 * 
 * The iframe loads from the backend's plugin proxy:
 * {API_BASE}/plugins/{pluginName}/ui{proxyPath}
 * 
 * The backend proxies this request to the plugin's container.
 */
export function PluginFrame({ pluginName, proxyPath, apiBase }: PluginFrameProps) {
  const { plugins } = usePlugins();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const iframeRef = useRef<HTMLIFrameElement>(null);

  // Find this plugin to check health status
  const plugin = plugins.find(p => p.name === pluginName);
  const isHealthy = plugin?.healthy ?? false;

  // Build the iframe URL
  // Remove 'claw-' prefix for cleaner URLs (matches backend proxy pattern)
  const shortName = pluginName.replace(/^claw-/, '');
  const iframeSrc = `${apiBase}/plugins/${shortName}${proxyPath}`;

  // Reset loading/error state when URL changes
  useEffect(() => {
    setLoading(true);
    setError(null);
  }, [iframeSrc]);

  const handleLoad = () => {
    setLoading(false);
    setError(null);
  };

  const handleError = () => {
    setLoading(false);
    setError('Failed to load plugin UI');
  };

  const handleReload = () => {
    if (iframeRef.current) {
      setLoading(true);
      setError(null);
      iframeRef.current.src = iframeSrc;
    }
  };

  // Show unhealthy warning
  if (!isHealthy && plugin) {
    return (
      <div className="plugin-frame-container">
        <div className="plugin-frame-error">
          <AlertTriangle size={48} className="error-icon" />
          <h2>Plugin Unavailable</h2>
          <p>
            The <strong>{plugin.name}</strong> plugin is currently unhealthy.
          </p>
          <p className="error-hint">
            Check that the plugin container is running and healthy.
          </p>
          <button className="plugin-reload-button" onClick={handleReload}>
            <RefreshCw size={16} />
            Retry
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="plugin-frame-container">
      {/* Loading overlay */}
      {loading && (
        <div className="plugin-frame-loading">
          <Loader2 size={32} className="loading-spinner" />
          <span>Loading plugin...</span>
        </div>
      )}

      {/* Error state */}
      {error && (
        <div className="plugin-frame-error">
          <AlertTriangle size={48} className="error-icon" />
          <h2>Failed to Load Plugin</h2>
          <p>{error}</p>
          <button className="plugin-reload-button" onClick={handleReload}>
            <RefreshCw size={16} />
            Retry
          </button>
        </div>
      )}

      {/* Plugin iframe */}
      <iframe
        ref={iframeRef}
        src={iframeSrc}
        className={`plugin-iframe ${loading ? 'loading' : ''} ${error ? 'hidden' : ''}`}
        title={`${pluginName} plugin`}
        onLoad={handleLoad}
        onError={handleError}
        sandbox="allow-same-origin allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox"
      />
    </div>
  );
}
