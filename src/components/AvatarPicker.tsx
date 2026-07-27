import { AVATARS, type AvatarKey } from "../lib/avatars";

/**
 * Pick one of the fixed avatar presets.
 *
 * A radiogroup of real <button>s rather than a <select>, because the whole
 * point is seeing the glyphs side by side. Each tile is a plain rectangle with
 * no clip-path, so unlike the Session 12 hex tiles its layout box IS its hit
 * area — but the measurement rule still applies and it was measured live rather
 * than assumed (see the session report).
 */
export function AvatarPicker({
  value,
  onChange,
  label = "Your avatar",
}: {
  value: AvatarKey;
  onChange: (next: AvatarKey) => void;
  label?: string;
}) {
  return (
    <div className="field">
      <span className="field-label" id="avatar-picker-label">
        {label}
      </span>
      <div className="avatar-picker" role="radiogroup" aria-labelledby="avatar-picker-label">
        {AVATARS.map(({ id, label: name, Icon }) => {
          const selected = id === value;
          return (
            <button
              key={id}
              type="button"
              role="radio"
              aria-checked={selected}
              aria-label={name}
              title={name}
              className={`avatar-option${selected ? " selected" : ""}`}
              onClick={() => onChange(id)}
            >
              <Icon size={22} aria-hidden />
            </button>
          );
        })}
      </div>
    </div>
  );
}

/**
 * An avatar as it appears next to a name, in rosters and turn banners.
 * `size` is the glyph size; the badge scales around it.
 */
export function AvatarBadge({
  avatar,
  size = 18,
  dimmed = false,
}: {
  avatar: AvatarKey;
  size?: number;
  dimmed?: boolean;
}) {
  const { Icon, label } = AVATARS.find((a) => a.id === avatar) ?? AVATARS[0];
  return (
    <span className={`avatar-badge${dimmed ? " dimmed" : ""}`} title={label}>
      <Icon size={size} aria-hidden />
    </span>
  );
}
