/** Local Geni: a G drawn as a local map marker. */
export default function BrandMark({ size = 40, className = '', label }) {
  return <svg className={`geni-mark ${className}`.trim()} width={size} height={size} viewBox="0 0 64 64" fill="none" role={label ? 'img' : undefined} aria-label={label} aria-hidden={label ? undefined : true} focusable="false">
    <rect width="64" height="64" rx="18" fill="var(--color-accent)" />
    <path d="M45 25c-2-5-7-8-13-8-9 0-15 7-15 15 0 8 6 13 15 20 9-7 15-12 15-20H33" stroke="#ffffff" strokeWidth="4.5" strokeLinecap="round" strokeLinejoin="round" />
  </svg>;
}
