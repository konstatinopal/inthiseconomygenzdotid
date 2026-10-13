import { useState } from 'react';

export function Avatar({ name, picture, size = 24 }: { name: string; picture?: string | null; size?: number }) {
  const [broken, setBroken] = useState(false);
  const initials = name
    .split(/[\s@.]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map(s => s[0]?.toUpperCase())
    .join('');
  if (picture && !broken)
    return <img src={picture} alt="" width={size} height={size} referrerPolicy="no-referrer" onError={() => setBroken(true)} style={{ borderRadius: '50%', flexShrink: 0 }} />;
  return (
    <span
      aria-hidden="true"
      style={{
        width: size,
        height: size,
        borderRadius: '50%',
        background: 'var(--accent-soft)',
        color: 'var(--accent)',
        fontSize: size * 0.42,
        fontWeight: 700,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        flexShrink: 0,
      }}
    >
      {initials}
    </span>
  );
}
