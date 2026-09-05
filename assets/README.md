# assets

- `icon.svg` — the promptlog mark: a prompt chevron facing a rewind triangle,
  white on black, 2133×2133 viewBox. Hand-written vector (413 bytes); edit
  this file, never the PNGs.
- `icon-512.png`, `icon-256.png`, `icon-128.png`, `icon-64.png` — exports of
  `icon.svg` for places that need a bitmap (marketplaces, social previews).
  Regenerate on macOS with `qlmanage -t -s 1024 -o . icon.svg` then `sips -Z <size>`.
