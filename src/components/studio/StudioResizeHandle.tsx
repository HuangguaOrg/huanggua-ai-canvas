import { useRef, type PointerEvent } from 'react';

/** Same pointer-capture interaction as the canvas chat panel; keyboard accessible. */
export default function StudioResizeHandle({ label, value, min, max, initial, reverse = false, onChange }: {
  label: string; value: number; min: number; max: number; initial: number; reverse?: boolean; onChange: (value: number) => void;
}) {
  const gesture = useRef<{ x: number; width: number } | null>(null);
  const resize = (width: number) => onChange(Math.max(min, Math.min(max, Math.round(width))));
  const finish = (event: PointerEvent<HTMLDivElement>) => {
    gesture.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };
  return <div role="separator" aria-label={label} aria-orientation="vertical" aria-valuemin={min} aria-valuemax={max} aria-valuenow={value}
    tabIndex={0} className="studio-resize" onDoubleClick={() => resize(initial)}
    onPointerDown={event => {
      if (event.button !== 0) return;
      event.preventDefault(); event.currentTarget.focus(); event.currentTarget.setPointerCapture(event.pointerId);
      gesture.current = { x: event.clientX, width: value };
    }} onPointerMove={event => {
      if (gesture.current) resize(gesture.current.width + (event.clientX - gesture.current.x) * (reverse ? -1 : 1));
    }} onPointerUp={finish} onPointerCancel={finish} onLostPointerCapture={() => { gesture.current = null; }}
    onKeyDown={event => {
      if (event.key === 'Home') { event.preventDefault(); resize(initial); }
      if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
        event.preventDefault(); resize(value + (event.key === 'ArrowRight' ? 16 : -16) * (reverse ? -1 : 1));
      }
    }} />;
}
