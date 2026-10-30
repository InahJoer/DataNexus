type BrandMarkProps = {
  tone?: 'dark' | 'light';
};

export function BrandMark({ tone = 'dark' }: BrandMarkProps) {
  return (
    <div className={`brand-mark brand-mark--${tone}`}>
      <svg className="brand-symbol" viewBox="0 0 36 36" fill="none" aria-hidden="true">
        <rect x="1" y="1" width="34" height="34" rx="11" fill="currentColor" fillOpacity=".12" />
        <path d="M9 11.5h7.2c3.4 0 5.8 2.5 5.8 6.5s-2.4 6.5-5.8 6.5H9v-13Z" stroke="currentColor" strokeWidth="2.2" strokeLinejoin="round" />
        <path d="m22.5 12 5 6-5 6" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
        <circle cx="28" cy="9" r="2" fill="#72D7C5" />
      </svg>
      <span>Data<span className="brand-accent">Nexus</span></span>
    </div>
  );
}
