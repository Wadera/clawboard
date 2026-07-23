import React, { useState } from 'react';
import { createPortal } from 'react-dom';
import { X, AlertTriangle } from 'lucide-react';
import './ConfirmationModal.css';

interface ConfirmationModalProps {
  title: string;
  message: string | React.ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  requiresConfirmation?: boolean;
  confirmationPlaceholder?: string;
  confirmationValue?: string;
  danger?: boolean;
  onConfirm: () => void | Promise<void>;
  onCancel: () => void;
}

export const ConfirmationModal: React.FC<ConfirmationModalProps> = ({
  title,
  message,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  requiresConfirmation = false,
  confirmationPlaceholder = '',
  confirmationValue = '',
  danger = false,
  onConfirm,
  onCancel
}) => {
  const [confirmText, setConfirmText] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  
  const canConfirm = !requiresConfirmation || confirmText === confirmationValue;
  
  const handleConfirm = async () => {
    if (!canConfirm || isSubmitting) return;
    
    setIsSubmitting(true);
    try {
      await onConfirm();
    } finally {
      setIsSubmitting(false);
    }
  };
  
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && canConfirm && !isSubmitting) {
      handleConfirm();
    } else if (e.key === 'Escape') {
      onCancel();
    }
  };
  
  return createPortal(
    <div className="confirmation-modal-overlay" onClick={onCancel}>
      <div className="confirmation-modal" onClick={(e) => e.stopPropagation()} onKeyDown={handleKeyDown}>
        <div className="confirmation-modal-header">
          {danger && <AlertTriangle className="confirmation-icon-danger" size={24} />}
          <h2>{title}</h2>
          <button className="modal-close" onClick={onCancel} disabled={isSubmitting}>
            <X size={20} />
          </button>
        </div>
        
        <div className="confirmation-modal-body">
          {typeof message === 'string' ? <p>{message}</p> : message}
          
          {requiresConfirmation && (
            <div className="confirmation-input-wrapper">
              <label htmlFor="confirm-input">
                Type <strong>{confirmationValue}</strong> to confirm:
              </label>
              <input
                id="confirm-input"
                type="text"
                placeholder={confirmationPlaceholder}
                value={confirmText}
                onChange={(e) => setConfirmText(e.target.value)}
                className="confirmation-input"
                autoFocus
                disabled={isSubmitting}
              />
            </div>
          )}
        </div>
        
        <div className="confirmation-modal-footer">
          <button 
            className="btn-cancel" 
            onClick={onCancel}
            disabled={isSubmitting}
          >
            {cancelLabel}
          </button>
          <button
            className={`btn-confirm ${danger ? 'btn-danger' : ''}`}
            onClick={handleConfirm}
            disabled={!canConfirm || isSubmitting}
          >
            {isSubmitting ? 'Processing...' : confirmLabel}
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
};
