/**
 * The typeshelf mark: three keyboards stood on a shelf like books.
 *
 * This is the small drawing, with few, large keys, the same as
 * `public/favicon.svg`; `public/logo.svg` is the detailed one for big sizes.
 * It is inline so its outline can follow the theme (`--logo-line`).
 */
export function Logo(props: { size: number }) {
  return (
    <svg class="logo" viewBox="56 54 400 400" width={props.size} height={props.size} aria-hidden="true">
      <g transform="translate(352 312) rotate(-115)">
        <rect width="236" height="74" rx="10" fill="#3DBBF2" stroke="currentColor" stroke-width="18" stroke-linejoin="round"/>
        <g fill="#FFF6D6"><rect x="18" y="14" width="44" height="18" rx="4"/><rect x="70" y="14" width="44" height="18" rx="4"/><rect x="122" y="14" width="44" height="18" rx="4"/><rect x="174" y="14" width="44" height="18" rx="4"/><rect x="18" y="42" width="200" height="18" rx="4"/></g>
      </g>
      <g transform="translate(100 312) rotate(-90)">
        <rect width="236" height="74" rx="10" fill="#FF3B6B" stroke="currentColor" stroke-width="18" stroke-linejoin="round"/>
        <g fill="#FFF6D6"><rect x="18" y="14" width="44" height="18" rx="4"/><rect x="70" y="14" width="44" height="18" rx="4"/><rect x="122" y="14" width="44" height="18" rx="4"/><rect x="174" y="14" width="44" height="18" rx="4"/><rect x="18" y="42" width="200" height="18" rx="4"/></g>
      </g>
      <g transform="translate(174 312) rotate(-90)">
        <rect width="236" height="74" rx="10" fill="#9B1B9B" stroke="currentColor" stroke-width="18" stroke-linejoin="round"/>
        <g fill="#FFD21F"><rect x="18" y="14" width="44" height="18" rx="4"/><rect x="70" y="14" width="44" height="18" rx="4"/><rect x="122" y="14" width="44" height="18" rx="4"/><rect x="174" y="14" width="44" height="18" rx="4"/><rect x="18" y="42" width="200" height="18" rx="4"/></g>
      </g>
      <g stroke="currentColor" stroke-width="18" stroke-linejoin="round">
        <rect x="140" y="356" width="232" height="40" fill="#E38B3A"/>
        <rect x="104" y="356" width="40" height="80" fill="#F4A95D"/>
        <rect x="368" y="356" width="40" height="80" fill="#F4A95D"/>
        <rect x="74" y="312" width="364" height="44" rx="6" fill="#F4A95D"/>
      </g>
    </svg>
  );
}
