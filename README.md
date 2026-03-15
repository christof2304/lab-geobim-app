# geobim.lab — BIM Viewer

Web-based IFC viewer with georeferencing and Cesium Ion upload.
Live at **[lab.geobim.app](https://lab.geobim.app)**

![Dark themed BIM viewer](https://img.shields.io/badge/theme-dark-0D1017) ![Vanilla JS](https://img.shields.io/badge/framework-none-lightgrey)

## Features

- **IFC Loading** — Native IFC parsing via WASM, category filter on load, multi-file support
- **3D Viewport** — Three.js with PBR materials, SSAO, tone mapping, anti-aliasing
- **Measure Tool** — Point-to-point, polyline, area, vertical & horizontal distance with vertex/edge/face snapping
- **Clipping Planes** — X/Y/Z axis clipping with flip direction
- **Hide / Delete** — Click to hide or delete elements, undo support
- **Model Tree** — Filterable element tree with type grouping and visibility toggles
- **Properties** — Click any element to inspect IFC properties
- **Georeferencing** — Cesium globe with search, coordinate editing, drag-to-place, rotation
- **Map Layers** — Satellite, Bayern imagery/topo, ALKIS cadastre (Farbe/Grau/Umring)
- **Cesium Ion Upload** — GLB export and direct upload to Cesium Ion
- **Pick / Center Origin** — Set insertion point or center model on origin
- **GFX Settings** — Lighting, tone mapping, AO, resolution, materials

## Tech Stack

| Component | Library |
|-----------|---------|
| IFC parsing | `@ifc-lite/parser`, `@ifc-lite/geometry`, `@ifc-lite/export` (Rust/WASM) |
| 3D rendering | Three.js |
| Globe | CesiumJS (CDN) |
| CRS conversion | proj4 |
| Ion upload | `@aws-sdk/client-s3` |
| Build | Vite |

## Build

```bash
npm install
npx vite build    # outputs to dist/
```

## Project Structure

```
src/
  main.js      IFC loading, Three.js viewport, UI, interaction
  georef.js    Cesium globe, georeferencing, Ion upload
  style.css    All styles (dark theme)
index.html     App shell
```

## License

[MIT](LICENSE)
