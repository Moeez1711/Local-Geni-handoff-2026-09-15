import { useState } from 'react';

/** Geographic coverage schematic remains usable without a Maps JavaScript key. */
export default function CoverageGrid({ bounds, cells = [], radius, preview = false }) {
  const [selected, setSelected] = useState(null);
  if (!bounds || !cells.length) return null;
  const x = lng => (lng - bounds.west) / (bounds.east - bounds.west) * 600;
  const y = lat => (bounds.north - lat) / (bounds.north - bounds.south) * 220;
  const status = cell => cell.saturated ? 'capped' : cell.status || 'pending';
  return <div className="coverage-grid">
    <div className="coverage-grid-heading"><strong>{preview ? 'Search area preview' : 'Area coverage'}</strong><span>{preview ? 'Each tile is one area' : 'Each cell is searched separately'}</span></div>
    <svg viewBox="0 0 600 220" role="img" aria-label={`${cells.length} geographic search areas; north is up`}><title>{preview ? 'Planned search areas inside the selected boundary.' : 'Search coverage. Select an area to inspect its boundary and status.'}</title>
      {cells.map((cell, index) => <rect key={cell.id || index} className={`coverage-cell ${status(cell)}`} x={x(cell.west)} y={y(cell.north)} width={Math.max(0, x(cell.east) - x(cell.west))} height={Math.max(0, y(cell.south) - y(cell.north))} onClick={preview ? undefined : () => setSelected(cell)}><title>Area {index + 1}: {status(cell)}. {cell.south.toFixed(4)}, {cell.west.toFixed(4)} to {cell.north.toFixed(4)}, {cell.east.toFixed(4)}</title></rect>)}
      {radius && <ellipse cx={x(radius.center.lng)} cy={y(radius.center.lat)} rx="299" ry="109" className="coverage-radius"/>}
    </svg>
    {!preview && <div className="coverage-key"><span><i className="pending"/>Unsearched</span><span><i className="active"/>Searching</span><span><i className="done"/>Processed</span><span><i className="failed"/>Failed / capped</span></div>}
    {!preview && selected && <p className="hint">{status(selected)} · {selected.south.toFixed(4)}, {selected.west.toFixed(4)} to {selected.north.toFixed(4)}, {selected.east.toFixed(4)}</p>}
  </div>;
}
