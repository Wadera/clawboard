import React, { useState } from 'react';
import './ScreenshotViewer.css';

interface Screenshot {
  path?: string;
  data?: string;
  mimeType?: string;
}

interface ScreenshotViewerProps {
  screenshots: Screenshot[];
}

export const ScreenshotViewer: React.FC<ScreenshotViewerProps> = ({ screenshots }) => {
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);
  const [loadedImages, setLoadedImages] = useState<Set<number>>(new Set());

  const getImageSrc = (screenshot: Screenshot): string => {
    if (screenshot.data) {
      // Handle base64 data
      if (screenshot.data.startsWith('data:')) {
        return screenshot.data;
      }
      return `data:${screenshot.mimeType || 'image/png'};base64,${screenshot.data}`;
    }
    if (screenshot.path) {
      // For file paths, we'll need to serve them through an API endpoint
      return `/api/media${screenshot.path}`;
    }
    return '';
  };

  const handleImageLoad = (index: number) => {
    setLoadedImages(prev => new Set(prev).add(index));
  };

  const openLightbox = (index: number) => {
    setLightboxIndex(index);
  };

  const closeLightbox = () => {
    setLightboxIndex(null);
  };

  const nextImage = () => {
    if (lightboxIndex !== null && lightboxIndex < screenshots.length - 1) {
      setLightboxIndex(lightboxIndex + 1);
    }
  };

  const prevImage = () => {
    if (lightboxIndex !== null && lightboxIndex > 0) {
      setLightboxIndex(lightboxIndex - 1);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') closeLightbox();
    if (e.key === 'ArrowRight') nextImage();
    if (e.key === 'ArrowLeft') prevImage();
  };

  if (!screenshots || screenshots.length === 0) {
    return null;
  }

  return (
    <>
      <div className="screenshot-gallery">
        <div className="screenshot-gallery-label">Screenshots ({screenshots.length})</div>
        <div className="screenshot-thumbnails">
          {screenshots.map((screenshot, index) => (
            <div
              key={index}
              className={`screenshot-thumbnail ${!loadedImages.has(index) ? 'loading' : ''}`}
              onClick={() => openLightbox(index)}
            >
              <img
                src={getImageSrc(screenshot)}
                alt={`Screenshot ${index + 1}`}
                loading="lazy"
                onLoad={() => handleImageLoad(index)}
              />
              {!loadedImages.has(index) && <div className="screenshot-loader" />}
            </div>
          ))}
        </div>
      </div>

      {lightboxIndex !== null && (
        <div
          className="screenshot-lightbox"
          onClick={closeLightbox}
          onKeyDown={handleKeyDown}
          tabIndex={0}
        >
          <div className="lightbox-content" onClick={e => e.stopPropagation()}>
            <button className="lightbox-close" onClick={closeLightbox} aria-label="Close">
              ✕
            </button>
            
            {lightboxIndex > 0 && (
              <button className="lightbox-prev" onClick={prevImage} aria-label="Previous">
                ‹
              </button>
            )}
            
            <img
              src={getImageSrc(screenshots[lightboxIndex])}
              alt={`Screenshot ${lightboxIndex + 1}`}
            />
            
            {lightboxIndex < screenshots.length - 1 && (
              <button className="lightbox-next" onClick={nextImage} aria-label="Next">
                ›
              </button>
            )}
            
            <div className="lightbox-counter">
              {lightboxIndex + 1} / {screenshots.length}
            </div>
          </div>
        </div>
      )}
    </>
  );
};
