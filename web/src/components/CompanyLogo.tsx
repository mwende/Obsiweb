/** Firmenlogo WENDE.IT – helle bzw. dunkle Variante passend zum Farbschema */
export function CompanyLogo({ height = 24, className }: { height?: number; className?: string }) {
  return (
    <picture className={className}>
      <source srcSet="/brand/wende-it-dark.png" media="(prefers-color-scheme: dark)" />
      <img src="/brand/wende-it-light.png" alt="WENDE.IT – Professional IT Solutions" height={height} style={{ height, width: 'auto', display: 'block' }} />
    </picture>
  );
}
