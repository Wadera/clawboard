import { authenticatedFetch } from '../utils/auth';
import { useState, useEffect, useCallback } from 'react';
import { Palette, Sparkles, X, Loader2, Download, ChevronDown, Search, Filter } from 'lucide-react';
import './ImageGenerationPage.css';

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || '/api';

interface UnifiedImage {
  id: string;
  type: 'generated' | 'screenshot';
  timestamp: string;
  filename: string;
  path?: string;
  prompt?: string;
  model?: string;
  status?: string;
  error_message?: string;
}

const MODELS = [
  { value: 'gemini/gemini-3-pro-image-preview', label: 'Nano Banana Pro (Best)' },
  { value: 'gemini/imagen-4.0-generate-001', label: 'Imagen 4' },
  { value: 'gemini/imagen-4.0-fast-generate-001', label: 'Imagen 4 Fast' },
];

export function ImageGenerationPage() {
  const [prompt, setPrompt] = useState('');
  const [model, setModel] = useState(MODELS[0].value);
  const [generating, setGenerating] = useState(false);
  const [images, setImages] = useState<UnifiedImage[]>([]);
  const [selectedImage, setSelectedImage] = useState<UnifiedImage | null>(null);
  const [error, setError] = useState<string | null>(null);
  
  // Filter states
  const [typeFilter, setTypeFilter] = useState<'all' | 'generated' | 'screenshot'>('all');
  const [sortOrder, setSortOrder] = useState<'newest' | 'oldest'>('newest');
  const [searchQuery, setSearchQuery] = useState('');

  const fetchImages = useCallback(async () => {
    try {
      const params = new URLSearchParams({
        type: typeFilter,
        sort: sortOrder,
        search: searchQuery
      });
      const res = await authenticatedFetch(`${API_BASE_URL}/images/all?${params}`);
      const data = await res.json();
      if (data.success) {
        setImages(data.images);
      }
    } catch (err) {
      console.error('Failed to fetch images:', err);
    }
  }, [typeFilter, sortOrder, searchQuery]);

  useEffect(() => {
    fetchImages();
  }, [fetchImages]);

  // Poll for generating images
  useEffect(() => {
    const hasGenerating = images.some(img => img.status === 'generating' || img.status === 'pending');
    if (!hasGenerating) return;

    const interval = setInterval(fetchImages, 3000);
    return () => clearInterval(interval);
  }, [images, fetchImages]);

  const handleGenerate = async () => {
    if (!prompt.trim() || generating) return;

    setGenerating(true);
    setError(null);

    try {
      const res = await authenticatedFetch(`${API_BASE_URL}/images/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: prompt.trim(), model }),
      });

      const data = await res.json();

      if (data.success) {
        setPrompt('');
        // Refresh images to include the new generation
        fetchImages();
      } else {
        setError(data.error || 'Failed to generate image');
      }
    } catch (err) {
      setError('Network error. Please try again.');
    } finally {
      setGenerating(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleGenerate();
    }
  };

  const getImageUrl = (img: UnifiedImage) => {
    // Use public media routes (no auth required for <img> tags)
    if (img.type === 'screenshot') {
      return `/api/media/screenshots/${img.filename}`;
    }
    return `/api/media/generated/${img.filename}`;
  };

  const getModelLabel = (value: string) => {
    return MODELS.find(m => m.value === value)?.label || value;
  };

  const formatDate = (date: string) => {
    return new Date(date).toLocaleString(undefined, {
      month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit'
    });
  };

  return (
    <div className="image-gen-page">
      <div className="image-gen-header">
        <div className="image-gen-header-title">
          <h1><Palette size={24} /> Image Generation</h1>
          <p>Generate images using AI models via LiteLLM</p>
        </div>
      </div>

      {/* Generation Form */}
      <div className="image-gen-form">
        <div className="image-gen-input-row">
          <textarea
            className="image-gen-prompt"
            placeholder="Describe the image you want to generate..."
            value={prompt}
            onChange={e => setPrompt(e.target.value)}
            onKeyDown={handleKeyDown}
            rows={2}
            disabled={generating}
          />
          <div className="image-gen-controls">
            <div className="image-gen-model-select">
              <select value={model} onChange={e => setModel(e.target.value)} disabled={generating}>
                {MODELS.map(m => (
                  <option key={m.value} value={m.value}>{m.label}</option>
                ))}
              </select>
              <ChevronDown size={14} className="select-icon" />
            </div>
            <button
              className="image-gen-button"
              onClick={handleGenerate}
              disabled={!prompt.trim() || generating}
            >
              {generating ? (
                <><Loader2 size={16} className="spin" /> Generating...</>
              ) : (
                <><Sparkles size={16} /> Generate</>
              )}
            </button>
          </div>
        </div>
        {error && <div className="image-gen-error">{error}</div>}
      </div>

      {/* Filter Bar */}
      <div className="image-gen-filters">
        <div className="filter-group">
          <Filter size={16} />
          <span className="filter-label">Filters:</span>
        </div>
        
        <div className="filter-group">
          <label>Type:</label>
          <div className="custom-select">
            <select value={typeFilter} onChange={e => setTypeFilter(e.target.value as any)}>
              <option value="all">All Images</option>
              <option value="generated">Generated</option>
              <option value="screenshot">Screenshots</option>
            </select>
            <ChevronDown size={14} className="select-icon" />
          </div>
        </div>

        <div className="filter-group">
          <label>Sort:</label>
          <div className="custom-select">
            <select value={sortOrder} onChange={e => setSortOrder(e.target.value as any)}>
              <option value="newest">Newest First</option>
              <option value="oldest">Oldest First</option>
            </select>
            <ChevronDown size={14} className="select-icon" />
          </div>
        </div>

        <div className="filter-group search-group">
          <Search size={16} />
          <input
            type="text"
            placeholder="Search filename or prompt..."
            value={searchQuery}
            onChange={e => setSearchQuery(e.target.value)}
            className="search-input"
          />
        </div>
      </div>

      {/* Gallery */}
      <div className="image-gen-gallery">
        {images.length === 0 ? (
          <div className="image-gen-empty">
            <Palette size={48} />
            <p>No images generated yet. Enter a prompt above to get started!</p>
          </div>
        ) : (
          <div className="image-gen-grid">
            {images.map(img => {
              const isCompleted = img.type === 'screenshot' || img.status === 'completed';
              const isGenerating = img.status === 'generating' || img.status === 'pending';
              const isFailed = img.status === 'failed';

              return (
                <div
                  key={img.id}
                  className={`image-gen-card ${img.status || 'completed'}`}
                  onClick={() => isCompleted && setSelectedImage(img)}
                >
                  {isCompleted ? (
                    <>
                      <img
                        src={getImageUrl(img)}
                        alt={img.prompt || img.filename}
                        className="image-gen-thumbnail"
                        loading="lazy"
                      />
                      <span className={`image-type-badge ${img.type}`}>
                        {img.type === 'generated' ? '🎨 Generated' : '📸 Screenshot'}
                      </span>
                    </>
                  ) : isGenerating ? (
                    <div className="image-gen-loading">
                      <Loader2 size={32} className="spin" />
                      <span>Generating...</span>
                    </div>
                  ) : isFailed ? (
                    <div className="image-gen-failed">
                      <span>❌ Failed</span>
                      {img.error_message && (
                        <span className="error-detail">{img.error_message.slice(0, 100)}</span>
                      )}
                    </div>
                  ) : null}
                  <div className="image-gen-card-info">
                    <p className="image-gen-card-prompt" title={img.prompt || img.filename}>
                      {img.type === 'generated' ? img.prompt : img.filename}
                    </p>
                    <div className="image-gen-card-meta">
                      {img.model && (
                        <span className="image-gen-card-model">{getModelLabel(img.model)}</span>
                      )}
                      <span className="image-gen-card-date">{formatDate(img.timestamp)}</span>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Lightbox */}
      {selectedImage && (
        <div className="image-gen-lightbox" onClick={() => setSelectedImage(null)}>
          <div className="image-gen-lightbox-content" onClick={e => e.stopPropagation()}>
            <button className="image-gen-lightbox-close" onClick={() => setSelectedImage(null)}>
              <X size={20} />
            </button>
            <img
              src={getImageUrl(selectedImage)}
              alt={selectedImage.prompt || selectedImage.filename}
              className="image-gen-lightbox-image"
            />
            <div className="image-gen-lightbox-info">
              <div className="lightbox-header">
                <span className={`image-type-badge ${selectedImage.type}`}>
                  {selectedImage.type === 'generated' ? '🎨 Generated' : '📸 Screenshot'}
                </span>
              </div>
              {selectedImage.type === 'generated' ? (
                <>
                  <p className="lightbox-prompt">{selectedImage.prompt}</p>
                  <div className="lightbox-meta">
                    <span>{getModelLabel(selectedImage.model!)}</span>
                    <span>{formatDate(selectedImage.timestamp)}</span>
                    <a
                      href={getImageUrl(selectedImage)}
                      download={`${selectedImage.id}.png`}
                      className="lightbox-download"
                      onClick={e => e.stopPropagation()}
                    >
                      <Download size={14} /> Download
                    </a>
                  </div>
                </>
              ) : (
                <>
                  <p className="lightbox-prompt">{selectedImage.filename}</p>
                  <div className="lightbox-meta">
                    <span>{formatDate(selectedImage.timestamp)}</span>
                    <a
                      href={getImageUrl(selectedImage)}
                      download={selectedImage.filename}
                      className="lightbox-download"
                      onClick={e => e.stopPropagation()}
                    >
                      <Download size={14} /> Download
                    </a>
                  </div>
                </>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
