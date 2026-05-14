import { Icon } from "./Icon.jsx";

/**
 * Empty-state block used inside Cards.
 *
 *   <Empty icon="records" title="No records yet" body="…" action={<Button…/>} />
 */
export function Empty({ icon = "pulse", title, body, action }) {
  return (
    <div className="empty">
      <div className="empty-ico">
        <Icon name={icon} size={22} />
      </div>
      <div className="empty-title">{title}</div>
      {body && <div className="empty-body">{body}</div>}
      {action && <div style={{ marginTop: 8 }}>{action}</div>}
    </div>
  );
}

export default Empty;
