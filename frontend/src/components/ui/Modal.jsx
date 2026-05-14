import { useEffect } from "react";

/**
 * Modal with scrim + Escape-to-close. Renders nothing when `open` is false.
 *
 *   <Modal open={isOpen} onClose={close} title="Revoke doctor"
 *          subtitle="…"
 *          footer={<><Button …/></>}
 *          width={560}>
 *     body
 *   </Modal>
 */
export function Modal({ open, onClose, title, subtitle, children, footer, width }) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e) => {
      if (e.key === "Escape") onClose?.();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div className="modal-scrim" onClick={onClose}>
      <div
        className="modal"
        onClick={(e) => e.stopPropagation()}
        style={width ? { width: `min(${width}px, 100%)` } : undefined}
      >
        <div className="modal-head">
          <div className="modal-title">{title}</div>
          {subtitle && <div className="modal-sub">{subtitle}</div>}
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>
  );
}

export default Modal;
